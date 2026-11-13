import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { addTestMember, insertItem, testItem } from './helpers.js';
import {
  mentionLogins, categorizeTimeline, syncItemConversation, listConversation, unreadSummary, recordReads, readsForMessage,
  postPlatformMessage, upsertFromWebhook, dedupeStoredCI, rerunItemCI,
} from '../server/conversation.js';
import { encryptToken, decryptToken, saveGitHubToken, getGitHubToken, deleteGitHubToken, githubTokenStatus } from '../server/github-tokens.js';

const key = Buffer.alloc(32, 7).toString('base64');
const config = (extra = {}) => ({ repo: 'AISBench/benchmark', githubToken: 'read-token', githubClientId: 'id', githubClientSecret: 'secret', tokenEncryptionKey: key, demo: false, feishuAppId: '', ...extra });
const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
function database(t) { const db = openDatabase(':memory:'); t.after(() => db.close()); return db; }

test('mention parsing and timeline categorization', () => {
  assert.deepEqual(mentionLogins('hi @Alice and @bob-2, not@nobody'), ['alice', 'bob-2']);
  assert.equal(categorizeTimeline({ event: 'labeled' }), 'operation');
  assert.equal(categorizeTimeline({ event: 'commented' }), null);
  assert.equal(categorizeTimeline({ event: 'reviewed' }), null);
});

test('conversation sync stores comments, operation events, CI and mentions', async t => {
  const db = database(t);
  addTestMember(db, { githubId: '999', login: 'alice', status: 'active' });
  addTestMember(db, { githubId: '998', login: 'bob', status: 'active' });
  insertItem(db, { ...testItem(), id: 'github:101', number: 101, kind: 'pr' });
  const sha = 'a'.repeat(40);
  const fetchImpl = async url => {
    const target = String(url);
    if (target.includes('/issues/101/comments')) return json([{ id: 1, body: 'hello @bob', user: { id: 999, login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/999?v=4' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/x/1' }]);
    if (target.includes('/issues/101/timeline')) return json([{ id: 9, event: 'labeled', label: { name: 'bug' }, actor: { id: 999, login: 'alice' }, created_at: '2026-01-01T01:00:00Z' }]);
    if (target.includes('/pulls/101/reviews')) return json([{ id: 3, body: 'looks good', state: 'APPROVED', user: { id: 998, login: 'bob' }, submitted_at: '2026-01-01T02:00:00Z', html_url: 'https://github.com/x/3' }]);
    if (target.includes('/pulls/101/comments')) return json([{ id: 4, body: 'why raise here?', user: { id: 998, login: 'bob' }, created_at: '2026-01-01T01:30:00Z', updated_at: '2026-01-01T01:30:00Z', html_url: 'https://github.com/x/101#discussion_r4', path: 'src/tasks.py', line: 42, start_line: 41, side: 'RIGHT', diff_hunk: '@@ -39,7 +39,9 @@ def run(task):\n     result = task.execute()\n-    return result\n+    if result is None:\n+        raise ValueError("empty")\n+    return result' }]);
    if (target.includes('/pulls/101')) return json({ number: 101, head: { sha } });
    if (target.includes('/check-runs')) return json({ check_runs: [
      { id: 6, name: 'ci', status: 'completed', conclusion: 'failure', app: { name: 'GitHub Actions', slug: 'github-actions' }, head_sha: sha, completed_at: '2026-01-01T02:30:00Z', html_url: 'https://github.com/x/check-old', details_url: 'https://github.com/x/actions/runs/7001/job/1' },
      { id: 7, name: 'ci', status: 'completed', conclusion: 'success', app: { name: 'GitHub Actions', slug: 'github-actions' }, head_sha: sha, completed_at: '2026-01-01T03:00:00Z', html_url: 'https://github.com/x/check', details_url: 'https://github.com/x/actions/runs/7001/job/2' },
    ] });
    if (target.includes('/statuses')) return json([{ id: 5, context: 'ci', state: 'failure', updated_at: '2026-01-01T01:00:00Z', target_url: 'https://github.com/x/status' }]);
    return json([]);
  };
  const result = await syncItemConversation(db, config(), 'github:101', { force: true, fetchImpl });
  assert.equal(result.skipped, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_messages').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_events').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_message_mentions').get().n, 1);
  const view = listConversation(db, config(), 'github:101', 'missing-member');
  assert.equal(view.messages.length, 3);
  assert.equal(view.events.ci.length, 1);
  assert.equal(view.events.ci[0].detail.conclusion, 'success', 'only the latest check state for the same name is kept');
  assert.equal(view.events.ci[0].detail.runId, 7001, 'GitHub Actions checks expose the workflow run id');
  assert.equal(view.events.operation.length, 1);
  assert.equal(view.messages[0].author.login, 'bob');
  const inline = view.messages.find(message => message.kind === 'review_comment');
  assert.equal(inline.path, 'src/tasks.py');
  assert.equal(inline.line, 42);
  assert.equal(inline.startLine, 41);
  assert.equal(inline.side, 'RIGHT');
  assert.match(inline.diffHunk, /@@ -39,7 \+39,9 @@/);
  assert.equal(inline.reviewCommentId, '4');
  assert.equal(inline.url, 'https://github.com/x/101#discussion_r4');
});

test('unread baseline, mentions and per-message read receipts', t => {
  const db = database(t);
  const alice = addTestMember(db, { githubId: '999', login: 'alice', status: 'active' });
  const bob = addTestMember(db, { githubId: '998', login: 'bob', status: 'active' });
  insertItem(db, { ...testItem(), id: 'github:101', number: 101 });
  db.prepare('UPDATE members SET conversation_baseline_at=? WHERE id IN (?,?)').run('2000-01-01T00:00:00Z', alice.id, bob.id);
  upsertFromWebhook(db, { repository: { full_name: 'AISBench/benchmark' }, issue: { number: 101 }, action: 'created', comment: { id: 11, body: 'hello @bob', user: { id: 999, login: 'alice' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' } }, 'issue_comment', 'delivery-1');
  const summary = unreadSummary(db, bob.id);
  assert.equal(summary['github:101'].unread, 1);
  assert.equal(summary['github:101'].mentions, 1);
  const message = db.prepare('SELECT id FROM item_messages').get();
  assert.equal(recordReads(db, bob.id, 'github:101', [message.id]), 1);
  assert.equal(unreadSummary(db, bob.id)['github:101'], undefined);
  assert.equal(readsForMessage(db, 'github:101', message.id)[0].memberId, bob.id);
  assert.equal(recordReads(db, alice.id, 'github:101', [message.id]), 0, 'own messages are not marked as read receipts');
});

test('webhook comments are idempotent and operation events dedupe by delivery', t => {
  const db = database(t);
  insertItem(db, { ...testItem(), id: 'github:101', number: 101 });
  const payload = { repository: { full_name: 'AISBench/benchmark' }, issue: { number: 101 }, action: 'created', comment: { id: 11, body: 'hi', user: { id: 999, login: 'alice' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' } };
  upsertFromWebhook(db, payload, 'issue_comment', 'delivery-1');
  upsertFromWebhook(db, payload, 'issue_comment', 'delivery-1');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_messages').get().n, 1);
  const issue = { repository: { full_name: 'AISBench/benchmark' }, issue: { number: 101 }, action: 'labeled', label: { name: 'bug' }, sender: { id: 9, login: 'maintainer' } };
  upsertFromWebhook(db, issue, 'issues', 'delivery-2');
  upsertFromWebhook(db, issue, 'issues', 'delivery-2');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM item_events WHERE category='operation'").get().n, 1);
});

test('webhook check re-runs replace the previous check state by name', t => {
  const db = database(t);
  insertItem(db, { ...testItem(), id: 'github:101', number: 101, kind: 'pr' });
  const payload = (id, conclusion, at) => ({ repository: { full_name: 'AISBench/benchmark' }, check_run: { id, name: 'lint', status: 'completed', conclusion, pull_requests: [{ number: 101 }], completed_at: at } });
  upsertFromWebhook(db, payload(1, 'failure', '2026-01-01T00:00:00Z'), 'check_run', 'delivery-ci-1');
  upsertFromWebhook(db, payload(2, 'success', '2026-01-01T01:00:00Z'), 'check_run', 'delivery-ci-2');
  const rows = db.prepare("SELECT detail FROM item_events WHERE item_id='github:101' AND category='ci'").all();
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].detail).conclusion, 'success');
});

test('stored duplicate CI states are cleaned up on startup', t => {
  const db = database(t);
  insertItem(db, { ...testItem(), id: 'github:101', number: 101, kind: 'pr' });
  const insert = db.prepare(`INSERT INTO item_events(id,item_id,category,event_type,dedupe_key,actor_login,actor_github_id,actor_avatar_url,summary,detail,occurred_at,synced_at)
    VALUES (?,?,'ci','commit_status',?,NULL,NULL,'',?,?,?,?)`);
  insert.run('old', 'github:101', 'status:docs:1', 'docs · pending', JSON.stringify({ context: 'docs', state: 'pending' }), '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  insert.run('new', 'github:101', 'status:docs:2', 'docs · success', JSON.stringify({ context: 'docs', state: 'success' }), '2026-01-01T01:00:00Z', '2026-01-01T01:00:00Z');
  assert.equal(dedupeStoredCI(db), 1);
  const rows = db.prepare("SELECT detail FROM item_events WHERE item_id='github:101' AND category='ci'").all();
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].detail).state, 'success');
});

test('GitHub Actions CI can be rerun as the member and non-Actions checks are rejected', async t => {
  const db = database(t);
  const member = addTestMember(db, { githubId: '999', login: 'alice', status: 'active' });
  insertItem(db, { ...testItem(), id: 'github:101', number: 101, kind: 'pr' });
  const insert = db.prepare(`INSERT INTO item_events(id,item_id,category,event_type,dedupe_key,actor_login,actor_github_id,actor_avatar_url,summary,detail,occurred_at,synced_at)
    VALUES (?,?,'ci',?,?,?,NULL,'',?,?,?,?)`);
  insert.run('actions', 'github:101', 'check_run', 'check:900', 'GitHub Actions', 'ci · success', JSON.stringify({ name: 'ci', app: 'GitHub Actions', appSlug: 'github-actions', runId: 900, status: 'completed', conclusion: 'success' }), '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  insert.run('status', 'github:101', 'commit_status', 'status:docs:1', 'release-bot', 'docs · success', JSON.stringify({ context: 'docs', state: 'success' }), '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

  const demo = await rerunItemCI(db, config({ demo: true }), { member, itemId: 'github:101', eventId: 'actions' });
  assert.equal(demo.demo, true);
  assert.equal(demo.runId, 900);

  await assert.rejects(
    () => rerunItemCI(db, config(), { member, itemId: 'github:101', eventId: 'status', fetchImpl: async () => { throw new Error('must not call GitHub'); } }),
    error => error.code === 'CI_NOT_RERUNABLE',
  );
  await assert.rejects(
    () => rerunItemCI(db, config(), { member, itemId: 'github:101', eventId: 'actions', fetchImpl: async () => { throw new Error('must not call GitHub'); } }),
    error => error.code === 'GITHUB_WRITE_AUTH_REQUIRED',
  );

  saveGitHubToken(db, { memberId: member.id, login: 'alice', githubUserId: '999', token: 'write-token', scopes: 'read:user public_repo' }, config());
  let call;
  const fetchImpl = async (url, options) => {
    call = { url: String(url), method: options.method, body: options.body, authorization: options.headers.Authorization };
    return new Response(null, { status: 201 });
  };
  const result = await rerunItemCI(db, config(), { member, itemId: 'github:101', eventId: 'actions', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.runId, 900);
  assert.equal(call.url, 'https://api.github.com/repos/AISBench/benchmark/actions/runs/900/rerun');
  assert.equal(call.method, 'POST');
  assert.equal(call.authorization, 'Bearer write-token');
  const row = db.prepare('SELECT summary,detail FROM item_events WHERE id=?').get('actions');
  assert.match(row.summary, /queued/);
  assert.equal(JSON.parse(row.detail).status, 'queued');
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action='ci.rerun'").get());

  await assert.rejects(
    () => rerunItemCI(db, config(), {
      member, itemId: 'github:101', eventId: 'actions',
      fetchImpl: async () => new Response(JSON.stringify({ message: 'Although you appear to have the correct authorization credentials, the `AISBench` organization has enabled OAuth App access restrictions.' }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    }),
    error => error.code === 'GITHUB_ORG_RESTRICTED' && error.status === 403 && /OAuth App/.test(error.message),
  );
});

test('organization-blocked member rerun falls back to the server Actions token', async t => {
  const db = database(t);
  const member = addTestMember(db, { githubId: '999', login: 'alice', status: 'active' });
  insertItem(db, { ...testItem(), id: 'github:101', number: 101, kind: 'pr' });
  db.prepare(`INSERT INTO item_events(id,item_id,category,event_type,dedupe_key,actor_login,actor_github_id,actor_avatar_url,summary,detail,occurred_at,synced_at)
    VALUES ('actions','github:101','ci','check_run','check:901','GitHub Actions',NULL,'','ci · success',?,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`)
    .run(JSON.stringify({ name: 'ci', app: 'GitHub Actions', appSlug: 'github-actions', runId: 901, status: 'completed', conclusion: 'success' }));
  saveGitHubToken(db, { memberId: member.id, login: 'alice', githubUserId: '999', token: 'member-token', scopes: 'read:user public_repo' }, config());
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(options.headers.Authorization);
    if (calls.length === 1) {
      return new Response(JSON.stringify({ message: 'Although you appear to have the correct authorization credentials, the `AISBench` organization has enabled OAuth App access restrictions.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(null, { status: 201 });
  };
  const result = await rerunItemCI(db, config({ githubActionsToken: 'server-actions-token' }), { member, itemId: 'github:101', eventId: 'actions', fetchImpl });
  assert.equal(result.via, 'server');
  assert.deepEqual(calls, ['Bearer member-token', 'Bearer server-actions-token']);
  assert.equal(getGitHubToken(db, member.id, config()), 'member-token', 'member token is kept when only the organization blocks it');
  const audit = JSON.parse(db.prepare("SELECT after_json FROM audit_logs WHERE action='ci.rerun' ORDER BY created_at DESC").get().after_json);
  assert.equal(audit.via, 'server');
  assert.equal(audit.runId, 901);
});

test('platform messages in demo are local-only and idempotent by clientId', async t => {
  const db = database(t);
  const member = addTestMember(db, { githubId: '999', login: 'alice', status: 'active' });
  insertItem(db, { ...testItem(), id: 'github:101', number: 101 });
  const row = await postPlatformMessage(db, config({ demo: true }), { member: db.prepare('SELECT * FROM members WHERE id=?').get(member.id), itemId: 'github:101', body: 'hello **team**', clientId: 'client-1' });
  const again = await postPlatformMessage(db, config({ demo: true }), { member: db.prepare('SELECT * FROM members WHERE id=?').get(member.id), itemId: 'github:101', body: 'hello **team**', clientId: 'client-1' });
  assert.equal(row.delivery_status, 'demo');
  assert.equal(row.id, again.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_messages').get().n, 1);
});

test('GitHub tokens are encrypted at rest and can be revoked', t => {
  const db = database(t);
  const member = addTestMember(db, { githubId: '999', login: 'alice', status: 'active' });
  const encrypted = encryptToken('secret-token', config());
  assert.equal(decryptToken({ encrypted_token: encrypted.encrypted, token_iv: encrypted.iv, token_tag: encrypted.tag }, config()), 'secret-token');
  assert.equal(saveGitHubToken(db, { memberId: member.id, login: 'alice', githubUserId: '999', token: 'secret-token', scopes: 'read:user public_repo' }, config()), true);
  assert.equal(getGitHubToken(db, member.id, config()), 'secret-token');
  assert.equal(githubTokenStatus(db, member.id).ready, true);
  const raw = JSON.stringify(db.prepare('SELECT * FROM github_user_tokens').get());
  assert.ok(!raw.includes('secret-token'));
  assert.equal(deleteGitHubToken(db, member.id), 1);
  assert.equal(getGitHubToken(db, member.id, config()), null);
});
