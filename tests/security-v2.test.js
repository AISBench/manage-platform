import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,setSetting } from '../server/db.js';
import { createServices } from '../server/services.js';
import { setMemberStatus } from '../server/members.js';
import { httpFixture,addTestMember,bindTestMember,insertItem,testItem,configForTests } from './helpers.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function beginBinding(client) {
  const result=await client.request('/auth/feishu/bind');assert.equal(result.status,302);
  return new URL(result.response.headers.get('location')).searchParams.get('state');
}

test('unbind/rebind same Feishu identity cannot recycle generation and activate stale test',async t=>{
  const started=deferred(),release=deferred();
  const f=await httpFixture(t,{integrations:{sendMessage:async()=>{started.resolve();await release.promise;return {messageId:'sent'};},exchangeCode:async()=>({openId:'ou_same',name:'User'})}});
  bindTestMember(f.db,'demo-reviewer','cli_test','ou_same');const c=f.client('demo-reviewer');
  const testing=c.request('/api/feishu/test','POST',{});await started.promise;
  assert.equal((await c.request('/api/feishu/binding','DELETE',{})).status,200);
  const state=await beginBinding(c);assert.equal((await c.request(`/auth/feishu/callback?state=${state}&code=mock`)).status,302);
  const binding=f.db.prepare("SELECT * FROM feishu_bindings WHERE member_id='demo-reviewer'").get();assert.ok(binding.binding_version>1);
  release.resolve();assert.equal((await testing).status,409);
  assert.equal(f.db.prepare("SELECT status FROM feishu_bindings WHERE member_id='demo-reviewer'").get().status,'needs_confirmation');
});

test('unbind revokes an OAuth exchange already in flight, not just unconsumed state',async t=>{
  const started=deferred(),release=deferred();
  const f=await httpFixture(t,{integrations:{exchangeCode:async()=>{started.resolve();await release.promise;return {openId:'ou_unwanted',name:'User'};}}});
  const c=f.client('demo-reviewer'),state=await beginBinding(c);
  const callback=c.request(`/auth/feishu/callback?state=${state}&code=mock`);await started.promise;
  assert.equal((await c.request('/api/feishu/binding','DELETE',{})).status,200);release.resolve();
  assert.equal((await callback).status,409);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM feishu_bindings WHERE member_id='demo-reviewer'").get().n,0);
});

function sendingFixture(t,sendMessage) {
  const db=openDatabase(':memory:');t.after(()=>db.close());
  const alice=addTestMember(db,{githubId:'501',login:'alice'}),bob=addTestMember(db,{githubId:'502',login:'bob'});bindTestMember(db,alice.id);bindTestMember(db,bob.id);
  setSetting(db,'rules',{enabled:true,staleHours:8760,reminderCooldownHours:24});
  for(let i=1;i<=2;i++) {
    const item=testItem({id:`github:${i}`,number:i,authorId:'999',updatedAt:new Date().toISOString()});insertItem(db,item);db.prepare('UPDATE items SET owner_member_id=? WHERE id=?').run(alice.id,item.id);
    db.prepare("INSERT INTO notifications(id,dedupe_key,item_id,recipient,recipient_member_id,binding_version,title,reason,status,created_at) VALUES (?,?,?,?,?,1,?,?,'pending',?)").run(`notice-${i}`,`key-${i}`,item.id,'alice',alice.id,item.title,'GitHub issues / opened',`2026-01-0${i}T00:00:00Z`);
  }
  const sent=[];const services=createServices(db,configForTests(),{sendMessage:async input=>{sent.push(input);await sendMessage?.({db,alice,bob,input,sent});return {messageId:'sent'};}});
  return {db,alice,bob,sent,services};
}

test('notification sender reloads next item relations after a previous external send yields',async t=>{
  const f=sendingFixture(t,async({db,bob,sent})=>{if(sent.length===1) db.prepare("UPDATE items SET owner_member_id=?,version=version+1 WHERE id='github:2'").run(bob.id);});
  await f.services.runReminders();assert.equal(f.sent.length,1);assert.equal(f.db.prepare("SELECT status FROM notifications WHERE id='notice-2'").get().status,'cancelled');
});

test('notification sender observes global pause between recipients',async t=>{
  const f=sendingFixture(t,async({db,sent})=>{if(sent.length===1) setSetting(db,'rules',{enabled:false,staleHours:8760,reminderCooldownHours:24});});
  await f.services.runReminders();assert.equal(f.sent.length,1);assert.equal(f.db.prepare("SELECT status FROM notifications WHERE id='notice-2'").get().status,'pending');
});

test('failed in-flight send cannot resurrect notification revoked by member disable',async t=>{
  const f=sendingFixture(t,async({db,alice})=>{setMemberStatus(db,alice.id,{version:1,enabled:false});throw new Error('offline');});
  await f.services.runReminders();assert.equal(f.db.prepare("SELECT status FROM notifications WHERE id='notice-1'").get().status,'cancelled');
  await f.services.runReminders();assert.equal(f.sent.length,1);
});

test('externally accepted in-flight send after revoke is recorded without reopening queue',async t=>{
  const f=sendingFixture(t,async({db,alice})=>{setMemberStatus(db,alice.id,{version:1,enabled:false});});
  await f.services.runReminders();const notice=f.db.prepare("SELECT status,error_code,sent_at FROM notifications WHERE id='notice-1'").get();assert.equal(notice.status,'cancelled');assert.equal(notice.error_code,'DELIVERED_AFTER_REVOCATION');assert.ok(notice.sent_at);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='notification.delivered_after_revocation'").get().n,1);
});

test('disabled unassigned participant does not swallow active administrator fallback',async t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());addTestMember(db,{githubId:'501',login:'alice',status:'disabled'});const admin=addTestMember(db,{githubId:'510',login:'admin',role:'admin'});bindTestMember(db,admin.id);
  insertItem(db);setSetting(db,'rules',{enabled:true,staleHours:1,reminderCooldownHours:24});let sends=0;
  const service=createServices(db,configForTests(),{sendMessage:async()=>{sends++;return {messageId:'ok'};}});await service.runReminders();assert.equal(sends,1);assert.equal(db.prepare("SELECT recipient_member_id FROM notifications WHERE status='sent'").get().recipient_member_id,admin.id);
});
