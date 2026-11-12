import test from 'node:test';
import assert from 'node:assert/strict';
import { getSetting,setSetting } from '../server/db.js';
import { publicItem } from '../server/public-service.js';
import { httpFixture,testItem } from './helpers.js';
import { verifiedIdentity,createRegistrationSession,getAccessPolicy,submitApplication } from '../server/registration.js';

const metadata=(extra={})=>({id:4242,full_name:'AISBench/benchmark',private:false,visibility:'public',...extra});
const sensitiveItem=()=>testItem({body:'private-body-never-public',ownerMemberId:'private-owner',workflow:'blocked',priority:'high',dueAt:'2027-01-01T00:00:00Z',module:'secret-module',notifications:['private'],url:'https://evil.example/steal',labels:['bug']});
async function populated(t,{fetchMetadata=async()=>metadata(),snapshot=[sensitiveItem()]}={}) {
  let calls=0;
  const f=await httpFixture(t,{integrations:{fetchItems:async()=>snapshot,fetchMetadata:async(...args)=>{calls++;return fetchMetadata(...args);}}});
  setSetting(f.db,'accessPolicy',{...getAccessPolicy(f.db),publicOverviewEnabled:true});await f.services.sync();return {...f,metadataCalls:()=>calls};
}

test('anonymous guest creates no session/cookie and public endpoint has only allowlisted metadata',async t=>{
  const f=await populated(t),guest=f.client(null),before=f.metadataCalls();
  const session=await guest.request('/api/session');assert.equal(session.data.mode,'guest');assert.equal(session.data.user,null);assert.equal(session.data.csrfToken,null);assert.equal(session.response.headers.getSetCookie().length,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
  const overview=await guest.request('/api/public/overview');assert.equal(overview.data.available,true);assert.deepEqual(overview.data.stats,{openPRs:0,closedPRs:0,openIssues:1,closedIssues:0});
  const listed=await guest.request('/api/public/items');assert.equal(listed.data.items[0].url,'https://github.com/AISBench/benchmark/issues/101');
  for(const key of ['id','body','authorId','assignees','reviewers','ownerMemberId','workflow','priority','dueAt','module','notifications']) assert.ok(!(key in listed.data.items[0]),key);
  for(const secret of ['private-body-never-public','private-owner','secret-module','evil.example']) assert.ok(!JSON.stringify(listed.data).includes(secret));
  assert.match(listed.response.headers.get('cache-control'),/no-store/);assert.equal(f.metadataCalls(),before,'guest GET must not call GitHub');
});

test('guest cannot use member, admin, mutation APIs or query internal fields',async t=>{
  const f=await populated(t),guest=f.client(null);
  for(const route of ['/api/items','/api/dashboard','/api/assignable-members','/api/members','/api/notifications','/api/admin/join-requests','/api/admin/access-policy']) assert.equal((await guest.request(route)).status,401,route);
  assert.equal((await guest.request('/api/sync','POST',{})).status,401);
  for(const query of ['ownerMemberId=secret','module=secret','priority=high','workflow=done','pageSize=1000','sort=owner']) assert.equal((await guest.request('/api/public/items?'+query)).status,400,query);
  assert.equal((await guest.request('/api/public/overview?owner=secret')).status,400);
});

test('public counts distinguish issue/pr and closed vs explicitly merged',async t=>{
  const snapshot=[testItem({kind:'pr',number:1,id:'github:1',state:'closed'}),testItem({kind:'pr',number:2,id:'github:2',state:'closed',merged:true}),testItem({kind:'pr',number:3,id:'github:3',state:'open'}),testItem({number:4,id:'github:4',state:'closed'})];
  const f=await populated(t,{snapshot}),guest=f.client(null);
  assert.deepEqual((await guest.request('/api/public/overview')).data.stats,{openPRs:1,closedPRs:2,openIssues:0,closedIssues:1});
  const list=(await guest.request('/api/public/items?kind=pr&state=closed&pageSize=1')).data;assert.equal(list.total,2);assert.equal(list.items.length,1);assert.equal(list.items[0].merged,true);
  const last=(await guest.request('/api/public/items?kind=pr&state=closed&pageSize=1&page=2')).data.items[0];assert.ok(!('merged' in last));
});

test('expired visibility fails closed without guest-triggered metadata calls',async t=>{
  const f=await populated(t),guest=f.client(null),old=getSetting(f.db,'publicVisibility');setSetting(f.db,'publicVisibility',{...old,checkedAt:new Date(Date.now()-61000).toISOString()});
  const count=f.metadataCalls(),overview=await guest.request('/api/public/overview');assert.equal(overview.data.available,false);assert.equal(overview.data.reason,'expired');assert.equal(overview.data.stats,null);
  assert.deepEqual((await guest.request('/api/public/items')).data.items,[]);assert.equal(f.metadataCalls(),count);
  await f.services.publicPortal.checkVisibility();assert.equal((await guest.request('/api/public/overview')).data.available,true);
});

test('private visibility revokes snapshot and newly public repo requires a full new projection',async t=>{
  let isPrivate=false;const f=await populated(t,{fetchMetadata:async()=>metadata({private:isPrivate,visibility:isPrivate?'private':'public'})}),guest=f.client(null);
  isPrivate=true;await f.services.publicPortal.checkVisibility({force:true});assert.equal((await guest.request('/api/public/overview')).data.reason,'private');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM public_items').get().n,0);
  isPrivate=false;await f.services.publicPortal.checkVisibility({force:true});assert.equal((await guest.request('/api/public/overview')).data.reason,'no_snapshot');
  await f.services.sync();assert.equal((await guest.request('/api/public/overview')).data.available,true);
});

test('metadata failure cannot expose private history and does not break internal repository reads',async t=>{
  const f=await populated(t,{fetchMetadata:async()=>{throw new Error('token body do-not-leak');}}),guest=f.client(null),admin=f.client('demo-admin');
  assert.equal((await guest.request('/api/public/overview')).data.reason,'unverified');assert.deepEqual((await guest.request('/api/public/items')).data.items,[]);
  const items=await admin.request('/api/items');assert.ok(items.data.items.some(i=>i.body==='private-body-never-public'));assert.ok(!JSON.stringify((await guest.request('/api/public/overview')).data).includes('do-not-leak'));
});

test('public metadata canonical identity must match configured repository',async t=>{
  const f=await populated(t,{fetchMetadata:async()=>metadata({full_name:'another/private-repo'})}),guest=f.client(null);assert.equal((await guest.request('/api/public/overview')).data.available,false);
});

test('public DTO reconstructs allowlist even if stored JSON has accidentally acquired internal keys',async t=>{
  const f=await populated(t),guest=f.client(null);const row=f.db.prepare('SELECT * FROM public_items').get();
  f.db.prepare('UPDATE public_items SET data=?').run(JSON.stringify({...JSON.parse(row.data),body:'corrupt-secret',owner:'secret-person',url:'javascript:alert(1)'}));
  const data=(await guest.request('/api/public/items')).data;assert.ok(!JSON.stringify(data).includes('corrupt-secret'));assert.ok(!JSON.stringify(data).includes('secret-person'));assert.equal(data.items[0].url,'https://github.com/AISBench/benchmark/issues/101');
});

test('disable public policy revokes cached projection; re-enable needs fresh public check and manual sync',async t=>{
  const f=await populated(t),admin=f.client('demo-admin'),guest=f.client(null);let policy=getAccessPolicy(f.db);
  const off=await admin.request('/api/admin/access-policy','PUT',{...policy,publicOverviewEnabled:false});assert.equal(off.status,200);policy=off.data.policy;
  assert.equal((await guest.request('/api/public/overview')).data.reason,'disabled');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM public_items').get().n,0);
  const on=await admin.request('/api/admin/access-policy','PUT',{...policy,publicOverviewEnabled:true});assert.equal(on.status,200);assert.equal((await guest.request('/api/public/overview')).data.reason,'no_snapshot');
  await f.services.sync();assert.equal((await guest.request('/api/public/overview')).data.available,true);
  assert.equal((await admin.request('/api/admin/access-policy','PUT',{...policy,publicOverviewEnabled:true})).status,409);
});

test('policy cannot be enabled for private repo and async lookup cannot retain revoked admin role',async t=>{
  let demote=false;
  const f=await httpFixture(t,{integrations:{fetchMetadata:async()=>{if(demote) f.db.prepare("UPDATE members SET role='member' WHERE id='demo-admin'").run();return metadata({private:!demote,visibility:demote?'public':'private'});}}}),admin=f.client('demo-admin'),policy=getAccessPolicy(f.db);
  assert.equal((await admin.request('/api/admin/access-policy','PUT',{...policy,publicOverviewEnabled:true})).status,400);assert.equal(getAccessPolicy(f.db).publicOverviewEnabled,false);
  demote=true;assert.equal((await admin.request('/api/admin/access-policy','PUT',{...policy,publicOverviewEnabled:true})).status,403);assert.equal(getAccessPolicy(f.db).publicOverviewEnabled,false);
});

test('fresh private metadata after fetch prevents publishing newly imported private items',async t=>{
  let checks=0;const f=await populated(t,{fetchMetadata:async()=>metadata(++checks===1?{}:{private:true,visibility:'private'})});
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM public_items').get().n,0);assert.equal((await f.client(null).request('/api/public/items')).data.available,false);
});

test('demo is guest first and explicit demo authorization is impossible in live mode',async t=>{
  const f=await httpFixture(t,{config:{demo:true}}),guest=f.client(null);
  const session=await guest.request('/api/session');assert.equal(session.data.mode,'guest');assert.equal(session.response.headers.getSetCookie().length,0);assert.equal((await guest.request('/api/public/overview')).data.available,true);
  assert.equal((await guest.request('/auth/demo/member','POST',{login:'demo-maintainer'})).status,403);
  assert.equal((await guest.request('/auth/demo/member','POST',{login:'demo-maintainer'},{'X-Demo-Intent':'1',Origin:'https://evil.example'})).status,403);
  assert.equal((await guest.request('/auth/demo/member','POST',{login:'demo-maintainer'},{'X-Demo-Intent':'1'})).status,200);assert.equal((await guest.request('/api/session')).data.mode,'member');
  const live=await httpFixture(t),anon=live.client(null);assert.equal((await anon.request('/auth/demo/member','POST',{login:'demo-maintainer'},{'X-Demo-Intent':'1'})).status,404);
});

// Public serializer is a separate unit so future developer fields cannot sneak
// into guest responses by spreading an internal Item object.
test('public serializer derives safe GitHub URL and cannot leak arbitrary fields',()=>{
  const dto=publicItem(sensitiveItem(),'AISBench/benchmark');assert.deepEqual(Object.keys(dto).sort(),['author','createdAt','kind','labels','number','state','title','updatedAt','url']);assert.throws(()=>publicItem({...sensitiveItem(),kind:'internal'},'AISBench/benchmark'));
});
