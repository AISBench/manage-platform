// Never include upstream response bodies, URLs, request options, or original errors
// in errors: all of them may contain credentials or authorization codes.
export class IntegrationError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'IntegrationError';
    if (Number.isInteger(status)) this.status = status;
  }
}

export function requiredString(value, field, maxLength = 8192) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new IntegrationError(`Invalid ${field}`);
  }
  return value;
}

export async function requestJson(url, { fetchImpl = fetch, timeoutMs = 10000, label = 'Integration', ...options } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new IntegrationError('Invalid integration timeout');
  }
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new IntegrationError(`${label} request timed out`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    // Race the complete operation, including body consumption; also bound mocks
    // and nonstandard fetch implementations which ignore AbortSignal.
    return await Promise.race([timeout, (async () => {
      let response;
      try {
        response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
      } catch {
        throw new IntegrationError(`${label} network request failed`);
      }
      if (!response?.ok) {
        const status = response?.status;
        const error = new IntegrationError(`${label} request failed${Number.isInteger(status) ? ` (HTTP ${status})` : ''}`, status);
        if (status === 429 || (status === 403 && response.headers?.get('x-ratelimit-remaining') === '0')) {
          const retry = response.headers?.get('retry-after');
          const reset = Number(response.headers?.get('x-ratelimit-reset')) * 1000;
          let when = retry && /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry || '');
          if (!Number.isFinite(when)) when = Number.isFinite(reset) && reset > Date.now() ? reset : Date.now() + 60000;
          error.retryAt = Math.min(Date.now() + 86400000, Math.max(Date.now() + 1000, when));
        }
        if ([400,401,403].includes(status) && !error.retryAt) error.permanent = true;
        throw error;
      }
      let data;
      try { data = await response.json(); } catch {
        throw new IntegrationError(`${label} returned invalid JSON`);
      }
      if (data === null || typeof data !== 'object') throw new IntegrationError(`${label} returned invalid data`);
      return { data, headers: response.headers };
    })()]);
  } finally {
    clearTimeout(timer);
  }
}
