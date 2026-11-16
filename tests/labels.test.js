import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { addTestMember, insertItem, testItem } from './helpers.js';
import { syncRepositoryLabels, listLabels, labelWriteAccess, updateItemLabels, hasLabel } from '../server/labels.js';
import { saveGitHubToken } from '../server/github-tokens.js';

const key = Buffer.alloc(32, 7).toString('base64');
const config = (extra = {}) => ({ repo: 'AISBench/benchmark', githubToken: 'read-token', tokenEncryptionKey: key, demo: false, ...extra });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function database(t) { const db = openDatabase(':memory:'); t.after(() => db.close()); return db; }
function memberWithToken(db, options = config()) {
  const member = addTestMember(db, { githubId: '501', login: 'alice', status: 'active' });
  saveGitHubToken(db, { memberId: member.id, login: 'alice', githubUserId: '501', token: 'member-token', scopes: 'public_repo' }, options);
  return member;
}

test('repository label catalogue mirrors colours and prunes removed labels', t => {
  const db = database(t);
  syncRepositoryLabels(db, [{ name: 'bug', color: 'D73A4A', description: 'Something is broken' }, { name: 'feature', color: '1d76db' }]);
  assert.deepEqual(listLabels(db), [
    { name: 'bug', color: 'd73a4a', description: 'Something is broken' },
    { name: 'feature', color: '1d76db', description: '' },
  ]);
  syncRepositoryLabels(db, [{ name: 'BUG', color: 'ff0000' }]);
  assert.deepEqual(listLabels(db), [{ name: 'bug', color: 'ff0000', description: '' }], 'case-insensitive upsert recolours and removes stale labels');
  assert.equal(syncRepositoryLabels(db, []), 0, 'an empty payload never wipes the catalogue');
  assert.equal(hasLabel({ labels: ['Bug', 'docs'] }, 'bug'), true);
  assert.equal(hasLabel({ labels: ['docs'] }, 'bug'), false);
});

test('label write access follows GitHub roles and stored tokens', async t => {
  const db = database(t);
  assert.equal((await labelWriteAccess(db, config({ demo: true }), 'demo-admin')).canEdit, true);
  const member = addTestMember(db, { githubId: '501', login: 'alice', status: 'active' });
  assert.deepEqual(await labelWriteAccess(db, config(), member.id), { canEdit: false, permissions: null, reason: 'NO_GITHUB_WRITE_TOKEN' });

  const token = memberWithToken(db, config());
  const permissions = value => async url => {
    assert.match(String(url), /\/repos\/AISBench\/benchmark$/);
    return json({ permissions: value });
  };
  assert.equal((await labelWriteAccess(db, config(), token.id, { fetchImpl: permissions({ push: true }) })).canEdit, true);
  assert.equal((await labelWriteAccess(db, config(), token.id, { fetchImpl: permissions({ triage: true }) })).canEdit, true);
  assert.equal((await labelWriteAccess(db, config(), token.id, { fetchImpl: permissions({ pull: true }) })).canEdit, false);
  const failing = async () => new Response('', { status: 500 });
  assert.deepEqual(await labelWriteAccess(db, config(), token.id, { fetchImpl: failing }), { canEdit: false, permissions: null, reason: 'GITHUB_PERMISSION_UNAVAILABLE' });
});

test('label writes go to GitHub with the member token and update the local item', async t => {
  const db = database(t);
  const member = memberWithToken(db);
  insertItem(db, { ...testItem(), id: 'github:101', number: 101, labels: ['feature'] });
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith('/repos/AISBench/benchmark')) return json({ permissions: { push: true } });
    if (target.endsWith('/issues/101/labels') && options.method === 'PUT') {
      calls.push(JSON.parse(options.body).labels);
      assert.equal(options.headers.Authorization, 'Bearer member-token', 'the member token is used, never the server token');
      return json([{ name: 'bug' }, { name: 'docs' }]);
    }
    throw new Error(`unexpected ${target}`);
  };
  const result = await updateItemLabels(db, config(), { member, itemId: 'github:101', labels: ['bug', 'docs', 'Bug'], fetchImpl });
  assert.deepEqual(calls, [['bug', 'docs']], 'duplicates are dropped before calling GitHub');
  assert.deepEqual(result.labels, ['bug', 'docs']);
  const row = db.prepare('SELECT * FROM items WHERE id=?').get('github:101');
  assert.deepEqual(JSON.parse(row.data).labels, ['bug', 'docs']);
  assert.equal(row.version, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='item.labels'").get().n, 1);
});

test('label writes surface GitHub permission and unknown-label errors', async t => {
  const db = database(t);
  const member = memberWithToken(db);
  insertItem(db, { ...testItem(), id: 'github:101', number: 101 });
  const rejecting = status => async url => String(url).endsWith('/repos/AISBench/benchmark')
    ? json({ permissions: { push: true } })
    : new Response(status === 422 ? JSON.stringify({ message: 'Validation Failed' }) : '', { status });
  await assert.rejects(updateItemLabels(db, config(), { member, itemId: 'github:101', labels: ['bug'], fetchImpl: rejecting(403) }), error => error.status === 403 && error.code === 'GITHUB_LABEL_FORBIDDEN');
  await assert.rejects(updateItemLabels(db, config(), { member, itemId: 'github:101', labels: ['nope'], fetchImpl: rejecting(422) }), error => error.status === 422 && error.code === 'LABEL_UNKNOWN');
  assert.deepEqual(JSON.parse(db.prepare('SELECT data FROM items WHERE id=?').get('github:101').data).labels, [], 'a rejected write never changes local labels');
  const noRole = async url => String(url).endsWith('/repos/AISBench/benchmark') ? json({ permissions: { pull: true } }) : json([]);
  await assert.rejects(updateItemLabels(db, config(), { member, itemId: 'github:101', labels: ['bug'], fetchImpl: noRole }), error => error.status === 403 && error.code === 'GITHUB_LABEL_FORBIDDEN');
});

test('demo label edits stay local and never touch GitHub', async t => {
  const db = database(t);
  const member = addTestMember(db, { githubId: '1001', login: 'demo-maintainer', status: 'active' });
  insertItem(db, { ...testItem(), id: 'github:101', number: 101, labels: ['bug'] });
  const result = await updateItemLabels(db, config({ demo: true }), {
    member, itemId: 'github:101', labels: ['bug', 'feature'],
    fetchImpl: async () => { throw new Error('demo must not call GitHub'); },
  });
  assert.deepEqual(result.labels, ['bug', 'feature']);
  assert.deepEqual(JSON.parse(db.prepare('SELECT data FROM items WHERE id=?').get('github:101').data).labels, ['bug', 'feature']);
});
