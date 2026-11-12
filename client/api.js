let csrfToken = '';

export function setCsrfToken(token) {
  csrfToken = token || '';
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, signal, headers = {} } = {}) {
  let response;
  const mutation = method !== 'GET' && method !== 'HEAD';
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(mutation ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('网络连接失败，请检查网络后重试。', 0);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const hint = response.status === 401 ? '登录已过期，请重新通过 GitHub 登录。' : response.status === 403 ? '没有权限执行此操作，或安全令牌已过期。请重新登录后重试。' : response.status === 409 ? '版本或身份冲突，未覆盖现有数据；请刷新后重新确认。' : '请求失败，请稍后重试。';
    throw new ApiError(data?.error ? `${hint}（${data.error}）` : hint, response.status);
  }
  if (data === null) throw new ApiError('服务返回了无法识别的数据，请稍后重试。', response.status);
  return data;
}
