import { randomUUID, createHash } from 'node:crypto';
import { addAudit, listItems } from './db.js';
import {
  fetchIssueComments, fetchPullReviews, fetchPullReviewComments, fetchIssueTimeline,
  fetchPullRequestDetail, fetchPullCheckRuns, fetchCommitStatuses, createIssueComment, rerunGitHubWorkflow, identityId,
} from './integrations/github.js';
import { getGitHubToken, deleteGitHubToken, markGitHubTokenVerified } from './github-tokens.js';

export const MESSAGE_LIMIT = 1000;
export const EVENT_LIMIT = 2000;
export const BODY_LIMIT = 20000;
export const TTL_MS = 30000;
const MENTION_RE = /(^|[^\w-])@([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)/gi;
const now = () => new Date().toISOString();
const fail = (status, message, code) => Object.assign(new Error(message), { status, statusCode: status, code });
const sha1 = value => createHash('sha1').update(value).digest('hex');
const authorOf = user => ({
  githubId: identityId(user?.id),
  login: typeof user?.login === 'string' && user.login ? user.login : 'ghost',
  avatarUrl: typeof user?.avatar_url === 'string' ? user.avatar_url : '',
});

export function mentionLogins(body) {
  const logins = new Set();
  for (const match of String(body || '').matchAll(MENTION_RE)) logins.add(match[2].toLowerCase());
  return [...logins];
}

function memberIdForGithub(db, githubId) {
  return githubId ? db.prepare('SELECT id FROM members WHERE github_user_id=?').get(String(githubId))?.id || null : null;
}

function syncMentions(db, messageId, body) {
  db.prepare('DELETE FROM item_message_mentions WHERE message_id=?').run(messageId);
  const insert = db.prepare('INSERT OR IGNORE INTO item_message_mentions(message_id,member_id,login) VALUES (?,?,?)');
  for (const login of mentionLogins(body)) {
    const member = db.prepare('SELECT id FROM members WHERE github_login=? COLLATE NOCASE').get(login);
    if (member) insert.run(messageId, member.id, login);
  }
}

function upsertMessage(db, itemId, row) {
  const at = now();
  const author = row.author || {};
  const memberId = memberIdForGithub(db, author.githubId);
  const existing = row.remoteKey ? db.prepare('SELECT * FROM item_messages WHERE github_comment_id=?').get(row.remoteKey) : null;
  if (existing) {
    db.prepare(`UPDATE item_messages SET body=?,updated_at=?,url=?,path=?,line=?,state=?,remote_deleted=0,synced_at=?,
      diff_hunk=COALESCE(?,diff_hunk),start_line=COALESCE(?,start_line),side=COALESCE(?,side) WHERE id=?`)
      .run(row.body, row.updatedAt || row.createdAt, row.url || null, row.path || null, row.line ?? null, row.state || null, at, row.diffHunk || null, row.startLine ?? null, row.side || null, existing.id);
    if (existing.source !== 'platform') {
      db.prepare(`UPDATE item_messages SET kind=?,author_member_id=COALESCE(author_member_id,?),author_login=?,author_github_id=?,author_avatar_url=? WHERE id=?`)
        .run(row.kind, memberId, author.login, author.githubId || null, author.avatarUrl || '', existing.id);
    }
    syncMentions(db, existing.id, row.body);
    return existing.id;
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO item_messages(id,item_id,source,kind,github_comment_id,in_reply_to_id,author_member_id,author_login,author_github_id,author_avatar_url,body,url,path,line,state,delivery_status,remote_deleted,created_at,updated_at,synced_at,diff_hunk,start_line,side)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',0,?,?,?,?,?,?)`)
    .run(id, itemId, 'github', row.kind, row.remoteKey, row.inReplyTo || null, memberId, author.login, author.githubId || null, author.avatarUrl || '', row.body, row.url || null, row.path || null, row.line ?? null, row.state || null, row.createdAt, row.updatedAt || row.createdAt, at, row.diffHunk || null, row.startLine ?? null, row.side || null);
  syncMentions(db, id, row.body);
  return id;
}

function markRemoteDeleted(db, itemId, remoteKeys) {
  const rows = db.prepare(`SELECT id,github_comment_id FROM item_messages WHERE item_id=? AND source='github'`).all(itemId);
  const update = db.prepare('UPDATE item_messages SET remote_deleted=1,synced_at=? WHERE id=?');
  for (const row of rows) if (row.github_comment_id && !remoteKeys.has(row.github_comment_id)) update.run(now(), row.id);
}

function commentRow(comment) {
  return {
    kind: 'issue_comment', remoteKey: `comment:${comment.id}`, author: authorOf(comment.user),
    body: String(comment.body || '').slice(0, BODY_LIMIT), createdAt: comment.created_at, updatedAt: comment.updated_at || comment.created_at,
    url: typeof comment.html_url === 'string' ? comment.html_url : null,
  };
}
function reviewRow(review) {
  return {
    kind: 'review', remoteKey: `review:${review.id}`, author: authorOf(review.user),
    body: String(review.body || '').slice(0, BODY_LIMIT), state: typeof review.state === 'string' ? review.state : null,
    createdAt: review.submitted_at || review.created_at, updatedAt: review.submitted_at || review.created_at,
    url: typeof review.html_url === 'string' ? review.html_url : null,
  };
}
function reviewCommentRow(comment) {
  return {
    kind: 'review_comment', remoteKey: `review_comment:${comment.id}`, author: authorOf(comment.user),
    body: String(comment.body || '').slice(0, BODY_LIMIT), path: typeof comment.path === 'string' ? comment.path : null,
    line: Number.isSafeInteger(comment.line) ? comment.line : Number.isSafeInteger(comment.original_line) ? comment.original_line : null,
    startLine: Number.isSafeInteger(comment.start_line) ? comment.start_line : null,
    side: comment.side === 'LEFT' || comment.side === 'RIGHT' ? comment.side : null,
    diffHunk: typeof comment.diff_hunk === 'string' ? comment.diff_hunk.slice(0, BODY_LIMIT) : null,
    inReplyTo: comment.in_reply_to_id ? String(comment.in_reply_to_id) : null,
    createdAt: comment.created_at, updatedAt: comment.updated_at || comment.created_at,
    url: typeof comment.html_url === 'string' ? comment.html_url : null,
  };
}

const OPERATION_LABELS = {
  labeled: '添加标签', unlabeled: '移除标签', assigned: '指派给', unassigned: '取消指派',
  closed: '关闭', reopened: '重新打开', renamed: '修改标题', review_requested: '请求评审',
  review_request_removed: '取消评审请求', ready_for_review: '标记为可评审', converted_to_draft: '转为草稿',
  merged: '合并', referenced: '引用', cross_referenced: '交叉引用', committed: '提交',
  milestoned: '设置里程碑', demilestoned: '移除里程碑', locked: '锁定', unlocked: '解锁',
  marked_as_duplicate: '标记为重复', connected: '关联', disconnected: '取消关联', deployed: '部署',
};

function operationSummary(raw) {
  const label = OPERATION_LABELS[raw.event] || raw.event;
  const extra = raw.label?.name ? ` ${raw.label.name}`
    : raw.assignee?.login ? ` @${raw.assignee.login}`
      : raw.milestone?.title ? ` ${raw.milestone.title}`
        : raw.rename?.to ? ` 「${raw.rename.to}」`
          : raw.source?.issue?.number ? ` #${raw.source.issue.number}`
            : raw.commit_id ? ` ${String(raw.commit_id).slice(0, 7)}` : '';
  return `${label}${extra}`;
}

function operationEvent(item, raw) {
  const actor = raw.actor || raw.user || {};
  const detail = {
    label: raw.label?.name || null, assignee: raw.assignee?.login || null, milestone: raw.milestone?.title || null,
    renameTo: raw.rename?.to || null, sha: raw.commit_id || null, sourceNumber: raw.source?.issue?.number || null,
    sourceUrl: raw.source?.issue?.html_url || null,
  };
  return {
    category: 'operation', eventType: raw.event,
    dedupeKey: `timeline:${item.id}:${raw.event}:${raw.id ?? sha1(JSON.stringify([raw.event, raw.created_at, actor.login, detail]))}`,
    actorLogin: typeof actor.login === 'string' ? actor.login : null, actorGithubId: identityId(actor.id),
    actorAvatarUrl: typeof actor.avatar_url === 'string' ? actor.avatar_url : '',
    summary: operationSummary(raw), detail, occurredAt: raw.created_at || now(),
  };
}

function actionsRunId(run) {
  if (run?.app?.slug !== 'github-actions' && run?.app?.name !== 'GitHub Actions') return null;
  const match = String(run.details_url || run.html_url || '').match(/\/actions\/runs\/(\d+)(?:\/|$)/);
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function checkEvent(item, run) {
  const status = typeof run.status === 'string' ? run.status : 'unknown';
  const conclusion = typeof run.conclusion === 'string' ? run.conclusion : null;
  return {
    category: 'ci', eventType: 'check_run', dedupeKey: `check:${run.id}`,
    actorLogin: run.app?.name || null, actorGithubId: null, actorAvatarUrl: '',
    summary: `${run.name || 'check'} · ${conclusion || status}`,
    detail: { name: run.name || 'check', app: run.app?.name || null, appSlug: run.app?.slug || null, runId: actionsRunId(run), status, conclusion, url: run.html_url || run.details_url || null, sha: run.head_sha || null, startedAt: run.started_at || null, completedAt: run.completed_at || null },
    occurredAt: run.completed_at || run.started_at || now(),
  };
}
function statusEvent(item, status) {
  return {
    category: 'ci', eventType: 'commit_status', dedupeKey: `status:${status.context}:${status.id}`,
    actorLogin: status.creator?.login || null, actorGithubId: identityId(status.creator?.id), actorAvatarUrl: status.creator?.avatar_url || '',
    summary: `${status.context || 'status'} · ${status.state || 'unknown'}`,
    detail: { context: status.context || null, state: status.state || null, description: status.description || null, url: status.target_url || null, sha: status.sha || null },
    occurredAt: status.updated_at || status.created_at || now(),
  };
}

// Keep a single row per CI check name/context; a re-run or a commit status must
// replace the previous state instead of showing old and new side by side.
function dedupeCIEvents(item, runs, statuses) {
  const byKey = new Map();
  for (const run of runs) {
    const event = checkEvent(item, run);
    const key = (event.detail.name || '').toLowerCase() || `run:${run.id}`;
    const previous = byKey.get(key);
    if (!previous || Date.parse(event.occurredAt) >= Date.parse(previous.occurredAt)) byKey.set(key, event);
  }
  for (const status of statuses) {
    const event = statusEvent(item, status);
    const key = (event.detail.context || '').toLowerCase() || `status:${status.id}`;
    if (byKey.has(key)) continue;
    const previous = byKey.get(key);
    if (!previous || Date.parse(event.occurredAt) >= Date.parse(previous.occurredAt)) byKey.set(key, event);
  }
  return [...byKey.values()];
}

export function dedupeStoredCI(db) {
  const rows = db.prepare("SELECT id,item_id,event_type,summary,detail,occurred_at FROM item_events WHERE category='ci'").all();
  const keep = new Map();
  for (const row of rows) {
    let detail = {};
    try { detail = JSON.parse(row.detail); } catch { /* ignore */ }
    const name = (detail.name || detail.context || row.summary || row.id).toLowerCase();
    const key = `${row.item_id}|${name}`;
    const previous = keep.get(key);
    const better = !previous
      || row.event_type === 'check_run' && previous.event_type !== 'check_run'
      || row.event_type === previous.event_type && Date.parse(row.occurred_at) >= Date.parse(previous.occurred_at);
    if (better) keep.set(key, row);
  }
  const kept = new Set([...keep.values()].map(row => row.id));
  const remove = rows.filter(row => !kept.has(row.id));
  if (!remove.length) return 0;
  const statement = db.prepare('DELETE FROM item_events WHERE id=?');
  db.exec('BEGIN IMMEDIATE');
  try { for (const row of remove) statement.run(row.id); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  return remove.length;
}

function upsertEvent(db, itemId, event) {
  const at = now();
  const existing = db.prepare('SELECT id FROM item_events WHERE dedupe_key=?').get(event.dedupeKey);
  if (existing) {
    db.prepare('UPDATE item_events SET summary=?,detail=?,occurred_at=?,synced_at=? WHERE id=?')
      .run(event.summary, JSON.stringify(event.detail), event.occurredAt, at, existing.id);
    return existing.id;
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO item_events(id,item_id,category,event_type,dedupe_key,actor_login,actor_github_id,actor_avatar_url,summary,detail,occurred_at,synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, itemId, event.category, event.eventType, event.dedupeKey, event.actorLogin, event.actorGithubId, event.actorAvatarUrl, event.summary, JSON.stringify(event.detail), event.occurredAt, at);
  return id;
}

export function parseItem(row) {
  try { return { ...JSON.parse(row.data), id: row.id, workflow: row.workflow, ownerMemberId: row.owner_member_id, priority: row.priority, dueAt: row.due_at, version: row.version ?? 1, needsReview: !!row.needs_review }; }
  catch { return null; }
}
function itemRow(db, id) {
  const row = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  const item = row && parseItem(row);
  if (!item) throw fail(404, '事务不存在', 'NOT_FOUND');
  return item;
}

export function categorizeTimeline(raw) {
  if (!raw || typeof raw.event !== 'string') return null;
  if (raw.event === 'commented' || raw.event === 'reviewed') return null;
  return 'operation';
}

export async function syncItemConversation(db, config, itemId, { force = false, fetchImpl = fetch } = {}) {
  const item = itemRow(db, itemId);
  if (config.demo) return { skipped: true, item, demo: true };
  const sync = db.prepare('SELECT * FROM item_conversation_sync WHERE item_id=?').get(item.id);
  const messagesAt = sync?.messages_synced_at ? Date.parse(sync.messages_synced_at) : 0;
  if (!force && Number.isFinite(messagesAt) && Date.now() - messagesAt < TTL_MS) return { skipped: true, item };
  const token = config.githubToken || '';
  const tasks = [
    fetchIssueComments({ repo: config.repo, number: item.number, token, fetchImpl }),
    fetchIssueTimeline({ repo: config.repo, number: item.number, token, fetchImpl }),
  ];
  if (item.kind === 'pr') {
    tasks.push(fetchPullReviews({ repo: config.repo, number: item.number, token, fetchImpl }));
    tasks.push(fetchPullReviewComments({ repo: config.repo, number: item.number, token, fetchImpl }));
  }
  const [comments, timeline, reviews = [], reviewComments = []] = await Promise.all(tasks);

  let ciEvents = [];
  let headSha = item.headSha || null;
  if (item.kind === 'pr') {
    try {
      if (!headSha) {
        const detail = await fetchPullRequestDetail({ repo: config.repo, number: item.number, token, fetchImpl });
        headSha = typeof detail.head?.sha === 'string' ? detail.head.sha : null;
      }
      if (headSha) {
        const [runs, statuses] = await Promise.all([
          fetchPullCheckRuns({ repo: config.repo, ref: headSha, token, fetchImpl }).catch(() => []),
          fetchCommitStatuses({ repo: config.repo, ref: headSha, token, fetchImpl }).catch(() => []),
        ]);
        ciEvents = dedupeCIEvents(item, runs, statuses);
      }
    } catch { /* CI is best-effort; conversation still syncs */ }
  }

  const full = comments.length + reviews.length + reviewComments.length < MESSAGE_LIMIT && timeline.length < EVENT_LIMIT;
  const seen = new Set();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const comment of comments) { const row = commentRow(comment); seen.add(row.remoteKey); upsertMessage(db, item.id, row); }
    for (const review of reviews) { const row = reviewRow(review); seen.add(row.remoteKey); upsertMessage(db, item.id, row); }
    for (const comment of reviewComments) { const row = reviewCommentRow(comment); seen.add(row.remoteKey); upsertMessage(db, item.id, row); }
    if (full) markRemoteDeleted(db, item.id, seen);
    for (const raw of timeline) {
      if (!categorizeTimeline(raw)) continue;
      upsertEvent(db, item.id, operationEvent(item, raw));
    }
    if (item.kind === 'pr') {
      db.prepare("DELETE FROM item_events WHERE item_id=? AND category='ci'").run(item.id);
      for (const event of ciEvents) upsertEvent(db, item.id, event);
    }
    const at = now();
    db.prepare(`INSERT INTO item_conversation_sync(item_id,messages_synced_at,events_synced_at,ci_synced_at,truncated) VALUES (?,?,?,?,?)
      ON CONFLICT(item_id) DO UPDATE SET messages_synced_at=excluded.messages_synced_at,events_synced_at=excluded.events_synced_at,ci_synced_at=excluded.ci_synced_at,truncated=excluded.truncated`)
      .run(item.id, at, at, at, full ? 0 : 1);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { skipped: false, item, messages: comments.length + reviews.length + reviewComments.length, events: timeline.length, ci: ciEvents.length };
}

export async function syncConversationBatch(db, config, { limit = 20, fetchImpl = fetch } = {}) {
  if (config.demo) return { synced: 0 };
  const items = listItems(db, Date.now(), config.feishuAppId || '').filter(item => item.state === 'open').slice(0, limit);
  let synced = 0;
  for (const item of items) {
    try { const result = await syncItemConversation(db, config, item.id, { fetchImpl }); if (!result.skipped) synced++; }
    catch (error) { if (error.status === 429 || error.retryAt) break; }
  }
  return { synced };
}

function ensureBaseline(db, memberId) {
  const row = db.prepare('SELECT conversation_baseline_at FROM members WHERE id=?').get(memberId);
  if (!row) return null;
  if (row.conversation_baseline_at) return row.conversation_baseline_at;
  const at = now();
  db.prepare('UPDATE members SET conversation_baseline_at=? WHERE id=?').run(at, memberId);
  return at;
}

export function unreadSummary(db, memberId) {
  const baseline = ensureBaseline(db, memberId);
  const member = db.prepare('SELECT github_user_id FROM members WHERE id=?').get(memberId);
  if (!baseline || !member) return {};
  const rows = db.prepare(`SELECT m.item_id,
      COUNT(*) AS unread,
      SUM(CASE WHEN EXISTS(SELECT 1 FROM item_message_mentions mm WHERE mm.message_id=m.id AND mm.member_id=?) THEN 1 ELSE 0 END) AS mentions,
      MAX(m.created_at) AS last_message_at
    FROM item_messages m
    LEFT JOIN item_read_state rs ON rs.item_id=m.item_id AND rs.member_id=?
    WHERE m.remote_deleted=0
      AND (m.author_member_id IS NULL OR m.author_member_id<>?)
      AND (m.author_github_id IS NULL OR m.author_github_id<>?)
      AND m.created_at > COALESCE(rs.last_read_at, ?)
    GROUP BY m.item_id`).all(memberId, memberId, memberId, member.github_user_id, baseline);
  return Object.fromEntries(rows.map(row => [row.item_id, { unread: row.unread, mentions: row.mentions || 0, lastMessageAt: row.last_message_at }]));
}

export function unreadForItem(db, memberId, itemId) {
  return unreadSummary(db, memberId)[itemId] || { unread: 0, mentions: 0, lastMessageAt: null };
}

export function recordReads(db, memberId, itemId, messageIds) {
  const member = db.prepare('SELECT github_user_id FROM members WHERE id=?').get(memberId);
  if (!member || !Array.isArray(messageIds) || !messageIds.length) return 0;
  const ids = [...new Set(messageIds.filter(id => typeof id === 'string' && id))].slice(0, 50);
  if (!ids.length) return 0;
  const rows = db.prepare(`SELECT id,created_at,author_member_id,author_github_id FROM item_messages WHERE item_id=? AND id IN (${ids.map(() => '?').join(',')})`).all(itemId, ...ids);
  let latest = null, latestId = null, inserted = 0;
  for (const row of rows) {
    if (row.author_member_id === memberId || (row.author_github_id && row.author_github_id === member.github_user_id)) continue;
    inserted += Number(db.prepare('INSERT OR IGNORE INTO item_message_reads(message_id,member_id,read_at) VALUES (?,?,?)').run(row.id, memberId, now()).changes);
    if (!latest || row.created_at > latest) { latest = row.created_at; latestId = row.id; }
  }
  if (latest) {
    db.prepare(`INSERT INTO item_read_state(item_id,member_id,last_read_at,last_read_message_id,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(item_id,member_id) DO UPDATE SET last_read_at=MAX(item_read_state.last_read_at,excluded.last_read_at),last_read_message_id=excluded.last_read_message_id,updated_at=excluded.updated_at`)
      .run(itemId, memberId, latest, latestId, now());
  }
  return inserted;
}

export function readsForMessage(db, itemId, messageId) {
  return db.prepare(`SELECT r.member_id AS memberId, r.read_at AS readAt, m.display_name AS displayName, m.github_login AS login, m.avatar_url AS avatarUrl
    FROM item_message_reads r JOIN members m ON m.id=r.member_id JOIN item_messages msg ON msg.id=r.message_id
    WHERE msg.item_id=? AND r.message_id=? AND m.status='active' ORDER BY r.read_at DESC LIMIT 50`).all(itemId, messageId);
}

function messageView(db, row, memberId) {
  const mentions = db.prepare('SELECT member_id AS memberId, login FROM item_message_mentions WHERE message_id=?').all(row.id);
  const readCount = db.prepare('SELECT COUNT(*) AS n FROM item_message_reads WHERE message_id=?').get(row.id).n;
  const readByMe = !!db.prepare('SELECT 1 FROM item_message_reads WHERE message_id=? AND member_id=?').get(row.id, memberId);
  return {
    id: row.id, source: row.source, kind: row.kind,
    author: {
      memberId: row.author_member_id || null,
      login: row.member_login || row.author_login,
      name: row.member_name || row.member_login || row.author_login,
      avatarUrl: row.member_avatar || row.author_avatar_url || '',
    },
    body: row.body, createdAt: row.created_at, updatedAt: row.updated_at, url: row.url,
    path: row.path, line: row.line, startLine: row.start_line ?? null, side: row.side || null,
    diffHunk: row.diff_hunk || null,
    reviewCommentId: typeof row.github_comment_id === 'string' && row.github_comment_id.startsWith('review_comment:') ? row.github_comment_id.slice('review_comment:'.length) : null,
    state: row.state,
    deliveryStatus: row.delivery_status, deliveryError: row.delivery_error,
    remoteDeleted: !!row.remote_deleted,
    mentions: mentions.map(mention => ({ ...mention, isSelf: mention.memberId === memberId })),
    readCount, readByMe,
  };
}

export function listConversation(db, config, itemId, memberId, { before = '', limit = 50 } = {}) {
  const item = itemRow(db, itemId);
  const size = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const params = [item.id];
  let where = 'm.item_id=?';
  if (before) { where += ' AND m.created_at<?'; params.push(before); }
  const rows = db.prepare(`SELECT m.*,mem.display_name AS member_name,mem.github_login AS member_login,mem.avatar_url AS member_avatar
    FROM item_messages m LEFT JOIN members mem ON mem.id=m.author_member_id
    WHERE ${where} ORDER BY m.created_at DESC,m.id DESC LIMIT ?`).all(...params, size);
  const messages = rows.map(row => messageView(db, row, memberId));
  const ci = db.prepare("SELECT * FROM item_events WHERE item_id=? AND category='ci' ORDER BY occurred_at DESC LIMIT 50").all(item.id);
  const operations = db.prepare("SELECT * FROM item_events WHERE item_id=? AND category='operation' ORDER BY occurred_at DESC LIMIT 200").all(item.id);
  const sync = db.prepare('SELECT * FROM item_conversation_sync WHERE item_id=?').get(item.id);
  return {
    item: { id: item.id, number: item.number, kind: item.kind, title: item.title, body: item.body, state: item.state, url: item.url, author: item.author, createdAt: item.createdAt, updatedAt: item.updatedAt, labels: item.labels || [], assignees: item.assignees || [], reviewers: item.reviewers || [], headSha: item.headSha || null, mergeableState: item.mergeableState || null, draft: !!item.draft, ownerMemberId: item.ownerMemberId || null, owner: item.owner || null, workflow: item.workflow, priority: item.priority, dueAt: item.dueAt, version: item.version, needsReview: !!item.needsReview },
    messages,
    events: {
      ci: ci.map(eventView),
      operation: operations.map(eventView),
    },
    unread: unreadForItem(db, memberId, item.id),
    sync: { messagesAt: sync?.messages_synced_at || null, eventsAt: sync?.events_synced_at || null, ciAt: sync?.ci_synced_at || null, truncated: !!sync?.truncated, stale: !sync?.messages_synced_at || Date.now() - Date.parse(sync.messages_synced_at) >= TTL_MS },
  };
}

export function messageDto(db, row, memberId) { return messageView(db, row, memberId); }

function eventView(row) {
  let detail = {};
  try { detail = JSON.parse(row.detail); } catch { /* ignore */ }
  return { id: row.id, category: row.category, type: row.event_type, actor: { login: row.actor_login, githubId: row.actor_github_id, avatarUrl: row.actor_avatar_url }, summary: row.summary, detail, occurredAt: row.occurred_at };
}

export function getMessage(db, itemId, messageId) {
  return db.prepare('SELECT * FROM item_messages WHERE item_id=? AND id=?').get(itemId, messageId);
}

export async function postPlatformMessage(db, config, { member, itemId, body, clientId, fetchImpl = fetch }) {
  if (typeof body !== 'string' || !body.trim() || body.length > BODY_LIMIT || body.includes('\u0000')) throw fail(400, '消息内容无效', 'INVALID_INPUT');
  const item = itemRow(db, itemId);
  if (item.state !== 'open') throw fail(409, '只在开放事项中发言', 'ITEM_CLOSED');
  if (clientId) {
    const existing = db.prepare('SELECT * FROM item_messages WHERE author_member_id=? AND client_id=?').get(member.id, String(clientId));
    if (existing) return db.prepare(`SELECT m.*,mem.display_name AS member_name,mem.github_login AS member_login,mem.avatar_url AS member_avatar FROM item_messages m LEFT JOIN members mem ON mem.id=m.author_member_id WHERE m.id=?`).get(existing.id);
  }
  const demo = config.demo;
  const token = demo ? null : getGitHubToken(db, member.id, config);
  if (!demo && !token) throw Object.assign(fail(409, '需要授权 GitHub 评论写入权限', 'GITHUB_WRITE_AUTH_REQUIRED'), { authUrl: `/auth/github?${new URLSearchParams({ returnTo: `/workspace/items/${encodeURIComponent(item.id)}` })}` });
  const id = randomUUID();
  const at = now();
  db.prepare(`INSERT INTO item_messages(id,item_id,source,kind,author_member_id,author_login,author_github_id,author_avatar_url,body,delivery_status,client_id,created_at,updated_at,synced_at)
    VALUES (?,?,'platform','platform',?,?,?,?,?,?,?,?,?,?)`)
    .run(id, item.id, member.id, member.github_login, member.github_user_id, member.avatar_url || '', body.trim(), demo ? 'demo' : 'pending', clientId ? String(clientId) : null, at, at, at);
  syncMentions(db, id, body);
  if (demo) return db.prepare(`SELECT m.*,mem.display_name AS member_name,mem.github_login AS member_login,mem.avatar_url AS member_avatar FROM item_messages m LEFT JOIN members mem ON mem.id=m.author_member_id WHERE m.id=?`).get(id);
  try {
    const created = await createIssueComment({ repo: config.repo, number: item.number, token, body: body.trim(), fetchImpl });
    db.prepare('UPDATE item_messages SET github_comment_id=?,url=?,created_at=?,updated_at=?,delivery_status=? WHERE id=?')
      .run(`comment:${created.id}`, created.html_url, created.created_at, created.created_at, 'synced', id);
    markGitHubTokenVerified(db, member.id);
    addAudit(db, { actorId: member.id, action: 'comment.create', targetType: 'item', targetId: item.id, after: { messageId: id, githubCommentId: String(created.id) } });
    return db.prepare(`SELECT m.*,mem.display_name AS member_name,mem.github_login AS member_login,mem.avatar_url AS member_avatar FROM item_messages m LEFT JOIN members mem ON mem.id=m.author_member_id WHERE m.id=?`).get(id);
  } catch (error) {
    const code = error.status === 401 ? 'GITHUB_TOKEN_INVALID' : error.status === 403 ? 'GITHUB_FORBIDDEN' : error.status === 429 ? 'GITHUB_RATE_LIMITED' : 'GITHUB_UNAVAILABLE';
    db.prepare('UPDATE item_messages SET delivery_status=?,delivery_error=? WHERE id=?').run('failed', code, id);
    if (code === 'GITHUB_TOKEN_INVALID') deleteGitHubToken(db, member.id);
    const status = code === 'GITHUB_TOKEN_INVALID' ? 409 : code === 'GITHUB_RATE_LIMITED' ? 429 : 502;
    throw Object.assign(fail(status, code === 'GITHUB_TOKEN_INVALID' ? 'GitHub 授权已失效，请重新授权' : code === 'GITHUB_FORBIDDEN' ? '没有向该仓库评论的 GitHub 权限' : code === 'GITHUB_RATE_LIMITED' ? 'GitHub 接口限流，请稍后重试' : 'GitHub 评论发送失败，请重试', code), { messageId: id, retryAt: error.retryAt });
  }
}

export async function retryPlatformMessage(db, config, { member, itemId, messageId, fetchImpl = fetch }) {
  const row = getMessage(db, itemId, messageId);
  if (!row || row.source !== 'platform' || row.author_member_id !== member.id) throw fail(404, '消息不存在', 'NOT_FOUND');
  if (row.delivery_status !== 'failed' || row.github_comment_id) throw fail(409, '该消息不需要重试', 'NOT_RETRYABLE');
  db.prepare('DELETE FROM item_messages WHERE id=?').run(messageId);
  return postPlatformMessage(db, config, { member, itemId, body: row.body, clientId: row.client_id, fetchImpl });
}

const RERUN_MESSAGES = {
  GITHUB_ORG_RESTRICTED: '组织启用了 OAuth App 访问限制，需要组织管理员批准该 OAuth App，或配置 GITHUB_ACTIONS_TOKEN 兜底',
  GITHUB_TOKEN_INVALID: 'GitHub 授权已失效，请重新授权',
  GITHUB_FORBIDDEN: '没有重试该 GitHub Actions 流水线的权限',
  GITHUB_RUN_NOT_FOUND: '流水线不存在或已过期，无法重试',
  GITHUB_RATE_LIMITED: 'GitHub 接口限流，请稍后重试',
  GITHUB_UNAVAILABLE: 'GitHub Actions 重试请求失败，请稍后重试',
  GITHUB_ACTIONS_TOKEN_INVALID: '服务器 GitHub Actions Token 已失效，请管理员更新 GITHUB_ACTIONS_TOKEN',
  GITHUB_ACTIONS_TOKEN_FORBIDDEN: '服务器 GitHub Actions Token 缺少 Actions 写权限，请管理员检查 Token 配置',
};

// "全量重试" maps to GitHub's rerun endpoint, which re-runs every job of the
// workflow run represented by this check run.
export async function rerunItemCI(db, config, { member, itemId, eventId, fetchImpl = fetch }) {
  const event = db.prepare("SELECT * FROM item_events WHERE id=? AND item_id=? AND category='ci'").get(eventId, itemId);
  if (!event) throw fail(404, 'CI 状态不存在', 'NOT_FOUND');
  let detail = {};
  try { detail = JSON.parse(event.detail); } catch { /* ignore */ }
  const isActions = event.event_type === 'check_run' && (detail.appSlug === 'github-actions' || detail.app === 'GitHub Actions');
  if (!isActions) throw fail(409, '只有 GitHub Actions 流水支持全量重试', 'CI_NOT_RERUNABLE');
  const runId = Number(detail.runId);
  if (!Number.isSafeInteger(runId) || runId < 1) throw fail(409, '缺少流水线运行 ID，请先刷新同步', 'CI_RUN_ID_MISSING');
  if (config.demo) return { ok: true, demo: true, runId };
  const authUrl = `/auth/github?${new URLSearchParams({ returnTo: `/workspace/items/${encodeURIComponent(itemId)}` })}`;
  const memberToken = getGitHubToken(db, member.id, config);
  const serverToken = typeof config.githubActionsToken === 'string' ? config.githubActionsToken.trim() : '';
  if (!memberToken && !serverToken) throw Object.assign(fail(409, '需要授权 GitHub 写入权限', 'GITHUB_WRITE_AUTH_REQUIRED'), { authUrl });
  // Members write as themselves; if the organization blocks OAuth Apps, fall
  // back to the server Actions token when it is configured.
  let source = memberToken ? 'member' : 'server';
  let token = memberToken || serverToken;
  try {
    try {
      await rerunGitHubWorkflow({ repo: config.repo, runId, token, fetchImpl });
    } catch (error) {
      if (source === 'member' && error.code === 'GITHUB_ORG_RESTRICTED' && serverToken) {
        source = 'server';
        token = serverToken;
        await rerunGitHubWorkflow({ repo: config.repo, runId, token, fetchImpl });
      } else throw error;
    }
  } catch (error) {
    const code = source === 'server' && error.status === 401 ? 'GITHUB_ACTIONS_TOKEN_INVALID'
      : source === 'server' && error.status === 403 ? 'GITHUB_ACTIONS_TOKEN_FORBIDDEN'
        : error.code === 'GITHUB_ORG_RESTRICTED' ? 'GITHUB_ORG_RESTRICTED'
          : error.status === 401 ? 'GITHUB_TOKEN_INVALID'
            : error.status === 403 ? 'GITHUB_FORBIDDEN'
              : error.status === 404 ? 'GITHUB_RUN_NOT_FOUND'
                : error.status === 429 ? 'GITHUB_RATE_LIMITED' : 'GITHUB_UNAVAILABLE';
    if (code === 'GITHUB_TOKEN_INVALID') deleteGitHubToken(db, member.id);
    const status = code === 'GITHUB_ACTIONS_TOKEN_INVALID' ? 503 : code === 'GITHUB_TOKEN_INVALID' ? 409
      : code === 'GITHUB_RUN_NOT_FOUND' ? 404
        : code === 'GITHUB_FORBIDDEN' || code === 'GITHUB_ORG_RESTRICTED' || code === 'GITHUB_ACTIONS_TOKEN_FORBIDDEN' ? 403
          : code === 'GITHUB_RATE_LIMITED' ? 429 : 502;
    throw Object.assign(fail(status, RERUN_MESSAGES[code], code), code === 'GITHUB_TOKEN_INVALID' ? { authUrl } : { retryAt: error.retryAt });
  }
  if (source === 'member') markGitHubTokenVerified(db, member.id);
  db.prepare('UPDATE item_events SET summary=?,detail=?,synced_at=? WHERE id=?')
    .run(`${detail.name || 'check'} · queued`, JSON.stringify({ ...detail, status: 'queued', conclusion: null }), now(), event.id);
  addAudit(db, { actorId: member.id, action: 'ci.rerun', targetType: 'item', targetId: itemId, after: { eventId: event.id, runId, via: source } });
  return { ok: true, runId, via: source };
}

function webhookOperation(payload, event, delivery) {
  const pr = payload.pull_request;
  const action = payload.action || 'updated';
  let summary = `${action}`;
  let detail = {};
  if (payload.label) { summary = `${action === 'labeled' ? '添加标签' : '移除标签'} ${payload.label.name}`; detail.label = payload.label.name; }
  else if (payload.assignee) { summary = `${action === 'assigned' ? '指派给' : '取消指派'} @${payload.assignee.login}`; detail.assignee = payload.assignee.login; }
  else if (action === 'renamed') { summary = `修改标题 「${payload.rename?.to || ''}」`; detail.renameTo = payload.rename?.to || null; }
  else if (action === 'closed' && pr?.merged) summary = '合并了 Pull Request';
  else if (action === 'closed') summary = '关闭';
  else if (action === 'reopened') summary = '重新打开';
  else if (action === 'ready_for_review') summary = '标记为可评审';
  else if (action === 'converted_to_draft') summary = '转为草稿';
  else if (action === 'synchronize') summary = '推送了新的提交';
  else if (action === 'review_requested') { summary = `请求 @${payload.requested_reviewer?.login || 'reviewer'} 评审`; detail.reviewer = payload.requested_reviewer?.login || null; }
  else if (action === 'edited') summary = '编辑了事项';
  const actor = payload.sender || {};
  return {
    category: 'operation', eventType: `${event}:${action}`,
    dedupeKey: `hook:${event}:${delivery}`,
    actorLogin: actor.login || null, actorGithubId: identityId(actor.id), actorAvatarUrl: actor.avatar_url || '',
    summary, detail, occurredAt: now(),
  };
}

export function upsertFromWebhook(db, payload, event, delivery) {
  const number = payload.issue?.number || payload.pull_request?.number || payload.check_run?.pull_requests?.[0]?.number;
  if (!Number.isSafeInteger(number)) return false;
  const row = db.prepare('SELECT * FROM items WHERE number=?').get(number);
  if (!row) return false;
  const item = parseItem(row);
  if (!item) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (event === 'issue_comment' && payload.comment) {
      if (payload.action === 'deleted') db.prepare('UPDATE item_messages SET remote_deleted=1 WHERE github_comment_id=?').run(`comment:${payload.comment.id}`);
      else upsertMessage(db, item.id, commentRow(payload.comment));
    } else if (event === 'pull_request_review' && payload.review) {
      upsertMessage(db, item.id, reviewRow(payload.review));
    } else if (event === 'pull_request_review_comment' && payload.comment) {
      if (payload.action === 'deleted') db.prepare('UPDATE item_messages SET remote_deleted=1 WHERE github_comment_id=?').run(`review_comment:${payload.comment.id}`);
      else upsertMessage(db, item.id, reviewCommentRow(payload.comment));
    } else if (event === 'check_run' && payload.check_run) {
      if (payload.check_run.name) {
        db.prepare(`DELETE FROM item_events WHERE item_id=? AND category='ci' AND event_type='check_run'
          AND lower(json_extract(detail,'$.name'))=lower(?)`).run(item.id, payload.check_run.name);
      }
      upsertEvent(db, item.id, checkEvent(item, payload.check_run));
    } else if (event === 'issues' || event === 'pull_request') {
      upsertEvent(db, item.id, webhookOperation(payload, event, delivery));
    }
    db.exec('COMMIT');
    return true;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
