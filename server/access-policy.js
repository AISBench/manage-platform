import { addAudit, getSetting, setSetting } from './db.js';

const fail = (status, message, code) => Object.assign(new Error(message), { status, statusCode: status, code });
function transact(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function assertActiveAdmin(db, actorId) {
  const actor = typeof actorId === 'string' && db.prepare('SELECT * FROM members WHERE id=?').get(actorId);
  if (!actor || actor.role !== 'admin' || actor.status !== 'active') throw fail(403, 'An active administrator is required', 'ADMIN_REQUIRED');
  return actor;
}
export function getAccessPolicy(db) {
  const stored = getSetting(db, 'accessPolicy', {});
  return { publicOverviewEnabled: stored.publicOverviewEnabled === true, version: Number.isSafeInteger(stored.version) && stored.version > 0 ? stored.version : 1 };
}
export function updateAccessPolicy(db, input, { actorId, requestId = null }) {
  if (!input || Object.keys(input).some(key => !['version', 'publicOverviewEnabled'].includes(key)) || typeof input.publicOverviewEnabled !== 'boolean') throw fail(400, 'Invalid access policy', 'INVALID_INPUT');
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw fail(400, 'A positive version is required', 'INVALID_VERSION');
  return transact(db, () => {
    assertActiveAdmin(db, actorId);
    const before = getAccessPolicy(db);
    if (input.version !== before.version) throw fail(409, 'Access policy changed; refresh and retry', 'VERSION_CONFLICT');
    const after = { publicOverviewEnabled: input.publicOverviewEnabled, version: before.version + 1 };
    setSetting(db, 'accessPolicy', after);
    addAudit(db, { actorId, action: 'access_policy.update', targetType: 'setting', targetId: 'accessPolicy', before, after, requestId });
    return after;
  });
}
