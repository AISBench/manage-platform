import test from 'node:test';
import assert from 'node:assert/strict';
import { githubAvatar, setMemberStatus } from '../server/members.js';
import { httpFixture } from './helpers.js';

const profile = (overrides = {}) => ({ id: 501, login: 'new-alice', name: 'Alice', type: 'User', avatar_url: 'https://avatars.githubusercontent.com/u/501?v=4', ...overrides });

async function setup(t, initial = profile()) {
  let current = initial;
  const fetchImpl = async url => new Response(JSON.stringify(String(url).includes('access_token') ? { access_token: 'never-persist-token' } : current), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const f = await httpFixture(t, { fetchImpl });
  const anonymous = f.client(null);
  async function oauth() {
    const start = await anonymous.request('/auth/github');
    const state = new URL(start.response.headers.get('location')).searchParams.get('state');
    return anonymous.request(`/auth/github/callback?state=${state}&code=test-code`);
  }
  return { ...f, anonymous, oauth, setProfile: value => { current = value; } };
}

test('GitHub avatar always comes from GitHub with a stable numeric fallback', () => {
  assert.equal(githubAvatar({ githubId: '501', login: 'alice', avatarUrl: 'https://avatars.githubusercontent.com/u/501?v=4', type: 'User' }), 'https://avatars.githubusercontent.com/u/501?v=4');
  assert.equal(githubAvatar({ githubId: '501', login: 'alice', type: 'User' }), 'https://avatars.githubusercontent.com/u/501?v=4');
  assert.equal(githubAvatar({ githubId: '501', login: 'alice', avatarUrl: 'https://evil.example/avatar.png', type: 'User' }), 'https://avatars.githubusercontent.com/u/501?v=4');
});

test('first GitHub login creates an active member and reuses it on later logins', async t => {
  const f = await setup(t);
  const callback = await f.oauth();
  assert.equal(callback.status, 302);
  assert.equal(callback.response.headers.get('location'), '/workspace?auth=success');

  const active = await f.anonymous.request('/api/session');
  assert.equal(active.data.mode, 'member');
  assert.equal(active.data.user.githubId, '501');
  assert.equal(active.data.user.role, 'member');
  assert.equal(active.data.user.status, 'active');
  assert.equal(active.data.user.avatarUrl, 'https://avatars.githubusercontent.com/u/501?v=4');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM members WHERE github_user_id='501'").get().n, 1);
  const member = f.db.prepare("SELECT * FROM members WHERE github_user_id='501'").get();
  assert.equal(member.status, 'active');
  assert.equal(member.role, 'member');
  assert.ok(member.first_login_at);

  const listing = await f.client('demo-admin').request('/api/members');
  assert.equal(listing.data.members.find(entry => entry.githubId === '501').avatarUrl, 'https://avatars.githubusercontent.com/u/501?v=4');

  f.setProfile(profile({ login: 'renamed-alice', name: 'Renamed', avatar_url: 'https://avatars.githubusercontent.com/u/501?v=9' }));
  assert.equal((await f.oauth()).status, 302);
  const second = await f.anonymous.request('/api/session');
  assert.equal(second.data.user.memberId, member.id);
  assert.equal(second.data.user.login, 'renamed-alice');
  assert.equal(second.data.user.avatarUrl, 'https://avatars.githubusercontent.com/u/501?v=9');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM members WHERE github_user_id='501'").get().n, 1);
});

test('avatar falls back to the numeric GitHub URL when the profile omits one', async t => {
  const f = await setup(t, profile({ id: 600, login: 'no-avatar', avatar_url: '' }));
  await f.oauth();
  const member = f.db.prepare("SELECT * FROM members WHERE github_user_id='600'").get();
  assert.equal(member.avatar_url, 'https://avatars.githubusercontent.com/u/600?v=4');
  const session = await f.anonymous.request('/api/session');
  assert.equal(session.data.user.avatarUrl, 'https://avatars.githubusercontent.com/u/600?v=4');
});

test('disabled members cannot log back in and are not re-created', async t => {
  const f = await setup(t);
  await f.oauth();
  const member = f.db.prepare("SELECT * FROM members WHERE github_user_id='501'").get();
  setMemberStatus(f.db, member.id, { version: member.version, enabled: false });
  const denied = await f.oauth();
  assert.equal(denied.status, 403);
  assert.equal(f.db.prepare("SELECT status FROM members WHERE id=?").get(member.id).status, 'disabled');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM members WHERE github_user_id='501'").get().n, 1);
});
