import { IntegrationError } from './integrations/http.js';
import { decryptToken, encryptToken } from './github-tokens.js';

// Custom-bot webhooks work across Feishu tenants and also for Lark
// international users, so they are the default personal notification channel.
const ALLOWED_HOSTS = new Set(['open.feishu.cn', 'open.larksuite.com']);
const WEBHOOK_PATH = /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{8,128}$/;
const invalid = () => Object.assign(new IntegrationError('飞书机器人地址不合法，仅支持 open.feishu.cn 或 open.larksuite.com 的 https Webhook'), { status: 400, code: 'INVALID_WEBHOOK_URL' });

export function normalizeWebhookUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.trim()) throw invalid();
  let url;
  try { url = new URL(value.trim()); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) throw invalid();
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host) || !WEBHOOK_PATH.test(url.pathname)) throw invalid();
  return { url: url.href, host };
}

export function saveWebhook(db, memberId, value, config, version) {
  const { url, host } = normalizeWebhookUrl(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new IntegrationError('Invalid Feishu webhook version');
  if (!config.tokenEncryptionKey) {
    throw Object.assign(new Error('服务端未配置 TOKEN_ENCRYPTION_KEY，个人机器人通道暂不可用'), { status: 503, code: 'TOKEN_STORAGE_UNAVAILABLE' });
  }
  const encrypted = encryptToken(url, config);
  db.prepare(`INSERT INTO feishu_webhooks(member_id,host,encrypted_url,url_iv,url_tag,status,binding_version,bound_at,verified_at)
    VALUES (?,?,?,?,?,'needs_confirmation',?,?,NULL) ON CONFLICT(member_id) DO UPDATE SET
    host=excluded.host,encrypted_url=excluded.encrypted_url,url_iv=excluded.url_iv,url_tag=excluded.url_tag,
    status='needs_confirmation',binding_version=excluded.binding_version,bound_at=excluded.bound_at,verified_at=NULL`)
    .run(memberId, host, encrypted.encrypted, encrypted.iv, encrypted.tag, version, new Date().toISOString());
  return { host };
}

export function getWebhook(db, memberId) {
  return db.prepare('SELECT * FROM feishu_webhooks WHERE member_id=?').get(memberId) || null;
}

export function decryptWebhookUrl(row, config) {
  if (!row) return null;
  return decryptToken({ encrypted_token: row.encrypted_url, token_iv: row.url_iv, token_tag: row.url_tag }, config);
}

export function webhookView(db, memberId) {
  const row = getWebhook(db, memberId);
  if (!row) return { bound: false, verified: false, host: '', boundAt: null, verifiedAt: null };
  return { bound: true, verified: row.status === 'active' && !!row.verified_at, host: row.host, boundAt: row.bound_at, verifiedAt: row.verified_at };
}

export function deleteWebhook(db, memberId) {
  return Number(db.prepare('DELETE FROM feishu_webhooks WHERE member_id=?').run(memberId).changes);
}
