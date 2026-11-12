import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, addAudit, getSetting, listItems, seedDemo, serializeUser } from '../server/db.js';
import { createMember, getMemberView, listMemberViews, updateMember, setMemberStatus, provisionAdmin, resolveGitHubUser } from '../server/members.js';

const profile = (id = '12345', login = 'alice') => ({ githubId: id, login, name: 'Alice', avatarUrl: 'https://avatars.githubusercontent.com/u/12345', type: 'User' });
function database(t) { const db = openDatabase(':memory:'); t.after(() => db.close()); return db; }
function activate(db, id) { db.prepare("UPDATE members SET status='active',first_login_at=?,last_login_at=? WHERE id=?").run('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', id); }
function user(db, member, id = member.githubId) { db.prepare('INSERT INTO users(id,login,name,member_id) VALUES (?,?,?,?)').run(id, member.login, 'Profile name', member.id); }
const status = expected => error => error.status === expected;

test('member CRUD keys on fixed identity, not mutable or reused login; strict versions and private notes', t => {
  const db = database(t);
  const alice = createMember(db, { profile: profile(), displayName: 'Team Alice', module: 'core', notes: 'Admin only' });
  assert.equal(alice.status, 'pending_activation'); assert.equal(alice.version, 1);
  assert.equal(alice.reachable, false); assert.equal(alice.githubId, '12345');
  assert.throws(() => createMember(db, { profile: profile('12345', 'renamed') }), status(409));
  const reused = createMember(db, { profile: profile('67890', 'alice') });
  assert.notEqual(reused.id, alice.id);
  const updated = updateMember(db, alice.id, { version: 1, displayName: 'Edited', module: 'new module', notes: 'Kept' });
  assert.equal(updated.version, 2); assert.equal(updated.displayName, 'Edited');
  assert.throws(() => updateMember(db, alice.id, { version: 1, role: 'admin' }), status(409));
  assert.throws(() => updateMember(db, alice.id, { displayName: 'x' }), status(400));
  assert.throws(() => updateMember(db, alice.id, { version: 2, githubId: '7' }), status(400));
  assert.throws(() => updateMember(db, alice.id, { version: 2, notes: null }), status(400));
  assert.throws(() => updateMember(db, 'absent', { version: 1 }), status(404));
  assert.equal(getMemberView(db, 'absent'), null);
  assert.ok(!Object.hasOwn(getMemberView(db, alice.id, { includeNotes: false }), 'notes'));
  assert.equal(listMemberViews(db).length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n, 3);
});

test('last activated administrator protected transactionally; pending admin is not a fallback', t => {
  const db = database(t);
  const admin = provisionAdmin(db, { profile: profile() }); activate(db, admin.id);
  const pending = createMember(db, { profile: profile('2', 'bob'), role: 'admin' });
  assert.throws(() => updateMember(db, admin.id, { version: 1, role: 'member' }), error => error.code === 'LAST_ADMIN');
  assert.throws(() => setMemberStatus(db, admin.id, { version: 1, enabled: false }), error => error.code === 'LAST_ADMIN');
  assert.equal(getMemberView(db, admin.id).version, 1);
  activate(db, pending.id);
  const demoted = updateMember(db, admin.id, { version: 1, role: 'member' });
  assert.equal(demoted.role, 'member');
  assert.throws(() => setMemberStatus(db, pending.id, { version: 1, enabled: false }), error => error.code === 'LAST_ADMIN');
});

test('disable revokes sessions/states, cancels queue, invalidates binding, preserves history and owner', t => {
  const db = database(t);
  const target = createMember(db, { profile: profile() }); activate(db, target.id); user(db, target);
  const other = createMember(db, { profile: profile('2', 'bob') }); user(db, other);
  for (const [token, member] of [['one', target], ['two', other]]) {
    db.prepare('INSERT INTO sessions(token_hash,user_id,member_id,csrf,expires_at) VALUES (?,?,?,?,?)').run(token, member.githubId, member.id, 'csrf', Date.now() + 100000);
    db.prepare('INSERT INTO oauth_states(state_hash,provider,user_id,member_id,browser_hash,expires_at) VALUES (?,?,?,?,?,?)').run(token, 'feishu', null, member.id, 'browser', Date.now() + 100000);
  }
  db.prepare("INSERT INTO feishu_bindings(member_id,app_id,open_id,status,bound_at,verified_at) VALUES (?,'app','private-open-id','active','now','now')").run(target.id);
  for (const state of ['pending', 'sending', 'sent', 'failed']) db.prepare('INSERT INTO notifications(id,dedupe_key,recipient,recipient_member_id,title,reason,status,created_at) VALUES (?,?,?,?,?,?,?,?)').run(state, state, 'alice', target.id, 'Title', 'reason', state, 'now');
  db.prepare("INSERT INTO items(id,number,data,owner,owner_member_id) VALUES ('item',1,?,'alice',?)").run(JSON.stringify({ state: 'open', updatedAt: new Date().toISOString() }), target.id);
  assert.equal(getMemberView(db, target.id, { appId: 'app' }).reachable, true);
  const disabled = setMemberStatus(db, target.id, { version: 1, enabled: false }, { actorId: other.id, requestId: 'request' });
  assert.equal(disabled.status, 'disabled'); assert.equal(disabled.version, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oauth_states').get().n, 1);
  assert.equal(db.prepare("SELECT status FROM notifications WHERE id='pending'").get().status, 'cancelled');
  assert.equal(db.prepare("SELECT status FROM notifications WHERE id='sending'").get().status, 'cancelled');
  assert.equal(db.prepare("SELECT status FROM notifications WHERE id='sent'").get().status, 'sent');
  assert.equal(db.prepare("SELECT status FROM notifications WHERE id='failed'").get().status, 'failed');
  const binding = db.prepare('SELECT * FROM feishu_bindings').get();
  assert.equal(binding.binding_version, 2); assert.equal(binding.status, 'needs_confirmation'); assert.equal(binding.verified_at, null);
  assert.equal(listItems(db, Date.now(), 'app')[0].ownerIssue, 'disabled');
  const enabled = setMemberStatus(db, target.id, { version: 2, enabled: true });
  assert.equal(enabled.status, 'active'); assert.equal(getMemberView(db, target.id, { appId: 'app' }).feishuVerified, false);
  assert.equal(listItems(db, Date.now(), 'app')[0].ownerIssue, 'needs_confirmation');
  assert.equal(db.prepare('SELECT owner_member_id FROM items').get().owner_member_id, target.id);
  assert.ok(!JSON.stringify(getMemberView(db, target.id, { appId: 'app' })).includes('private-open-id'));
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_logs').all()).includes('private-open-id'));
  assert.throws(() => setMemberStatus(db, target.id, { version: 2, enabled: false }), status(409));
});

test('disable effects and audit rollback together on a database failure', t => {
  const db = database(t); const member = createMember(db, { profile: profile() }); user(db, member);
  db.prepare('INSERT INTO sessions(token_hash,user_id,member_id,csrf,expires_at) VALUES (?,?,?,?,?)').run('t', member.githubId, member.id, 'c', Date.now());
  db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(() => setMemberStatus(db, member.id, { version: 1, enabled: false }));
  assert.equal(getMemberView(db, member.id).status, 'pending_activation');
  assert.equal(getMemberView(db, member.id).version, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
});

test('pending enable does not activate and bootstrap is once-only with explicit audited recovery', t => {
  const db = database(t);
  const admin = provisionAdmin(db, { profile: profile() });
  assert.equal(admin.status, 'pending_activation'); assert.equal(getSetting(db, 'membershipInitialized'), true);
  assert.throws(() => provisionAdmin(db, { profile: profile('2', 'bob') }), status(409));
  const disabled = setMemberStatus(db, admin.id, { version: 1, enabled: false });
  assert.equal(setMemberStatus(db, admin.id, { version: disabled.version, enabled: true }).status, 'pending_activation');
  const recovered = provisionAdmin(db, { profile: profile(), recover: true });
  assert.equal(recovered.id, admin.id); assert.equal(recovered.role, 'admin'); assert.equal(recovered.version, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='member.recover_admin'").get().n, 1);
  assert.throws(() => createMember(db, { profile: { ...profile(), githubId: '9007199254740993' }, role: 'owner' }), status(400));
  const largeId = createMember(db, { profile: profile('9007199254740993', 'large-id') }); assert.equal(largeId.githubId, '9007199254740993');
});

test('member and item reachability uses application-scoped bindings and normalized identity only', t => {
  const db = database(t); const member = createMember(db, { profile: profile(), module: 'Core' }); activate(db, member.id); user(db, member);
  db.prepare("INSERT INTO items(id,number,data,owner_member_id) VALUES ('i',1,?,?)").run(JSON.stringify({ author: 'alice', assignees: ['alice'], reviewers: ['alice'], state: 'open', updatedAt: '2026-01-01' }), member.id);
  assert.equal(listItems(db)[0].ownerIssue, 'unbound');
  db.prepare("INSERT INTO feishu_bindings(member_id,app_id,open_id,status,bound_at,verified_at) VALUES (?,'app','private-id','active','now','now')").run(member.id);
  assert.equal(getMemberView(db, member.id, { appId: 'other' }).feishuBound, false);
  const item = listItems(db, Date.now(), 'app')[0];
  assert.equal(item.ownerReachable, true); assert.equal(item.owner, 'alice'); assert.equal(item.module, 'Core');
  assert.equal(item.authorId, null); assert.deepEqual(item.assigneeIds, []); assert.deepEqual(item.reviewerIds, []);
  db.prepare('UPDATE users SET notifications_enabled=0 WHERE member_id=?').run(member.id);
  assert.equal(listItems(db, Date.now(), 'app')[0].ownerIssue, 'notifications_disabled');
  db.prepare("UPDATE members SET github_login='renamed' WHERE id=?").run(member.id);
  assert.equal(listItems(db)[0].owner, 'renamed');
});

test('audit serializer recursively removes credential and complete identity keys', t => {
  const db = database(t);
  addAudit(db, { action: 'test', targetType: 'member', after: { safe: 'yes', open_id: 'secret', nested: [{ accessToken: 'secret', password: 'secret', feishuOpenId: 'secret', status: 'active' }], authorization: 'secret' } });
  const audit = db.prepare('SELECT after_json FROM audit_logs').get().after_json;
  assert.ok(!audit.includes('secret')); assert.deepEqual(JSON.parse(audit), { safe: 'yes', nested: [{ status: 'active' }] });
});

test('GitHub resolver GET validates input and canonical profile without exposing token or body', async () => {
  let calls = 0;
  const resolved = await resolveGitHubUser({ login: 'Alice', token: 'private-token', fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.github.com/users/Alice'); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.ok(options.signal); assert.equal(options.headers.Authorization, 'Bearer private-token');
    return { ok: true, status: 200, json: async () => ({ id: 12345, login: 'alice', name: 'Alice', avatar_url: 'avatar', type: 'User' }) };
  } });
  assert.equal(resolved.githubId, '12345'); assert.equal(resolved.type, 'User'); assert.equal(resolved.url, 'https://github.com/alice'); assert.equal(calls, 1);
  for (const login of ['', '../alice', 'alice?x', 'a--b', '-alice', 'a'.repeat(40), 'a\nb', 'alice\n', 'alice\r']) await assert.rejects(resolveGitHubUser({ login, fetchImpl: () => { throw new Error('must not fetch'); } }), status(400));
  for (const type of ['Organization', 'Bot']) await assert.rejects(resolveGitHubUser({ login: 'alice', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ id: 1, login: 'alice', type }) }) }), status(400));
  for (const [httpStatus, expected] of [[404, 404], [403, 503], [429, 503], [500, 502]]) await assert.rejects(resolveGitHubUser({ login: 'alice', fetchImpl: async () => ({ ok: false, status: httpStatus, json: () => { throw new Error('secret-response'); } }) }), error => error.status === expected && !error.message.includes('secret'));
  await assert.rejects(resolveGitHubUser({ login: 'alice', token: 'secret', fetchImpl: async () => { throw new Error('secret credentials'); } }), error => error.status === 502 && !error.message.includes('secret'));
  await assert.rejects(resolveGitHubUser({ login: 'alice', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ id: 9007199254740992, login: 'alice', type: 'User' }) }) }), status(502));
});

test('GitHub resolver enforces timeout even if a mocked provider ignores abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = resolveGitHubUser({ login: 'alice', fetchImpl: async () => new Promise(() => {}) });
  const check = assert.rejects(result, status(504));
  t.mock.timers.tick(10001);
  await check;
});

test('demo upgrade uses fixed fixture identities and does not overwrite local edits on reseed', t => {
  const db = database(t); seedDemo(db, 'AISBench/benchmark');
  assert.equal(listMemberViews(db).length, 4);
  assert.equal(getMemberView(db, 'demo-admin').githubId, '1001');
  assert.ok(getMemberView(db, 'demo-admin').firstLoginAt);
  assert.equal(db.prepare("SELECT member_id FROM users WHERE id='demo'").get().member_id, 'demo-admin');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feishu_bindings').get().n, 0);
  assert.equal(getSetting(db, 'membershipInitialized'), true);
  db.prepare("UPDATE items SET workflow='blocked',priority='high',due_at='2030-01-01',owner_member_id=NULL,owner=NULL WHERE id='github:9001'").run();
  updateMember(db, 'demo-reviewer', { version: 1, displayName: 'Local edit' });
  seedDemo(db, 'AISBench/benchmark');
  const row = db.prepare("SELECT * FROM items WHERE id='github:9001'").get();
  assert.equal(row.workflow, 'blocked'); assert.equal(row.priority, 'high'); assert.equal(row.due_at, '2030-01-01'); assert.equal(row.owner_member_id, null);
  assert.equal(getMemberView(db, 'demo-reviewer').displayName, 'Local edit');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 8);
  assert.equal(listItems(db).find(item => item.number === 9000).authorId, '1001');
});

test('compatibility serializer never treats environment/demo flags or legacy binding as authority', () => {
  const serialized = serializeUser({ id: '11', login: 'alice', feishu_open_id: 'private-id', notifications_enabled: 1 }, { demo: true, admins: ['alice'] });
  assert.equal(serialized.isAdmin, false); assert.equal(serialized.feishuBound, false); assert.equal(serialized.feishuVerified, false);
  assert.ok(!JSON.stringify(serialized).includes('private-id'));
  assert.equal(serializeUser({ id: '11', login: 'alice', role: 'admin', status: 'disabled' }).isAdmin, false);
});

test('resolver never propagates spoofed upstream public error codes or messages', async () => {
  await assert.rejects(resolveGitHubUser({ login: 'alice', fetchImpl: async () => { throw Object.assign(new Error('secret-token private-open-id'), { code: 'GITHUB_FAKE', status: 400 }); } }), error => error.status === 502 && !error.message.includes('secret-token') && !error.message.includes('private-open-id'));
});

test('disabled recovery never trusts stale sessions or a corrupt active binding', t => {
  const db = database(t); const member = createMember(db, { profile: profile() }); activate(db, member.id); user(db, member);
  db.prepare("UPDATE members SET status='disabled' WHERE id=?").run(member.id);
  db.prepare("INSERT INTO feishu_bindings(member_id,app_id,open_id,status,bound_at,verified_at) VALUES (?,'app','private-id','active','now','now')").run(member.id);
  db.prepare('INSERT INTO sessions(token_hash,user_id,member_id,csrf,expires_at) VALUES (?,?,?,?,?)').run('stale', member.githubId, member.id, 'c', Date.now() + 10000);
  const recovered = provisionAdmin(db, { profile: profile(), recover: true });
  assert.equal(recovered.status, 'active'); assert.equal(recovered.role, 'admin');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(db.prepare('SELECT binding_version FROM feishu_bindings').get().binding_version, 2);
  assert.equal(getMemberView(db, member.id, { appId: 'app' }).feishuVerified, false);
});

test('corrupt active admin without first-login timestamp cannot bypass last-admin protection', t => {
  const db = database(t); const admin = provisionAdmin(db, { profile: profile() });
  db.prepare("UPDATE members SET status='active',first_login_at=NULL WHERE id=?").run(admin.id);
  assert.throws(() => setMemberStatus(db, admin.id, { version: 1, enabled: false }), error => error.code === 'LAST_ADMIN');
  assert.throws(() => updateMember(db, admin.id, { version: 1, role: 'member' }), error => error.code === 'LAST_ADMIN');
  assert.throws(() => createMember(db, { profile: profile('11\n') }), status(400));
});
