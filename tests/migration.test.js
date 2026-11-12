import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, existsSync, statSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, getSetting, seedDemo, setSetting } from '../server/db.js';
import { getMemberView, migrateLegacyMembers, updateMember } from '../server/members.js';
import { backupDatabase, runCli } from '../server/cli.js';

function directory(t) { const directory = mkdtempSync(path.join(os.tmpdir(), 'triage-migration-')); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; }
function database(t) { const db = openDatabase(':memory:'); t.after(() => db.close()); return db; }
const profiles = { alice: { githubId: '11', login: 'Alice', type: 'User' }, bob: { githubId: '22', login: 'bob', type: 'User' }, carol: { githubId: '33', login: 'carol', type: 'User' } };
const options = { admins: ['alice'], allowed: ['bob', 'carol'], appId: 'app', resolveUser: async login => profiles[login] };
function populate(db) {
  db.prepare('INSERT INTO users(id,login,name,feishu_open_id,quiet_start,quiet_end) VALUES (?,?,?,?,?,?)').run('11', 'alice', 'Local Alice', 'alice-private-open-id', '23:00', '07:00');
  db.prepare('INSERT INTO users(id,login,name,notifications_enabled) VALUES (?,?,?,?)').run('22', 'bob', 'Local Bob', 0);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES (?,?,?,?)').run('old', '11', 'c', Date.now() + 100000);
  db.prepare('INSERT INTO oauth_states(state_hash,provider,user_id,browser_hash,expires_at) VALUES (?,?,?,?,?)').run('state', 'feishu', '11', 'browser', Date.now() + 100000);
  for (const [index, owner] of ['Alice', 'bob', 'stranger', ' alice '].entries()) db.prepare('INSERT INTO items(id,number,data,owner,workflow,priority,due_at) VALUES (?,?,?,?,?,?,?)').run(`item-${index}`, index + 1, JSON.stringify({ author: 'alice', state: 'open', updatedAt: '2026-01-01' }), owner, 'blocked', 'high', '2030-01-01');
  for (const [id, recipient, status] of [['pending', 'alice', 'pending'], ['sending', 'stranger', 'sending'], ['sent', 'bob', 'sent']]) db.prepare('INSERT INTO notifications(id,dedupe_key,recipient,title,reason,status,created_at) VALUES (?,?,?,?,?,?,?)').run(id, id, recipient, 'title', 'reason', status, 'now');
}
function snapshot(db) {
  return JSON.stringify(['members', 'users', 'sessions', 'oauth_states', 'items', 'notifications', 'feishu_bindings', 'audit_logs', 'settings'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test('versioned additive migration retains all original row data and reopens idempotently', t => {
  const filename = path.join(directory(t), 'old.sqlite');
  const old = new DatabaseSync(filename);
  old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, login TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT, avatar_url TEXT, feishu_open_id TEXT UNIQUE, notifications_enabled INTEGER NOT NULL DEFAULT 1, quiet_start TEXT NOT NULL DEFAULT '', quiet_end TEXT NOT NULL DEFAULT '');
    CREATE TABLE items (id TEXT PRIMARY KEY, number INTEGER UNIQUE NOT NULL, data TEXT NOT NULL, workflow TEXT NOT NULL DEFAULT 'todo', owner TEXT, priority TEXT NOT NULL DEFAULT 'normal', due_at TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  old.prepare('INSERT INTO users(id,login,name,feishu_open_id) VALUES (?,?,?,?)').run('11', 'alice', 'Edited local name', 'sensitive-open-id');
  old.prepare('INSERT INTO items(id,number,data,workflow,owner,priority,due_at) VALUES (?,?,?,?,?,?,?)').run('legacy', 9, '{"title":"Legacy edit"}', 'blocked', 'alice', 'high', '2030-01-01');
  old.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('custom', JSON.stringify({ keep: true })); old.close();
  let db = openDatabase(filename);
  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version), [1, 2, 3]);
  const user = db.prepare('SELECT * FROM users').get(); assert.equal(user.name, 'Edited local name'); assert.equal(user.feishu_open_id, 'sensitive-open-id'); assert.equal(user.member_id, null);
  const item = db.prepare('SELECT * FROM items').get(); assert.equal(item.workflow, 'blocked'); assert.equal(item.data, '{"title":"Legacy edit"}'); assert.equal(item.priority, 'high'); assert.equal(item.due_at, '2030-01-01'); assert.equal(item.version, 1);
  assert.equal(getSetting(db, 'membershipInitialized', false), false); assert.deepEqual(getSetting(db, 'custom'), { keep: true });
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  const before = snapshot(db); db.close(); db = openDatabase(filename);
  assert.equal(snapshot(db), before); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 3);
  assert.throws(() => db.prepare("INSERT INTO users(id,login,member_id) VALUES ('2','bob','missing')").run());
  db.close();
});

test('legacy membership migration verifies before transaction and preserves preferences/history', async t => {
  const db = database(t); populate(db);
  const calls = [];
  const report = await migrateLegacyMembers(db, { ...options, resolveUser: async login => { calls.push(login); assert.equal(db.isTransaction, false); return profiles[login]; } });
  assert.deepEqual(calls, ['alice', 'bob', 'carol']);
  assert.equal(report.created, 3); assert.equal(report.linkedUsers, 2); assert.equal(report.mappedOwners, 2); assert.equal(report.unresolvedOwners, 2); assert.equal(report.cancelledNotifications, 2);
  const alice = db.prepare("SELECT * FROM members WHERE github_user_id='11'").get();
  const bob = db.prepare("SELECT * FROM members WHERE github_user_id='22'").get();
  const carol = db.prepare("SELECT * FROM members WHERE github_user_id='33'").get();
  assert.equal(alice.role, 'admin'); assert.equal(alice.status, 'active'); assert.ok(alice.first_login_at);
  assert.equal(carol.status, 'pending_activation'); assert.equal(carol.first_login_at, null);
  assert.equal(db.prepare("SELECT member_id FROM users WHERE id='11'").get().member_id, alice.id);
  const prefs = db.prepare("SELECT * FROM users WHERE id='11'").get(); assert.equal(prefs.name, 'Local Alice'); assert.equal(prefs.quiet_start, '23:00'); assert.equal(prefs.quiet_end, '07:00');
  assert.equal(getMemberView(db, bob.id).notificationsEnabled, false);
  const binding = db.prepare('SELECT * FROM feishu_bindings').get(); assert.equal(binding.member_id, alice.id); assert.equal(binding.app_id, 'app'); assert.equal(binding.status, 'needs_confirmation'); assert.equal(binding.verified_at, null);
  assert.equal(getMemberView(db, alice.id, { appId: 'app' }).feishuVerified, false);
  for (const item of db.prepare('SELECT * FROM items').all()) { assert.equal(item.workflow, 'blocked'); assert.equal(item.priority, 'high'); assert.equal(item.due_at, '2030-01-01'); }
  assert.equal(db.prepare("SELECT owner_member_id FROM items WHERE id='item-0'").get().owner_member_id, alice.id);
  assert.equal(db.prepare("SELECT legacy_owner_unresolved FROM items WHERE id='item-3'").get().legacy_owner_unresolved, 1);
  assert.equal(db.prepare("SELECT recipient_member_id FROM notifications WHERE id='sent'").get().recipient_member_id, bob.id);
  assert.equal(db.prepare("SELECT status FROM notifications WHERE id='sent'").get().status, 'sent');
  assert.equal(db.prepare("SELECT status FROM notifications WHERE id='pending'").get().status, 'cancelled');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oauth_states').get().n, 0);
  assert.equal(getSetting(db, 'membershipInitialized'), true);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_logs').all()).includes('private-open-id'));
  updateMember(db, alice.id, { version: 1, displayName: 'Admin edit', notes: 'local note' });
  const before = snapshot(db);
  const rerun = await migrateLegacyMembers(db, { ...options, resolveUser: () => { throw new Error('must not fetch'); } });
  assert.equal(rerun.skipped, true); assert.equal(snapshot(db), before);
});

test('lookup failure, reused username, absent admin, and demo data fail closed without partial writes', async t => {
  const db = database(t); populate(db); const before = snapshot(db);
  await assert.rejects(migrateLegacyMembers(db, { ...options, resolveUser: async login => { if (login === 'bob') throw new Error('private upstream body'); return profiles[login]; } }), error => error.code === 'MIGRATION_RESOLVE_FAILED' && !error.message.includes('private'));
  assert.equal(snapshot(db), before); assert.equal(getSetting(db, 'membershipInitialized', false), false);
  await assert.rejects(migrateLegacyMembers(db, { ...options, resolveUser: async login => login === 'alice' ? { ...profiles.alice, githubId: '999' } : profiles[login] }), error => error.code === 'MIGRATION_IDENTITY_CONFLICT');
  assert.equal(snapshot(db), before);
  await assert.rejects(migrateLegacyMembers(db, { ...options, admins: [] })); assert.equal(snapshot(db), before);
  await assert.rejects(migrateLegacyMembers(db, { ...options, admins: ['demo-maintainer'] }), error => error.code === 'MIGRATION_DEMO_DATA'); assert.equal(snapshot(db), before);
});

test('binding conflict and audit failure roll back membership, owners, sessions, and settings atomically', async t => {
  const db = database(t); populate(db);
  // Abort at the final audit write: every preceding mutation must roll back.
  db.exec("CREATE TRIGGER reject_migration_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'failure'); END");
  const before = snapshot(db);
  await assert.rejects(migrateLegacyMembers(db, options)); assert.equal(snapshot(db), before); assert.equal(getSetting(db, 'membershipInitialized', false), false);
  db.exec('DROP TRIGGER reject_migration_audit');
  db.prepare("INSERT INTO members(id,github_user_id,github_login,role,status,created_at,updated_at) VALUES ('other','99','other','member','pending_activation','now','now')").run();
  db.prepare("INSERT INTO feishu_bindings(member_id,app_id,open_id,status,bound_at) VALUES ('other','app','alice-private-open-id','needs_confirmation','now')").run();
  const withBinding = snapshot(db);
  await assert.rejects(migrateLegacyMembers(db, options), error => error.code === 'MIGRATION_BINDING_CONFLICT');
  assert.equal(snapshot(db), withBinding);
});

test('canonical login alias collisions are rejected rather than guessed', async t => {
  const db = database(t); const before = snapshot(db);
  await assert.rejects(migrateLegacyMembers(db, { admins: ['alice'], allowed: ['bob'], resolveUser: async login => ({ githubId: login === 'alice' ? '11' : '22', login: 'same-login', type: 'User' }) }), error => error.code === 'MIGRATION_IDENTITY_CONFLICT');
  assert.equal(snapshot(db), before);
});

test('legacy demo fixtures upgrade even when items already exist without erasing edits', t => {
  const db = database(t);
  db.prepare("INSERT INTO users(id,login,name) VALUES ('demo','demo-maintainer','Local name')").run();
  db.prepare("INSERT INTO items(id,number,data,workflow,owner,priority,due_at) VALUES ('github:9001',9001,?,'blocked','demo-maintainer','high','2035-01-01')").run(JSON.stringify({ title: 'Local title', author: 'reviewer-chen', assignees: ['demo-maintainer'], reviewers: ['reviewer-chen'] }));
  seedDemo(db, 'AISBench/benchmark');
  const row = db.prepare("SELECT * FROM items WHERE id='github:9001'").get();
  assert.equal(row.workflow, 'blocked'); assert.equal(row.priority, 'high'); assert.equal(row.due_at, '2035-01-01'); assert.equal(JSON.parse(row.data).title, 'Local title');
  assert.equal(row.owner_member_id, 'demo-admin'); assert.equal(JSON.parse(row.data).authorId, '1002'); assert.deepEqual(JSON.parse(row.data).reviewerIds, ['1002']);
  assert.equal(db.prepare("SELECT name FROM users WHERE id='demo'").get().name, 'Local name');
  const before = snapshot(db); seedDemo(db, 'AISBench/benchmark'); assert.equal(snapshot(db), before);
});

test('consistent online backup contains committed WAL data and refuses overwrites/source replacement', async t => {
  const dir = directory(t); const source = path.join(dir, 'live.sqlite'); const output = path.join(dir, 'backup.sqlite');
  const db = openDatabase(source);
  try {
    setSetting(db, 'liveCommitted', { durable: 'from WAL' });
    assert.ok(existsSync(`${source}-wal`)); assert.ok(statSync(`${source}-wal`).size > 0);
    await backupDatabase(source, output);
    const copy = new DatabaseSync(output, { readOnly: true });
    assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(JSON.parse(copy.prepare("SELECT value FROM settings WHERE key='liveCommitted'").get().value), { durable: 'from WAL' }); copy.close();
    const bytes = readFileSync(output);
    await assert.rejects(backupDatabase(source, output)); assert.deepEqual(readFileSync(output), bytes);
    await assert.rejects(backupDatabase(source, source)); assert.equal(getSetting(db, 'liveCommitted').durable, 'from WAL');
    const failed = path.join(dir, 'failed.sqlite');
    await assert.rejects(backupDatabase(source, failed, { backupImpl: async () => { throw new Error('mock failure'); } })); assert.equal(existsSync(failed), false);
  } finally { db.close(); }
});

test('CLI offline backup needs no OAuth configuration; bootstrap/recovery use mocked resolver and sanitize errors', async t => {
  const dir = directory(t); const source = path.join(dir, 'platform.sqlite'); const output = path.join(dir, 'copy.sqlite');
  const db = openDatabase(source); setSetting(db, 'offline', true); db.close();
  const messages = []; const errors = []; const stdout = { write: message => messages.push(message) }; const stderr = { write: message => errors.push(message) };
  assert.equal(await runCli(['backup', '--output', output], { env: { DATA_DIR: dir }, stdout, stderr, resolveUser: () => { throw new Error('must not fetch'); } }), 0);
  assert.ok(existsSync(output)); assert.equal(errors.length, 0);
  const resolver = async login => ({ githubId: '11', login, type: 'User' });
  assert.equal(await runCli(['bootstrap', '--github', 'alice'], { env: { DATA_DIR: dir }, stdout, stderr, resolveUser: resolver }), 0);
  assert.equal(await runCli(['bootstrap', '--github', 'alice'], { env: { DATA_DIR: dir }, stdout, stderr, resolveUser: resolver }), 1);
  assert.equal(await runCli(['recover-admin', '--github', 'alice'], { env: { DATA_DIR: dir }, stdout, stderr, resolveUser: resolver }), 0);
  assert.equal(await runCli(['bootstrap', '--github', 'alice'], { env: { DATA_DIR: dir, GITHUB_TOKEN: 'secret-token' }, stdout, stderr, resolveUser: async () => { throw new Error('secret-token private-open-id'); } }), 1);
  assert.ok(!errors.join('').includes('secret-token')); assert.ok(!errors.join('').includes('private-open-id'));
  assert.equal(await runCli(['backup', '--github', 'alice'], { env: {}, stdout, stderr }), 1);
  assert.equal(await runCli(['backup', '--output', path.join(dir, 'missing-copy.sqlite'), '--database', path.join(dir, 'missing.sqlite')], { env: {}, stdout, stderr }), 1);
  assert.equal(existsSync(path.join(dir, 'missing.sqlite')), false);
});
