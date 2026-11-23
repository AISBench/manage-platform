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

const TASK_KINDS = ['item_review', 'issue_create', 'pr_create'];

function defaultAnchor({ kind, itemId, messageId, memberId, clientRequestId }) {
  if (kind === 'issue_create') return `issue_create:${memberId}:${clientRequestId || randomUUID()}`;
  if (kind === 'pr_create') return `pr_create:${itemId}`;
  return `item_review:${itemId}:${messageId || ''}`;
}

function findActiveByAnchor(db, memberId, anchorKey) {
  return db.prepare(`SELECT * FROM agent_tasks WHERE member_id=? AND anchor_key=? AND status IN (${ACTIVE.map(() => '?').join(',')})`)
    .get(memberId, anchorKey, ...ACTIVE);
}

export function createTask(db, { itemId = null, kind = 'item_review', repo, number = null, memberId, hint = '', messageId = '', reviewCommentId = '', anchorKey = '', clientRequestId = '' }) {
  if (!TASK_KINDS.includes(kind)) throw Object.assign(new Error('未知的 Agent 任务类型'), { status: 400, code: 'AGENT_TASK_KIND' });
  expireStale(db, memberId);
  const anchor = anchorKey || defaultAnchor({ kind, itemId, messageId, memberId, clientRequestId });
  const existing = findActiveByAnchor(db, memberId, anchor);
  if (existing) return { task: taskView(db, existing), created: false };
  const id = randomUUID();
  const now = nowIso();
  try {
    db.prepare('INSERT INTO agent_tasks(id,kind,item_id,repo,number,member_id,hint,anchor_key,message_id,review_comment_id,status,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, kind, itemId, repo, number, memberId, hint || '', anchor, messageId || null, reviewCommentId || null, 'queued', now, now, new Date(Date.now() + TASK_TTL_MS).toISOString());
  } catch (error) {
    // A concurrent click on the same anchor may have won the unique index.
    if (String(error?.message || '').includes('UNIQUE')) {
      const row = findActiveByAnchor(db, memberId, anchor);
      if (row) return { task: taskView(db, row), created: false };
    }
    throw error;
  }
  return { task: taskView(db, db.prepare('SELECT * FROM agent_tasks WHERE id=?').get(id)), created: true };
}

export function listTasksForItem(db, memberId, itemId, limit = 50) {
  expireStale(db, memberId);
  return db.prepare('SELECT * FROM agent_tasks WHERE member_id=? AND item_id=? ORDER BY created_at DESC LIMIT ?')
    .all(memberId, itemId, Math.max(1, Math.min(100, Number(limit) || 50)))
    .map(row => {
      const draft = db.prepare('SELECT id FROM agent_drafts WHERE task_id=?').get(row.id);
      return { ...taskView(db, row), draft: draft ? getDraft(db, draft.id, memberId) : null };
    });
}

function replyView(db, row) {
  if (!row.message_id) return null;
  const message = db.prepare('SELECT id,kind,author_login,body,path,line,url,created_at FROM item_messages WHERE id=?').get(row.message_id);
  if (!message) return { messageId: row.message_id, reviewCommentId: row.review_comment_id || '', kind: '' };
  return {
    messageId: message.id,
    kind: message.kind || '',
    reviewCommentId: row.review_comment_id || '',
    author: message.author_login || '',
    body: String(message.body || '').slice(0, 500),
    path: message.path || '',
    line: message.line ?? null,
    url: message.url || '',
    createdAt: message.created_at,
  };
}

function taskView(db, row) {
  const item = itemSummary(db, row.item_id);
  const kind = row.kind || 'item_review';
  return {
    id: row.id, kind,
    itemId: row.item_id ?? null, repo: row.repo,
    number: row.number == null ? null : Number(row.number), hint: row.hint || '',
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at,
    messageId: row.message_id || '', reviewCommentId: row.review_comment_id || '',
    anchorKey: row.anchor_key || '',
    replyTo: replyView(db, row),
    item,
    target: item
      ? { type: 'item', id: item.id, kind: item.kind, number: item.number, title: item.title, url: item.url }
      : { type: kind === 'issue_create' ? 'issue_request' : 'none', hint: row.hint || '' },
  };
}

export function listTasksForMember(db, memberId) {
  expireStale(db, memberId);
  return db.prepare('SELECT * FROM agent_tasks WHERE member_id=? ORDER BY created_at DESC LIMIT 100')
    .all(memberId).map(row => {
      const draft = db.prepare('SELECT id,kind,status,summary,comment_url,publish_error,updated_at FROM agent_drafts WHERE task_id=?').get(row.id);
      return { ...taskView(db, row), draft: draft ? { id: draft.id, kind: draft.kind || 'item_comment', status: draft.status, summary: draft.summary, commentUrl: draft.comment_url || '', publishError: draft.publish_error || '', updatedAt: draft.updated_at } : null };
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
  const kind = draft.kind || 'item_comment';
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO agent_drafts(id,task_id,member_id,summary,root_cause_hypothesis,comment_md,comments_json,actions_json,references_json,confidence,model,agent_name,agent_token_prefix,kind,payload_json,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
      .run(id, taskId, memberId, draft.summary || '', draft.root_cause_hypothesis || '', draft.comment_md || '', JSON.stringify(draft.comments || []), JSON.stringify(draft.actions || []), JSON.stringify(draft.references || []), draft.confidence || 0, draft.model || '', String(agentName || '').slice(0, 120), String(agentTokenPrefix || '').slice(0, 20), kind, JSON.stringify(draft.payload || {}), now, now);
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
    kind: row.kind || 'item_comment',
    payload: parse(row.payload_json, {}),
    rootCauseHypothesis: row.root_cause_hypothesis, commentMd: row.comment_md,
    comments: parse(row.comments_json, []),
    actions: parse(row.actions_json, []), references: parse(row.references_json, []),
    confidence: Number(row.confidence) || 0, model: row.model, status: row.status,
    agentName: row.agent_name || '', agentTokenPrefix: row.agent_token_prefix || '',
    commentUrl: row.comment_url || '', publishError: row.publish_error || '',
    createdAt: row.created_at, updatedAt: row.updated_at,
    task: task ? {
      id: task.id, kind: task.kind || 'item_review', itemId: task.item_id ?? null, repo: task.repo,
      number: task.number == null ? null : Number(task.number),
      messageId: task.message_id || '', reviewCommentId: task.review_comment_id || '',
      replyTo: replyView(db, task),
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

export function updateDraftPayload(db, draftId, payload) {
  db.prepare('UPDATE agent_drafts SET payload_json=?,updated_at=? WHERE id=?').run(JSON.stringify(payload || {}), nowIso(), draftId);
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
