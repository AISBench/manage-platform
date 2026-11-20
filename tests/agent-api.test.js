import test from 'node:test';
import assert from 'node:assert/strict';
import { addTestMember, httpFixture, insertItem, testItem } from './helpers.js';
import { resolveAgentToken } from '../server/agent-tokens.js';
import { saveGitHubToken } from '../server/github-tokens.js';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

function fakeIssueMaster(overrides = {}) {
  const calls = [];
  return {
    calls,
    configured: true,
    async searchKb(args) {
      calls.push(['searchKb', args]);
      return { repo: args.repo, chunks: [{ path: 'tools/config.py', startLine: 1, endLine: 9, title: 'tools/config.py', text: 'x', score: 0.9 }], index: { status: 'fresh', sha: 'abc' }, warning: '' };
    },
    async wiki(args) {
      calls.push(['wiki', args]);
      return { repo: args.repo, topic: args.topic, text: '# page' };
    },
    async publish(args) {
      calls.push(['publish', args]);
      if (overrides.publishError) throw Object.assign(new Error(overrides.publishError), { status: 502, code: 'ISSUE_MASTER_UPSTREAM_ERROR' });
      return { commentUrl: '', applied: ['添加标签：bug'], errors: [], replayed: false };
    },
  };
}

async function agentRequest(base, token, route, method = 'GET', body) {
  const response = await fetch(base + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

async function setup(t, { item = testItem(), config = {}, issueMaster, githubToken = true } = {}) {
  const comments = [];
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/issues/101/comments') && options.method === 'POST') {
      comments.push({ url: target, body: JSON.parse(options.body || '{}'), authorization: options.headers?.Authorization || options.headers?.authorization });
      return new Response(JSON.stringify({ id: 9001, html_url: 'https://github.com/AISBench/benchmark/issues/101#issuecomment-9001', created_at: new Date().toISOString() }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected external HTTP: ${target}`);
  };
  const fixture = await httpFixture(t, { integrations: issueMaster ? { issueMaster } : {}, config: { tokenEncryptionKey: TEST_KEY, ...config }, fetchImpl });
  const member = addTestMember(fixture.db, { githubId: '501', login: 'alice' });
  insertItem(fixture.db, item);
  const session = fixture.client(member.id);
  await session.request('/api/session');
  const created = await session.request('/api/agent/tokens', 'POST', { name: 'my agent' });
  assert.equal(created.status, 201);
  if (githubToken) saveGitHubToken(fixture.db, { memberId: member.id, login: 'alice', githubUserId: '501', token: 'member-token', scopes: 'public_repo' }, fixture.config);
  return { ...fixture, member, session, token: created.data.token, tokenId: created.data.id, comments };
}

test('agent token is shown once, listed with prefix, resolvable and revocable', async t => {
  const { db, session, token, tokenId } = await setup(t);
  assert.match(token, /^ask_[A-Za-z0-9_-]{43}$/);
  const listed = await session.request('/api/agent/tokens');
  assert.equal(listed.status, 200);
  assert.equal(listed.data.tokens.length, 1);
  assert.equal(listed.data.tokens[0].prefix, token.slice(0, 10));
  assert.equal(JSON.stringify(listed.data).includes(token), false, 'plaintext token must not be listed');
  assert.ok(resolveAgentToken(db, token));
  assert.equal(resolveAgentToken(db, 'ask_bad'), null);
  const revoked = await session.request(`/api/agent/tokens/${tokenId}`, 'DELETE');
  assert.equal(revoked.status, 200);
  assert.equal(resolveAgentToken(db, token), null);
});

test('agent routes return 404 when agent access is disabled', async t => {
  const fixture = await httpFixture(t, { config: { agentEnabled: false } });
  const member = addTestMember(fixture.db, { githubId: '501', login: 'alice' });
  const session = fixture.client(member.id);
  await session.request('/api/session');
  for (const [route, method] of [['/api/agent/me', 'GET'], ['/api/agent/tokens', 'GET'], ['/api/agent/tasks', 'GET'], ['/api/agent/drafts', 'GET']]) {
    assert.equal((await session.request(route, method)).status, 404, route);
  }
});

test('task lifecycle: create, list with token, claim idempotently, submit draft, reject duplicate submit', async t => {
  const { session, token, db, base } = await setup(t);
  const created = await session.request('/api/items/github:101/agent-task', 'POST', { hint: '看复现步骤' });
  assert.equal(created.status, 201);
  assert.equal(created.data.created, true);
  assert.equal(created.data.task.status, 'queued');
  const reused = await session.request('/api/items/github:101/agent-task', 'POST', {});
  assert.equal(reused.status, 200);
  assert.equal(reused.data.task.id, created.data.task.id);
  assert.equal(reused.data.created, false);

  const taskId = created.data.task.id;
  const tasks = await agentRequest(base, token, '/api/agent/tasks');
  assert.equal(tasks.status, 200);
  assert.equal(tasks.data.tasks.length, 1);
  assert.equal(tasks.data.tasks[0].item.number, 101);

  assert.equal((await agentRequest(base, token, `/api/agent/tasks/${taskId}/claim`, 'POST', {})).status, 200);
  assert.equal((await agentRequest(base, token, `/api/agent/tasks/${taskId}/claim`, 'POST', {})).status, 200);

  const context = await agentRequest(base, token, `/api/agent/tasks/${taskId}/context`);
  assert.equal(context.status, 200);
  assert.equal(context.data.number, 101);
  for (const hidden of ['workflow', 'priority', 'dueAt', 'ownerMemberId', 'owner', 'module', 'notes']) assert.equal(context.data[hidden], undefined, hidden);

  const draft = { summary: '根因', comment_md: '建议这样修复', actions: [{ kind: 'add_label', value: 'bug', reason: '复现' }], references: [{ kind: 'file', path: 'tools/config.py', snippet: 'x' }], confidence: 0.6, model: 'test-model' };
  const submitted = await agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', { draft });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.data.draft.status, 'pending');
  assert.equal(submitted.data.draft.actions[0].kind, 'add_label');
  const again = await agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', { draft });
  assert.equal(again.status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_drafts').get().n, 1);
});

test('issue page can read the full draft inline and keeps it after publish', async t => {
  const { session, token, base } = await setup(t, { issueMaster: fakeIssueMaster() });
  const created = await session.request('/api/items/github:101/agent-task', 'POST', {});
  const taskId = created.data.task.id;
  const draft = { summary: '根因结论', comment_md: '**建议这样修复**', actions: [{ kind: 'add_label', value: 'bug', reason: '复现' }], references: [{ kind: 'file', path: 'tools/config.py', snippet: 'x' }], confidence: 0.6, model: 'test-model' };
  assert.equal((await agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', { draft })).status, 201);

  const inline = await session.request('/api/items/github:101/agent-task');
  assert.equal(inline.status, 200);
  assert.equal(inline.data.task.status, 'submitted');
  assert.equal(inline.data.draft.commentMd, '**建议这样修复**');
  assert.equal(inline.data.draft.actions[0].kind, 'add_label');

  assert.equal((await session.request(`/api/agent/drafts/${inline.data.draft.id}/publish`, 'POST', {})).status, 200);
  const after = await session.request('/api/items/github:101/agent-task');
  assert.equal(after.data.task, null);
  assert.equal(after.data.draft.status, 'published');
});

test('invalid drafts are rejected before storage', async t => {
  const { session, token, base } = await setup(t);
  const created = await session.request('/api/items/github:101/agent-task', 'POST', {});
  const taskId = created.data.task.id;
  const submit = draft => agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', { draft });
  assert.equal((await submit({ comment_md: 'x', actions: [{ kind: 'delete_repo', value: 'x' }] })).status, 400);
  assert.equal((await submit({ comment_md: 'x', references: [{ kind: 'file', url: 'https://evil.example/x' }] })).status, 400);
  assert.equal((await submit({ comment_md: 'x', references: [{ kind: 'file', path: '/etc/passwd' }] })).status, 400);
  assert.equal((await submit({ comment_md: 'x', confidence: 2 })).status, 400);
});

test('kb routes proxy to issue-master and validate input', async t => {
  const issueMaster = fakeIssueMaster();
  const { token, base } = await setup(t, { issueMaster });
  const search = await agentRequest(base, token, '/api/agent/kb/search', 'POST', { repo: 'AISBench/benchmark', question: '评测 JSON 字段', topK: 5 });
  assert.equal(search.status, 200);
  assert.equal(search.data.chunks[0].path, 'tools/config.py');
  assert.deepEqual(issueMaster.calls[0], ['searchKb', { repo: 'AISBench/benchmark', question: '评测 JSON 字段', topK: 5 }]);
  const wiki = await agentRequest(base, token, '/api/agent/kb/wiki?repo=AISBench%2Fbenchmark&topic=eval');
  assert.equal(wiki.status, 200);
  assert.equal(wiki.data.text, '# page');
  assert.equal((await agentRequest(base, token, '/api/agent/kb/search', 'POST', { repo: 'AISBench/benchmark', question: '' })).status, 400);
  assert.equal((await agentRequest(base, 'ask_invalid', '/api/agent/me')).status, 401);
});

test('publishing posts as the member, discloses the Agent, and only runs actions through issue_master', async t => {
  const issueMaster = fakeIssueMaster();
  const { session, token, db, base, member, client, comments } = await setup(t, { issueMaster });
  const created = await session.request('/api/items/github:101/agent-task', 'POST', {});
  const draft = { comment_md: '修复建议', model: 'm', actions: [{ kind: 'add_label', value: 'bug', reason: '复现' }] };
  const submitted = await agentRequest(base, token, `/api/agent/tasks/${created.data.task.id}/submit`, 'POST', { draft });
  const draftId = submitted.data.draft.id;
  assert.equal(submitted.data.draft.agentName, 'my agent');

  const published = await session.request(`/api/agent/drafts/${draftId}/publish`, 'POST', {});
  assert.equal(published.status, 200);
  assert.equal(published.data.draft.status, 'published');
  assert.match(published.data.commentUrl, /issues\/101/);
  assert.equal(comments.length, 1, 'the comment is posted by the member token, not the bot');
  assert.equal(comments[0].authorization, 'Bearer member-token');
  assert.match(comments[0].body.body, /本评论由 Agent「my agent」生成/);
  assert.match(comments[0].body.body, /@alice/);
  assert.match(comments[0].body.body, /模型：m/);
  const actionCall = issueMaster.calls.at(-1);
  assert.equal(actionCall[0], 'publish');
  assert.equal(actionCall[1].postComment, false, 'issue_master must not post a second comment');
  assert.equal(actionCall[1].commentMd, '');
  assert.deepEqual(actionCall[1].actions.map(action => action.kind), ['add_label']);
  assert.ok(published.data.applied.includes('添加标签：bug'));
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action='agent.publish' AND target_id=?").get(draftId));
  assert.equal((await session.request(`/api/agent/drafts/${draftId}/publish`, 'POST', {})).status, 409);

  const other = addTestMember(db, { githubId: '502', login: 'bob' });
  assert.notEqual(other.id, member.id);
  const otherSession = client(other.id);
  assert.equal((await otherSession.request(`/api/agent/drafts/${draftId}/publish`, 'POST', {})).status, 404);
  // The owner cannot decline an already published draft either.
  assert.equal((await session.request(`/api/agent/drafts/${draftId}/decline`, 'POST', {})).status, 409);
});

test('publishing without GitHub write authorization keeps the draft pending', async t => {
  const { session, token, base } = await setup(t, { githubToken: false });
  const created = await session.request('/api/items/github:101/agent-task', 'POST', {});
  const submitted = await agentRequest(base, token, `/api/agent/tasks/${created.data.task.id}/submit`, 'POST', { draft: { comment_md: '修复建议' } });
  const published = await session.request(`/api/agent/drafts/${submitted.data.draft.id}/publish`, 'POST', {});
  assert.equal(published.status, 409);
  const drafts = await session.request('/api/agent/drafts');
  assert.equal(drafts.data.drafts[0].status, 'pending');
  assert.match(drafts.data.drafts[0].publishError, /授权 GitHub/);
});

test('demo mode simulates publish and refuses knowledge base access', async t => {
  const fixture = await httpFixture(t, { config: { demo: true } });
  const member = addTestMember(fixture.db, { githubId: '501', login: 'alice' });
  insertItem(fixture.db, testItem());
  const session = fixture.client(member.id);
  await session.request('/api/session');
  const token = (await session.request('/api/agent/tokens', 'POST', { name: 'demo agent' })).data.token;
  const created = await session.request('/api/items/github:101/agent-task', 'POST', {});
  const submitted = await agentRequest(fixture.base, token, `/api/agent/tasks/${created.data.task.id}/submit`, 'POST', { draft: { comment_md: '演示草稿' } });
  assert.equal(submitted.status, 201);
  const published = await session.request(`/api/agent/drafts/${submitted.data.draft.id}/publish`, 'POST', {});
  assert.equal(published.status, 200);
  assert.equal(published.data.simulated, true);
  const search = await agentRequest(fixture.base, token, '/api/agent/kb/search', 'POST', { repo: 'AISBench/benchmark', question: 'x' });
  assert.equal(search.status, 503);
});
