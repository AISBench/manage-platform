import { randomUUID } from 'node:crypto';
import { IntegrationError, requestJson, requiredString } from './http.js';

const API = 'https://open.feishu.cn/open-apis';
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function redirectUrl(value) {
  requiredString(value, 'Feishu redirect URI', 4096);
  let url;
  try { url = new URL(value); } catch { throw new IntegrationError('Invalid Feishu redirect URI'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new IntegrationError('Invalid Feishu redirect URI');
  return value; // OAuth token exchange must preserve the exact redirect URI.
}

function credentials(appId, appSecret) {
  requiredString(appId, 'Feishu app ID', 256);
  requiredString(appSecret, 'Feishu app secret');
}

async function feishuRequest(path, options, label) {
  const { data } = await requestJson(`${API}${path}`, { ...options, label });
  // v2 OAuth has top-level access_token; v1 user_info and messages wrap data.
  if (data.code !== 0 || data.error) {
    const code = Number.isSafeInteger(data.code) ? ` (code ${data.code})` : '';
    const error = new IntegrationError(`${label} failed${code}`);
    error.code = Number.isSafeInteger(data.code) ? `FEISHU_${data.code}` : 'FEISHU_ERROR';
    if ([230002,230006,230013,230014,230017,99991663,99991668,99991672].includes(data.code)) error.permanent = true;
    throw error;
  }
  return data;
}

export function feishuAuthorizeUrl({ appId, redirectUri, state }) {
  requiredString(appId, 'Feishu app ID', 256);
  requiredString(state, 'Feishu OAuth state', 4096);
  const url = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUrl(redirectUri));
  url.searchParams.set('state', state);
  // Binding only needs user_info (no scopes required), not offline access.
  return url.href;
}

export async function exchangeFeishuCode({ appId, appSecret, code, redirectUri, fetchImpl = fetch, timeoutMs = 10000 }) {
  credentials(appId, appSecret);
  requiredString(code, 'Feishu authorization code');
  const redirect = redirectUrl(redirectUri);
  const token = await feishuRequest('/authen/v2/oauth/token', {
    fetchImpl, timeoutMs, method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ grant_type: 'authorization_code', client_id: appId, client_secret: appSecret, code, redirect_uri: redirect }),
  }, 'Feishu OAuth');
  if (typeof token.access_token !== 'string' || !token.access_token) throw new IntegrationError('Feishu OAuth returned no access token');
  const user = await feishuRequest('/authen/v1/user_info', {
    fetchImpl, timeoutMs, method: 'GET', headers: { Authorization: `Bearer ${token.access_token}` },
  }, 'Feishu user info');
  if (typeof user.data?.open_id !== 'string' || !user.data.open_id || typeof user.data?.name !== 'string') {
    throw new IntegrationError('Feishu returned invalid user info');
  }
  // Tokens are deliberately never returned, persisted, or logged.
  return { openId: user.data.open_id, name: user.data.name };
}

function boundedText(value, limit, field) {
  if (typeof value !== 'string') throw new IntegrationError(`Invalid Feishu ${field}`);
  const result = value.slice(0, limit);
  // Do not split a surrogate pair at the truncation boundary.
  return result.replace(/[\uD800-\uDBFF]$/, '');
}

export async function sendFeishuMessage({ appId, appSecret, openId, title = '', text = '', url = '', uuid = randomUUID(), fetchImpl = fetch, timeoutMs = 10000 }) {
  credentials(appId, appSecret);
  requiredString(openId, 'Feishu recipient', 256);
  requiredString(uuid, 'Feishu message UUID', 50);
  const parts = [boundedText(title, 200, 'message title'), boundedText(text, 6000, 'message text')].filter(Boolean);
  if (url) {
    requiredString(url, 'Feishu message URL', 2048);
    let link;
    try { link = new URL(url); } catch { throw new IntegrationError('Invalid Feishu message URL'); }
    if (!['https:', 'http:'].includes(link.protocol) || link.username || link.password) throw new IntegrationError('Invalid Feishu message URL');
    parts.push(link.href);
  }
  if (!parts.length) throw new IntegrationError('Feishu message is empty');
  // Plain text is not Markdown/card JSON. JSON.stringify handles quotes,
  // newlines and other user-controlled text without payload injection.
  const message = { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text: parts.join('\n\n') }), uuid };
  // Self-built/internal apps only. No cached credentials or automatic retries:
  // callers retain the UUID when retrying to use Feishu's one-hour deduplication.
  const tenant = await feishuRequest('/auth/v3/tenant_access_token/internal', {
    fetchImpl, timeoutMs, method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  }, 'Feishu tenant authentication');
  if (typeof tenant.tenant_access_token !== 'string' || !tenant.tenant_access_token) throw new IntegrationError('Feishu returned no tenant access token');
  const result = await feishuRequest('/im/v1/messages?receive_id_type=open_id', {
    fetchImpl, timeoutMs, method: 'POST',
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${tenant.tenant_access_token}` },
    body: JSON.stringify(message),
  }, 'Feishu message');
  if (typeof result.data?.message_id !== 'string' || !result.data.message_id) throw new IntegrationError('Feishu returned no message ID');
  return { messageId: result.data.message_id };
}
