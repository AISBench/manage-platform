import test from 'node:test';
import assert from 'node:assert/strict';
import { addTestMember, httpFixture, insertItem, testItem } from './helpers.js';
import { resolveAgentToken } from '../server/agent-tokens.js';
import { saveGitHubToken } from '../server/github-tokens.js';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

function fakeAgentAdaptor(overrides = {}) {
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
      if (overrides.publishError) throw Object.assign(new Error(overrides.publishError), { status: 502, code: 'AGENT_ADAPTOR_UPSTREAM_ERROR' });
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

async function setup(t, { item = testItem(), config = {}, agentAdaptor, githubToken = true } = {}) {
  const comments = [];
  const replies = [];
  const reviews = [];
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (/\/pulls\/(?:9100|9504)\/files\?/.test(target) && options.method === 'GET') {
      return new Response(JSON.stringify([
        { filename: 'tools/config.py', status: 'modified', additions: 2, deletions: 1, changes: 3, patch: '@@ -1,2 +1,3 @@\n-old\n+new' },
        { filename: 'docs/readme.md', status: 'added', additions: 1, deletions: 0, changes: 1, patch: '@@ -0,0 +1,1 @@\n+hello' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (/\/pulls\/\d+\/reviews$/.test(target) && options.method === 'POST') {
      reviews.push({ url: target, body: JSON.parse(options.body || '{}'), authorization: options.headers?.Authorization || options.headers?.authorization });
      return new Response(JSON.stringify({ id: 777, html_url: 'https://github.com/AISBench/benchmark/pull/9504#pullrequestreview-777', state: 'COMMENTED' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (/\/pulls\/\d+\/comments\/555\/replies$/.test(target) && options.method === 'POST') {
      replies.push({ url: target, body: JSON.parse(options.body || '{}'), authorization: options.headers?.Authorization || options.headers?.authorization });
      return new Response(JSON.stringify({ id: 999, html_url: 'https://github.com/AISBench/benchmark/pull/9502#discussion_r999', created_at: new Date().toISOString(), in_reply_to_id: 555 }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (target.includes('/issues/101/comments') && options.method === 'POST') {
      comments.push({ url: target, body: JSON.parse(options.body || '{}'), authorization: options.headers?.Authorization || options.headers?.authorization });
      return new Response(JSON.stringify({ id: 9101, html_url: 'https://github.com/AISBench/benchmark/issues/101#issuecomment-9101', created_at: new Date().toISOString() }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected external HTTP: ${target}`);
  };
  const fixture = await httpFixture(t, { integrations: agentAdaptor ? { agentAdaptor } : {}, config: { tokenEncryptionKey: TEST_KEY, ...config }, fetchImpl });
  const member = addTestMember(fixture.db, { githubId: '501', login: 'alice' });
  insertItem(fixture.db, item);
  const session = fixture.client(member.id);
  await session.request('/api/session');
  const created = await session.request('/api/agent/tokens', 'POST', { name: 'my agent' });
  assert.equal(created.status, 201);
  if (githubToken) saveGitHubToken(fixture.db, { memberId: member.id, login: 'alice', githubUserId: '501', token: 'member-token', scopes: 'public_repo' }, fixture.config);
  return { ...fixture, member, session, token: created.data.token, tokenId: created.data.id, comments, replies, reviews };
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

test('pull request review task context includes PR metadata and file patches', async t => {
  const item = {
    ...testItem(), id: 'github:9100', number: 9100, kind: 'pr', title: 'Fix config loading',
    url: 'https://github.com/AISBench/benchmark/pull/9100',
    reviewers: ['reviewer-chen'], reviewerIds: ['1002'], draft: false, mergeableState: 'clean',
    headSha: 'a1b2c3d4', ciStatus: 'success',
  };
  const { session, token, base } = await setup(t, { item });
  const created = await session.request('/api/items/github:9100/agent-task', 'POST', { hint: '重点看配置兼容性' });
  assert.equal(created.status, 201);
  assert.equal(created.data.task.hint, '重点看配置兼容性');
  const taskId = created.data.task.id;
  assert.equal((await agentRequest(base, token, `/api/agent/tasks/${taskId}/claim`, 'POST', {})).status, 200);

  const context = await agentRequest(base, token, `/api/agent/tasks/${taskId}/context`);
  assert.equal(context.status, 200);
  assert.equal(context.data.kind, 'pr');
  assert.equal(context.data.pr.mergeableState, 'clean');
  assert.equal(context.data.pr.ciStatus, 'success');
  assert.deepEqual(context.data.pr.reviewers, ['reviewer-chen']);
  assert.equal(context.data.files.length, 2);
  assert.equal(context.data.files[0].path, 'tools/config.py');
  assert.match(context.data.files[0].patch, /@@/);
  assert.equal(context.data.files[1].path, 'docs/readme.md');
  assert.equal(context.data.filesTruncated, false);
  assert.equal(context.data.reviewGuide.summaryMaxChars, 600);

  const direct = await agentRequest(base, token, '/api/agent/items/github:9100/context');
  assert.equal(direct.status, 200);
  assert.equal(direct.data.files.length, 2);
});

test('pull request context reports unreadable files instead of failing', async t => {
  const item = { ...testItem(), id: 'github:9101', number: 9101, kind: 'pr', title: 'Unreadable diff' };
  const { token, base } = await setup(t, { item });
  const context = await agentRequest(base, token, '/api/agent/items/github:9101/context');
  assert.equal(context.status, 200);
  assert.equal(context.data.kind, 'pr');
  assert.deepEqual(context.data.files, []);
  assert.match(context.data.filesError, /无法读取该 PR 的变更文件/);
});

test('agent can draft a threaded reply to one inline review comment', async t => {
  const item = { ...testItem(), id: 'github:9502', number: 9502, kind: 'pr', title: 'Fix race', url: 'https://github.com/AISBench/benchmark/pull/9502' };
  const { session, token, db, base, replies, comments } = await setup(t, { item });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO item_messages(id,item_id,source,kind,github_comment_id,author_login,author_avatar_url,body,url,path,line,delivery_status,remote_deleted,created_at,updated_at,synced_at,diff_hunk,start_line,side,thread_resolved,thread_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'synced',0,?,?,?,?,?,?,0,?)`).run(
    'msg-review-1', 'github:9502', 'github', 'review_comment', 'review_comment:555', 'reviewer-chen', '',
    '这里可能有并发问题', 'https://github.com/AISBench/benchmark/pull/9502#discussion_r555',
    'tools/config.py', 12, now, now, now, '@@ -10,3 +10,4 @@', null, 'RIGHT', 'thread-1');

  const created = await session.request('/api/items/github:9502/agent-task', 'POST', { messageId: 'msg-review-1', hint: '已经加了锁，说明锁的范围' });
  assert.equal(created.status, 201);
  assert.equal(created.data.task.hint, '已经加了锁，说明锁的范围');
  assert.equal(created.data.task.replyTo.reviewCommentId, '555');
  assert.equal(created.data.task.replyTo.author, 'reviewer-chen');
  assert.match(created.data.task.replyTo.body, /并发/);

  const taskId = created.data.task.id;
  assert.equal((await agentRequest(base, token, `/api/agent/tasks/${taskId}/claim`, 'POST', {})).status, 200);
  const context = await agentRequest(base, token, `/api/agent/tasks/${taskId}/context`);
  assert.equal(context.status, 200);
  assert.equal(context.data.replyTo.reviewCommentId, '555');
  assert.equal(context.data.replyTo.path, 'tools/config.py');
  assert.equal(context.data.replyTo.thread.length, 1);
  assert.match(context.data.replyTo.thread[0].body, /并发/);
  assert.equal(context.data.task.hint, '已经加了锁，说明锁的范围');

  const submitted = await agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', {
    draft: { comment_md: '已经加上锁保护，锁的范围覆盖整个写入路径。', model: 'm' },
  });
  assert.equal(submitted.status, 201);
  const published = await session.request(`/api/agent/drafts/${submitted.data.draft.id}/publish`, 'POST', {});
  assert.equal(published.status, 200);
  assert.equal(replies.length, 1, 'the reply must use the review-comment replies endpoint');
  assert.match(replies[0].url, /\/pulls\/9502\/comments\/555\/replies$/);
  assert.equal(replies[0].authorization, 'Bearer member-token');
  assert.match(replies[0].body.body, /本评论由 Agent/);
  assert.equal(comments.length, 0, 'anchored replies must not create a top-level issue comment');

  const row = db.prepare('SELECT kind,github_comment_id,in_reply_to_id,path,line FROM item_messages WHERE github_comment_id=?').get('review_comment:999');
  assert.equal(row.kind, 'review_comment');
  assert.equal(row.in_reply_to_id, '555');
  assert.equal(row.path, 'tools/config.py');
  assert.equal(row.line, 12);
});

test('anchored reply requires an existing PR review comment', async t => {
  const { session } = await setup(t);
  assert.equal((await session.request('/api/items/github:101/agent-task', 'POST', { messageId: 'missing' })).status, 400);
});

test('multiple anchored replies can run in parallel on one item', async t => {
  const item = { ...testItem(), id: 'github:9503', number: 9503, kind: 'pr', title: 'Parallel replies' };
  const { session, db } = await setup(t, { item });
  const now = new Date().toISOString();
  const insertComment = (id, remoteId, body, line) => db.prepare(`INSERT INTO item_messages(id,item_id,source,kind,github_comment_id,author_login,author_avatar_url,body,path,line,delivery_status,remote_deleted,created_at,updated_at,synced_at,thread_resolved)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,0)`).run(
    id, 'github:9503', 'github', 'review_comment', `review_comment:${remoteId}`, 'reviewer-chen', '',
    body, 'tools/config.py', line, 'synced', now, now, now);
  insertComment('msg-review-2', '556', '第一条检视意见', 20);
  insertComment('msg-review-3', '557', '第二条检视意见', 21);

  assert.equal((await session.request('/api/items/github:9503/agent-task', 'POST', {})).status, 201);
  const first = await session.request('/api/items/github:9503/agent-task', 'POST', { messageId: 'msg-review-2', hint: '回复第一条' });
  assert.equal(first.status, 201);
  const second = await session.request('/api/items/github:9503/agent-task', 'POST', { messageId: 'msg-review-3', hint: '回复第二条' });
  assert.equal(second.status, 201);
  assert.notEqual(first.data.task.id, second.data.task.id);

  const duplicate = await session.request('/api/items/github:9503/agent-task', 'POST', { messageId: 'msg-review-2', hint: '重复点击' });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.task.id, first.data.task.id);

  const queue = await session.request('/api/items/github:9503/agent-tasks');
  assert.equal(queue.status, 200);
  assert.equal(queue.data.tasks.length, 3);
  assert.equal(queue.data.tasks.filter(task => task.replyTo).length, 2);
});

test('issue comment can be answered by the caller agent with a quoted reply', async t => {
  const { session, token, db, base, comments } = await setup(t);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO item_messages(id,item_id,source,kind,github_comment_id,author_login,author_avatar_url,body,url,delivery_status,remote_deleted,created_at,updated_at,synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'msg-issue-1', 'github:101', 'github', 'issue_comment', 'comment:321', 'reviewer-chen', '',
    '这里的行为是否符合预期？', 'https://github.com/AISBench/benchmark/issues/101#issuecomment-321', 'synced', 0, now, now, now);

  const created = await session.request('/api/items/github:101/agent-task', 'POST', { messageId: 'msg-issue-1', hint: '说明这是预期行为' });
  assert.equal(created.status, 201);
  assert.equal(created.data.task.replyTo.kind, 'issue_comment');
  assert.equal(created.data.task.replyTo.author, 'reviewer-chen');
  const taskId = created.data.task.id;
  assert.equal((await agentRequest(base, token, `/api/agent/tasks/${taskId}/claim`, 'POST', {})).status, 200);

  const context = await agentRequest(base, token, `/api/agent/tasks/${taskId}/context`);
  assert.equal(context.status, 200);
  assert.equal(context.data.replyTo.kind, 'issue_comment');
  assert.match(context.data.replyTo.body, /是否符合预期/);
  assert.equal(context.data.task.hint, '说明这是预期行为');

  const submitted = await agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', { draft: { comment_md: '这是预期行为，原因是…', model: 'm' } });
  assert.equal(submitted.status, 201);
  const published = await session.request(`/api/agent/drafts/${submitted.data.draft.id}/publish`, 'POST', {});
  assert.equal(published.status, 200);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body.body, /^> 回复 @reviewer-chen/);
  assert.match(comments[0].body.body, /本评论由 Agent/);
  const row = db.prepare('SELECT kind,github_comment_id,in_reply_to_id FROM item_messages WHERE github_comment_id=?').get('comment:9101');
  assert.equal(row.kind, 'platform');
  assert.equal(row.in_reply_to_id, 'comment:321');
});

test('PR review draft publishes multiple line comments as one review', async t => {
  const item = { ...testItem(), id: 'github:9504', number: 9504, kind: 'pr', title: 'Review me', url: 'https://github.com/AISBench/benchmark/pull/9504' };
  const { session, token, db, base, reviews, comments } = await setup(t, { item });
  const created = await session.request('/api/items/github:9504/agent-task', 'POST', { hint: '重点看并发与文档' });
  const taskId = created.data.task.id;
  assert.equal((await agentRequest(base, token, `/api/agent/tasks/${taskId}/claim`, 'POST', {})).status, 200);
  const submitted = await agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', {
    draft: {
      summary: '两处问题', comment_md: '检视意见如下', model: 'm',
      comments: [
        { path: 'tools/config.py', line: 1, side: 'RIGHT', body: '[review] [major] 这里存在并发风险\n[suggestion] 使用锁保护整个写入路径' },
        { path: 'docs/readme.md', line: 1, side: 'RIGHT', body: '[review] [minor] 文档缺少说明\n[suggestion] 补充参数与示例' },
      ],
    },
  });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.data.draft.comments.length, 2);

  const published = await session.request(`/api/agent/drafts/${submitted.data.draft.id}/publish`, 'POST', {});
  assert.equal(published.status, 200);
  assert.equal(reviews.length, 1, 'inline findings must be submitted as one review');
  assert.match(reviews[0].url, /\/pulls\/9504\/reviews$/);
  assert.equal(reviews[0].authorization, 'Bearer member-token');
  assert.equal(reviews[0].body.event, 'COMMENT');
  assert.equal(reviews[0].body.comments.length, 2);
  assert.equal(reviews[0].body.comments[0].path, 'tools/config.py');
  assert.match(reviews[0].body.body, /本评论由 Agent/);
  assert.equal(comments.length, 0, 'a line review must not create a top-level issue comment');

  const row = db.prepare('SELECT kind,state,github_comment_id FROM item_messages WHERE github_comment_id=?').get('review:777');
  assert.equal(row.kind, 'review');
  assert.equal(row.state, 'COMMENTED');
});

test('PR review draft requires valid line anchors', async t => {
  const item = { ...testItem(), id: 'github:9504', number: 9504, kind: 'pr', title: 'Review me' };
  const { session, token, base } = await setup(t, { item });
  const created = await session.request('/api/items/github:9504/agent-task', 'POST', {});
  const taskId = created.data.task.id;
  assert.equal((await agentRequest(base, token, `/api/agent/tasks/${taskId}/claim`, 'POST', {})).status, 200);
  const submit = comments => agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', { draft: { comment_md: '摘要', comments } });
  assert.equal((await submit([])).status, 400, 'a PR review needs at least one inline comment');
  const invalid = await submit([{ path: 'tools/config.py', line: 999, side: 'RIGHT', body: '[review] [minor] x\n[suggestion] y' }]);
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.error, /行内意见定位无效/);
  const badFormat = await submit([{ path: 'tools/config.py', line: 1, side: 'RIGHT', body: '没有按格式写' }]);
  assert.equal(badFormat.status, 400);
  assert.match(badFormat.data.error, /格式必须为/);
  const longSummary = await agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', {
    draft: { comment_md: 'x'.repeat(601), comments: [{ path: 'tools/config.py', line: 1, side: 'RIGHT', body: '[review] [minor] x\n[suggestion] y' }] },
  });
  assert.equal(longSummary.status, 400);
  assert.match(longSummary.data.error, /600/);
});

test('issue page can read the full draft inline and keeps it after publish', async t => {
  const { session, token, base } = await setup(t, { agentAdaptor: fakeAgentAdaptor() });
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

test('kb routes proxy to agent-adaptor and validate input', async t => {
  const agentAdaptor = fakeAgentAdaptor();
  const { token, base } = await setup(t, { agentAdaptor });
  const search = await agentRequest(base, token, '/api/agent/kb/search', 'POST', { repo: 'AISBench/benchmark', question: '评测 JSON 字段', topK: 5 });
  assert.equal(search.status, 200);
  assert.equal(search.data.chunks[0].path, 'tools/config.py');
  assert.deepEqual(agentAdaptor.calls[0], ['searchKb', { repo: 'AISBench/benchmark', question: '评测 JSON 字段', topK: 5 }]);
  const wiki = await agentRequest(base, token, '/api/agent/kb/wiki?repo=AISBench%2Fbenchmark&topic=eval');
  assert.equal(wiki.status, 200);
  assert.equal(wiki.data.text, '# page');
  assert.equal((await agentRequest(base, token, '/api/agent/kb/search', 'POST', { repo: 'AISBench/benchmark', question: '' })).status, 400);
  assert.equal((await agentRequest(base, 'ask_invalid', '/api/agent/me')).status, 401);
});

test('publishing posts as the member, discloses the Agent, and only runs actions through agent_adaptor', async t => {
  const agentAdaptor = fakeAgentAdaptor();
  const { session, token, db, base, member, client, comments } = await setup(t, { agentAdaptor });
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
  const actionCall = agentAdaptor.calls.at(-1);
  assert.equal(actionCall[0], 'publish');
  assert.equal(actionCall[1].postComment, false, 'agent_adaptor must not post a second comment');
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
