import test from 'node:test';
import assert from 'node:assert/strict';
import { addTestMember, httpFixture, insertItem, testItem } from './helpers.js';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
const HEAD_SHA = 'b'.repeat(40);
const SKILL_SHA = 'c'.repeat(40);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function agentRequest(base, token, route, method = 'GET', body) {
  return fetch(base + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async response => ({ status: response.status, data: await response.json().catch(() => null) }));
}

function prDraft(overrides = {}) {
  return {
    kind: 'pr_result',
    issueNumber: 101,
    prUrl: 'https://github.com/AISBench/benchmark/pull/777',
    prNumber: 777,
    headSha: HEAD_SHA,
    baseRef: 'master',
    headRef: 'fix/issue-101',
    forkOwner: 'alice',
    prTitle: 'fix: 评测任务崩溃',
    gate: [{ name: 'pytest', status: 'PASS', evidence: 'pytest -q smoke_tests 通过' }],
    unverified: [],
    summary: '修复评测崩溃',
    model: 'test-model',
    ...overrides,
  };
}

async function setup(t, { prTitle = 'fix: 评测任务崩溃', prBody = 'Fixes #101' } = {}) {
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/commits?per_page=1')) return json([{ sha: SKILL_SHA }]);
    if (target.includes('/contents/.agents/skills/')) {
      return new Response(`# ${target.split('/').slice(-2, -1)[0]} skill`, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    if (/\/pulls\/777$/.test(target) && options.method === 'GET') {
      return json({
        number: 777, state: 'open', title: prTitle, body: prBody,
        user: { login: 'alice' },
        base: { ref: 'master', repo: { full_name: 'AISBench/benchmark' } },
        head: { ref: 'fix/issue-101', sha: HEAD_SHA, repo: { full_name: 'alice/benchmark', fork: true, owner: { login: 'alice' } } },
        merged_at: null,
      });
    }
    if (target.includes('/check-runs')) return json({ check_runs: [{ status: 'completed', conclusion: 'success' }] });
    if (target.includes('/statuses')) return json([{ state: 'success' }]);
    throw new Error(`Unexpected external HTTP: ${target}`);
  };
  const fixture = await httpFixture(t, { config: { tokenEncryptionKey: TEST_KEY }, fetchImpl });
  const member = addTestMember(fixture.db, { githubId: '501', login: 'alice' });
  insertItem(fixture.db, testItem());
  const session = fixture.client(member.id);
  await session.request('/api/session');
  const token = (await session.request('/api/agent/tokens', 'POST', { name: 'pr agent' })).data.token;
  return { ...fixture, member, session, token };
}

test('PR task is idempotent, injects the devflow skill and validates the PR result', async t => {
  const { session, token, base } = await setup(t);
  const first = await session.request('/api/items/github:101/agent-task', 'POST', { kind: 'pr_create' });
  assert.equal(first.status, 201);
  assert.equal(first.data.task.kind, 'pr_create');
  const second = await session.request('/api/items/github:101/agent-task', 'POST', { kind: 'pr_create' });
  assert.equal(second.status, 200);
  assert.equal(second.data.task.id, first.data.task.id);

  const taskId = first.data.task.id;
  assert.equal((await agentRequest(base, token, `/api/agent/tasks/${taskId}/claim`, 'POST', {})).status, 200);
  const context = await agentRequest(base, token, `/api/agent/tasks/${taskId}/context`);
  assert.equal(context.status, 200);
  assert.equal(context.data.kind, 'pr_create');
  assert.equal(context.data.devflow.sha, SKILL_SHA);
  assert.equal(context.data.devflow.skill.name, 'aisbench-devflow');
  assert.match(context.data.instructions, /不做合入|不执行合入/);

  const mismatch = await agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', { draft: prDraft({ headSha: 'd'.repeat(40) }) });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.data.error, /head/);

  const submitted = await agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', { draft: prDraft() });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.data));
  assert.equal(submitted.data.draft.kind, 'pr_result');
  assert.equal(submitted.data.draft.payload.checks.state, 'success');

  const refreshed = await session.request(`/api/agent/drafts/${submitted.data.draft.id}/refresh`, 'POST', {});
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.draft.payload.checks.state, 'success');

  const accepted = await session.request(`/api/agent/drafts/${submitted.data.draft.id}/publish`, 'POST', {});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.prUrl, 'https://github.com/AISBench/benchmark/pull/777');
});

test('PR result is rejected when the linked issue or gate evidence does not match', async t => {
  const { session, token, base } = await setup(t);
  const created = await session.request('/api/items/github:101/agent-task', 'POST', { kind: 'pr_create' });
  const taskId = created.data.task.id;
  await agentRequest(base, token, `/api/agent/tasks/${taskId}/claim`, 'POST', {});

  const wrongIssue = await agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', { draft: prDraft({ issueNumber: 999 }) });
  assert.equal(wrongIssue.status, 400);
  assert.match(wrongIssue.data.error, /Issue 与任务不一致/);

  const failingGate = await agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', {
    draft: prDraft({ gate: [{ name: 'pytest', status: 'FAIL', evidence: '2 failed' }] }),
  });
  assert.equal(failingGate.status, 400);
  assert.match(failingGate.data.error, /FAIL/);
});

test('garbled PR title or body is rejected before acceptance', async t => {
  const { session, token, base } = await setup(t, {
    prTitle: '[refactor]?? model_postprocessors ????',
    prBody: 'Fixes #101\n\n???????? ???? ???? ???? ???? ???? ???? ???? ???? ???? ???? ???? ????',
  });
  const created = await session.request('/api/items/github:101/agent-task', 'POST', { kind: 'pr_create' });
  const taskId = created.data.task.id;
  await agentRequest(base, token, `/api/agent/tasks/${taskId}/claim`, 'POST', {});
  const submitted = await agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', { draft: prDraft() });
  assert.equal(submitted.status, 400);
  assert.match(submitted.data.error, /编码损坏/);
});
