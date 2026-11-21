import { requestJson } from './http.js';

// The token is never included in user-facing messages or logs.
function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function disabled() {
  return fail(503, 'AGENT_ADAPTOR_DISABLED', '未配置 Agent Adaptor 接入（AGENT_ADAPTOR_URL / AGENT_ADAPTOR_TOKEN）');
}

function mapError(error) {
  const status = error?.status;
  if (status === 401 || status === 403) return fail(502, 'AGENT_ADAPTOR_AUTH_FAILED', 'Agent Adaptor 接入令牌无效或已过期');
  if (status === 422) return fail(400, 'AGENT_ADAPTOR_REPO_UNSUPPORTED', 'Agent Adaptor 未托管该仓库');
  if (status === 429) return fail(429, 'AGENT_ADAPTOR_RATE_LIMITED', 'Agent Adaptor 请求过于频繁，请稍后重试');
  if (status === 400) return fail(400, 'AGENT_ADAPTOR_INVALID_REQUEST', 'Agent Adaptor 拒绝了该请求，请检查 issue 编号与提示内容');
  if (status >= 500) return fail(502, 'AGENT_ADAPTOR_UPSTREAM_ERROR', 'Agent Adaptor 服务返回错误，请查看其日志');
  return fail(503, 'AGENT_ADAPTOR_UNAVAILABLE', '无法连接 Agent Adaptor 服务，请检查网络与地址配置');
}

export function createAgentAdaptorClient(config, { fetchImpl = fetch } = {}) {
  const base = (config.agentAdaptorUrl || '').replace(/\/+$/, '');
  const token = config.agentAdaptorToken || '';
  const configured = Boolean(base && token);
  const timeoutMs = config.agentAdaptorTimeoutMs || 15000;

  async function call(path, options = {}) {
    try {
      const { data } = await requestJson(`${base}${path}`, {
        fetchImpl, timeoutMs, label: 'Agent Adaptor',
        ...options,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(options.headers || {}) },
      });
      return data;
    } catch (error) { throw mapError(error); }
  }

  return {
    configured,
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
