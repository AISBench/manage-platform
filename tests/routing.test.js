import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,setSetting } from '../server/db.js';
import { createServices } from '../server/services.js';
import { addTestMember,bindTestMember,testItem,insertItem,configForTests,httpFixture } from './helpers.js';

test('external unassigned issue routes to active verified admin without assigning ownership',async t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());const admin=addTestMember(db,{githubId:'1010',login:'admin',role:'admin'});bindTestMember(db,admin.id);
  insertItem(db,testItem({author:'external',authorId:'999'}));setSetting(db,'rules',{enabled:true,staleHours:48,reminderCooldownHours:24});const sent=[];
  const services=createServices(db,configForTests(),{sendMessage:async m=>{sent.push(m);}});assert.equal((await services.runReminders()).delivered,1);assert.equal(sent[0].openId,`ou_${admin.id}`);assert.equal(db.prepare('SELECT owner_member_id FROM items').get().owner_member_id,null);
});

test('explicit pending owner is not silently redirected to admin and records unreachable reason',async t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());const admin=addTestMember(db,{githubId:'1010',login:'admin',role:'admin'});bindTestMember(db,admin.id);const owner=addTestMember(db,{githubId:'1011',login:'pending',status:'pending_activation'});
  insertItem(db,testItem({authorId:'999'}));db.prepare('UPDATE items SET owner_member_id=?').run(owner.id);setSetting(db,'rules',{enabled:true,staleHours:1,reminderCooldownHours:24});
  const sent=[];const services=createServices(db,configForTests(),{sendMessage:async m=>sent.push(m)});await services.runReminders();assert.equal(sent.length,0);assert.equal(db.prepare('SELECT error_code FROM notifications').get().error_code,'MEMBER_PENDING');
});

test('accepted event batch does not force a full repository sync',async t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());let reads=0;
  for(let i=0;i<5;i++) insertItem(db,{...testItem(),id:`github:${i+1}`,number:i+1});
  const services=createServices(db,configForTests(),{fetchItems:async()=>{reads++;return [];}});
  for(let i=0;i<5;i++) services.acceptWebhook({repository:{full_name:'AISBench/benchmark'},issue:{number:i+1},action:'opened'},`batch-${i}`,'issues');
  await services.processWebhooks();assert.equal(reads,0);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM webhook_inbox WHERE status='done'").get().n,5);
});

test('local assignment generates notification by member id and transactional version',async t=>{
  const f=await httpFixture(t),admin=f.client('demo-admin');bindTestMember(f.db,'demo-reviewer');setSetting(f.db,'rules',{enabled:true,staleHours:8760,reminderCooldownHours:24});
  const item=(await admin.request('/api/items')).data.items.find(i=>i.id==='github:9000');
  assert.equal((await admin.request(`/api/items/${item.id}`,'PATCH',{version:item.version,ownerMemberId:'demo-reviewer'})).status,200);
  const notice=f.db.prepare("SELECT * FROM notifications WHERE reason='平台负责人分派 / 改派'").get();assert.equal(notice.recipient_member_id,'demo-reviewer');assert.equal(notice.status,'pending');
});

test('no active admin is observable rather than a fake delivered notification',async t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());insertItem(db,testItem({authorId:'999'}));setSetting(db,'rules',{enabled:true,staleHours:1,reminderCooldownHours:24});
  const services=createServices(db,configForTests(),{sendMessage:async()=>assert.fail('No recipient')});const result=await services.runReminders();assert.equal(result.delivered,0);assert.equal(db.prepare('SELECT status,error_code FROM notifications').get().error_code,'NO_ACTIVE_ADMIN');
});
