import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fetchRepositoryItems, normalizeIssue, verifyGitHubSignature } from '../server/integrations/github.js';
import { exchangeFeishuCode, feishuAuthorizeUrl, sendFeishuMessage } from '../server/integrations/feishu.js';

const API = 'https://api.github.com/repos/AISBench/benchmark';
const SHA = 'a'.repeat(40);
const SECRET = 'credential-must-not-appear';
const issue = (number, extra = {}) => ({ number, state: 'open', title: `Item ${number}`, body: null, html_url: `https://github.com/AISBench/benchmark/issues/${number}`, user: { login: 'alice' }, assignees: [{ login: 'bob' }], labels: [{ name: 'bug' }], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z', ...extra });
const pull = (number = 2, extra = {}) => ({ number, requested_reviewers: [{ login: 'carol' }], draft: true, mergeable_state: 'blocked', head: { sha: SHA }, ...extra });
const response = (data, headers = {}, status = 200) => new Response(JSON.stringify(data), { status, headers });
const listUrl = `${API}/issues?state=all&per_page=100&page=1`;
const statusUrl = `${API}/commits/${SHA}/status?per_page=100&page=1`;
const checksUrl = `${API}/commits/${SHA}/check-runs?per_page=100&page=1&filter=latest`;

function mockRoutes(routes, inspect = () => {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    url = String(url);
    calls.push({ url, options });
    inspect(url, options);
    assert.ok(Object.hasOwn(routes, url), `Unexpected mocked HTTP request: ${url}`);
    const route = routes[url];
    return typeof route === 'function' ? route(options) : response(route);
  };
  return { fetchImpl, calls };
}
function prRoutes(overrides = {}) {
  return {
    [listUrl]: [issue(2, { pull_request: {} })],
    [`${API}/pulls/2`]: pull(),
    [statusUrl]: { statuses: [] },
    [checksUrl]: { check_runs: [] },
    ...overrides,
  };
}
const sync = options => fetchRepositoryItems({ repo: 'AISBench/benchmark', token: SECRET, ...options });
const oauthOptions = { appId: 'cli_app', appSecret: SECRET, code: 'private-code', redirectUri: 'https://example.com/auth/feishu/callback?source=bind' };
const feishuToken = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const feishuUser = 'https://open.feishu.cn/open-apis/authen/v1/user_info';
const tenantToken = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const messageUrl = 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id';
const messageOptions = { appId: 'cli_app', appSecret: SECRET, openId: 'ou_user', title: '提醒 "测试"', text: '需要处理\n任务', url: 'https://github.com/AISBench/benchmark/issues/1', uuid: 'reminder-123' };
const sanitized = pattern => error => {
  assert.match(error.message, pattern);
  assert.equal(String(error.stack).includes(SECRET), false);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
};

test('normalization excludes local workflow fields and handles deleted author, labels and empty body', () => {
  const item = normalizeIssue(issue(1, { user: null, assignees: [{ login: 'bob' }, { login: 'bob' }], labels: ['help wanted', { name: 'bug' }, null] }));
  assert.equal(item.id, 'github:1');
  assert.equal(item.kind, 'issue');
  assert.equal(item.body, '');
  assert.equal(item.author, '');
  assert.deepEqual(item.assignees, ['bob']);
  assert.deepEqual(item.labels, ['help wanted', 'bug']);
  assert.deepEqual(item.reviewers, []);
  assert.equal(item.ciStatus, null);
  for (const field of ['workflow', 'owner', 'priority', 'dueAt', 'overdue']) assert.equal(Object.hasOwn(item, field), false);
  assert.throws(() => normalizeIssue({ number: 0, state: 'open' }), /invalid issue/);
});

test('normalization preserves closed PR state and optional merged indication', () => {
  const item = normalizeIssue(issue(3, { state: 'closed', pull_request: { merged_at: '2026-01-01T00:00:00Z' } }));
  assert.equal(item.state, 'closed');
  assert.equal(item.kind, 'pr');
  assert.equal(item.merged, true);
});

test('sync paginates state=all, deduplicates, enriches only open PRs and uses GET only', async () => {
  const second = `${API}/issues?state=all&per_page=100&page=2`;
  const mock = mockRoutes(prRoutes({
    [listUrl]: () => response([issue(1), issue(2, { pull_request: {} })], { Link: `<${second}>; rel="next", <${second}>; rel="last"` }),
    [second]: [issue(1), issue(3, { state: 'closed', pull_request: {} })],
    [statusUrl]: { statuses: [{ context: 'legacy', state: 'success' }] },
    [checksUrl]: { check_runs: [{ id: 1, name: 'tests', status: 'completed', conclusion: 'success' }] },
  }), (_, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
  });
  const items = await sync(mock);
  assert.equal(items.length, 3);
  const pr = items.find(item => item.number === 2);
  assert.deepEqual(pr.reviewers, ['carol']);
  assert.equal(pr.draft, true);
  assert.equal(pr.mergeableState, 'blocked');
  assert.equal(pr.ciStatus, 'success');
  assert.equal(items.find(item => item.number === 3).state, 'closed');
  assert.equal(mock.calls.some(call => call.url.endsWith('/pulls/3')), false);
});

test('GitHub canonical numeric-repository cursor pagination preserves all issue states', async () => {
  // Mirrors GitHub's real Link header for AISBench/benchmark.
  const second = 'https://api.github.com/repositories/1076721820/issues?state=all&per_page=100&page=2&after=Y3Vyc29yOnYyOpLPAAABoLdoLUjPAAAAAUg-sBU%3D';
  const third = 'https://api.github.com/repositories/1076721820/issues?state=all&per_page=100&page=3&after=next-cursor';
  const mock = mockRoutes({
    [listUrl]: () => response([issue(1)], { Link: `<${second}>; rel="next"` }),
    [second]: () => response([issue(2, { state: 'closed' })], { Link: `<${third}>; rel="next"` }),
    [third]: [issue(3)],
  });
  const items = await sync(mock);
  assert.deepEqual(items.map(item => item.number), [1, 2, 3]);
  assert.equal(items[1].state, 'closed');
  assert.equal(mock.calls.length, 3);
});

test('canonical numeric-repository pagination supports exact commit status and check-runs suffixes', async () => {
  const secondStatus = `https://api.github.com/repositories/1076721820/commits/${SHA}/status?per_page=100&page=2`;
  const secondChecks = `https://api.github.com/repositories/1076721820/commits/${SHA}/check-runs?per_page=100&page=2&filter=latest`;
  const mock = mockRoutes(prRoutes({
    [statusUrl]: () => response({ statuses: [{ context: 'lint', state: 'success' }] }, { Link: `<${secondStatus}>; rel="next"` }),
    [secondStatus]: { statuses: [{ context: 'build', state: 'success' }] },
    [checksUrl]: () => response({ check_runs: [{ id: 1, name: 'lint', status: 'completed', conclusion: 'success' }] }, { Link: `<${secondChecks}>; rel="next"` }),
    [secondChecks]: { check_runs: [{ id: 2, name: 'tests', status: 'completed', conclusion: 'failure' }] },
  }));
  assert.equal((await sync(mock))[0].ciStatus, 'failure');
  assert.equal(mock.calls.length, 6);
});

test('canonical pagination rejects resource changes and later numeric repository ID changes', async () => {
  for (const suffix of ['pulls', 'issues/1', `commits/${SHA}/status`]) {
    const target = `https://api.github.com/repositories/1076721820/${suffix}?state=all&per_page=100&page=2`;
    const mock = mockRoutes({ [listUrl]: () => response([issue(1)], { Link: `<${target}>; rel="next"` }) });
    await assert.rejects(sync(mock), /unsafe pagination/);
    assert.equal(mock.calls.length, 1);
  }
  const second = 'https://api.github.com/repositories/1076721820/issues?state=all&per_page=100&page=2';
  const changed = 'https://api.github.com/repositories/9999999999/issues?state=all&per_page=100&page=3';
  const mock = mockRoutes({
    [listUrl]: () => response([issue(1)], { Link: `<${second}>; rel="next"` }),
    [second]: () => response([issue(2)], { Link: `<${changed}>; rel="next"` }),
  });
  await assert.rejects(sync(mock), /unsafe pagination/);
  assert.equal(mock.calls.length, 2);
});

test('full pages without Link continue through the final partial page', async () => {
  const mock = mockRoutes({
    [listUrl]: Array.from({ length: 100 }, (_, index) => issue(index + 1)),
    [`${API}/issues?state=all&per_page=100&page=2`]: [issue(101, { state: 'closed' })],
  });
  assert.equal((await sync(mock)).length, 101);
  assert.equal(mock.calls.length, 2);
});

test('status and check-runs are paginated, superseded failures do not poison current success', async () => {
  const secondStatus = `${API}/commits/${SHA}/status?per_page=100&page=2`;
  const secondChecks = `${API}/commits/${SHA}/check-runs?per_page=100&page=2&filter=latest`;
  const mock = mockRoutes(prRoutes({
    [statusUrl]: () => response({ statuses: [{ context: 'lint', state: 'success' }] }, { Link: `<${secondStatus}>; rel="next"` }),
    [secondStatus]: { statuses: [{ context: 'lint', state: 'failure' }, { context: 'build', state: 'success' }] },
    [checksUrl]: () => response({ check_runs: [{ id: 11, name: 'test', app: { id: 1 }, status: 'completed', conclusion: 'success' }] }, { Link: `<${secondChecks}>; rel="next"` }),
    [secondChecks]: { check_runs: [{ id: 10, name: 'test', app: { id: 1 }, status: 'completed', conclusion: 'failure' }] },
  }));
  assert.equal((await sync(mock))[0].ciStatus, 'success');
  assert.equal(mock.calls.length, 6);
});

for (const [name, status, checks, expected] of [
  ['no check data', [], [], 'unknown'],
  ['pending legacy status', [{ context: 'ci', state: 'pending' }], [], 'pending'],
  ['running check', [], [{ status: 'in_progress' }], 'pending'],
  ['cancelled check', [], [{ status: 'completed', conclusion: 'cancelled' }], 'failure'],
  ['legacy failure beats pending', [{ context: 'ci', state: 'error' }], [{ status: 'queued' }], 'failure'],
  ['neutral and skipped checks', [], [{ id: 1, name: 'lint', status: 'completed', conclusion: 'neutral' }, { id: 2, name: 'test', status: 'completed', conclusion: 'skipped' }], 'success'],
]) {
  test(`CI aggregation: ${name}`, async () => {
    const mock = mockRoutes(prRoutes({ [statusUrl]: { statuses: status }, [checksUrl]: { check_runs: checks } }));
    assert.equal((await sync(mock))[0].ciStatus, expected);
  });
}

test('failure on later check page is included in CI result', async () => {
  const secondChecks = `${API}/commits/${SHA}/check-runs?per_page=100&page=2&filter=latest`;
  const mock = mockRoutes(prRoutes({
    [checksUrl]: () => response({ check_runs: [{ id: 1, name: 'lint', status: 'completed', conclusion: 'success' }] }, { Link: `<${secondChecks}>; rel="next"` }),
    [secondChecks]: { check_runs: [{ id: 2, name: 'tests', status: 'completed', conclusion: 'failure' }] },
  }));
  assert.equal((await sync(mock))[0].ciStatus, 'failure');
});

test('403 on combined status also preserves best-effort unknown CI', async () => {
  const mock = mockRoutes(prRoutes({ [statusUrl]: () => response({ message: SECRET }, {}, 403) }));
  assert.equal((await sync(mock))[0].ciStatus, 'unknown');
});

test('403 on checks is best effort unknown, never an unearned green result', async () => {
  const mock = mockRoutes(prRoutes({ [statusUrl]: { statuses: [{ context: 'legacy', state: 'success' }] }, [checksUrl]: () => response({ message: SECRET }, {}, 403) }));
  assert.equal((await sync(mock))[0].ciStatus, 'unknown');
});

test('core GitHub failures and non-403 check failures abort sync with sanitized errors', async () => {
  for (const [endpoint, status] of [[listUrl, 401], [`${API}/pulls/2`, 403], [checksUrl, 500]]) {
    const mock = mockRoutes(prRoutes({ [endpoint]: () => response({ message: SECRET }, {}, status) }));
    await assert.rejects(sync(mock), sanitized(new RegExp(`HTTP ${status}`)));
  }
});

test('unsafe, inconsistent and looping pagination fail without forwarding credentials', async () => {
  for (const target of ['https://attacker.example/collect', `${API}/pulls?state=all&per_page=100&page=2`, `${API}/issues?state=open&per_page=100&page=2`, listUrl]) {
    const mock = mockRoutes({ [listUrl]: () => response([issue(1)], { Link: `<${target}>; rel="next"` }) });
    await assert.rejects(sync(mock), /pagination/);
    assert.equal(mock.calls.length, 1);
  }
});

test('GitHub validates repository and malformed core list/PR data', async () => {
  await assert.rejects(sync({ repo: '../benchmark', fetchImpl: () => assert.fail('no request expected') }), /Invalid GitHub repository/);
  await assert.rejects(sync(mockRoutes({ [listUrl]: { items: [] } })), /invalid list/);
  for (const malformed of [null, { number: '../private', state: 'open', pull_request: {} }]) {
    const mock = mockRoutes({ [listUrl]: [malformed] });
    await assert.rejects(sync(mock), /invalid issue/);
    assert.equal(mock.calls.length, 1);
  }
  await assert.rejects(sync(mockRoutes(prRoutes({ [`${API}/pulls/2`]: { number: 99 } }))), /invalid pull/);
});

test('GitHub signature validates exact raw bytes and rejects malformed signatures without throwing', () => {
  const raw = Buffer.from('{"message":"中文"}\n');
  const signature = `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  assert.equal(verifyGitHubSignature(raw, signature, SECRET), true);
  assert.equal(verifyGitHubSignature(new Uint8Array(raw), signature, SECRET), true);
  assert.equal(verifyGitHubSignature(raw.toString(), signature, SECRET), true);
  assert.equal(verifyGitHubSignature(Buffer.concat([raw, Buffer.from(' ')]), signature, SECRET), false);
  for (const invalid of [undefined, '', 'sha1=123', 'sha256=00', `sha256=${'z'.repeat(64)}`, `${signature},${signature}`]) assert.equal(verifyGitHubSignature(raw, invalid, SECRET), false);
  assert.equal(verifyGitHubSignature(raw, signature, ''), false);
  assert.equal(verifyGitHubSignature({}, signature, SECRET), false);
  assert.equal(verifyGitHubSignature(raw, signature, 'wrong-secret'), false);
});

test('Feishu authorize URL uses modern client_id, exact encoded callback and OAuth state', () => {
  const url = new URL(feishuAuthorizeUrl({ appId: 'cli_test', redirectUri: oauthOptions.redirectUri, state: 'a+b&c=/中文' }));
  assert.equal(url.origin, 'https://accounts.feishu.cn');
  assert.equal(url.pathname, '/open-apis/authen/v1/authorize');
  assert.equal(url.searchParams.get('client_id'), 'cli_test');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), oauthOptions.redirectUri);
  assert.equal(url.searchParams.get('state'), 'a+b&c=/中文');
  assert.equal(url.searchParams.has('scope'), false);
  assert.throws(() => feishuAuthorizeUrl({ appId: 'cli_test', redirectUri: 'javascript:alert(1)', state: 'state' }), /redirect URI/);
  assert.throws(() => feishuAuthorizeUrl({ appId: 'cli_test', redirectUri: oauthOptions.redirectUri, state: '' }), /OAuth state/);
});

test('Feishu exchanges v2 OAuth code then calls user_info and never returns tokens', async () => {
  const mock = mockRoutes({
    [feishuToken]: options => {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { grant_type: 'authorization_code', client_id: oauthOptions.appId, client_secret: SECRET, code: oauthOptions.code, redirect_uri: oauthOptions.redirectUri });
      assert.equal(options.headers.Authorization, undefined);
      return response({ code: 0, access_token: 'private-user-token' });
    },
    [feishuUser]: options => {
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer private-user-token');
      return response({ code: 0, data: { open_id: 'ou_user', name: '张三', email: 'not-returned' } });
    },
  });
  assert.deepEqual(await exchangeFeishuCode({ ...oauthOptions, ...mock }), { openId: 'ou_user', name: '张三' });
  assert.equal(mock.calls.length, 2);
});

test('Feishu OAuth rejects API errors even on HTTP 200 and never treats legacy token shape as v2', async () => {
  for (const tokenResponse of [{ code: 20002, error_description: SECRET }, { error: 'invalid_grant', error_description: SECRET }, { code: 0, data: { access_token: SECRET } }]) {
    const mock = mockRoutes({ [feishuToken]: tokenResponse });
    await assert.rejects(exchangeFeishuCode({ ...oauthOptions, ...mock }), sanitized(/Feishu/));
    assert.equal(mock.calls.length, 1);
  }
});

test('Feishu OAuth fails closed on invalid user identity or user-info application errors', async () => {
  for (const result of [{ code: 0, data: { name: 'No ID' } }, { code: 20005, msg: SECRET }]) {
    const mock = mockRoutes({ [feishuToken]: { code: 0, access_token: 'user-token' }, [feishuUser]: result });
    await assert.rejects(exchangeFeishuCode({ ...oauthOptions, ...mock }), sanitized(/Feishu/));
  }
});

test('Feishu sends personal app text using tenant token, JSON content and deduplication UUID', async () => {
  const mock = mockRoutes({
    [tenantToken]: options => {
      assert.deepEqual(JSON.parse(options.body), { app_id: 'cli_app', app_secret: SECRET });
      return response({ code: 0, tenant_access_token: 'private-tenant-token' });
    },
    [messageUrl]: options => {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer private-tenant-token');
      const payload = JSON.parse(options.body);
      assert.equal(payload.receive_id, 'ou_user');
      assert.equal(payload.msg_type, 'text');
      assert.equal(payload.uuid, 'reminder-123');
      assert.deepEqual(JSON.parse(payload.content), { text: `${messageOptions.title}\n\n${messageOptions.text}\n\n${messageOptions.url}` });
      return response({ code: 0, data: { message_id: 'om_result' } });
    },
  });
  assert.deepEqual(await sendFeishuMessage({ ...messageOptions, ...mock }), { messageId: 'om_result' });
  assert.equal(mock.calls.length, 2);
});

test('Feishu bounds message content before sending and handles Unicode truncation', async () => {
  const mock = mockRoutes({
    [tenantToken]: { code: 0, tenant_access_token: 'tenant-token' },
    [messageUrl]: options => {
      const payload = JSON.parse(options.body);
      const text = JSON.parse(payload.content).text;
      assert.ok(text.length <= 6202);
      assert.equal(text.includes('\uFFFD'), false);
      assert.ok(Buffer.byteLength(options.body) < 32000);
      assert.equal(payload.uuid.length, 36);
      return response({ code: 0, data: { message_id: 'bounded-message' } });
    },
  });
  await sendFeishuMessage({ ...messageOptions, uuid: undefined, title: '😀'.repeat(500), text: '中文😀'.repeat(5000), url: '', ...mock });
});

test('Feishu input validation is fail-fast, before tenant authentication', async () => {
  for (const change of [{ openId: '' }, { uuid: 'x'.repeat(51) }, { title: '', text: '', url: '' }, { url: 'javascript:alert(1)' }, { appSecret: '' }]) {
    await assert.rejects(sendFeishuMessage({ ...messageOptions, ...change, fetchImpl: () => assert.fail('no outbound request') }), /Invalid|empty/);
  }
});

test('Feishu tenant/message errors and malformed success responses are sanitized', async () => {
  for (const routes of [
    { [tenantToken]: { code: 999, msg: SECRET } },
    { [tenantToken]: { code: 0 } },
    { [tenantToken]: () => response({ msg: SECRET }, {}, 429) },
    { [tenantToken]: { code: 0, tenant_access_token: SECRET }, [messageUrl]: { code: 230013, msg: SECRET } },
    { [tenantToken]: { code: 0, tenant_access_token: SECRET }, [messageUrl]: { code: 0, data: {} } },
  ]) {
    await assert.rejects(sendFeishuMessage({ ...messageOptions, ...mockRoutes(routes) }), sanitized(/Feishu/));
  }
});

test('network errors and JSON parse errors cannot expose credentials', async () => {
  for (const fetchImpl of [async () => { throw new Error(`socket failed ${SECRET}`); }, async () => ({ ok: true, json: async () => { throw new Error(`parse failed ${SECRET}`); } })]) {
    await assert.rejects(sync({ fetchImpl }), sanitized(/GitHub.*(network|JSON)/));
    await assert.rejects(exchangeFeishuCode({ ...oauthOptions, fetchImpl }), sanitized(/Feishu.*(network|JSON)/));
  }
});

test('timeouts bound uncooperative fetch and stalled JSON consumption and abort the request', async () => {
  for (const mode of ['fetch', 'body']) {
    let signal;
    const fetchImpl = async (_, options) => {
      signal = options.signal;
      if (mode === 'fetch') return new Promise(() => {});
      return { ok: true, json: () => new Promise(() => {}) };
    };
    await assert.rejects(sync({ fetchImpl, timeoutMs: 10 }), sanitized(/timed out/));
    assert.equal(signal.aborted, true);
    await assert.rejects(exchangeFeishuCode({ ...oauthOptions, fetchImpl, timeoutMs: 10 }), sanitized(/timed out/));
    assert.equal(signal.aborted, true);
  }
});
