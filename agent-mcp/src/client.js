const DEFAULT_TIMEOUT_MS = 30000;

function fail(message, status) {
  return Object.assign(new Error(message), { status });
}

export class PlatformClient {
  constructor({ baseUrl, token, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.token = token || '';
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    if (!this.baseUrl) throw new Error('AISBENCH_URL 未配置');
    if (!this.token) throw new Error('AISBENCH_TOKEN 未配置');
  }

  async call(path, { method = 'GET', body, query } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const message = data?.error ? `${data.error}（HTTP ${response.status}）` : `请求失败（HTTP ${response.status}）`;
        throw fail(message, response.status);
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw fail('请求超时，请检查 AISBENCH_URL 与网络', 0);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  me() { return this.call('/api/agent/me'); }
  tasks() { return this.call('/api/agent/tasks'); }
  claim(taskId) { return this.call(`/api/agent/tasks/${encodeURIComponent(taskId)}/claim`, { method: 'POST', body: {} }); }
  taskContext(taskId) { return this.call(`/api/agent/tasks/${encodeURIComponent(taskId)}/context`); }
  itemContext(itemId) { return this.call(`/api/agent/items/${encodeURIComponent(itemId)}/context`); }
  kbSearch({ repo, question, topK }) { return this.call('/api/agent/kb/search', { method: 'POST', body: { repo, question, ...(topK ? { topK } : {}) } }); }
  kbWiki({ repo, topic }) { return this.call('/api/agent/kb/wiki', { query: { repo, topic } }); }
  issueTemplates() { return this.call('/api/agent/issue-templates'); }
  issueSearch({ query, state, label }) { return this.call('/api/agent/issues/search', { query: { q: query, state, label } }); }
  submit(taskId, draft) { return this.call(`/api/agent/tasks/${encodeURIComponent(taskId)}/submit`, { method: 'POST', body: { draft } }); }
}
