import { requestJson } from './http.js';

// The token is never included in user-facing messages or logs.
function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function disabled() {
  return fail(503, 'ISSUE_MASTER_DISABLED', '未配置 Issue Master 接入（ISSUE_MASTER_URL / ISSUE_MASTER_TOKEN）');
}

function mapError(error) {
  const status = error?.status;
  if (status === 401 || status === 403) return fail(502, 'ISSUE_MASTER_AUTH_FAILED', 'Issue Master 接入令牌无效或已过期');
  if (status === 422) return fail(400, 'ISSUE_MASTER_REPO_UNSUPPORTED', 'Issue Master 未托管该仓库');
  if (status === 429) return fail(429, 'ISSUE_MASTER_RATE_LIMITED', 'Issue Master 请求过于频繁，请稍后重试');
  if (status === 400) return fail(400, 'ISSUE_MASTER_INVALID_REQUEST', 'Issue Master 拒绝了该请求，请检查 issue 编号与提示内容');
  if (status >= 500) return fail(502, 'ISSUE_MASTER_UPSTREAM_ERROR', 'Issue Master 服务返回错误，请查看其日志');
  return fail(503, 'ISSUE_MASTER_UNAVAILABLE', '无法连接 Issue Master 服务，请检查网络与地址配置');
}

export function createIssueMasterClient(config, { fetchImpl = fetch } = {}) {
  const base = (config.issueMasterUrl || '').replace(/\/+$/, '');
  const token = config.issueMasterToken || '';
  const configured = Boolean(base && token);
  const timeoutMs = config.issueMasterTimeoutMs || 15000;

  async function call(path, options = {}) {
    try {
      const { data } = await requestJson(`${base}${path}`, {
        fetchImpl, timeoutMs, label: 'Issue Master',
        ...options,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(options.headers || {}) },
      });
      return data;
    } catch (error) { throw mapError(error); }
  }

  return {
    configured,
    async trigger({ repo, number, hint = '', requester = '', requestId = '' } = {}) {
      if (!configured) throw disabled();
      return call('/api/v1/issue/handle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(requestId ? { 'X-Request-ID': requestId } : {}) },
        body: JSON.stringify({ repo, number, hint, requester, requestId }),
      });
    },
    async latest({ repo, number } = {}) {
      if (!configured) throw disabled();
      const query = new URLSearchParams({ repo: String(repo || ''), number: String(number || '') });
      return call(`/api/v1/issue/tasks/latest?${query}`);
    },
    // Read-only knowledge base search backed by deepwiki; never generates text.
    async searchKb({ repo, question, topK } = {}) {
      if (!configured) throw disabled();
      return call('/api/v1/kb/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, question, ...(topK ? { topK: Number(topK) } : {}) }),
      });
    },
    async wiki({ repo, topic } = {}) {
      if (!configured) throw disabled();
      const query = new URLSearchParams({ repo: String(repo || ''), topic: String(topic || '') });
      return call(`/api/v1/kb/wiki?${query}`);
    },
    // Publishing is triggered only after a human confirms the draft on the platform.
    async publish({ repo, number, commentMd, actions, requester, idempotencyKey, postComment = true } = {}) {
      if (!configured) throw disabled();
      return call('/api/v1/issue/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, number, comment_md: commentMd, actions: actions || [], requester, idempotencyKey, post_comment: postComment }),
      });
    },
  };
}
