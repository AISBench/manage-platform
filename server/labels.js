import { addActivity, addAudit } from './db.js';
import { getGitHubToken } from './github-tokens.js';
import { fetchRepositoryLabels, fetchRepositoryPermissions, replaceIssueLabels } from './integrations/github.js';

const NAME_LIMIT = 100;
const LABEL_LIMIT = 20;
const COLOR_RE = /^[0-9a-fA-F]{6}$/;
// GitHub grants label writes to triage and above, so the platform mirrors exactly
// the same roles instead of inventing its own rule.
const WRITE_PERMISSIONS = ['admin', 'maintain', 'push', 'triage'];
const PERMISSION_TTL_MS = 60000;
const permissionCache = new Map();

const fail = (status, message, code) => Object.assign(new Error(message), { status, statusCode: status, code });
const names = value => (Array.isArray(value) ? value : [])
  .map(entry => typeof entry === 'string' ? entry : entry?.name)
  .filter(name => typeof name === 'string' && name.trim())
  .map(name => name.trim());

export function listLabels(db) {
  return db.prepare('SELECT name,color,description FROM repository_labels ORDER BY name COLLATE NOCASE').all()
    .map(row => ({ name: row.name, color: COLOR_RE.test(row.color) ? row.color.toLowerCase() : '', description: row.description || '' }));
}

export function hasLabel(item, name) {
  const needle = String(name || '').toLowerCase();
  return names(item?.labels).some(label => label.toLowerCase() === needle);
}

// Labels are repository-scoped, so one catalogue keeps every chip in sync.
export function syncRepositoryLabels(db, labels) {
  const incoming = new Map();
  for (const label of Array.isArray(labels) ? labels : []) {
    const name = typeof label?.name === 'string' ? label.name.trim() : '';
    if (!name || name.length > NAME_LIMIT) continue;
    incoming.set(name.toLowerCase(), {
      name,
      color: COLOR_RE.test(label.color) ? label.color.toLowerCase() : '',
      description: typeof label.description === 'string' ? label.description.slice(0, 500) : '',
    });
  }
  if (!incoming.size) return 0;
  const at = new Date().toISOString();
  const upsert = db.prepare(`INSERT INTO repository_labels(name,color,description,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET color=excluded.color,description=excluded.description,updated_at=excluded.updated_at`);
  let changed = 0;
  for (const label of incoming.values()) changed += Number(upsert.run(label.name, label.color, label.description, at).changes);
  const keep = [...incoming.keys()];
  db.prepare(`DELETE FROM repository_labels WHERE lower(name) NOT IN (${keep.map(() => '?').join(',')})`).run(...keep);
  return changed;
}

export async function refreshRepositoryLabels(db, config, { fetchImpl = fetch } = {}) {
  if (config.demo) return 0;
  try {
    return syncRepositoryLabels(db, await fetchRepositoryLabels({ repo: config.repo, token: config.githubToken, fetchImpl }));
  } catch {
    // The label catalogue is presentation data; a failed refresh must not abort a
    // repository sync that already succeeded.
    return 0;
  }
}

export async function labelWriteAccess(db, config, memberId, { fetchImpl = fetch } = {}) {
  if (config.demo) return { canEdit: true, permissions: null, reason: 'demo' };
  const token = getGitHubToken(db, memberId, config);
  if (!token) return { canEdit: false, permissions: null, reason: 'NO_GITHUB_WRITE_TOKEN' };
  const cacheKey = `${config.repo}:${memberId}`;
  const cached = fetchImpl === fetch ? permissionCache.get(cacheKey) : null;
  if (cached && Date.now() - cached.at < PERMISSION_TTL_MS) return cached.value;
  let value;
  try {
    const permissions = await fetchRepositoryPermissions({ repo: config.repo, token, fetchImpl });
    value = { canEdit: WRITE_PERMISSIONS.some(role => permissions[role] === true), permissions, reason: null };
  } catch {
    value = { canEdit: false, permissions: null, reason: 'GITHUB_PERMISSION_UNAVAILABLE' };
  }
  if (fetchImpl === fetch) permissionCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function normalizeNames(labels) {
  const unique = [];
  for (const name of names(labels)) {
    if (name.length > NAME_LIMIT) throw fail(400, '标签名过长', 'LABEL_INVALID');
    if (!unique.some(existing => existing.toLowerCase() === name.toLowerCase())) unique.push(name);
  }
  if (unique.length > LABEL_LIMIT) throw fail(400, '标签数量过多', 'LABEL_INVALID');
  return unique;
}

export async function updateItemLabels(db, config, { member, itemId, labels, requestId = null, fetchImpl = fetch }) {
  const row = db.prepare('SELECT * FROM items WHERE id=?').get(itemId);
  if (!row) throw fail(404, '事务不存在', 'NOT_FOUND');
  let data;
  try { data = JSON.parse(row.data); } catch { throw fail(500, '事务数据损坏', 'ITEM_CORRUPT'); }
  const wanted = normalizeNames(labels);

  let applied = wanted;
  if (!config.demo) {
    const access = await labelWriteAccess(db, config, member.id, { fetchImpl });
    if (!access.canEdit) {
      const message = access.reason === 'NO_GITHUB_WRITE_TOKEN'
        ? '尚未授权 GitHub 写权限，无法修改标签。请在个人设置中重新授权。'
        : '你在 GitHub 上没有修改该仓库标签的权限，平台不会绕过 GitHub 授权。';
      throw fail(403, message, access.reason === 'NO_GITHUB_WRITE_TOKEN' ? 'GITHUB_WRITE_UNAUTHORIZED' : 'GITHUB_LABEL_FORBIDDEN');
    }
    const token = getGitHubToken(db, member.id, config);
    try {
      applied = await replaceIssueLabels({ repo: config.repo, number: data.number, token, labels: wanted, fetchImpl });
    } catch (error) {
      if (error.status === 403) throw fail(403, error.code === 'GITHUB_ORG_RESTRICTED' ? 'GitHub 组织限制了 OAuth App 写入，无法修改标签。' : 'GitHub 拒绝了标签修改，请确认你在该仓库拥有 triage 及以上权限。', 'GITHUB_LABEL_FORBIDDEN');
      if (error.status === 422) throw fail(422, '标签不存在或无法应用，请先在 GitHub 仓库中创建该标签。', 'LABEL_UNKNOWN');
      if (error.status === 404) throw fail(404, 'GitHub 事务不存在或无权访问。', 'NOT_FOUND');
      throw fail(error.retryAt ? 429 : 502, 'GitHub 标签接口暂时不可用，请稍后重试。', 'GITHUB_UNAVAILABLE');
    }
  }

  const before = names(data.labels);
  const next = { ...data, labels: applied };
  db.prepare('UPDATE items SET data=?,version=version+1 WHERE id=?').run(JSON.stringify(next), row.id);
  addActivity(db, config.demo ? '更新演示标签' : '更新 GitHub 标签', `${member.github_login || member.login || ''} 更新 #${data.number}：${applied.join('、') || '无标签'}`);
  addAudit(db, { actorId: member.id, action: 'item.labels', targetType: 'item', targetId: row.id, before: { labels: before }, after: { labels: applied }, requestId });
  return { labels: applied };
}
