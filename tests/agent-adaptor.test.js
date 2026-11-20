import test from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture } from './helpers.js';

const unavailable = () => Object.assign(new Error('无法连接 Agent Adaptor 服务'), { status: 503, code: 'AGENT_ADAPTOR_UNAVAILABLE' });

function fakeAgentAdaptor(options = {}) {
  const calls = [];
  return {
    calls,
    configured: options.configured !== false,
    async trigger(payload) {
      calls.push({ type: 'trigger', payload });
      if (options.triggerError) throw options.triggerError;
      return options.triggerResult || { taskId: 77, status: 'queued' };
    },
    async latest(payload) {
      calls.push({ type: 'latest', payload });
      if (options.latestError) throw options.latestError;
      return options.latestResult || {
        task: { id: 77, status: 'open', createdAt: '2026-11-17T10:00:00.000Z' },
        draft: null,
        feishuNotifyReady: true,
      };
    },
  };
}

test('agent adaptor trigger is administrator-only and limited to open issues', async t => {
  const agentAdaptor = fakeAgentAdaptor();
  const f = await httpFixture(t, { integrations: { agentAdaptor } });

  assert.equal((await f.client(null).request('/api/items/github:9001/agent-adaptor/handle', 'POST', {})).status, 401);
  assert.equal((await f.client('demo-reviewer').request('/api/items/github:9001/agent-adaptor/handle', 'POST', {})).status, 403);

  const admin = f.client('demo-admin');
  assert.equal((await admin.request('/api/items/github:9000/agent-adaptor/handle', 'POST', {})).status, 400, 'pull requests are rejected');
  assert.equal((await admin.request('/api/items/github:9999/agent-adaptor/handle', 'POST', {})).status, 404);

  const triggered = await admin.request('/api/items/github:9001/agent-adaptor/handle', 'POST', { hint: '看看复现步骤' });
  assert.equal(triggered.status, 202);
  assert.deepEqual(triggered.data, { taskId: 77, status: 'queued' });
  assert.equal(agentAdaptor.calls.length, 1);
  const call = agentAdaptor.calls[0];
  assert.equal(call.type, 'trigger');
  assert.equal(call.payload.repo, 'AISBench/benchmark');
  assert.equal(call.payload.number, 9001);
  assert.equal(call.payload.hint, '看看复现步骤');
  assert.equal(call.payload.requester, 'platform:demo-maintainer');
  assert.match(call.payload.requestId, /^[0-9a-f-]{36}$/);

  const audit = await admin.request('/api/admin/audit-logs?action=agent_adaptor.trigger');
  assert.equal(audit.data.logs[0].targetId, 'github:9001');
  assert.equal(audit.data.logs[0].after.taskId, 77);
});

test('agent adaptor status proxies task state and degrades honestly when unavailable', async t => {
  const agentAdaptor = fakeAgentAdaptor({
    latestResult: {
      task: { id: 77, status: 'consumed', createdAt: '2026-11-17T10:00:00.000Z' },
      draft: { status: 'pending_confirm', commentUrl: '', updatedAt: '2026-11-17T10:05:00.000Z' },
      feishuNotifyReady: false,
    },
  });
  const f = await httpFixture(t, { integrations: { agentAdaptor } });
  const admin = f.client('demo-admin');

  const status = await admin.request('/api/items/github:9001/agent-adaptor');
  assert.equal(status.status, 200);
  assert.equal(status.data.configured, true);
  assert.equal(status.data.task.status, 'consumed');
  assert.equal(status.data.draft.status, 'pending_confirm');
  assert.equal(status.data.feishuNotifyReady, false);
  assert.equal((await admin.request('/api/items/github:9000/agent-adaptor')).status, 400, 'pull requests have no processing state');

  const offline = await httpFixture(t, { integrations: { agentAdaptor: fakeAgentAdaptor({ latestError: unavailable() }) } });
  const offlineStatus = await offline.client('demo-admin').request('/api/items/github:9001/agent-adaptor');
  assert.equal(offlineStatus.status, 200);
  assert.equal(offlineStatus.data.available, false);
  assert.ok(offlineStatus.data.error);
});

test('unconfigured agent adaptor returns a disabled state without network access', async t => {
  const f = await httpFixture(t, {
    integrations: {
      agentAdaptor: fakeAgentAdaptor({
        configured: false,
        triggerError: Object.assign(new Error('未配置 Agent Adaptor 接入'), { status: 503, code: 'AGENT_ADAPTOR_DISABLED' }),
      }),
    },
  });
  const admin = f.client('demo-admin');
  assert.equal((await admin.request('/api/items/github:9001/agent-adaptor/handle', 'POST', {})).status, 503);
  const status = await admin.request('/api/items/github:9001/agent-adaptor');
  assert.deepEqual(status.data, { configured: false, available: false, demo: false });
});

test('demo mode simulates a trigger without calling agent_adaptor', async t => {
  const agentAdaptor = fakeAgentAdaptor();
  const f = await httpFixture(t, { config: { demo: true }, integrations: { agentAdaptor } });
  const admin = f.client('demo-admin');

  const triggered = await admin.request('/api/items/github:9001/agent-adaptor/handle', 'POST', {});
  assert.equal(triggered.status, 200);
  assert.deepEqual(triggered.data, { demo: true, simulated: true });
  assert.equal(agentAdaptor.calls.length, 0);

  const status = await admin.request('/api/items/github:9001/agent-adaptor');
  assert.equal(status.data.configured, false);
  assert.equal(status.data.demo, true);
});

test('triggering is rate limited per member', async t => {
  const f = await httpFixture(t, { integrations: { agentAdaptor: fakeAgentAdaptor() } });
  const admin = f.client('demo-admin');
  const statuses = [];
  for (let i = 0; i < 4; i += 1) statuses.push((await admin.request('/api/items/github:9001/agent-adaptor/handle', 'POST', {})).status);
  assert.deepEqual(statuses, [202, 202, 202, 429]);
});
