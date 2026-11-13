import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

function encryptionKey(config) {
  if (typeof config?.tokenEncryptionKey !== 'string' || !config.tokenEncryptionKey) return null;
  const key = Buffer.from(config.tokenEncryptionKey, 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return key;
}

export function encryptToken(token, config) {
  const key = encryptionKey(config);
  if (!key) throw Object.assign(new Error('GitHub 写入授权暂不可用：服务端未配置 TOKEN_ENCRYPTION_KEY'), { status: 503, code: 'TOKEN_STORAGE_UNAVAILABLE' });
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { encrypted: encrypted.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export function decryptToken(row, config) {
  const key = encryptionKey(config);
  if (!key || !row) return null;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(row.token_iv, 'base64'));
    decipher.setAuthTag(Buffer.from(row.token_tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(row.encrypted_token, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function saveGitHubToken(db, { memberId, login, githubUserId, token, scopes }, config) {
  if (!encryptionKey(config)) return false;
  const encrypted = encryptToken(token, config);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO github_user_tokens(member_id,github_login,github_user_id,encrypted_token,token_iv,token_tag,scopes,authorized_at,last_verified_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET
    github_login=excluded.github_login,github_user_id=excluded.github_user_id,encrypted_token=excluded.encrypted_token,
    token_iv=excluded.token_iv,token_tag=excluded.token_tag,scopes=excluded.scopes,authorized_at=excluded.authorized_at,last_verified_at=excluded.last_verified_at`)
    .run(memberId, login, githubUserId, encrypted.encrypted, encrypted.iv, encrypted.tag, scopes || '', now, now);
  return true;
}

export function getGitHubToken(db, memberId, config) {
  if (!encryptionKey(config)) return null;
  const row = db.prepare('SELECT * FROM github_user_tokens WHERE member_id=?').get(memberId);
  return decryptToken(row, config);
}

export function deleteGitHubToken(db, memberId) {
  return Number(db.prepare('DELETE FROM github_user_tokens WHERE member_id=?').run(memberId).changes);
}

export function githubTokenStatus(db, memberId) {
  const row = db.prepare('SELECT github_login,github_user_id,scopes,authorized_at,last_verified_at FROM github_user_tokens WHERE member_id=?').get(memberId);
  return row ? { ready: true, login: row.github_login, scopes: row.scopes || '', authorizedAt: row.authorized_at, verifiedAt: row.last_verified_at } : { ready: false, login: null, scopes: '', authorizedAt: null, verifiedAt: null };
}

export function markGitHubTokenVerified(db, memberId) {
  db.prepare('UPDATE github_user_tokens SET last_verified_at=? WHERE member_id=?').run(new Date().toISOString(), memberId);
}
