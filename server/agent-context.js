// Build the whitelist context an external Agent may see for one item.
// Never include local workflow state, owner identity, priority, due date,
// member directory, notes, notifications or the legacy owner issue: the Agent
// works against the GitHub facts only and its output is reviewed by a human.
// Pull requests additionally expose metadata and bounded file patches so the
// Agent can review the actual change.
const MAX_BODY = 8000;
const MAX_COMMENT = 8000;
const MAX_COMMENTS = 40;
const MAX_TIMELINE = 60;
const MAX_FILES = 30;
const MAX_FILE_PATCH = 3000;
const MAX_TOTAL_PATCH = 24000;

function clip(value, limit) {
  const text = typeof value === 'string' ? value : '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function pullRequestFiles(files, filesError = '') {
  const out = [];
  let budget = MAX_TOTAL_PATCH;
  for (const file of (Array.isArray(files) ? files : []).slice(0, MAX_FILES)) {
    if (!file || typeof file.filename !== 'string') continue;
    const patch = clip(file.patch, Math.min(MAX_FILE_PATCH, Math.max(0, budget)));
    budget -= patch.length;
    out.push({
      path: file.filename,
      status: typeof file.status === 'string' ? file.status : '',
      additions: Number(file.additions) || 0,
      deletions: Number(file.deletions) || 0,
      changes: Number(file.changes) || 0,
      patch,
    });
    if (budget <= 0) break;
  }
  const truncated = Array.isArray(files) && files.length > out.length;
  return { files: out, filesTruncated: truncated, ...(filesError ? { filesError } : {}) };
}

export function buildItemContext(db, item, { repo, pullFiles, filesError = '', replyTo = null, reviewTask = false }) {
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
  const isPr = item.kind === 'pr';
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
    ...(replyTo ? { replyTo } : {}),
    ...(reviewTask ? {
      reviewGuide: {
        summaryMaxChars: 600,
        inlineFormat: '[review] [严重程度] {具体问题}\n[suggestion] {可行解决方式}',
        severityExamples: ['blocker', 'major', 'minor', 'nit'],
        note: 'Review 摘要保持简短；具体问题与建议全部写成行内意见。',
      },
    } : {}),
    ...(isPr ? {
      pr: {
        draft: Boolean(item.draft),
        merged: Boolean(item.merged),
        mergeableState: typeof item.mergeableState === 'string' ? item.mergeableState : 'unknown',
        headSha: typeof item.headSha === 'string' ? item.headSha : '',
        reviewers: Array.isArray(item.reviewers) ? item.reviewers.slice(0, 20) : [],
        ciStatus: typeof item.ciStatus === 'string' ? item.ciStatus : 'unknown',
      },
      ...pullRequestFiles(pullFiles, filesError),
    } : {}),
  };
}
