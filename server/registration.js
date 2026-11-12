import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { addAudit, getSetting, setSetting } from './db.js';
import { normalizeProfile, assertActiveAdmin, grantMemberInTransaction } from './members.js';

const defaults = { registrationEnabled: true, publicOverviewEnabled: false, reapplyCooldownHours: 24, maxPendingRequests: 1000, version: 1 };
const fail = (status, message, code) => Object.assign(new Error(message), { status, statusCode: status, code });
const hash = token => createHash('sha256').update(token).digest('hex');
const token = () => randomBytes(32).toString('hex');
function transact(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function text(value, field, max, min = 0) {
  if (typeof value !== 'string' || value.length > max || value.includes('\u0000') || value.trim().length < min) throw fail(400, `Invalid ${field}`, 'INVALID_INPUT');
  return value.trim();
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw fail(400, 'A positive version is required', 'INVALID_VERSION');
}
function identityRow(db, id) {
  const row = db.prepare('SELECT * FROM registration_identities WHERE id=?').get(id);
  if (!row) throw fail(404, 'Verified identity not found', 'IDENTITY_NOT_FOUND');
  return row;
}
const identityView = row => ({ githubId: row.github_user_id, login: row.github_login, name: row.name || '', avatarUrl: row.avatar_url || '' });
function publicApplication(row) {
  return { id: row.id, status: row.status, displayName: row.display_name, module: row.module, reason: row.reason,
    submittedAt: row.submitted_at, reviewedAt: row.reviewed_at, publicFeedback: row.public_feedback,
    version: row.version, round: row.round };
}
function adminApplication(db, row) {
  const identity = identityRow(db, row.identity_id);
  return { ...publicApplication(row), identityId: row.identity_id, ...identityView(identity), internalNote: row.internal_note,
    reviewer: row.reviewer_member_id, memberId: row.member_id };
}
function latestRequest(db, identityId) {
  return db.prepare('SELECT * FROM join_requests WHERE identity_id=? ORDER BY round DESC,submitted_at DESC,id DESC LIMIT 1').get(identityId);
}
function cooldownAt(application, policy) {
  return application?.status === 'rejected' ? new Date(Date.parse(application.reviewed_at) + policy.reapplyCooldownHours * 3600000).toISOString() : null;
}

// Only server-verified OAuth profiles belong here; this never grants membership.
export function verifiedIdentity(db, profile) {
  if (profile?.type !== 'User' || profile.bot === true) throw fail(400, 'Only verified personal GitHub users are supported', 'INVALID_PROFILE');
  profile = normalizeProfile(profile);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO registration_identities(id,github_user_id,github_login,name,avatar_url,created_at,verified_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(github_user_id) DO UPDATE SET github_login=excluded.github_login,name=excluded.name,avatar_url=excluded.avatar_url,verified_at=excluded.verified_at`)
    .run(randomUUID(), profile.githubId, profile.login, profile.name, profile.avatarUrl, now, now);
  return db.prepare('SELECT * FROM registration_identities WHERE github_user_id=?').get(profile.githubId);
}
export function createRegistrationSession(db, res, identityId, config) {
  identityRow(db, identityId);
  const value = token();
  const session = { token_hash: hash(value), identity_id: identityId, csrf: token(), expires_at: Date.now() + 30 * 60000 };
  db.prepare('INSERT INTO registration_sessions(token_hash,identity_id,csrf,expires_at) VALUES (?,?,?,?)')
    .run(session.token_hash, identityId, session.csrf, session.expires_at);
  res.cookie('triage_registration', value, { httpOnly: true, secure: !!config.secure, sameSite: 'lax', path: '/', maxAge: 30 * 60000 });
  return session;
}
export function readRegistrationSession(db, value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return null;
  const session = db.prepare('SELECT * FROM registration_sessions WHERE token_hash=? AND expires_at>?').get(hash(value), Date.now());
  if (!session) return null;
  const identity = db.prepare('SELECT * FROM registration_identities WHERE id=?').get(session.identity_id);
  return identity ? { session, identity } : null;
}
export function getAccessPolicy(db) { return { ...defaults, ...getSetting(db, 'accessPolicy', {}) }; }
export function getRegistrationStatus(db, identityId, now = Date.now()) {
  const identity = identityRow(db, identityId);
  const member = db.prepare('SELECT status FROM members WHERE github_user_id=?').get(identity.github_user_id);
  const application = latestRequest(db, identityId);
  const policy = getAccessPolicy(db);
  const reapplyAt = cooldownAt(application, policy);
  const pendingCount = db.prepare("SELECT COUNT(*) AS n FROM join_requests WHERE status='pending'").get().n;
  return { identity: identityView(identity), application: application ? publicApplication(application) : null,
    memberStatus: member?.status || null, canApply: !member && policy.registrationEnabled && application?.status !== 'pending'
      && application?.status !== 'approved' && (!reapplyAt || now >= Date.parse(reapplyAt)) && pendingCount < policy.maxPendingRequests,
    canLogin: !!member && member.status !== 'disabled', reapplyAt, blocked: member?.status === 'disabled' };
}
export function submitApplication(db, identityId, input, { requestId = null, now = Date.now() } = {}) {
  if (!input || Object.keys(input).some(key => !['displayName', 'module', 'reason', 'consent'].includes(key)) || input.consent !== true) throw fail(400, 'Explicit data-use consent and application fields are required', 'INVALID_INPUT');
  const displayName = text(input.displayName === undefined ? '' : input.displayName, 'display name', 120);
  const module = text(input.module === undefined ? '' : input.module, 'module', 120);
  const reason = text(input.reason, 'reason', 2000, 10);
  return transact(db, () => {
    const identity = identityRow(db, identityId);
    const member = db.prepare('SELECT status FROM members WHERE github_user_id=?').get(identity.github_user_id);
    if (member) throw fail(member.status === 'disabled' ? 403 : 409, member.status === 'disabled' ? 'Disabled members must contact an administrator' : 'Identity already has membership', member.status === 'disabled' ? 'MEMBER_DISABLED' : 'ALREADY_MEMBER');
    const policy = getAccessPolicy(db);
    if (!policy.registrationEnabled) throw fail(403, 'Registration is currently disabled', 'REGISTRATION_DISABLED');
    const prior = latestRequest(db, identityId);
    if (prior?.status === 'pending' || prior?.status === 'approved') throw fail(409, 'Application already exists', 'APPLICATION_EXISTS');
    const reapplyAt = cooldownAt(prior, policy);
    if (reapplyAt && now < Date.parse(reapplyAt)) throw fail(429, 'Reapplication cooldown has not elapsed', 'REAPPLY_COOLDOWN');
    if (db.prepare("SELECT COUNT(*) AS n FROM join_requests WHERE status='pending'").get().n >= policy.maxPendingRequests) throw fail(429, 'The application queue is full; try later', 'QUEUE_FULL');
    const id = randomUUID(), submittedAt = new Date(now).toISOString();
    db.prepare(`INSERT INTO join_requests(id,identity_id,status,display_name,module,reason,consented_at,submitted_at,round) VALUES (?,?,'pending',?,?,?,?,?,?)`)
      .run(id, identityId, displayName, module, reason, submittedAt, submittedAt, (prior?.round || 0) + 1);
    const application = publicApplication(db.prepare('SELECT * FROM join_requests WHERE id=?').get(id));
    addAudit(db, { action: 'registration.submit', targetType: 'join_request', targetId: id, after: { identityId, status: 'pending', round: application.round }, requestId });
    return application;
  });
}
export function listJoinRequests(db, { status = '', q = '', page = 1, pageSize = 20 } = {}) {
  if (!['', 'pending', 'approved', 'rejected'].includes(status) || typeof q !== 'string' || q.length > 200 || !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger((page - 1) * pageSize)) throw fail(400, 'Invalid application filters or pagination', 'INVALID_INPUT');
  const where = [], params = [];
  if (status) { where.push('r.status=?'); params.push(status); }
  if (q.trim()) {
    where.push("(i.github_login LIKE ? ESCAPE '\\' OR r.display_name LIKE ? ESCAPE '\\' OR i.github_user_id=?)");
    const search = `%${q.trim().replace(/[\\%_]/g, '\\$&')}%`; params.push(search, search, q.trim());
  }
  const from = `FROM join_requests r JOIN registration_identities i ON i.id=r.identity_id${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params).n;
  const requests = db.prepare(`SELECT r.* ${from} ORDER BY r.submitted_at DESC,r.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize).map(row => adminApplication(db, row));
  return { requests, total, page, pageSize, pendingCount: db.prepare("SELECT COUNT(*) AS n FROM join_requests WHERE status='pending'").get().n };
}
export function reviewApplication(db, id, input, { actorId, requestId = null }) {
  if (!input || Object.keys(input).some(key => !['version', 'decision', 'publicFeedback', 'internalNote'].includes(key)) || !['approved', 'rejected'].includes(input.decision)) throw fail(400, 'Invalid review decision', 'INVALID_INPUT');
  version(input.version);
  const publicFeedback = text(input.publicFeedback === undefined ? '' : input.publicFeedback, 'public feedback', 500, input.decision === 'rejected' ? 1 : 0);
  const internalNote = text(input.internalNote === undefined ? '' : input.internalNote, 'internal note', 2000);
  return transact(db, () => {
    assertActiveAdmin(db, actorId);
    const before = db.prepare('SELECT * FROM join_requests WHERE id=?').get(id);
    if (!before) throw fail(404, 'Application not found', 'NOT_FOUND');
    if (before.status !== 'pending' || before.version !== input.version) throw fail(409, 'Application changed; refresh and retry', 'VERSION_CONFLICT');
    const identity = identityRow(db, before.identity_id);
    let memberId = null;
    if (input.decision === 'approved') {
      memberId = grantMemberInTransaction(db, { profile: { githubId: identity.github_user_id, login: identity.github_login, name: identity.name, avatarUrl: identity.avatar_url, type: 'User' }, displayName: before.display_name, module: before.module, actorId, requestId }).id;
    }
    const result = db.prepare(`UPDATE join_requests SET status=?,reviewer_member_id=?,reviewed_at=?,public_feedback=?,internal_note=?,member_id=?,version=version+1 WHERE id=? AND status='pending' AND version=?`)
      .run(input.decision, actorId, new Date().toISOString(), publicFeedback, internalNote, memberId, id, input.version);
    if (Number(result.changes) !== 1) throw fail(409, 'Application changed; refresh and retry', 'VERSION_CONFLICT');
    const after = db.prepare('SELECT * FROM join_requests WHERE id=?').get(id);
    addAudit(db, { actorId, action: input.decision === 'approved' ? 'registration.approve' : 'registration.reject', targetType: 'join_request', targetId: id,
      before: { status: before.status, version: before.version }, after: { status: after.status, version: after.version, memberId, publicFeedback, internalNote }, requestId });
    return adminApplication(db, after);
  });
}
export function updateAccessPolicy(db, input, { actorId, requestId = null }) {
  const allowed = ['version', 'registrationEnabled', 'publicOverviewEnabled', 'reapplyCooldownHours', 'maxPendingRequests'];
  if (!input || Object.keys(input).some(key => !allowed.includes(key)) || typeof input.registrationEnabled !== 'boolean' || typeof input.publicOverviewEnabled !== 'boolean'
    || !Number.isSafeInteger(input.reapplyCooldownHours) || input.reapplyCooldownHours < 1 || input.reapplyCooldownHours > 720
    || !Number.isSafeInteger(input.maxPendingRequests) || input.maxPendingRequests < 1 || input.maxPendingRequests > 10000) throw fail(400, 'Invalid access policy', 'INVALID_INPUT');
  version(input.version);
  return transact(db, () => {
    assertActiveAdmin(db, actorId);
    const before = getAccessPolicy(db);
    if (input.version !== before.version) throw fail(409, 'Access policy changed; refresh and retry', 'VERSION_CONFLICT');
    const after = { registrationEnabled: input.registrationEnabled, publicOverviewEnabled: input.publicOverviewEnabled, reapplyCooldownHours: input.reapplyCooldownHours, maxPendingRequests: input.maxPendingRequests, version: before.version + 1 };
    setSetting(db, 'accessPolicy', after);
    addAudit(db, { actorId, action: 'access_policy.update', targetType: 'setting', targetId: 'accessPolicy', before, after, requestId });
    return after;
  });
}
