import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase, seedDemo, getSetting, setSetting } from '../server/db.js';
import { createMember, getMemberView, updateMember } from '../server/members.js';
import { createPublicService } from '../server/public-service.js';
import { verifiedIdentity, createRegistrationSession, readRegistrationSession, getRegistrationStatus, submitApplication, listJoinRequests, reviewApplication, getAccessPolicy, updateAccessPolicy } from '../server/registration.js';

const profile = (githubId = '3001', login = 'applicant') => ({ githubId, login, name: 'Applicant', avatarUrl: 'https://avatars.githubusercontent.com/u/3001', type: 'User' });
const input = { displayName: 'Applicant name', module: 'bench', reason: 'I would like to contribute tests.', consent: true };
const status = expected => error => error.status === expected;
function database(t) { const db = openDatabase(':memory:'); t.after(() => db.close()); return db; }
function admin(db) { seedDemo(db, 'AISBench/benchmark'); return 'demo-admin'; }
function identity(db, id = '3001', login = 'applicant') { return verifiedIdentity(db, profile(id, login)); }
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const review = (db, id, actorId, decision = 'approved', extra = {}) => reviewApplication(db, id, { version: 1, decision, ...extra }, { actorId, requestId: 'review-request' });
function policy(db, actorId, changes) { return updateAccessPolicy(db, { ...getAccessPolicy(db), ...changes }, { actorId }); }

// No server, OAuth, GitHub, Feishu, or external sends are used by these core tests.
test('schema3 is additive, indexed, persistent and preserves v2 rows and edited demo policy/roles', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'triage-registration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'upgrade.sqlite');
  let db = openDatabase(filename);
  seedDemo(db, 'AISBench/benchmark');
  db.prepare("UPDATE members SET display_name='Edited',role='member' WHERE id='demo-admin'").run();
  setSetting(db, 'accessPolicy', { ...getAccessPolicy(db), registrationEnabled: false, version: 7 });
  const original = JSON.stringify(db.prepare('SELECT * FROM members ORDER BY id').all());
  const oldItem = db.prepare('SELECT * FROM items ORDER BY id LIMIT 1').get();
  // Reconstruct a real v2 database by removing only the additive v3 structures.
  db.exec('DROP TABLE registration_sessions; DROP TABLE join_requests; DROP TABLE registration_identities; DROP TABLE public_items; DROP TABLE public_snapshots; DELETE FROM schema_migrations WHERE version=3');
  db.close(); db = openDatabase(filename);
  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version), [1, 2, 3]);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM members ORDER BY id').all()), original);
  assert.deepEqual(db.prepare('SELECT * FROM items WHERE id=?').get(oldItem.id), oldItem);
  assert.equal(getAccessPolicy(db).version, 7); assert.equal(getAccessPolicy(db).registrationEnabled, false);
  seedDemo(db, 'AISBench/benchmark');
  assert.equal(getMemberView(db, 'demo-admin').role, 'member');
  assert.equal(getAccessPolicy(db).registrationEnabled, false); assert.equal(getAccessPolicy(db).publicOverviewEnabled, false);
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='join_requests_one_pending'").get().sql.includes("WHERE status='pending'"), true);
  assert.throws(() => db.prepare('INSERT INTO public_snapshots(id) VALUES (2)').run());
  db.close(); db = openDatabase(filename); assert.equal(count(db, 'schema_migrations'), 3); db.close();
});

test('verified identity updates display snapshots only; renamed/reused usernames cannot inherit identity', t => {
  const db = database(t), first = identity(db);
  assert.equal(count(db, 'members'), 0); assert.equal(count(db, 'join_requests'), 0);
  const renamed = identity(db, '3001', 'renamed');
  assert.equal(renamed.id, first.id); assert.equal(renamed.github_user_id, '3001'); assert.equal(renamed.github_login, 'renamed');
  const reused = identity(db, '3002', 'applicant'); assert.notEqual(reused.id, first.id);
  for (const bad of [{ ...profile(), type: 'Organization' }, { ...profile(), bot: true }, { ...profile(), githubId: 0 }, { ...profile(), githubId: 9007199254740992 }, { ...profile(), githubId: ' 123' }, { ...profile(), login: 'bad--name' }]) assert.throws(() => verifiedIdentity(db, bad), status(400));
  assert.equal(identity(db, '9007199254740993', 'large-id').github_user_id, '9007199254740993');
});

test('restricted sessions use hash-only random cookies and absolute expiry, never member privileges', t => {
  const db = database(t), person = identity(db); let cookie;
  const session = createRegistrationSession(db, { cookie: (...args) => { cookie = args; } }, person.id, { secure: true });
  assert.equal(cookie[0], 'triage_registration'); assert.match(cookie[1], /^[a-f0-9]{64}$/);
  assert.deepEqual(cookie[2], { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 1800000 });
  assert.equal(session.token_hash, createHash('sha256').update(cookie[1]).digest('hex')); assert.notEqual(session.token_hash, cookie[1]);
  assert.deepEqual(Object.keys(session).sort(), ['csrf', 'expires_at', 'identity_id', 'token_hash']);
  assert.equal(readRegistrationSession(db, cookie[1]).identity.id, person.id);
  const expiry = readRegistrationSession(db, cookie[1]).session.expires_at;
  assert.equal(expiry, session.expires_at); assert.equal(count(db, 'sessions'), 0); assert.equal(count(db, 'users'), 0);
  for (const invalid of ['', null, [], 'not-a-token', session.token_hash]) assert.equal(readRegistrationSession(db, invalid), null);
  db.prepare('UPDATE registration_sessions SET expires_at=?').run(Date.now() - 1);
  assert.equal(readRegistrationSession(db, cookie[1]), null);
});

test('submission is explicit, strict, identity-derived, and one pending per identity', t => {
  const db = database(t), person = identity(db);
  assert.equal(getRegistrationStatus(db, person.id).application, null); assert.equal(getRegistrationStatus(db, person.id).canApply, true);
  for (const change of [{ consent: false }, { consent: 'true' }, { consent: undefined }, { reason: 'short' }, { reason: 'x'.repeat(2001) }, { reason: '          ' }, { displayName: null }, { module: 'x'.repeat(121) }, { githubId: '55' }, { role: 'admin' }, { scope: 'member' }]) assert.throws(() => submitApplication(db, person.id, { ...input, ...change }), status(400));
  assert.equal(count(db, 'join_requests'), 0);
  const application = submitApplication(db, person.id, input, { requestId: 'submit-request' });
  assert.equal(application.status, 'pending'); assert.equal(application.round, 1); assert.equal(application.version, 1);
  assert.equal(count(db, 'members'), 0); assert.equal(count(db, 'users'), 0); assert.equal(getRegistrationStatus(db, person.id).canApply, false);
  assert.throws(() => submitApplication(db, person.id, input), status(409));
  assert.throws(() => db.prepare("INSERT INTO join_requests(id,identity_id,status,round) VALUES ('other',?,'pending',2)").run(person.id));
  assert.equal(count(db, 'join_requests'), 1);
  assert.equal(db.prepare("SELECT request_id FROM audit_logs WHERE action='registration.submit'").get().request_id, 'submit-request');
});

test('review atomically grants ordinary pending member and old restricted sessions stay restricted', t => {
  const db = database(t), actorId = admin(db), person = identity(db); let cookie;
  const session = createRegistrationSession(db, { cookie: (name, value) => { cookie = value; } }, person.id, { secure: false });
  const application = submitApplication(db, person.id, input);
  identity(db, '3001', 'renamed-applicant');
  const reusedLogin = identity(db, '3002', 'applicant');
  const approved = review(db, application.id, actorId, 'approved', { internalNote: 'Only administrators see this', publicFeedback: 'Welcome!' });
  assert.equal(approved.status, 'approved'); assert.equal(approved.version, 2); assert.equal(approved.reviewer, actorId);
  const member = getMemberView(db, approved.memberId);
  assert.equal(member.role, 'member'); assert.equal(member.status, 'pending_activation'); assert.equal(member.githubId, person.github_user_id);
  assert.equal(member.displayName, input.displayName); assert.equal(member.module, input.module); assert.equal(member.login, 'renamed-applicant');
  assert.equal(getRegistrationStatus(db, reusedLogin.id).application, null); assert.equal(getRegistrationStatus(db, reusedLogin.id).canLogin, false);
  const restricted = readRegistrationSession(db, cookie); assert.equal(restricted.session.csrf, session.csrf); assert.equal(count(db, 'sessions'), 0);
  const own = getRegistrationStatus(db, person.id); assert.equal(own.canLogin, true); assert.equal(own.canApply, false); assert.equal(own.memberStatus, 'pending_activation');
  for (const secret of ['internalNote', 'reviewer', 'memberId', 'identityId', 'Only administrators']) assert.ok(!JSON.stringify(own).includes(secret));
  const total = count(db, 'members'), audits = count(db, 'audit_logs');
  assert.throws(() => review(db, application.id, actorId), status(409));
  assert.throws(() => review(db, application.id, actorId, 'rejected', { publicFeedback: 'No' }), status(409));
  assert.equal(count(db, 'members'), total); assert.equal(count(db, 'audit_logs'), audits);
});

test('fresh actor role/status checked inside review transaction, optimistic versions reject stale reviews', t => {
  const db = database(t), actorId = admin(db), person = identity(db), application = submitApplication(db, person.id, input);
  let transactionalActorReads = 0;
  const prepare = db.prepare.bind(db);
  t.mock.method(db, 'prepare', sql => {
    if (sql === 'SELECT * FROM members WHERE id=?') { assert.equal(db.isTransaction, true); transactionalActorReads++; }
    return prepare(sql);
  });
  for (const [role, memberStatus] of [['member', 'active'], ['admin', 'disabled'], ['admin', 'pending_activation']]) {
    db.prepare('UPDATE members SET role=?,status=? WHERE id=?').run(role, memberStatus, actorId);
    assert.throws(() => review(db, application.id, actorId), status(403));
    assert.equal(getRegistrationStatus(db, person.id).application.status, 'pending');
  }
  db.prepare("UPDATE members SET role='admin',status='active' WHERE id=?").run(actorId);
  for (const v of [0, '1', 1.5]) assert.throws(() => reviewApplication(db, application.id, { version: v, decision: 'approved' }, { actorId }), status(400));
  assert.throws(() => reviewApplication(db, application.id, { version: 2, decision: 'approved' }, { actorId }), status(409));
  assert.equal(count(db, 'members'), 4); assert.equal(count(db, 'join_requests'), 1);
  review(db, application.id, actorId); assert.equal(count(db, 'members'), 5);
  assert.ok(transactionalActorReads >= 5);
});

test('rejection exposes public feedback only, preserves history and enforces exact cooldown', t => {
  const db = database(t), actorId = admin(db), person = identity(db), application = submitApplication(db, person.id, input);
  for (const publicFeedback of ['', ' ', null, 'x'.repeat(501)]) assert.throws(() => review(db, application.id, actorId, 'rejected', { publicFeedback }), status(400));
  assert.throws(() => review(db, application.id, actorId, 'rejected', { publicFeedback: 'No', internalNote: 'x'.repeat(2001) }), status(400));
  const rejected = review(db, application.id, actorId, 'rejected', { publicFeedback: 'Please explain your intended contribution.', internalNote: 'Private assessment' });
  assert.equal(count(db, 'members'), 4);
  const own = getRegistrationStatus(db, person.id); assert.equal(own.application.publicFeedback, rejected.publicFeedback); assert.equal(own.canApply, false);
  assert.ok(!JSON.stringify(own).includes('Private assessment'));
  const due = Date.parse(own.reapplyAt);
  assert.equal(due, Date.parse(rejected.reviewedAt) + 86400000);
  assert.throws(() => submitApplication(db, person.id, input, { now: due - 1 }), status(429));
  assert.equal(getRegistrationStatus(db, person.id, due).canApply, true);
  const next = submitApplication(db, person.id, input, { now: due }); assert.equal(next.round, 2); assert.notEqual(next.id, rejected.id);
  assert.equal(count(db, 'join_requests'), 2); assert.equal(db.prepare('SELECT status FROM join_requests WHERE id=?').get(rejected.id).status, 'rejected');
});

test('existing membership prevents submissions, approval preserves existing role/status, disabled cannot bypass', t => {
  const db = database(t), actorId = admin(db), person = identity(db);
  const application = submitApplication(db, person.id, input);
  // Simulate independent provisioning after submission (not manual createMember, which requires confirmation).
  db.prepare("INSERT INTO members(id,github_user_id,github_login,role,status,created_at,updated_at) VALUES ('existing','3001','renamed','admin','active','now','now')").run();
  const approved = review(db, application.id, actorId); assert.equal(approved.memberId, 'existing');
  assert.equal(getMemberView(db, 'existing').role, 'admin'); assert.equal(getMemberView(db, 'existing').status, 'active'); assert.equal(getMemberView(db, 'existing').login, 'renamed');
  assert.throws(() => submitApplication(db, person.id, input), status(409));
  const disabledIdentity = identity(db, '3002', 'disabled-applicant'), pending = submitApplication(db, disabledIdentity.id, input);
  db.prepare("INSERT INTO members(id,github_user_id,github_login,status,created_at,updated_at) VALUES ('disabled-member','3002','disabled-applicant','disabled','now','now')").run();
  assert.throws(() => review(db, pending.id, actorId), status(409)); assert.throws(() => submitApplication(db, disabledIdentity.id, input), status(403));
  const own = getRegistrationStatus(db, disabledIdentity.id); assert.equal(own.blocked, true); assert.equal(own.canLogin, false); assert.equal(own.canApply, false);
  assert.equal(own.application.status, 'pending'); assert.equal(getMemberView(db, 'disabled-member').status, 'disabled');
});

test('approval/member/audit and submission/audit fail atomically', t => {
  const db = database(t), actorId = admin(db), person = identity(db), application = submitApplication(db, person.id, input);
  db.exec("CREATE TRIGGER fail_review_audit BEFORE INSERT ON audit_logs WHEN NEW.action='registration.approve' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  const audits = count(db, 'audit_logs');
  assert.throws(() => review(db, application.id, actorId));
  assert.equal(count(db, 'members'), 4); assert.equal(count(db, 'audit_logs'), audits); assert.equal(getRegistrationStatus(db, person.id).application.status, 'pending');
  db.exec("CREATE TRIGGER fail_submit_audit BEFORE INSERT ON audit_logs WHEN NEW.action='registration.submit' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  const other = identity(db, '3002', 'other'); assert.throws(() => submitApplication(db, other.id, input));
  assert.equal(getRegistrationStatus(db, other.id).application, null); assert.equal(count(db, 'join_requests'), 1);
});

test('manual member creation requires explicit pending approval and is atomic without nested transactions', t => {
  const db = database(t), actorId = admin(db), person = identity(db), application = submitApplication(db, person.id, input);
  assert.throws(() => createMember(db, { profile: profile(), actorId }), error => error.status === 409 && error.code === 'PENDING_APPLICATION');
  assert.throws(() => createMember(db, { profile: profile(), approvePendingRequest: true }), status(403));
  assert.throws(() => createMember(db, { profile: profile(), actorId, approvePendingRequest: 'true' }), status(400));
  db.exec("CREATE TRIGGER fail_manual_approve BEFORE INSERT ON audit_logs WHEN NEW.action='registration.approve' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(() => createMember(db, { profile: profile(), actorId, approvePendingRequest: true }));
  assert.equal(count(db, 'members'), 4); assert.equal(getRegistrationStatus(db, person.id).application.status, 'pending');
  db.exec('DROP TRIGGER fail_manual_approve');
  const member = createMember(db, { profile: profile(), actorId, approvePendingRequest: true });
  const request = listJoinRequests(db).requests.find(r => r.id === application.id);
  assert.equal(request.status, 'approved'); assert.equal(request.memberId, member.id); assert.equal(request.reviewer, actorId); assert.equal(request.version, 2);
  assert.throws(() => createMember(db, { profile: profile(), actorId, approvePendingRequest: true }), status(409));
  assert.throws(() => updateMember(db, member.id, { version: 1, githubId: '3002' }), status(400));
});

test('queue capacity/registration switch are independent; policy versions, ranges, privilege and audits are atomic', t => {
  const db = database(t), actorId = admin(db), person = identity(db), other = identity(db, '3002', 'other');
  const original = getAccessPolicy(db); assert.equal(original.publicOverviewEnabled, false);
  policy(db, actorId, { maxPendingRequests: 1 }); submitApplication(db, person.id, input);
  assert.equal(getRegistrationStatus(db, other.id).canApply, false);
  assert.throws(() => submitApplication(db, other.id, input), error => error.status === 429 && error.code === 'QUEUE_FULL');
  policy(db, actorId, { registrationEnabled: false, maxPendingRequests: 2 });
  assert.throws(() => submitApplication(db, other.id, input), status(403));
  assert.equal(getAccessPolicy(db).publicOverviewEnabled, false); assert.equal(getRegistrationStatus(db, person.id).application.status, 'pending');
  for (const changes of [{ reapplyCooldownHours: 0 }, { reapplyCooldownHours: 721 }, { maxPendingRequests: 0 }, { maxPendingRequests: 10001 }, { registrationEnabled: 1 }, { publicOverviewEnabled: 'true' }, { unknown: true }]) assert.throws(() => policy(db, actorId, changes), status(400));
  assert.throws(() => updateAccessPolicy(db, original, { actorId }), status(409));
  assert.throws(() => policy(db, 'demo-reviewer', {}), status(403));
  const before = getAccessPolicy(db);
  db.exec("CREATE TRIGGER fail_policy_audit BEFORE INSERT ON audit_logs WHEN NEW.action='access_policy.update' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(() => policy(db, actorId, { registrationEnabled: true })); assert.deepEqual(getAccessPolicy(db), before);
  assert.equal(getSetting(db, 'accessPolicy').version, before.version);
});

test('admin lists filter and paginate deterministically; identity-isolated public status has no internal fields', t => {
  const db = database(t), actorId = admin(db), first = identity(db), other = identity(db, '3002', 'second-user');
  const a = submitApplication(db, first.id, input), b = submitApplication(db, other.id, { ...input, displayName: 'Second' });
  review(db, a.id, actorId, 'rejected', { publicFeedback: 'Public reason', internalNote: 'Internal private' });
  const list = listJoinRequests(db, { status: 'pending', pageSize: 1 });
  assert.equal(list.total, 1); assert.equal(list.pendingCount, 1); assert.equal(list.requests[0].id, b.id); assert.equal(list.requests[0].githubId, '3002');
  assert.equal(listJoinRequests(db, { q: 'Second' }).total, 1); assert.equal(listJoinRequests(db, { q: '3001' }).total, 1);
  assert.equal(listJoinRequests(db, { q: '%' }).total, 0); assert.equal(listJoinRequests(db, { page: 2, pageSize: 1 }).requests.length, 1);
  for (const filter of [{ status: 'disabled' }, { page: 0 }, { pageSize: 101 }, { q: null }]) assert.throws(() => listJoinRequests(db, filter), status(400));
  const own = getRegistrationStatus(db, other.id); assert.equal(own.application.id, b.id);
  assert.ok(!JSON.stringify(own).includes('Internal private')); assert.ok(!JSON.stringify(own).includes(a.id));
  assert.equal(listJoinRequests(db, { status: 'rejected' }).requests[0].internalNote, 'Internal private');
});

test('post-fetch public verification cannot reuse metadata started before the item snapshot completed', async t => {
  const db = database(t);
  setSetting(db, 'accessPolicy', { ...getAccessPolicy(db), publicOverviewEnabled: true });
  const publicMetadata = { id: 99, full_name: 'AISBench/benchmark', private: false, visibility: 'public' };
  let calls = 0, releaseOlderCheck;
  const portal = createPublicService(db, { demo: false, repo: 'AISBench/benchmark' }, {
    fetchMetadata: async () => {
      calls++;
      if (calls === 1) return publicMetadata;
      if (calls === 2) return new Promise(resolve => { releaseOlderCheck = resolve; });
      return { ...publicMetadata, private: true, visibility: 'private' };
    },
    fetchImpl: async () => { throw new Error('External requests are forbidden in this test'); },
  });
  const ticket = await portal.beginProjection();
  // A periodic metadata request starts while item fetching is in progress.
  // Its public result was sampled before the repository became private.
  const olderCheck = portal.checkVisibility({ force: true });
  const finished = portal.finishProjection(ticket, [{ number: 1, kind: 'issue', state: 'open', title: 'Private-era item' }]);
  releaseOlderCheck(publicMetadata);
  await olderCheck;
  assert.equal(await finished, null, 'finish must request post-snapshot metadata, not reuse a pre-snapshot check');
  assert.ok(calls >= 3);
  assert.equal(portal.overview().available, false);
  assert.equal(count(db, 'public_items'), 0);
});

test('public epoch revocation rejects in-flight and already-prepared projections without external requests', async t => {
  const db = database(t);
  setSetting(db, 'accessPolicy', { ...getAccessPolicy(db), publicOverviewEnabled: true });
  const metadata = { id: 99, full_name: 'AISBench/benchmark', private: false, visibility: 'public' };
  let hold = false, release;
  const portal = createPublicService(db, { demo: false, repo: 'AISBench/benchmark' }, {
    fetchMetadata: async () => hold ? new Promise(resolve => { release = resolve; }) : metadata,
    fetchImpl: async () => { throw new Error('External requests are forbidden in this test'); },
  });
  const item = { number: 1, kind: 'issue', state: 'open', title: 'Public title', ownerMemberId: 'must-not-leak', body: 'private body' };
  const firstTicket = await portal.beginProjection();
  const first = await portal.finishProjection(firstTicket, [item]);
  db.exec('BEGIN IMMEDIATE'); portal.commitProjection(first); db.exec('COMMIT');
  assert.equal(portal.overview().available, true);
  assert.ok(!JSON.stringify(portal.list()).includes('must-not-leak'));
  assert.ok(!JSON.stringify(portal.list()).includes('private body'));
  portal.revoke('private');
  assert.equal(portal.overview().available, false); assert.equal(count(db, 'public_items'), 0);
  assert.equal(portal.commitProjection(first), false);
  const ticket = await portal.beginProjection();
  hold = true;
  const finishing = portal.finishProjection(ticket, [item]);
  policy(db, admin(db), { publicOverviewEnabled: false });
  portal.revoke('disabled');
  release(metadata);
  assert.equal(await finishing, null);
  assert.equal(portal.overview().reason, 'disabled');
  assert.equal(portal.list().items.length, 0); assert.equal(count(db, 'public_items'), 0);
});
