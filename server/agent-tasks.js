import { randomUUID } from 'node:crypto';

// Agent task lifecycle: queued -> claimed -> submitted -> published/expired.
// The unique partial index on (item_id, member_id) for active statuses means
// "give this item to my agent" is naturally idempotent.
const ACTIVE = ['queued', 'claimed', 'submitted'];
export const TASK_TTL_MS = 24 * 3600000;

function nowIso() { return new Date().toISOString(); }

function conflict(message) {
  return Object.assign(new Error(message), { status: 409, code: 'AGENT_TASK_CONFLICT' });
}

function missing(message) {
  return Object.assign(new Error(message), { status: 404, code: 'AGENT_TASK_NOT_FOUND' });
}

function itemSummary(db, itemId) {
  const row = db.prepare('SELECT id,number,data FROM items WHERE id=?').get(itemId);
  if (!row) return null;
  let data = {};
  try { data = JSON.parse(row.data); } catch { data = {}; }
  return { id: row.id, number: row.number, kind: data.kind || '', title: data.title || '', state: data.state || '', url: data.url || '' };
}

function expireStale(db, memberId) {
  db.prepare(`UPDATE agent_tasks SET status='expired',updated_at=? WHERE member_id=? AND status IN ('queued','claimed','submitted') AND expires_at<?`)
    .run(nowIso(), memberId, nowIso());
}

export function createTask(db, { itemId, repo, number, memberId, hint = '' }) {
  expireStale(db, memberId);
  const existing = db.prepare(`SELECT * FROM agent_tasks WHERE item_id=? AND member_id=? AND status IN (${ACTIVE.map(() => '?').join(',')})`)
    .get(itemId, memberId, ...ACTIVE);
  if (existing) return { task: taskView(db, existing), created: false };
  const id = randomUUID();
  const now = nowIso();
  db.prepare('INSERT INTO agent_tasks(id,item_id,repo,number,member_id,hint,status,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, itemId, repo, number, memberId, hint || '', 'queued', now, now, new Date(Date.now() + TASK_TTL_MS).toISOString());
  return { task: taskView(db, db.prepare('SELECT * FROM agent_tasks WHERE id=?').get(id)), created: true };
}

function taskView(db, row) {
  return {
    id: row.id, itemId: row.item_id, repo: row.repo, number: Number(row.number), hint: row.hint || '',
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at,
    item: itemSummary(db, row.item_id),
  };
}

export function listTasksForMember(db, memberId) {
  expireStale(db, memberId);
  return db.prepare('SELECT * FROM agent_tasks WHERE member_id=? ORDER BY created_at DESC LIMIT 100')
    .all(memberId).map(row => {
      const draft = db.prepare('SELECT id,status,summary,comment_url,publish_error,updated_at FROM agent_drafts WHERE task_id=?').get(row.id);
      return { ...taskView(db, row), draft: draft ? { id: draft.id, status: draft.status, summary: draft.summary, commentUrl: draft.comment_url || '', publishError: draft.publish_error || '', updatedAt: draft.updated_at } : null };
    });
}

export function listQueuedForToken(db, memberId) {
  expireStale(db, memberId);
  return db.prepare(`SELECT * FROM agent_tasks WHERE member_id=? AND status IN ('queued','claimed') AND expires_at>? ORDER BY created_at ASC`)
    .all(memberId, nowIso()).map(row => taskView(db, row));
}

export function getLatestDraftForItem(db, itemId, memberId) {
  const row = db.prepare(`SELECT d.* FROM agent_drafts d JOIN agent_tasks t ON t.id=d.task_id
    WHERE t.item_id=? AND d.member_id=? ORDER BY d.created_at DESC LIMIT 1`).get(itemId, memberId);
  if (!row) return null;
  const task = db.prepare('SELECT * FROM agent_tasks WHERE id=?').get(row.task_id);
  return draftView(db, row, task);
}

export function getTask(db, taskId, memberId) {
  const row = db.prepare('SELECT * FROM agent_tasks WHERE id=? AND member_id=?').get(taskId, memberId);
  return row ? taskView(db, row) : null;
}

export function claimTask(db, taskId, memberId) {
  const result = db.prepare(`UPDATE agent_tasks SET status='claimed',updated_at=? WHERE id=? AND member_id=? AND status='queued' AND expires_at>?`)
    .run(nowIso(), taskId, memberId, nowIso());
  // Already claimed by the same token is idempotent success.
  if (result.changes > 0) return true;
  const row = db.prepare('SELECT status FROM agent_tasks WHERE id=? AND member_id=?').get(taskId, memberId);
  return Boolean(row && row.status === 'claimed');
}

export function submitDraft(db, { taskId, memberId, draft, agentName = '', agentTokenPrefix = '' }) {
  const task = db.prepare('SELECT * FROM agent_tasks WHERE id=? AND member_id=?').get(taskId, memberId);
  if (!task) throw missing('任务不存在或不属于当前令牌');
  if (task.status !== 'queued' && task.status !== 'claimed') throw conflict('该任务已提交，不能重复提交草稿');
  if (Date.parse(task.expires_at) < Date.now()) throw conflict('任务已过期，请重新创建');
  const id = randomUUID();
  const now = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO agent_drafts(id,task_id,member_id,summary,root_cause_hypothesis,comment_md,actions_json,references_json,confidence,model,agent_name,agent_token_prefix,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
      .run(id, taskId, memberId, draft.summary || '', draft.root_cause_hypothesis || '', draft.comment_md, JSON.stringify(draft.actions || []), JSON.stringify(draft.references || []), draft.confidence || 0, draft.model || '', String(agentName || '').slice(0, 120), String(agentTokenPrefix || '').slice(0, 20), now, now);
    db.prepare("UPDATE agent_tasks SET status='submitted',updated_at=? WHERE id=?").run(now, taskId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (String(error?.message || '').includes('UNIQUE')) throw conflict('该任务已提交过草稿');
    throw error;
  }
  return getDraft(db, id, memberId);
}

function draftView(db, row, task) {
  const parse = (blob, fallback) => { try { return JSON.parse(blob); } catch { return fallback; } };
  return {
    id: row.id, taskId: row.task_id, memberId: row.member_id, summary: row.summary,
    rootCauseHypothesis: row.root_cause_hypothesis, commentMd: row.comment_md,
    actions: parse(row.actions_json, []), references: parse(row.references_json, []),
    confidence: Number(row.confidence) || 0, model: row.model, status: row.status,
    agentName: row.agent_name || '', agentTokenPrefix: row.agent_token_prefix || '',
    commentUrl: row.comment_url || '', publishError: row.publish_error || '',
    createdAt: row.created_at, updatedAt: row.updated_at,
    task: task ? {
      id: task.id, itemId: task.item_id, repo: task.repo, number: Number(task.number),
      item: itemSummary(db, task.item_id),
    } : null,
  };
}

export function getDraft(db, draftId, memberId) {
  const row = db.prepare('SELECT * FROM agent_drafts WHERE id=? AND member_id=?').get(draftId, memberId);
  if (!row) return null;
  const task = db.prepare('SELECT * FROM agent_tasks WHERE id=?').get(row.task_id);
  return draftView(db, row, task);
}

export function listDraftsForMember(db, memberId) {
  return db.prepare('SELECT * FROM agent_drafts WHERE member_id=? ORDER BY created_at DESC LIMIT 100').all(memberId)
    .map(row => getDraft(db, row.id, memberId));
}

export function markPublished(db, draftId, commentUrl) {
  db.prepare("UPDATE agent_drafts SET status='published',comment_url=?,publish_error=NULL,updated_at=? WHERE id=?")
    .run(commentUrl || '', nowIso(), draftId);
  const row = db.prepare('SELECT task_id FROM agent_drafts WHERE id=?').get(draftId);
  if (row) db.prepare("UPDATE agent_tasks SET status='published',updated_at=? WHERE id=?").run(nowIso(), row.task_id);
}

export function markPublishError(db, draftId, message) {
  db.prepare('UPDATE agent_drafts SET publish_error=?,updated_at=? WHERE id=?').run(String(message || '').slice(0, 1000), nowIso(), draftId);
}

export function markDeclined(db, draftId) {
  db.prepare("UPDATE agent_drafts SET status='declined',updated_at=? WHERE id=?").run(nowIso(), draftId);
  const row = db.prepare('SELECT task_id FROM agent_drafts WHERE id=?').get(draftId);
  if (row) db.prepare("UPDATE agent_tasks SET status='declined',updated_at=? WHERE id=?").run(nowIso(), row.task_id);
}
