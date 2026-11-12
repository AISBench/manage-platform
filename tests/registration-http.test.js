import test from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture } from './helpers.js';
import { getAccessPolicy,verifiedIdentity,createRegistrationSession } from '../server/registration.js';
import { setMemberStatus } from '../server/members.js';

const profile={id:501,login:'new-alice',name:'Alice',type:'User',avatar_url:'https://avatars.githubusercontent.com/u/501'};
const application={displayName:'Alice 团队昵称',module:'数据集',reason:'希望参与数据集评测与问题排查的团队协作工作。',consent:true};
async function setup(t,options={}) {
  let identity={...profile};
  const f=await httpFixture(t,{...options,fetchImpl:async url=>new Response(JSON.stringify(String(url).includes('access_token')?{access_token:'never-persist-token'}:identity),{status:200,headers:{'Content-Type':'application/json'}})});
  const client=f.client(null);
  async function oauth(c=client,query='') {
    const start=await c.request('/auth/github'+query),state=new URL(start.response.headers.get('location')).searchParams.get('state');
    return c.request(`/auth/github/callback?state=${state}&code=test-code`);
  }
  return {...f,applicant:client,admin:f.client('demo-admin'),oauth,setProfile:value=>{identity=value;}};
}

test('GitHub OAuth only verifies restricted identity; explicit consent submission creates pending request',async t=>{
  const f=await setup(t),c=f.applicant;
  const callback=await f.oauth();assert.equal(callback.status,302);assert.equal(callback.response.headers.get('location'),'/join');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM members WHERE github_user_id='501'").get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM join_requests').get().n,0);
  const session=await c.request('/api/session');assert.equal(session.data.mode,'applicant');assert.equal(session.data.user,null);assert.equal(session.data.applicant.application,null);
  assert.equal((await c.request('/api/registration/applications','POST',{...application,role:'admin'})).status,400);
  assert.equal((await c.request('/api/registration/applications','POST',{...application,consent:false})).status,400);
  const sent=await c.request('/api/registration/applications','POST',application);assert.equal(sent.status,201);assert.equal(sent.data.application.status,'pending');assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM members WHERE github_user_id='501'").get().n,0);
  for(const route of ['/api/items','/api/dashboard','/api/preferences','/api/admin/join-requests','/api/admin/members','/api/notifications']) assert.equal((await c.request(route)).status,401,route);
  assert.equal((await c.request('/auth/feishu/bind')).status,401);
  assert.ok(!JSON.stringify(session.data).includes('never-persist-token'));
});

test('approval grants only pending normal member, never escalates existing restricted cookie',async t=>{
  const f=await setup(t),c=f.applicant;await f.oauth();await c.request('/api/session');
  const submitted=await c.request('/api/registration/applications','POST',application),id=submitted.data.application.id;
  const requests=await f.admin.request('/api/admin/join-requests?status=pending');assert.equal(requests.data.pendingCount,1);assert.equal(requests.data.requests[0].githubId,'501');
  const approved=await f.admin.request(`/api/admin/join-requests/${id}/approve`,'POST',{version:1,publicFeedback:'欢迎加入',internalNote:'internal-secret-review-note'});assert.equal(approved.status,200);
  const member=f.db.prepare("SELECT * FROM members WHERE github_user_id='501'").get();assert.equal(member.role,'member');assert.equal(member.status,'pending_activation');
  const session=await c.request('/api/session');assert.equal(session.data.mode,'applicant');assert.equal(session.data.user,null);assert.equal(session.data.applicant.canLogin,true);assert.equal(session.data.applicant.application.publicFeedback,'欢迎加入');assert.ok(!JSON.stringify(session.data).includes('internal-secret-review-note'));
  assert.equal((await c.request('/api/dashboard')).status,401);assert.equal((await c.request('/api/registration/applications','POST',application)).status,409);
  const login=await f.oauth(c,'?returnTo=https://evil.example/steal');assert.equal(login.status,302);assert.match(login.response.headers.get('location'),/^\/workspace\?/);
  const active=await c.request('/api/session');assert.equal(active.data.mode,'member');assert.equal(active.data.user.role,'member');assert.equal(active.data.user.githubId,'501');assert.equal((await c.request('/api/dashboard')).status,200);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM registration_sessions').get().n,0,'member login rotates and removes old restricted session');
});

test('application state is own-only and CSRF/origin protections cover restricted writes',async t=>{
  const f=await setup(t),a=f.applicant;await f.oauth();await a.request('/api/session');
  assert.equal((await a.request('/api/registration/applications','POST',application,{'X-CSRF-Token':'bad'})).status,403);
  assert.equal((await a.request('/api/registration/applications','POST',application,{Origin:'https://evil.example'})).status,403);
  const submit=await a.request('/api/registration/applications','POST',application);
  for(const key of ['identityId','githubId','applicationId']) assert.equal((await a.request(`/api/registration/status?${key}=${submit.data.application.id}`)).status,400);
  f.setProfile({id:502,login:'another-applicant',type:'User'});const b=f.client(null);await f.oauth(b);await b.request('/api/session');
  const own=await b.request('/api/registration/status');assert.equal(own.data.identity.githubId,'502');assert.equal(own.data.application,null);assert.ok(!JSON.stringify(own.data).includes(application.reason));
  assert.equal((await f.client(null).request('/api/registration/status')).status,401);
});

test('reject feedback is public only to applicant; cooldown, admin role and version guards apply',async t=>{
  const f=await setup(t),c=f.applicant;await f.oauth();await c.request('/api/session');const {application:entry}=(await c.request('/api/registration/applications','POST',application)).data;
  const member=f.client('demo-reviewer');assert.equal((await member.request('/api/admin/join-requests')).status,403);
  assert.equal((await member.request(`/api/admin/join-requests/${entry.id}/approve`,'POST',{version:1})).status,403);
  assert.equal((await f.admin.request(`/api/admin/join-requests/${entry.id}/reject`,'POST',{version:1,publicFeedback:''})).status,400);
  const rejected=await f.admin.request(`/api/admin/join-requests/${entry.id}/reject`,'POST',{version:1,publicFeedback:'请补充参与方向',internalNote:'do-not-show-reviewer-note'});assert.equal(rejected.status,200);
  assert.equal((await f.admin.request(`/api/admin/join-requests/${entry.id}/approve`,'POST',{version:1})).status,409);
  const status=await c.request('/api/registration/status');assert.equal(status.data.application.status,'rejected');assert.equal(status.data.canApply,false);assert.ok(status.data.reapplyAt);assert.ok(!JSON.stringify(status.data).includes('do-not-show-reviewer-note'));
  assert.equal((await c.request('/api/registration/applications','POST',application)).status,429);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM members WHERE github_user_id='501'").get().n,0);
});

test('approved-then-disabled user cannot reapply or use old member/restricted sessions to recover',async t=>{
  const f=await setup(t),c=f.applicant;await f.oauth();await c.request('/api/session');const request=(await c.request('/api/registration/applications','POST',application)).data.application;
  await f.admin.request(`/api/admin/join-requests/${request.id}/approve`,'POST',{version:1});const member=f.db.prepare("SELECT * FROM members WHERE github_user_id='501'").get();setMemberStatus(f.db,member.id,{version:member.version,enabled:false});
  const restricted=await c.request('/api/registration/status');assert.equal(restricted.data.blocked,true);assert.equal(restricted.data.canApply,false);assert.equal(restricted.data.canLogin,false);
  assert.equal((await c.request('/api/registration/applications','POST',application)).status,403);assert.equal((await f.oauth()).status,403);
  assert.equal((await c.request('/api/dashboard')).status,401);
});

test('manual pre-entry of pending applicant requires explicit confirmation and atomically approves same identity',async t=>{
  const f=await setup(t,{integrations:{resolveUser:async()=>({githubId:'501',login:'new-alice',name:'Alice',avatarUrl:'',type:'User'})}}),c=f.applicant;await f.oauth();await c.request('/api/session');const request=(await c.request('/api/registration/applications','POST',application)).data.application;
  const resolved=await f.admin.request('/api/admin/github-users/resolve?login=new-alice');assert.equal(resolved.data.profile.pendingApplicationId,request.id);
  const body={githubLogin:'new-alice',expectedGithubId:'501',displayName:'管理员预录入',role:'member'};
  assert.equal((await f.admin.request('/api/admin/members','POST',body)).status,409);
  const entered=await f.admin.request('/api/admin/members','POST',{...body,approvePendingRequest:true});assert.equal(entered.status,201);
  assert.equal((await c.request('/api/registration/status')).data.application.status,'approved');assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM members WHERE github_user_id='501'").get().n,1);
});

test('registration toggle stops new submissions but does not block approved members or own status',async t=>{
  const f=await setup(t),c=f.applicant;await f.oauth();await c.request('/api/session');
  const policy=getAccessPolicy(f.db);assert.equal((await f.admin.request('/api/admin/access-policy','PUT',{...policy,registrationEnabled:false})).status,200);
  assert.equal((await c.request('/api/registration/status')).data.canApply,false);assert.equal((await c.request('/api/registration/applications','POST',application)).status,403);
  assert.equal((await f.admin.request('/api/dashboard')).status,200);assert.equal((await f.client(null).request('/api/session')).data.features.registrationEnabled,false);
});

test('restricted logout/expiry are bounded and do not leave live access or create anonymous member sessions',async t=>{
  const f=await setup(t),c=f.applicant;await f.oauth();await c.request('/api/session');
  assert.equal((await c.request('/auth/logout','POST',{})).status,200);assert.equal((await c.request('/api/session')).data.mode,'guest');assert.equal((await c.request('/api/registration/status')).status,401);
  await f.oauth();await c.request('/api/session');f.db.prepare('UPDATE registration_sessions SET expires_at=?').run(Date.now()-1);
  assert.equal((await c.request('/api/session')).data.mode,'guest');assert.equal((await c.request('/api/dashboard')).status,401);
});
