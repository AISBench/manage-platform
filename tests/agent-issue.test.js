import test from 'node:test';
import assert from 'node:assert/strict';
import { addTestMember, httpFixture, insertItem, testItem } from './helpers.js';
import { saveGitHubToken } from '../server/github-tokens.js';
import { parseIssueTemplates, renderIssueBody } from '../server/issue-templates.js';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
const BUG_TEMPLATE = `name: Bug
description: 提交程序中的错误或异常
title: "[Bug] "
labels: ["bug", "待处理"]
body:
  - type: input
    id: os_and_version
    attributes:
      label: 操作系统及版本
    validations:
      required: true
  - type: textarea
    id: actual
    attributes:
      label: 实际行为
    validations:
      required: true
  - type: checkboxes
    id: checks
    attributes:
      label: 前置检查
      options:
        - label: 我已搜索过现有Issue，无重复问题
          required: true
`;

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

function issueDraft({ title = '[Bug] 评测任务在 vllm_api_stream_chat 下崩溃', actual = '执行命令后进程直接退出，日志只有 traceback。' } = {}, overrides = {}) {
  return {
    kind: 'issue_create',
    templateId: '001_bug',
    title,
    fields: { os_and_version: 'ubuntu 20.04', actual, checks: ['我已搜索过现有Issue，无重复问题'] },
    labels: ['bug', '待处理'],
    supplement: '',
    dedupe: {
      queries: ['vllm_api_stream_chat 崩溃', '评测任务 traceback'],
      candidates: [
        { number: 555, title: '其他问题', url: 'https://github.com/AISBench/benchmark/issues/555', state: 'open' },
        { number: 556, title: '另一个问题', url: 'https://github.com/AISBench/benchmark/issues/556', state: 'closed' },
        { number: 557, title: '无关问题', url: 'https://github.com/AISBench/benchmark/issues/557', state: 'open' },
      ],
      conclusion: 'not_duplicate',
      rationale: '现有 Issue 讨论的是数据集配置错误，与本问题的 vllm_api_stream_chat 启动崩溃现象、堆栈和复现命令都不同，因此不构成重复。',
    },
    summary: '评测任务崩溃',
    model: 'test-model',
    ...overrides,
  };
}

async function setup(t, { searchItems = [], onCreate } = {}) {
  const created = [];
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith('/contents/.github/ISSUE_TEMPLATE') || target.includes('/contents/.github/ISSUE_TEMPLATE?')) {
      return json([{ name: '001_bug.yml', path: '.github/ISSUE_TEMPLATE/001_bug.yml', type: 'file' }]);
    }
    if (target.includes('/contents/.github/ISSUE_TEMPLATE/001_bug.yml')) {
      return new Response(BUG_TEMPLATE, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    if (target.includes('/search/issues')) {
      return json({ items: searchItems });
    }
    if (/\/repos\/AISBench\/benchmark\/issues$/.test(target) && options.method === 'POST') {
      const body = JSON.parse(options.body || '{}');
      created.push({ body, authorization: options.headers?.Authorization || options.headers?.authorization });
      if (onCreate) return onCreate(body);
      return json({ number: 9001, html_url: 'https://github.com/AISBench/benchmark/issues/9001', labels: (body.labels || []).map(name => ({ name })) }, 201);
    }
    throw new Error(`Unexpected external HTTP: ${target}`);
  };
  const fixture = await httpFixture(t, { config: { tokenEncryptionKey: TEST_KEY }, fetchImpl });
  const member = addTestMember(fixture.db, { githubId: '501', login: 'alice' });
  for (const label of ['bug', '待处理']) {
    fixture.db.prepare('INSERT OR REPLACE INTO repository_labels(name,color,description,updated_at) VALUES (?,?,?,?)').run(label, 'ff0000', '', new Date().toISOString());
  }
  const session = fixture.client(member.id);
  await session.request('/api/session');
  const token = (await session.request('/api/agent/tokens', 'POST', { name: 'issue agent' })).data.token;
  saveGitHubToken(fixture.db, { memberId: member.id, login: 'alice', githubUserId: '501', token: 'member-token', scopes: 'public_repo' }, fixture.config);
  return { ...fixture, member, session, token, created };
}

test('issue task exposes templates and publishes through the member token with the required labels', async t => {
  const { db, session, token, created, base } = await setup(t);
  const task = await session.request('/api/agent/issue-tasks', 'POST', { requirement: '在 vllm_api_stream_chat 评测时进程崩溃，需要按 bug 模板提交 Issue 说明复现步骤' });
  assert.equal(task.status, 201);
  assert.equal(task.data.task.kind, 'issue_create');
  assert.equal(task.data.task.itemId, null);

  const queued = await agentRequest(base, token, '/api/agent/tasks');
  assert.equal(queued.status, 200);
  assert.equal(queued.data.tasks[0].kind, 'issue_create');
  const taskId = queued.data.tasks[0].id;
  assert.equal((await agentRequest(base, token, `/api/agent/tasks/${taskId}/claim`, 'POST', {})).status, 200);

  const context = await agentRequest(base, token, `/api/agent/tasks/${taskId}/context`);
  assert.equal(context.status, 200);
  assert.equal(context.data.kind, 'issue_create');
  assert.equal(context.data.templates[0].id, '001_bug');
  assert.ok(context.data.labels.includes('bug'));
  assert.match(context.data.instructions, /aisbench_issue_search/);

  const submitted = await agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', { draft: issueDraft() });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.data));
  assert.equal(submitted.data.draft.kind, 'issue_create');
  assert.equal(submitted.data.draft.payload.templateId, '001_bug');

  const drafts = await session.request('/api/agent/drafts');
  assert.equal(drafts.data.drafts.length, 1);
  assert.equal(drafts.data.drafts[0].kind, 'issue_create');
  assert.match(drafts.data.drafts[0].payload.body, /### 实际行为/);

  const published = await session.request(`/api/agent/drafts/${drafts.data.drafts[0].id}/publish`, 'POST', {});
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal(published.data.issueUrl, 'https://github.com/AISBench/benchmark/issues/9001');
  assert.equal(created.length, 1);
  assert.equal(created[0].authorization, 'Bearer member-token');
  assert.deepEqual(created[0].body.labels, ['bug', '待处理']);
  assert.match(created[0].body.body, /本 Issue 由 Agent/);
  assert.equal(db.prepare("SELECT status FROM agent_drafts WHERE kind='issue_create'").get().status, 'published');
});

test('issue draft must satisfy the template labels and required fields', async t => {
  const { session, token, base } = await setup(t);
  const task = await session.request('/api/agent/issue-tasks', 'POST', { requirement: '需要提交一个 bug 类型的 Issue，附上复现步骤和环境信息' });
  const taskId = task.data.task.id;
  await agentRequest(base, token, `/api/agent/tasks/${taskId}/claim`, 'POST', {});

  const missingLabel = await agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', { draft: issueDraft({}, { labels: ['bug'] }) });
  assert.equal(missingLabel.status, 400);
  assert.match(missingLabel.data.error, /缺少模板标签/);

  const missingField = await agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', {
    draft: issueDraft({}, { fields: { os_and_version: '', actual: 'x' } }),
  });
  assert.equal(missingField.status, 400);
  assert.match(missingField.data.error, /模板必填字段缺失/);
});

test('publishing blocks an unconfirmed high-similarity issue', async t => {
  const title = '[Bug] 评测任务在 vllm_api_stream_chat 下崩溃';
  const actual = '执行命令后进程直接退出，日志只有 traceback。';
  const template = parseIssueTemplates([{ name: '001_bug.yml', text: BUG_TEMPLATE }])[0];
  const fields = { os_and_version: 'ubuntu 20.04', actual, checks: ['我已搜索过现有Issue，无重复问题'] };
  const body = renderIssueBody(template, fields, '');
  const duplicate = { number: 555, title, state: 'open', html_url: 'https://github.com/AISBench/benchmark/issues/555', body, labels: [], updated_at: new Date().toISOString() };
  const { session, token, base, created } = await setup(t, { searchItems: [duplicate] });
  const task = await session.request('/api/agent/issue-tasks', 'POST', { requirement: '提交评测崩溃问题，并确认没有重复 Issue 后再创建' });
  const taskId = task.data.task.id;
  await agentRequest(base, token, `/api/agent/tasks/${taskId}/claim`, 'POST', {});
  const submitted = await agentRequest(base, token, `/api/agent/tasks/${taskId}/submit`, 'POST', { draft: issueDraft({ title, actual }, { fields }) });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.data));
  assert.ok(submitted.data.draft.payload.duplicates[0].similarity >= 0.8);

  const draftId = submitted.data.draft.id;
  const blocked = await session.request(`/api/agent/drafts/${draftId}/publish`, 'POST', {});
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /存在相近 Issue 未确认/);
  assert.equal(created.length, 0);

  const confirmed = await session.request(`/api/agent/drafts/${draftId}/publish`, 'POST', { confirmedDuplicates: [555] });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.equal(created.length, 1);
});
