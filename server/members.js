import { randomUUID } from 'node:crypto';
import { addAudit, getSetting, setSetting } from './db.js';

class MemberError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.statusCode = status; this.code = code; }
}
const fail = (status, message, code) => new MemberError(status, message, code);
const loginPattern = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
function validLogin(login) { return typeof login === 'string' && login.trim() === login && loginPattern.test(login) && !login.includes('--'); }
export function normalizeProfile(profile) {
  if (!profile || !validLogin(profile.login) || (profile.type && profile.type !== 'User')) throw fail(400, 'Invalid verified GitHub user profile', 'INVALID_PROFILE');
  const id = profile.githubId ?? profile.id;
  if ((typeof id === 'number' && (!Number.isSafeInteger(id) || id <= 0)) || String(id).trim() !== String(id) || !/^[1-9]\d*$/.test(String(id))) throw fail(400, 'Invalid GitHub fixed user ID', 'INVALID_PROFILE');
  return { githubId: String(id), login: profile.login, name: typeof profile.name === 'string' ? profile.name.slice(0, 500) : '', avatarUrl: typeof profile.avatarUrl === 'string' ? profile.avatarUrl : typeof profile.avatar_url === 'string' ? profile.avatar_url : '', type: 'User' };
}
// The platform avatar always mirrors GitHub. Reject foreign avatar hosts and
// fall back to the stable numeric avatar URL when the profile omits one.
export function githubAvatar(profile) {
  profile = normalizeProfile(profile);
  if (profile.avatarUrl.startsWith('https://avatars.githubusercontent.com/')) return profile.avatarUrl;
  return `https://avatars.githubusercontent.com/u/${profile.githubId}?v=4`;
}
function text(value, name, max) {
  if (typeof value !== 'string' || value.length > max || value.includes('\u0000')) throw fail(400, `Invalid ${name}`, 'INVALID_INPUT');
  return value.trim();
}
function roleValue(role) { if (!['admin', 'member'].includes(role)) throw fail(400, 'Invalid member role', 'INVALID_INPUT'); return role; }
function transact(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function currentMember(db, id, version) {
  if (!Number.isSafeInteger(version) || version < 1) throw fail(400, 'A positive member version is required', 'INVALID_VERSION');
  const row = db.prepare('SELECT * FROM members WHERE id=?').get(id);
  if (!row) throw fail(404, 'Member not found', 'NOT_FOUND');
  if (row.version !== version) throw fail(409, 'Member changed; refresh and retry', 'VERSION_CONFLICT');
  return row;
}
function protectLastAdmin(db, member) {
  if (member.role === 'admin' && member.status === 'active' && !db.prepare("SELECT id FROM members WHERE id<>? AND role='admin' AND status='active' AND first_login_at IS NOT NULL LIMIT 1").get(member.id)) {
    throw fail(409, 'Cannot disable or demote the last activated administrator', 'LAST_ADMIN');
  }
}
function auditMember(row) { return { id: row.id, githubId: row.github_user_id, login: row.github_login, displayName: row.display_name, module: row.module, role: row.role, status: row.status, version: row.version }; }
function revokeMemberAccess(db, id) {
  db.prepare('DELETE FROM sessions WHERE member_id=? OR user_id IN (SELECT id FROM users WHERE member_id=?)').run(id, id);
  db.prepare('DELETE FROM oauth_states WHERE member_id=? OR user_id IN (SELECT id FROM users WHERE member_id=?)').run(id, id);
  db.prepare("UPDATE notifications SET status='cancelled',error_code='member_disabled',error=NULL WHERE recipient_member_id=? AND status IN ('pending','sending')").run(id);
  db.prepare("UPDATE feishu_bindings SET status='needs_confirmation',verified_at=NULL,binding_version=binding_version+1 WHERE member_id=?").run(id);
}

export async function resolveGitHubUser({ login, token = '', fetchImpl = fetch }) {
  if (!validLogin(login)) throw fail(400, 'Invalid GitHub username', 'INVALID_LOGIN');
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail(504, 'GitHub user lookup timed out', 'GITHUB_TIMEOUT')); }, 10000); });
  try {
    return await Promise.race([(async () => {
      const response = await fetchImpl(`https://api.github.com/users/${encodeURIComponent(login)}`, {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'aisbench-triage', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (response.status === 404) throw fail(404, 'GitHub user not found', 'GITHUB_NOT_FOUND');
      if (response.status === 403 || response.status === 429) throw fail(503, 'GitHub lookup unavailable or rate limited; retry later', 'GITHUB_UNAVAILABLE');
      if (!response.ok) throw fail(502, 'GitHub user lookup failed', 'GITHUB_UNAVAILABLE');
      const data = await response.json();
      if (data.type !== 'User' || data.bot === true || /\[bot\]$/i.test(data.login || '')) throw fail(400, 'Only personal GitHub user accounts are supported', 'GITHUB_USER_REQUIRED');
      let profile;
      try { profile = normalizeProfile(data); } catch { throw fail(502, 'GitHub returned an invalid user profile', 'GITHUB_INVALID_RESPONSE'); }
      return { ...profile, url: `https://github.com/${profile.login}` };
    })(), timeout]);
  } catch (error) {
    if (error instanceof MemberError && error.code?.startsWith('GITHUB_')) throw error;
    throw fail(502, 'GitHub user lookup failed; check connectivity and credentials', 'GITHUB_UNAVAILABLE');
  } finally { clearTimeout(timer); }
}

export function getMemberView(db, id, { appId = '', includeNotes = true } = {}) {
  const row = db.prepare(`SELECT m.*,u.name AS profile_name,u.avatar_url AS profile_avatar_url,u.notifications_enabled,
    b.app_id,b.status AS binding_status,b.bound_at,b.verified_at,b.member_id AS binding_id
    FROM members m LEFT JOIN users u ON u.member_id=m.id LEFT JOIN feishu_bindings b ON b.member_id=m.id WHERE m.id=?`).get(id);
  if (!row) return null;
  const feishuBound = !!row.binding_id && row.app_id === appId;
  const feishuVerified = feishuBound && row.binding_status === 'active' && !!row.verified_at;
  return { id: row.id, githubId: row.github_user_id, login: row.github_login, name: row.profile_name || row.github_login,
    displayName: row.display_name, avatarUrl: row.avatar_url || row.profile_avatar_url || '', module: row.module, ...(includeNotes ? { notes: row.notes } : {}),
    role: row.role, status: row.status, version: row.version, firstLoginAt: row.first_login_at, lastLoginAt: row.last_login_at,
    createdAt: row.created_at, updatedAt: row.updated_at, feishuBound, feishuVerified,
    notificationsEnabled: !!row.notifications_enabled, reachable: row.status === 'active' && feishuVerified && !!row.notifications_enabled };
}
export function listMemberViews(db, options = {}) {
  return db.prepare('SELECT id FROM members ORDER BY created_at,id').all().map(row => getMemberView(db, row.id, options));
}
function insertMember(db, { profile, displayName = '', module = '', notes = '', role = 'member', actorId = null, id = randomUUID(), status = 'pending_activation', firstLoginAt = null, lastLoginAt = null }) {
  const now = new Date().toISOString();
  if (db.prepare('SELECT id FROM members WHERE github_user_id=?').get(profile.githubId)) throw fail(409, 'GitHub identity already belongs to a member; edit or re-enable that record', 'DUPLICATE_IDENTITY');
  db.prepare(`INSERT INTO members(id,github_user_id,github_login,display_name,module,notes,role,status,created_by,first_login_at,last_login_at,avatar_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, profile.githubId, profile.login, displayName, module, notes, role, status, actorId, firstLoginAt, lastLoginAt, githubAvatar(profile), now, now);
  return id;
}
// Transaction-safe: callers own BEGIN/COMMIT. First GitHub login links (or
// creates) an active member; no application or administrator approval needed.
export function autoProvisionMemberInTransaction(db, { profile, requestId = null }) {
  profile = normalizeProfile(profile);
  const existing = db.prepare('SELECT * FROM members WHERE github_user_id=?').get(profile.githubId);
  if (existing?.status === 'disabled') throw fail(403, 'Disabled members must be re-enabled by an administrator', 'MEMBER_DISABLED');
  if (existing) return existing;
  const now = new Date().toISOString();
  const id = insertMember(db, { profile, status: 'active', firstLoginAt: now, lastLoginAt: now });
  const member = db.prepare('SELECT * FROM members WHERE id=?').get(id);
  addAudit(db, { action: 'member.auto_provision', targetType: 'member', targetId: id, after: auditMember(member), requestId });
  return member;
}
export function updateMember(db, id, changes, { actorId = null, requestId = null } = {}) {
  const allowed = new Set(['version', 'displayName', 'module', 'notes', 'role']);
  if (!changes || Object.keys(changes).some(key => !allowed.has(key))) throw fail(400, 'Unknown member field or immutable GitHub identity', 'INVALID_INPUT');
  const values = {};
  for (const [key, max] of [['displayName', 200], ['module', 200], ['notes', 4000]]) if (Object.hasOwn(changes, key)) values[key] = text(changes[key], key, max);
  if (Object.hasOwn(changes, 'role')) values.role = roleValue(changes.role);
  return transact(db, () => {
    const before = currentMember(db, id, changes.version);
    if (values.role === 'member') protectLastAdmin(db, before);
    db.prepare('UPDATE members SET display_name=?,module=?,notes=?,role=?,version=version+1,updated_at=? WHERE id=? AND version=?')
      .run(values.displayName ?? before.display_name, values.module ?? before.module, values.notes ?? before.notes, values.role ?? before.role, new Date().toISOString(), id, changes.version);
    addAudit(db, { actorId, action: 'member.update', targetType: 'member', targetId: id, before: auditMember(before), after: auditMember(db.prepare('SELECT * FROM members WHERE id=?').get(id)), requestId });
    return getMemberView(db, id);
  });
}
export function setMemberStatus(db, id, { version, enabled }, { actorId = null, requestId = null } = {}) {
  if (typeof enabled !== 'boolean') throw fail(400, 'enabled must be a boolean', 'INVALID_INPUT');
  return transact(db, () => {
    const before = currentMember(db, id, version);
    if (!enabled) protectLastAdmin(db, before);
    const status = enabled ? before.first_login_at ? 'active' : 'pending_activation' : 'disabled';
    db.prepare('UPDATE members SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(status, new Date().toISOString(), id, version);
    if (!enabled) revokeMemberAccess(db, id);
    addAudit(db, { actorId, action: enabled ? 'member.enable' : 'member.disable', targetType: 'member', targetId: id, before: auditMember(before), after: auditMember(db.prepare('SELECT * FROM members WHERE id=?').get(id)), requestId });
    return getMemberView(db, id);
  });
}
export function provisionAdmin(db, { profile, recover = false, actorId = null }) {
  profile = normalizeProfile(profile);
  if (typeof recover !== 'boolean') throw fail(400, 'Invalid recovery flag', 'INVALID_INPUT');
  return transact(db, () => {
    const existing = db.prepare('SELECT * FROM members WHERE github_user_id=?').get(profile.githubId);
    if (!recover && (getSetting(db, 'membershipInitialized', false) || db.prepare('SELECT id FROM members LIMIT 1').get())) throw fail(409, 'Membership already provisioned; use explicit local recovery', 'ALREADY_INITIALIZED');
    let id = existing?.id;
    if (existing) {
      db.prepare("UPDATE members SET role='admin',status=?,github_login=?,version=version+1,updated_at=? WHERE id=?")
        .run(existing.first_login_at ? 'active' : 'pending_activation', profile.login, new Date().toISOString(), id);
      // Recovery grants login only; never trusts a stale session or binding on a disabled member.
      if (existing.status === 'disabled') revokeMemberAccess(db, id);
    } else id = insertMember(db, { profile, role: 'admin', actorId });
    setSetting(db, 'membershipInitialized', true);
    addAudit(db, { actorId, action: recover ? 'member.recover_admin' : 'member.bootstrap', targetType: 'member', targetId: id, before: existing ? auditMember(existing) : null, after: auditMember(db.prepare('SELECT * FROM members WHERE id=?').get(id)) });
    return getMemberView(db, id);
  });
}

export async function migrateLegacyMembers(db, { admins = [], allowed = [], appId = '', resolveUser }) {
  if (getSetting(db, 'membershipInitialized', false)) return { skipped: true, created: 0, linkedUsers: 0, mappedOwners: 0, unresolvedOwners: 0, cancelledNotifications: 0 };
  if (!Array.isArray(admins) || !Array.isArray(allowed) || !admins.length || typeof resolveUser !== 'function' || [...admins, ...allowed].some(login => !validLogin(login))) throw fail(400, 'Migration requires valid legacy usernames and at least one administrator', 'MIGRATION_INVALID_INPUT');
  const adminNames = new Set(admins.map(login => login.toLowerCase()));
  const logins = [...new Set([...admins, ...allowed].map(login => login.toLowerCase()))];
  const demoNames = new Set(['demo-maintainer', 'reviewer-chen', 'pending-lin', 'disabled-wang', 'new-contributor']);
  if (logins.some(login => demoNames.has(login)) || db.prepare("SELECT id FROM users WHERE id IN ('demo','demo-2') LIMIT 1").get() || db.prepare("SELECT id FROM members WHERE id LIKE 'demo-%' LIMIT 1").get()) throw fail(409, 'Demo fixtures cannot be imported into real membership', 'MIGRATION_DEMO_DATA');
  // Resolve every allowlisted login before opening the write transaction. Fail closed on any lookup failure.
  const resolved = [];
  for (const login of logins) {
    let profile;
    try { profile = normalizeProfile(await resolveUser(login)); } catch { throw fail(409, 'Legacy identity verification failed; no membership changes were made', 'MIGRATION_RESOLVE_FAILED'); }
    if (demoNames.has(profile.login.toLowerCase())) throw fail(409, 'Demo identities cannot be migrated', 'MIGRATION_DEMO_DATA');
    resolved.push({ requested: login, profile, admin: adminNames.has(login) });
  }
  return transact(db, () => {
    if (getSetting(db, 'membershipInitialized', false)) return { skipped: true, created: 0, linkedUsers: 0, mappedOwners: 0, unresolvedOwners: 0, cancelledNotifications: 0 };
    const users = db.prepare('SELECT * FROM users').all();
    const identityByLogin = new Map();
    for (const entry of resolved) {
      for (const login of [entry.requested, entry.profile.login.toLowerCase()]) {
        if (identityByLogin.has(login) && identityByLogin.get(login) !== entry.profile.githubId) throw fail(409, 'Ambiguous legacy identity; migration stopped', 'MIGRATION_IDENTITY_CONFLICT');
        identityByLogin.set(login, entry.profile.githubId);
        if (users.some(user => user.login.toLowerCase() === login && user.id !== entry.profile.githubId)) throw fail(409, 'Stored GitHub identity does not match verified whitelist; migration stopped', 'MIGRATION_IDENTITY_CONFLICT');
      }
    }
    const report = { skipped: false, created: 0, linkedUsers: 0, mappedOwners: 0, unresolvedOwners: 0, cancelledNotifications: 0 };
    const byGithubId = new Map();
    for (const entry of resolved) {
      const prior = byGithubId.get(entry.profile.githubId);
      if (prior) { prior.admin ||= entry.admin; continue; }
      byGithubId.set(entry.profile.githubId, { ...entry });
    }
    const membersByGithubId = new Map();
    const now = new Date().toISOString();
    for (const [githubId, entry] of byGithubId) {
      const user = users.find(row => row.id === githubId);
      let member = db.prepare('SELECT * FROM members WHERE github_user_id=?').get(githubId);
      if (member && user?.member_id && user.member_id !== member.id) throw fail(409, 'Existing member linkage conflicts with legacy profile', 'MIGRATION_IDENTITY_CONFLICT');
      if (!member) {
        const id = insertMember(db, { profile: entry.profile, role: entry.admin ? 'admin' : 'member', status: user ? 'active' : 'pending_activation', firstLoginAt: user ? now : null, lastLoginAt: user ? now : null });
        member = db.prepare('SELECT * FROM members WHERE id=?').get(id); report.created++;
      }
      membersByGithubId.set(githubId, member);
      if (user) {
        if (user.member_id && user.member_id !== member.id) throw fail(409, 'Existing profile linkage conflicts with migration', 'MIGRATION_IDENTITY_CONFLICT');
        db.prepare('UPDATE users SET member_id=? WHERE id=?').run(member.id, user.id); report.linkedUsers++;
        if (user.feishu_open_id && appId && !db.prepare('SELECT member_id FROM feishu_bindings WHERE member_id=?').get(member.id)) {
          if (db.prepare('SELECT member_id FROM feishu_bindings WHERE app_id=? AND open_id=?').get(appId, user.feishu_open_id)) throw fail(409, 'Legacy binding identity conflict; migration stopped', 'MIGRATION_BINDING_CONFLICT');
          db.prepare("INSERT INTO feishu_bindings(member_id,app_id,open_id,status,bound_at) VALUES (?,?,?,'needs_confirmation',?)").run(member.id, appId, user.feishu_open_id, now);
        }
      }
    }
    // Existing business roles are never overwritten by a migration rerun/partial provisioning.
    if (![...membersByGithubId.values()].some(member => member.role === 'admin' && member.status !== 'disabled')) throw fail(409, 'Migration would have no usable administrator', 'MIGRATION_NO_ADMIN');
    const exactMember = login => typeof login === 'string' ? membersByGithubId.get(identityByLogin.get(login.toLowerCase())) : null;
    for (const item of db.prepare('SELECT id,owner,owner_member_id FROM items').all()) {
      if (item.owner_member_id || !item.owner) continue;
      const member = exactMember(item.owner);
      db.prepare('UPDATE items SET owner_member_id=?,legacy_owner_unresolved=? WHERE id=?').run(member?.id || null, member ? 0 : 1, item.id);
      if (member) report.mappedOwners++; else report.unresolvedOwners++;
    }
    for (const notification of db.prepare('SELECT id,recipient,recipient_member_id FROM notifications').all()) {
      if (notification.recipient_member_id) continue;
      const member = exactMember(notification.recipient);
      if (member) db.prepare('UPDATE notifications SET recipient_member_id=? WHERE id=?').run(member.id, notification.id);
    }
    // All old queued addresses are untrusted; preserve history but never deliver an old envelope.
    report.cancelledNotifications = Number(db.prepare("UPDATE notifications SET status='cancelled',error_code='legacy_migration',error=NULL WHERE status IN ('pending','sending')").run().changes);
    db.exec('DELETE FROM sessions; DELETE FROM oauth_states;');
    db.prepare("UPDATE feishu_bindings SET status='needs_confirmation',verified_at=NULL,binding_version=binding_version+1").run();
    setSetting(db, 'membershipInitialized', true);
    addAudit(db, { action: 'member.legacy_migration', targetType: 'membership', after: report });
    return report;
  });
}
