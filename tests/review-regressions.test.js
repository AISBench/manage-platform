import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,setSetting,getSetting,listItems } from '../server/db.js';
import { createServices,isParticipant } from '../server/services.js';
import { setMemberStatus } from '../server/members.js';
import { addTestMember,bindTestMember,testItem,insertItem,configForTests,httpFixture } from './helpers.js';

const repo='AISBench/benchmark',payload={repository:{full_name:repo},issue:{number:101},action:'opened',sender:{id:999,login:'outsider'}};
function fixture(t,{includeItem=true,integrations={}}={}) {
  const db=openDatabase(':memory:');t.after(()=>db.close());const member=addTestMember(db);bindTestMember(db,member.id);
  setSetting(db,'rules',{enabled:true,staleHours:1,reminderCooldownHours:1});if(includeItem) insertItem(db);
  const sent=[];const services=createServices(db,configForTests(),{sendMessage:async m=>{sent.push(m);return {messageId:'mock'};},...integrations});
  return {db,member,services,sent};
}
function pending(db,member,{createdAt=new Date(Date.now()-7200000).toISOString(),reason='超期或长时间未更新',id='original',status='pending',sentAt=null}={}) {
  db.prepare('INSERT INTO notifications(id,dedupe_key,item_id,recipient,recipient_member_id,binding_version,title,reason,status,created_at,sent_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,`key:${id}`,'github:101','alice',member.id,1,'Task',reason,status,createdAt,sentAt);
}
function quietNow(db) {
  const clock=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
  const [h,m]=clock.split(':').map(Number),end=(h*60+m+120)%1440;
  db.prepare('UPDATE users SET quiet_start=?,quiet_end=?').run(clock,`${String(Math.floor(end/60)).padStart(2,'0')}:${String(end%60).padStart(2,'0')}`);
}

test('quiet backlog older than cooldown is single and does not burst on release',async t=>{
  const {db,member,services,sent}=fixture(t);pending(db,member);quietNow(db);
  assert.equal((await services.runReminders()).queued,0);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE status='pending'").get().n,1);assert.equal(sent.length,0);
  db.prepare("UPDATE users SET quiet_start='',quiet_end=''").run();db.prepare('UPDATE notifications SET next_at=0').run();
  await services.runReminders();await services.runReminders();assert.equal(sent.length,1);
});

test('cooldown starts at successful send rather than queue creation',async t=>{
  const {db,member,services,sent}=fixture(t);pending(db,member,{status:'sent',sentAt:new Date().toISOString()});await services.runReminders();assert.equal(sent.length,0);
});

test('webhook obtains post-event snapshot and deduplicates replay',async t=>{
  let release,markStarted,calls=0;const started=new Promise(resolve=>{markStarted=resolve;}),fresh=testItem({updatedAt:new Date().toISOString()});
  const {db,services,sent}=fixture(t,{includeItem:false,integrations:{fetchItems:async()=>++calls===1?await new Promise(r=>{release=r;markStarted();}):[fresh]}});
  const before=services.sync();await started;const event=services.onWebhook(payload,'fresh-event','issues');release([]);await Promise.all([before,event]);
  assert.equal(calls,2);assert.equal(sent.length,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries').get().n,1);
  await services.onWebhook(payload,'fresh-event','issues');assert.equal(calls,2);assert.equal(sent.length,1);
});

test('durable event survives sync failure, retries and has a processed timestamp',async t=>{
  let failing=true,calls=0;
  const {db,services,sent}=fixture(t,{includeItem:false,integrations:{fetchItems:async()=>{calls++;if(failing) throw new Error('offline');return [testItem({updatedAt:new Date().toISOString()})];}}});
  services.acceptWebhook(payload,'durable','issues');services.acceptWebhook(payload,'durable','issues');await services.processWebhooks();
  assert.equal(db.prepare('SELECT attempts FROM webhook_inbox').get().attempts,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries').get().n,0);
  failing=false;db.prepare('UPDATE webhook_inbox SET next_at=0').run();await services.processWebhooks();assert.equal(sent.length,1);assert.equal(calls,2);assert.ok(db.prepare('SELECT processed_at FROM webhook_inbox').get().processed_at);
  await services.processWebhooks();assert.equal(sent.length,1);
});

test('disabled fixed identity cancels queued events and cannot receive new reminders',async t=>{
  const {db,member,services,sent}=fixture(t);pending(db,member,{reason:'GitHub issues / opened'});
  setMemberStatus(db,member.id,{version:1,enabled:false});await services.runReminders();assert.equal(sent.length,0);assert.equal(db.prepare('SELECT status FROM notifications WHERE id=?').get('original').status,'cancelled');
});

test('username reuse never grants participation or notification ownership',async t=>{
  const {db,services,sent}=fixture(t);const imposter=addTestMember(db,{githubId:'502',login:'another-user'});bindTestMember(db,imposter.id);
  db.prepare('UPDATE members SET github_login=? WHERE id=?').run('alice',imposter.id);
  const item=listItems(db)[0];assert.equal(isParticipant(item,{memberId:imposter.id,githubId:'502'}),false);assert.equal(isParticipant(item,'alice'),false);
  await services.runReminders();assert.equal(sent.length,1);assert.ok(sent[0].openId!==`ou_${imposter.id}`);
});

test('Feishu callback rejects browser account/session switch despite valid state cookie',async t=>{
  const f=await httpFixture(t),a=f.client('demo-admin'),b=f.client('demo-reviewer');
  const start=await a.request('/auth/feishu/bind'),state=new URL(start.response.headers.get('location')).searchParams.get('state');
  const oauthCookie=start.response.headers.getSetCookie().find(c=>c.startsWith('triage_oauth_feishu=')).split(';')[0];
  const result=await fetch(`${f.base}/auth/feishu/callback?state=${state}&code=mock`,{headers:{Cookie:`${b.cookie}; ${oauthCookie}`},redirect:'manual'});
  assert.equal(result.status,400);assert.match((await result.json()).error,/不匹配/);
});

test('successful send test cannot reactivate binding disabled during external request',async t=>{
  let f;
  f=await httpFixture(t,{integrations:{sendMessage:async()=>{setMemberStatus(f.db,'demo-reviewer',{version:1,enabled:false});return {messageId:'sent'};}}});
  bindTestMember(f.db,'demo-reviewer');const c=f.client('demo-reviewer');
  assert.equal((await c.request('/api/feishu/test','POST',{})).status,401);
  const binding=f.db.prepare("SELECT * FROM feishu_bindings WHERE member_id='demo-reviewer'").get();assert.equal(binding.status,'needs_confirmation');assert.equal(binding.verified_at,null);
});

test('rebinding during send test keeps new binding unverified',async t=>{
  let f;f=await httpFixture(t,{integrations:{sendMessage:async()=>{f.db.prepare("UPDATE feishu_bindings SET binding_version=binding_version+1,open_id='ou_new',status='needs_confirmation',verified_at=NULL WHERE member_id='demo-reviewer'").run();return {messageId:'sent'};}}});
  bindTestMember(f.db,'demo-reviewer');const c=f.client('demo-reviewer');assert.equal((await c.request('/api/feishu/test','POST',{})).status,409);assert.equal(f.db.prepare("SELECT status FROM feishu_bindings WHERE member_id='demo-reviewer'").get().status,'needs_confirmation');
});

test('Feishu self-test is required, marks only current binding active and never exposes open_id',async t=>{
  const f=await httpFixture(t,{integrations:{sendMessage:async()=>({messageId:'sent'})}});bindTestMember(f.db,'demo-reviewer');
  f.db.prepare("UPDATE feishu_bindings SET status='needs_confirmation',verified_at=NULL WHERE member_id='demo-reviewer'").run();
  const c=f.client('demo-reviewer');assert.equal((await c.request('/api/session')).data.user.feishuVerified,false);
  const sent=await c.request('/api/feishu/test','POST',{});assert.equal(sent.status,200);assert.equal(sent.data.user.feishuVerified,true);assert.ok(!JSON.stringify(sent.data).includes('ou_'));
});

test('GitHub rate limit backs off without corrupting saved data; reopen needs review',async t=>{
  let limited=true;
  const {db,services}=fixture(t,{integrations:{fetchItems:async()=>{if(limited) throw Object.assign(new Error('rate'),{retryAt:Date.now()+60000});return [testItem({state:'open'})];}}});
  await assert.rejects(services.sync());assert.ok(getSetting(db,'nextSyncAllowedAt'));assert.equal(listItems(db).length,1);await assert.rejects(services.sync(),e=>e.status===429);
  limited=false;setSetting(db,'nextSyncAllowedAt',null);db.prepare("UPDATE items SET data=?,workflow='done',priority='high'").run(JSON.stringify(testItem({state:'closed'})));
  await services.sync();const item=listItems(db)[0];assert.equal(item.needsReview,true);assert.equal(item.priority,'high');assert.equal(item.workflow,'done');
});

test('message retries use stable UUID, backoff and bounded attempts with sanitized errors',async t=>{
  const uuids=[];const {db,services}=fixture(t,{integrations:{sendMessage:async m=>{uuids.push(m.uuid);throw new Error('secret do-not-leak');}}});
  await services.runReminders();await services.runReminders();assert.equal(uuids.length,1);
  db.prepare('UPDATE notifications SET next_at=0').run();await services.runReminders();db.prepare('UPDATE notifications SET next_at=0').run();await services.runReminders();
  const row=db.prepare('SELECT * FROM notifications').get();assert.equal(uuids.length,3);assert.equal(new Set(uuids).size,1);assert.equal(row.status,'failed');assert.ok(!row.error.includes('do-not-leak'));
});

test('unbound/confirmation/pending receivers are visible as skipped rather than sent',async t=>{
  const {db,member,services,sent}=fixture(t);db.prepare("UPDATE feishu_bindings SET status='needs_confirmation',verified_at=NULL").run();
  const result=await services.runReminders();assert.equal(sent.length,0);assert.equal(result.skipped,1);assert.equal(db.prepare('SELECT status,error_code FROM notifications').get().error_code,'BINDING_CONFIRMATION');
  db.prepare('UPDATE members SET status=? WHERE id=?').run('pending_activation',member.id);await services.runReminders();assert.equal(sent.length,0);
});
