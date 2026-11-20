// Build the whitelist context an external Agent may see for one item.
// Never include local workflow state, owner identity, priority, due date,
// member directory, notes, notifications or the legacy owner issue: the Agent
// works against the GitHub facts only and its output is reviewed by a human.
const MAX_BODY = 8000;
const MAX_COMMENT = 8000;
const MAX_COMMENTS = 40;
const MAX_TIMELINE = 60;

function clip(value, limit) {
  const text = typeof value === 'string' ? value : '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function buildItemContext(db, item, { repo }) {
  if (!item) return null;
  const comments = db.prepare(`SELECT author_login,body,created_at FROM item_messages
    WHERE item_id=? AND remote_deleted=0 AND kind IN ('issue_comment','platform','review','review_comment')
    ORDER BY created_at ASC`).all(item.id)
    .slice(-MAX_COMMENTS)
    .map(row => ({ author: row.author_login || '', body: clip(row.body, MAX_COMMENT), createdAt: row.created_at }));
  const timeline = db.prepare(`SELECT event_type,actor_login,summary,detail,occurred_at FROM item_events
    WHERE item_id=? ORDER BY occurred_at ASC`).all(item.id)
    .slice(-MAX_TIMELINE)
    .map(row => {
      let detail = '';
      try { const parsed = JSON.parse(row.detail || '{}'); detail = parsed?.detail || parsed?.summary || ''; } catch { detail = row.detail || ''; }
      return { type: row.event_type || '', actor: row.actor_login || '', detail: clip(row.summary || detail, 500), at: row.occurred_at };
    });
  return {
    id: item.id,
    repo,
    number: item.number,
    kind: item.kind,
    state: item.state,
    title: item.title || '',
    body: clip(item.body, MAX_BODY),
    labels: Array.isArray(item.labels) ? item.labels.slice(0, 30) : [],
    assignees: Array.isArray(item.assignees) ? item.assignees.slice(0, 20) : [],
    createdAt: item.createdAt || '',
    updatedAt: item.updatedAt || '',
    url: item.url || '',
    comments,
    timeline,
  };
}
