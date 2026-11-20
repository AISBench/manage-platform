import { createHash, randomBytes, randomUUID } from 'node:crypto';

// Personal access tokens for user Agents (MCP / custom scripts).
// The plaintext token is returned exactly once; only its SHA-256 hash and a
// short prefix are stored so a database leak cannot be replayed.
const TOKEN_RE = /^ask_[A-Za-z0-9_-]{43}$/;
const LAST_USED_THROTTLE_MS = 60000;

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createAgentToken(db, { memberId, name }) {
  const token = `ask_${randomBytes(32).toString('base64url')}`;
  const id = randomUUID();
  const prefix = token.slice(0, 10);
  db.prepare('INSERT INTO agent_tokens(id,member_id,name,token_hash,token_prefix,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, memberId, name, hashToken(token), prefix, new Date().toISOString());
  return { id, token, prefix };
}

export function listAgentTokens(db, memberId) {
  return db.prepare('SELECT id,name,token_prefix,created_at,last_used_at FROM agent_tokens WHERE member_id=? AND revoked_at IS NULL ORDER BY created_at DESC')
    .all(memberId)
    .map(row => ({ id: row.id, name: row.name, prefix: row.token_prefix, createdAt: row.created_at, lastUsedAt: row.last_used_at || null }));
}

export function revokeAgentToken(db, memberId, id) {
  const result = db.prepare('UPDATE agent_tokens SET revoked_at=? WHERE id=? AND member_id=? AND revoked_at IS NULL')
    .run(new Date().toISOString(), id, memberId);
  return result.changes > 0;
}

// Resolve a Bearer token to an active member. Unknown/revoked tokens and
// disabled members both return null so callers cannot distinguish them.
export function resolveAgentToken(db, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const row = db.prepare(`SELECT t.id AS token_id,t.member_id,t.last_used_at,t.name AS token_name,t.token_prefix,m.github_login,m.display_name,m.status
    FROM agent_tokens t JOIN members m ON m.id=t.member_id
    WHERE t.token_hash=? AND t.revoked_at IS NULL`).get(hashToken(token));
  if (!row || row.status !== 'active') return null;
  const last = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  if (!Number.isFinite(last) || Date.now() - last >= LAST_USED_THROTTLE_MS) {
    try { db.prepare('UPDATE agent_tokens SET last_used_at=? WHERE id=?').run(new Date().toISOString(), row.token_id); }
    catch { /* last_used_at is best-effort audit data */ }
  }
  return { tokenId: row.token_id, memberId: row.member_id, login: row.github_login || '', name: row.display_name || row.github_login || '', agentName: row.token_name || '', tokenPrefix: row.token_prefix || '', scopes: ['kb', 'draft'] };
}
