import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { loadConfig } from '../server/config.js';
import { isParticipant,isQuietTime } from '../server/services.js';
import { setMemberStatus } from '../server/members.js';
import { getSetting } from '../server/db.js';
import { httpFixture,bindTestMember,addTestMember } from './helpers.js';

test('configuration defaults and fails closed without trusting runtime whitelist',()=>{
  assert.throws(()=>loadConfig({}),/Production requires/);
  assert.throws(()=>loadConfig({DEMO_MODE:'true',PORT:'NaN'}),/PORT/);
  assert.throws(()=>loadConfig({DEMO_MODE:'true',GITHUB_REPO:'bad'}),/GITHUB_REPO/);
  assert.throws(()=>loadConfig({DEMO_MODE:'true',BASE_URL:'https://x.test/path'}),/BASE_URL/);
  assert.throws(()=>loadConfig({DEMO_MODE:'true',TRUST_PROXY:'true'}),/TRUST_PROXY/);
  assert.throws(()=>loadConfig({DEMO_MODE:'true',NODE_ENV:'production'}),/DEMO_MODE/);
  const config=loadConfig({GITHUB_CLIENT_ID:'id',GITHUB_CLIENT_SECRET:'secret'});assert.equal(config.syncIntervalMs,600000);assert.deepEqual(config.admins,[]);
});

test('demo session, metrics, immutable identity filtering and versioned local edit',async t=>{
  const f=await httpFixture(t,{config:{demo:true}}),c=f.client('demo-admin');
  const session=await c.request('/api/session');assert.equal(session.data.user.memberId,'demo-admin');assert.equal(session.data.user.githubId,'1001');
  const dash=await c.request('/api/dashboard');assert.equal(dash.data.stats.openPRs,3);assert.equal(dash.data.stats.openIssues,4);assert.ok(dash.data.stats.unassigned>0);
  const mine=await c.request('/api/items?mine=true&kind=pr');assert.ok(mine.data.items.every(i=>isParticipant(i,session.data.user)));
  const item=mine.data.items[0];
  const edited=await c.request(`/api/items/${item.id}`,'PATCH',{version:item.version,workflow:'in_progress',ownerMemberId:'demo-pending',priority:'high',dueAt:'2026-01-01T00:00:00Z'});
  assert.equal(edited.status,200);assert.equal(edited.data.item.ownerIssue,'pending_activation');assert.equal(edited.data.item.state,item.state);
  assert.equal((await c.request(`/api/items/${item.id}`,'PATCH',{version:item.version,workflow:'done'})).status,409);
  assert.equal((await c.request('/api/sync','POST',{})).status,200);
});

test('csrf, strict body validation, immutable member fields and unknown routes',async t=>{
  const f=await httpFixture(t),c=f.client('demo-admin');
  assert.equal((await c.request('/api/sync','POST',{}, {Origin:'https://evil.example'})).status,403);
  assert.equal((await c.request('/api/sync','POST',{}, {'X-CSRF-Token':'bad'})).status,403);
  assert.equal((await c.request('/api/sync','POST',{}, {'X-CSRF-Token':'é'.repeat(64)})).status,403);
  assert.equal((await c.request('/api/items/github:9000','PATCH',{state:'closed',version:1})).status,400);
  assert.equal((await c.request('/api/items/github:9000','PATCH',{workflow:'done'})).status,400);
  assert.equal((await c.request('/api/preferences','PATCH',{notificationsEnabled:true,quietStart:'22:00',quietEnd:''})).status,400);
  assert.equal((await c.request('/api/preferences','PATCH',{notificationsEnabled:true,quietStart:'25:00',quietEnd:'08:00'})).status,400);
  assert.equal((await c.request('/api/rules','PUT',{enabled:true,staleHours:0,reminderCooldownHours:24})).status,400);
  assert.equal((await c.request('/api/admin/members/demo-reviewer','PATCH',{version:1,githubId:'999'})).status,400);
  assert.equal((await c.request('/api/unknown')).status,404);
});

test('administrator edits and disables auto-provisioned members',async t=>{
  const f=await httpFixture(t,{config:{demo:true}}),c=f.client('demo-admin');
  const m=(await c.request('/api/admin/members?q=reviewer-chen')).data.members[0];
  const changed=await c.request(`/api/admin/members/${m.id}`,'PATCH',{version:m.version,displayName:'新姓名'});assert.equal(changed.status,200);
  assert.equal((await c.request(`/api/admin/members/${m.id}`,'PATCH',{version:m.version,module:'stale'})).status,409);
  const disabled=await c.request(`/api/admin/members/${m.id}/disable`,'POST',{version:changed.data.member.version});assert.equal(disabled.data.member.status,'disabled');
  const enabled=await c.request(`/api/admin/members/${m.id}/enable`,'POST',{version:disabled.data.member.version});assert.equal(enabled.data.member.status,'active');
  const listing=await c.request('/api/admin/members?status=active&page=1&pageSize=1');assert.equal(listing.data.members.length,1);assert.ok(listing.data.total>=2);
  const normal=f.client('demo-reviewer');const assignable=await normal.request('/api/assignable-members');assert.ok(assignable.data.members.some(v=>v.id===m.id));assert.ok(assignable.data.members.every(v=>!('notes' in v)&&v.status!=='disabled'));
});

test('last activated admin protected, disabled members lose session and binding confirmation',async t=>{
  const f=await httpFixture(t),admin=f.client('demo-admin'),member=f.client('demo-reviewer');
  bindTestMember(f.db,'demo-reviewer');
  assert.equal((await admin.request('/api/admin/members/demo-admin/disable','POST',{version:1})).status,409);
  const disabled=await admin.request('/api/admin/members/demo-reviewer/disable','POST',{version:1});assert.equal(disabled.status,200);
  assert.equal((await member.request('/api/dashboard')).status,401);
  assert.equal(f.db.prepare("SELECT status FROM feishu_bindings WHERE member_id='demo-reviewer'").get().status,'needs_confirmation');
  const enabled=await admin.request('/api/admin/members/demo-reviewer/enable','POST',{version:disabled.data.member.version});assert.equal(enabled.data.member.status,'active');assert.equal(enabled.data.member.feishuVerified,false);
});

test('ordinary member cannot manage team or reassign; can atomically claim unassigned',async t=>{
  const f=await httpFixture(t),c=f.client('demo-reviewer');
  for(const route of ['/api/admin/members','/api/admin/audit-logs','/api/admin/integration-status','/api/members']) assert.equal((await c.request(route)).status,403);
  assert.equal((await c.request('/api/reminders/run','POST',{})).status,403);
  const items=(await c.request('/api/items')).data.items,unrelated=items.find(i=>i.id==='github:9002');
  assert.equal((await c.request(`/api/items/${unrelated.id}`,'PATCH',{version:unrelated.version,priority:'high'})).status,403);
  const free=items.find(i=>!i.ownerMemberId);
  assert.equal((await c.request(`/api/items/${free.id}/claim`,'POST',{version:free.version})).status,200);
  assert.equal((await c.request(`/api/items/${free.id}/claim`,'POST',{version:free.version+1})).status,409);
  assert.equal((await c.request(`/api/items/${free.id}`,'PATCH',{version:free.version+1,ownerMemberId:'demo-pending'})).status,403);
  assert.equal((await c.request(`/api/items/${free.id}`,'PATCH',{version:free.version+1,ownerMemberId:'demo-reviewer',workflow:'in_progress'})).status,200);
});

test('bulk assignment is all-or-nothing and audits before/after',async t=>{
  const f=await httpFixture(t),c=f.client('demo-admin'),items=(await c.request('/api/items')).data.items.slice(0,2);
  const before=f.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n;
  const failed=await c.request('/api/items/bulk-assign','POST',{items:[{id:items[0].id,version:items[0].version},{id:items[1].id,version:999}],ownerMemberId:'demo-pending'});assert.equal(failed.status,409);
  assert.equal(f.db.prepare('SELECT version FROM items WHERE id=?').get(items[0].id).version,items[0].version);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n,before);
  const passed=await c.request('/api/items/bulk-assign','POST',{items:items.map(i=>({id:i.id,version:i.version})),ownerMemberId:'demo-pending'});assert.equal(passed.status,200);assert.ok(passed.data.items.every(i=>i.ownerMemberId==='demo-pending'));
  const logs=await c.request('/api/admin/audit-logs?action=item.update');assert.ok(logs.data.total>=2);assert.ok(logs.data.logs[0].requestId);
});

test('live OAuth links the fixed ID despite rename; same username reused by another ID becomes a separate member',async t=>{
  let profile={id:777,login:'after-rename',type:'User',name:'GitHub 昵称'};
  const f=await httpFixture(t,{seed:false,config:{admins:['attacker'],allowed:['after-rename']},fetchImpl:async url=>new Response(JSON.stringify(String(url).includes('access_token')?{access_token:'private-token'}:profile),{status:200,headers:{'Content-Type':'application/json'}})});
  const invited=addTestMember(f.db,{githubId:'777',login:'before-rename',status:'pending_activation'}),c=f.client();
  f.db.prepare("UPDATE members SET display_name='团队姓名' WHERE id=?").run(invited.id);
  assert.equal((await c.request('/api/dashboard')).status,401);
  async function oauth() {const start=await c.request('/auth/github');const state=new URL(start.response.headers.get('location')).searchParams.get('state');return c.request(`/auth/github/callback?state=${state}&code=abc`);}
  assert.equal((await oauth()).status,302);
  const session=await c.request('/api/session');assert.equal(session.data.user.memberId,invited.id);assert.equal(session.data.user.login,'after-rename');assert.equal(session.data.user.name,'团队姓名');assert.equal(session.data.user.isAdmin,false);
  assert.equal((await c.request('/api/members')).status,403);assert.equal((await c.request('/api/notifications')).status,200);
  await c.request('/auth/logout','POST',{});
  profile={id:778,login:'before-rename',type:'User'};assert.equal((await oauth()).status,302);const second=await c.request('/api/session');assert.equal(second.data.mode,'member');assert.equal(second.data.user.githubId,'778');
  profile={id:777,login:'another-name',type:'User'};const m=f.db.prepare('SELECT version FROM members WHERE id=?').get(invited.id);setMemberStatus(f.db,invited.id,{version:m.version,enabled:false});assert.equal((await oauth()).status,403);
});

test('OAuth browser state is consumed once and first login auto-provisions a member',async t=>{
  const f=await httpFixture(t,{seed:false,fetchImpl:async url=>new Response(JSON.stringify(String(url).includes('access_token')?{access_token:'secret'}:{id:123,type:'User',login:'unknown',avatar_url:'https://avatars.githubusercontent.com/u/123'}),{status:200})}),c=f.client();
  const start=await c.request('/auth/github'),state=new URL(start.response.headers.get('location')).searchParams.get('state');
  assert.equal((await c.request(`/auth/github/callback?state=${state}&code=code`)).status,302);assert.equal((await c.request('/api/dashboard')).status,200);
  const session=await c.request('/api/session');assert.equal(session.data.mode,'member');assert.equal(session.data.user.githubId,'123');assert.equal(session.data.user.avatarUrl,'https://avatars.githubusercontent.com/u/123');
  assert.equal((await c.request(`/auth/github/callback?state=${state}&code=code`)).status,400);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM members').get().n,1);
});

test('personal preferences/demo send protection and sanitized integration metrics',async t=>{
  const f=await httpFixture(t,{config:{demo:true}}),c=f.client('demo-admin');
  assert.equal((await c.request('/api/preferences','PATCH',{notificationsEnabled:false,quietStart:'22:00',quietEnd:'08:00'})).data.user.notificationsEnabled,false);
  assert.deepEqual((await c.request('/api/feishu/test','POST',{})).data,{sent:false,demo:true});
  assert.deepEqual((await c.request('/api/reminders/run','POST',{})).data,{queued:0,delivered:0,failed:0,skipped:0});
  const status=await c.request('/api/admin/integration-status');assert.equal(status.data.schemaVersion,6);assert.equal(status.data.syncIntervalMinutes,10);assert.equal(status.data.membership.pending,1);
  assert.ok(!JSON.stringify(status.data).includes('test-secret'));assert.equal((await c.request('/api/feishu/binding','DELETE',{})).status,200);
});

test('quiet hours support overnight Asia/Shanghai',()=>{
  assert.equal(isQuietTime('22:00','08:00',new Date('2026-01-01T15:00:00Z')),true);assert.equal(isQuietTime('22:00','08:00',new Date('2026-01-01T03:00:00Z')),false);assert.equal(isQuietTime('09:00','18:00',new Date('2026-01-01T03:00:00Z')),true);
});

test('signed webhook durable ack, replay protection, malformed body and manual retry',async t=>{
  let failing=true;
  const f=await httpFixture(t,{config:{webhookSecret:'test-secret'},integrations:{fetchItems:async()=>{if(failing) throw new Error('offline');return [];}}}),c=f.client('demo-admin');
  const payload=JSON.stringify({repository:{full_name:'AISBench/benchmark'},action:'opened',issue:{number:42}}),signature='sha256='+createHmac('sha256','test-secret').update(payload).digest('hex');
  const headers={'Content-Type':'application/json','X-GitHub-Delivery':'delivery-1','X-GitHub-Event':'issues','X-Hub-Signature-256':signature};
  const send=()=>fetch(f.base+'/api/webhooks/github',{method:'POST',headers,body:payload});
  assert.equal((await send()).status,202);assert.equal((await send()).status,202);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM webhook_inbox').get().n,1);
  await f.services.processWebhooks();assert.equal(f.db.prepare('SELECT attempts FROM webhook_inbox').get().attempts,1);
  failing=false;assert.equal((await c.request('/api/admin/webhooks/delivery-1/retry','POST',{})).status,200);await f.services.processWebhooks();
  assert.equal(f.db.prepare('SELECT status FROM webhook_inbox').get().status,'done');assert.equal((await c.request('/api/admin/webhooks/delivery-1/retry','POST',{})).status,409);
  assert.equal((await fetch(f.base+'/api/webhooks/github',{method:'POST',headers:{...headers,'X-Hub-Signature-256':'bad'},body:payload})).status,401);
  assert.equal(getSetting(f.db,'syncError'),null);
});
