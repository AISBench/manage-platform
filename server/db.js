import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const legacySchema = `
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, login TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT, avatar_url TEXT, feishu_open_id TEXT UNIQUE, notifications_enabled INTEGER NOT NULL DEFAULT 1, quiet_start TEXT NOT NULL DEFAULT '', quiet_end TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS oauth_states (state_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, user_id TEXT, browser_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, number INTEGER UNIQUE NOT NULL, data TEXT NOT NULL, workflow TEXT NOT NULL DEFAULT 'todo', owner TEXT, priority TEXT NOT NULL DEFAULT 'normal', due_at TEXT);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, dedupe_key TEXT UNIQUE NOT NULL, item_id TEXT, recipient TEXT NOT NULL, title TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
  CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY, received_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS webhook_inbox (id TEXT PRIMARY KEY, event TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, received_at TEXT NOT NULL);
`;

function addColumn(db, table, name, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
      const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(row => row.version));
      if ([...applied].some(version => version > 6)) throw new Error('Database schema is newer than this application');
      if (!applied.has(1)) {
        db.exec(legacySchema);
        db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(1, new Date().toISOString());
      }
      if (!applied.has(2)) {
        db.exec(`CREATE TABLE IF NOT EXISTS members (
          id TEXT PRIMARY KEY, github_user_id TEXT UNIQUE NOT NULL, github_login TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '', module TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
          status TEXT NOT NULL DEFAULT 'pending_activation' CHECK(status IN ('pending_activation','active','disabled')),
          created_by TEXT, first_login_at TEXT, last_login_at TEXT, version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS feishu_bindings (
          member_id TEXT PRIMARY KEY REFERENCES members(id), app_id TEXT NOT NULL, open_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'needs_confirmation' CHECK(status IN ('active','needs_confirmation')),
          binding_version INTEGER NOT NULL DEFAULT 1, bound_at TEXT NOT NULL, verified_at TEXT,
          UNIQUE(app_id,open_id));
          CREATE TABLE IF NOT EXISTS audit_logs (
          id TEXT PRIMARY KEY, actor_member_id TEXT, action TEXT NOT NULL, target_type TEXT NOT NULL,
          target_id TEXT, before_json TEXT, after_json TEXT, request_id TEXT, created_at TEXT NOT NULL);`);
        addColumn(db, 'users', 'member_id', 'TEXT REFERENCES members(id)');
        addColumn(db, 'sessions', 'member_id', 'TEXT REFERENCES members(id)');
        addColumn(db, 'oauth_states', 'member_id', 'TEXT REFERENCES members(id)');
        addColumn(db, 'items', 'owner_member_id', 'TEXT REFERENCES members(id)');
        addColumn(db, 'items', 'version', 'INTEGER NOT NULL DEFAULT 1');
        addColumn(db, 'items', 'needs_review', 'INTEGER NOT NULL DEFAULT 0');
        addColumn(db, 'items', 'legacy_owner_unresolved', 'INTEGER NOT NULL DEFAULT 0');
        addColumn(db, 'items', 'repository_id', 'TEXT');
        addColumn(db, 'notifications', 'recipient_member_id', 'TEXT REFERENCES members(id)');
        addColumn(db, 'notifications', 'binding_version', 'INTEGER');
        addColumn(db, 'notifications', 'next_at', 'INTEGER NOT NULL DEFAULT 0');
        addColumn(db, 'notifications', 'error_code', 'TEXT');
        addColumn(db, 'webhook_inbox', 'processed_at', 'TEXT');
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_member_id_unique ON users(member_id);
          CREATE INDEX IF NOT EXISTS sessions_member_id ON sessions(member_id);
          CREATE INDEX IF NOT EXISTS oauth_states_member_id ON oauth_states(member_id);
          CREATE INDEX IF NOT EXISTS items_owner_member_id ON items(owner_member_id);
          CREATE INDEX IF NOT EXISTS notifications_recipient_member_id ON notifications(recipient_member_id);
          CREATE INDEX IF NOT EXISTS audit_logs_created_at ON audit_logs(created_at);`);
        db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(2, new Date().toISOString());
      }
      if (!applied.has(3)) {
        db.exec(`CREATE TABLE registration_identities (
          id TEXT PRIMARY KEY, github_user_id TEXT UNIQUE NOT NULL, github_login TEXT, name TEXT, avatar_url TEXT,
          created_at TEXT, verified_at TEXT);
          CREATE TABLE registration_sessions (
          token_hash TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES registration_identities(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
          CREATE TABLE join_requests (
          id TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES registration_identities(id),
          status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')), display_name TEXT, module TEXT, reason TEXT,
          consented_at TEXT, submitted_at TEXT, reviewer_member_id TEXT REFERENCES members(id), reviewed_at TEXT,
          public_feedback TEXT NOT NULL DEFAULT '', internal_note TEXT NOT NULL DEFAULT '', member_id TEXT REFERENCES members(id),
          version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), round INTEGER NOT NULL CHECK(round>=1));
          CREATE UNIQUE INDEX join_requests_one_pending ON join_requests(identity_id) WHERE status='pending';
          CREATE INDEX join_requests_status_submitted ON join_requests(status,submitted_at);
          CREATE INDEX join_requests_identity_round ON join_requests(identity_id,round DESC);
          CREATE TABLE public_snapshots (
          id INTEGER PRIMARY KEY CHECK(id=1), repository_id TEXT, repo TEXT, generation TEXT, generated_at TEXT, visibility_checked_at TEXT);
          CREATE TABLE public_items (number INTEGER PRIMARY KEY, data TEXT NOT NULL, generation TEXT NOT NULL);`);
        db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(3, new Date().toISOString());
      }
      if (!applied.has(4)) {
        // The platform avatar mirrors the GitHub profile; keep it on the member
        // so member listings do not depend on the legacy users row.
        addColumn(db, 'members', 'avatar_url', "TEXT NOT NULL DEFAULT ''");
        db.exec(`UPDATE members SET avatar_url=COALESCE((SELECT avatar_url FROM users WHERE users.member_id=members.id),'') WHERE avatar_url=''`);
        db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(4, new Date().toISOString());
      }
      if (!applied.has(5)) {
        addColumn(db, 'members', 'conversation_baseline_at', 'TEXT');
        db.exec(`CREATE TABLE IF NOT EXISTS item_messages (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL REFERENCES items(id),
          source TEXT NOT NULL CHECK(source IN ('github','platform','demo')),
          kind TEXT NOT NULL CHECK(kind IN ('issue_comment','review','review_comment','platform')),
          github_comment_id TEXT UNIQUE,
          github_review_id TEXT,
          github_review_comment_id TEXT,
          in_reply_to_id TEXT,
          author_member_id TEXT REFERENCES members(id),
          author_login TEXT NOT NULL,
          author_github_id TEXT,
          author_avatar_url TEXT NOT NULL DEFAULT '',
          body TEXT NOT NULL,
          url TEXT,
          path TEXT,
          line INTEGER,
          state TEXT,
          delivery_status TEXT NOT NULL DEFAULT 'synced' CHECK(delivery_status IN ('pending','synced','failed','demo')),
          delivery_error TEXT,
          remote_deleted INTEGER NOT NULL DEFAULT 0,
          client_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          synced_at TEXT NOT NULL,
          UNIQUE(author_member_id, client_id));
          CREATE INDEX IF NOT EXISTS item_messages_item_created ON item_messages(item_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS item_messages_author ON item_messages(author_member_id);
          CREATE TABLE IF NOT EXISTS item_message_mentions (
          message_id TEXT NOT NULL REFERENCES item_messages(id),
          member_id TEXT NOT NULL REFERENCES members(id),
          login TEXT NOT NULL,
          PRIMARY KEY(message_id, member_id));
          CREATE INDEX IF NOT EXISTS item_message_mentions_member ON item_message_mentions(member_id);
          CREATE TABLE IF NOT EXISTS item_events (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL REFERENCES items(id),
          category TEXT NOT NULL CHECK(category IN ('ci','operation')),
          event_type TEXT NOT NULL,
          dedupe_key TEXT UNIQUE NOT NULL,
          actor_login TEXT,
          actor_github_id TEXT,
          actor_avatar_url TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '{}',
          occurred_at TEXT NOT NULL,
          synced_at TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS item_events_item_category_time ON item_events(item_id, category, occurred_at DESC);
          CREATE TABLE IF NOT EXISTS item_message_reads (
          message_id TEXT NOT NULL REFERENCES item_messages(id),
          member_id TEXT NOT NULL REFERENCES members(id),
          read_at TEXT NOT NULL,
          PRIMARY KEY(message_id, member_id));
          CREATE INDEX IF NOT EXISTS item_message_reads_member ON item_message_reads(member_id);
          CREATE TABLE IF NOT EXISTS item_read_state (
          item_id TEXT NOT NULL REFERENCES items(id),
          member_id TEXT NOT NULL REFERENCES members(id),
          last_read_at TEXT NOT NULL,
          last_read_message_id TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(item_id, member_id));
          CREATE TABLE IF NOT EXISTS item_conversation_sync (
          item_id TEXT PRIMARY KEY REFERENCES items(id),
          messages_synced_at TEXT,
          events_synced_at TEXT,
          ci_synced_at TEXT,
          truncated INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS github_user_tokens (
          member_id TEXT PRIMARY KEY REFERENCES members(id),
          github_login TEXT NOT NULL,
          github_user_id TEXT NOT NULL,
          encrypted_token TEXT NOT NULL,
          token_iv TEXT NOT NULL,
          token_tag TEXT NOT NULL,
          scopes TEXT NOT NULL DEFAULT '',
          authorized_at TEXT NOT NULL,
          last_verified_at TEXT);`);
        db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(5, new Date().toISOString());
      }
      if (!applied.has(6)) {
        addColumn(db, 'item_messages', 'diff_hunk', 'TEXT');
        addColumn(db, 'item_messages', 'start_line', 'INTEGER');
        addColumn(db, 'item_messages', 'side', 'TEXT');
        db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(6, new Date().toISOString());
      }
      db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES ('accessPolicy', ?)").run(JSON.stringify({ publicOverviewEnabled: false, version: 1 }));
      db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES ('rules', ?)").run(JSON.stringify({ enabled: false, staleHours: 48, reminderCooldownHours: 24 }));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return db;
  } catch (error) { db.close(); throw error; }
}
export const getSetting = (db, key, fallback = null) => { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; };
export const setSetting = (db, key, value) => db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
export function addActivity(db, title, detail = '') {
  db.prepare('INSERT INTO activity(id,title,detail,created_at) VALUES (?,?,?,?)').run(randomUUID(), title, detail, new Date().toISOString());
  db.exec('DELETE FROM activity WHERE id IN (SELECT id FROM activity ORDER BY created_at DESC LIMIT -1 OFFSET 300)');
}
function safeAudit(value) {
  if (Array.isArray(value)) return value.map(safeAudit);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/openid|token|secret|cookie|authorization|password|csrf|browserhash|statehash/i.test(key.replace(/[_-]/g, '')))
    .map(([key, item]) => [key, safeAudit(item)]));
  return value;
}
export function addAudit(db, { actorId = null, action, targetType, targetId = null, before = null, after = null, requestId = null }) {
  const id = randomUUID();
  db.prepare('INSERT INTO audit_logs(id,actor_member_id,action,target_type,target_id,before_json,after_json,request_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, actorId, action, targetType, targetId, before === null ? null : JSON.stringify(safeAudit(before)), after === null ? null : JSON.stringify(safeAudit(after)), requestId, new Date().toISOString());
  return id;
}
// Deprecated compatibility serializer: callers must supply authoritative member/binding fields.
// Never reconstruct authorization from environment usernames, demo mode, or legacy open IDs.
export function serializeUser(row) {
  return { id: row.id, memberId: row.member_id || null, login: row.login, name: row.name || row.login, avatarUrl: row.avatar_url || '', isAdmin: row.role === 'admin' && row.status === 'active', role: row.role || null, status: row.status || null, feishuBound: row.feishuBound === true, feishuVerified: row.feishuVerified === true, notificationsEnabled: !!row.notifications_enabled, quietStart: row.quiet_start || '', quietEnd: row.quiet_end || '' };
}
export function serializeItem(row, rules = { staleHours: 48 }, now = Date.now(), context = {}) {
  const data = JSON.parse(row.data);
  const overdue = data.state === 'open' && row.workflow !== 'done' && (row.due_at ? Date.parse(row.due_at) < now : now - Date.parse(data.updatedAt) >= rules.staleHours * 3600000);
  const ownerMemberId = row.owner_member_id || null;
  let ownerIssue = null;
  if (!ownerMemberId && row.owner) ownerIssue = 'legacy_unresolved';
  else if (ownerMemberId) {
    if (context.ownerStatus === 'disabled') ownerIssue = 'disabled';
    else if (context.ownerStatus !== 'active') ownerIssue = 'pending_activation';
    else if (!context.feishuBound) ownerIssue = 'unbound';
    else if (!context.feishuVerified) ownerIssue = 'needs_confirmation';
    else if (!context.notificationsEnabled) ownerIssue = 'notifications_disabled';
  }
  return { ...data, id: row.id, authorId: data.authorId == null ? null : String(data.authorId), assigneeIds: Array.isArray(data.assigneeIds) ? data.assigneeIds.map(String) : [], reviewerIds: Array.isArray(data.reviewerIds) ? data.reviewerIds.map(String) : [],
    workflow: row.workflow, ownerMemberId, owner: ownerMemberId ? context.ownerLogin || null : row.owner || null,
    ownerName: context.ownerName || (ownerMemberId ? context.ownerLogin : row.owner) || '', ownerStatus: context.ownerStatus || null,
    ownerReachable: !!ownerMemberId && !ownerIssue, ownerIssue, module: context.module || '',
    priority: row.priority, dueAt: row.due_at, overdue, version: row.version ?? 1, needsReview: !!row.needs_review };
}
export function listItems(db, now = Date.now(), appId = '') {
  const rules = getSetting(db, 'rules', { staleHours: 48 });
  return db.prepare(`SELECT i.*,m.github_login AS owner_login,m.display_name AS owner_display_name,m.status AS owner_status,m.module AS owner_module,
    u.name AS owner_profile_name,u.notifications_enabled AS owner_notifications_enabled,
    b.member_id AS binding_id,b.app_id AS binding_app_id,b.status AS binding_status,b.verified_at AS binding_verified_at
    FROM items i LEFT JOIN members m ON m.id=i.owner_member_id LEFT JOIN users u ON u.member_id=m.id
    LEFT JOIN feishu_bindings b ON b.member_id=m.id ORDER BY i.number DESC`).all().map(row => serializeItem(row, rules, now, {
      ownerLogin: row.owner_login, ownerName: row.owner_display_name || row.owner_profile_name || row.owner_login,
      ownerStatus: row.owner_status, module: row.owner_module,
      feishuBound: !!row.binding_id && row.binding_app_id === appId,
      feishuVerified: row.binding_app_id === appId && row.binding_status === 'active' && !!row.binding_verified_at,
      notificationsEnabled: !!row.owner_notifications_enabled,
    }));
}

export function seedDemo(db, repo) {
  const ago = hours => new Date(Date.now() - hours * 3600000).toISOString();
  const mentionLoginsForSeed = body => {
    const logins = new Set();
    for (const match of String(body).matchAll(/(^|[^\w-])@([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)/gi)) logins.add(match[2].toLowerCase());
    return [...logins];
  };
  const fixtures = [
    ['demo-admin', '1001', 'demo-maintainer', '演示维护者', 'admin', 'active'],
    ['demo-reviewer', '1002', 'reviewer-chen', '陈同学', 'member', 'active'],
    ['demo-pending', '1003', 'pending-lin', '林同学', 'member', 'pending_activation'],
    ['demo-disabled', '1004', 'disabled-wang', '王同学', 'member', 'disabled'],
  ];
  const examples = [
    ['pr', '支持服务化模型的流式性能评测', 'demo-maintainer', ['reviewer-chen'], ['enhancement', 'performance'], 5, 'pending'],
    ['issue', '多轮对话数据集评测结果异常', 'contributor-li', [], ['bug', 'help wanted'], 76, null],
    ['pr', '修复并发请求场景下的 token 统计', 'contributor-zhou', ['demo-maintainer'], ['bug'], 54, 'failure'],
    ['issue', '增加自定义数据集接入文档', 'demo-maintainer', [], ['documentation'], 12, null],
    ['pr', '优化数据集缓存与加载性能', 'reviewer-chen', ['demo-maintainer'], ['performance'], 20, 'success'],
    ['issue', '新增模型后端适配需求', 'contributor-wang', [], ['enhancement'], 96, null],
    ['issue', 'Windows 环境安装说明补充', 'reviewer-chen', [], ['documentation'], 2, null],
    ['pr', '更新评测任务配置示例', 'demo-maintainer', [], ['documentation'], 4, 'success'],
  ];
  const ids = { 'demo-maintainer': '1001', 'reviewer-chen': '1002', 'contributor-li': '2001', 'contributor-zhou': '2002', 'contributor-wang': '2003' };
  db.exec('BEGIN IMMEDIATE');
  try {
    const upgrading = !getSetting(db, 'demoFixtureVersion');
    const now = new Date().toISOString();
    for (const [id, githubId, login, name, role, status] of fixtures) {
      db.prepare(`INSERT OR IGNORE INTO members(id,github_user_id,github_login,display_name,role,status,first_login_at,last_login_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, githubId, login, name, role, status, status === 'active' ? now : null, status === 'active' ? now : null, now, now);
    }
    for (const [userId, login, name, memberId] of [['demo', 'demo-maintainer', '演示维护者', 'demo-admin'], ['demo-2', 'reviewer-chen', '陈同学', 'demo-reviewer']]) {
      db.prepare('INSERT OR IGNORE INTO users(id,login,name,member_id) VALUES (?,?,?,?)').run(userId, login, name, memberId);
      if (upgrading) db.prepare('UPDATE users SET member_id=? WHERE id=? AND login=? COLLATE NOCASE AND member_id IS NULL').run(memberId, userId, login);
    }
    let inserted = 0;
    examples.forEach(([kind, title, author, reviewers, labels, hours, ciStatus], index) => {
      const number = 9000 + index;
      const item = { id: `github:${number}`, number, kind, title, body: '这是本地演示数据，不对应真实 GitHub 事务。可在平台内调整负责人、优先级和处理进度。', url: `https://github.com/${repo}`, state: index === 7 ? 'closed' : 'open', author, assignees: index % 2 ? ['demo-maintainer'] : [], reviewers, labels, updatedAt: ago(hours), createdAt: ago(hours + 30), ciStatus };
      item.authorId = ids[author]; item.assigneeIds = item.assignees.map(login => ids[login]); item.reviewerIds = reviewers.map(login => ids[login]);
      inserted += Number(db.prepare('INSERT OR IGNORE INTO items(id,number,data,workflow,owner,owner_member_id,priority) VALUES (?,?,?,?,?,?,?)')
        .run(item.id, number, JSON.stringify(item), index === 7 ? 'done' : index === 2 ? 'blocked' : index === 0 ? 'in_progress' : 'todo', index % 2 ? 'demo-maintainer' : null, index % 2 ? 'demo-admin' : null, index === 2 ? 'high' : 'normal').changes);
      if (upgrading) {
        const existing = db.prepare('SELECT * FROM items WHERE id=? AND number=?').get(item.id, number);
        if (!existing) return;
        const data = JSON.parse(existing.data);
        if (data.authorId == null) data.authorId = ids[data.author] || null;
        if (!Array.isArray(data.assigneeIds)) data.assigneeIds = (data.assignees || []).map(login => ids[login]).filter(Boolean);
        if (!Array.isArray(data.reviewerIds)) data.reviewerIds = (data.reviewers || []).map(login => ids[login]).filter(Boolean);
        const ownerId = fixtures.find(f => f[2] === existing.owner)?.[0] || null;
        db.prepare('UPDATE items SET data=?,owner_member_id=COALESCE(owner_member_id,?),legacy_owner_unresolved=? WHERE id=?')
          .run(JSON.stringify(data), ownerId, existing.owner && !existing.owner_member_id && !ownerId ? 1 : 0, existing.id);
      }
    });
    const demoMessages = [
      ['demo-msg-9000-1', 'github:9000', 'github', 'issue_comment', 'demo-reviewer', 'reviewer-chen', '1002', '这个 PR 的流式性能数据我看过了，整体稳定。@demo-maintainer 需要再确认一下长序列场景。', 'synced', ago(30)],
      ['demo-msg-9000-2', 'github:9000', 'github', 'review_comment', null, 'contributor-li', '2001', '这里建议补充一下异常中断时的 token 统计。', 'synced', ago(20)],
      ['demo-msg-9000-3', 'github:9000', 'platform', 'platform', 'demo-admin', 'demo-maintainer', '1001', '收到，我在平台上跟进一下长序列场景，稍后把结论同步到 GitHub。', 'demo', ago(6)],
      ['demo-msg-9000-4', 'github:9000', 'github', 'issue_comment', 'demo-reviewer', 'reviewer-chen', '1002', '补充一份很长的测试记录，用于验证折叠效果。' + '这是较长的演示评论内容，用于展示折叠与展开。'.repeat(60), 'synced', ago(1)],
      ['demo-msg-9001-1', 'github:9001', 'github', 'issue_comment', 'demo-reviewer', 'reviewer-chen', '1002', '这个问题在最近一次同步中也出现了，@demo-maintainer 方便看一下数据集配置吗？', 'synced', ago(18)],
      ['demo-msg-9001-2', 'github:9001', 'github', 'issue_comment', null, 'contributor-zhou', '2002', '我这边也复现了，附上最小复现步骤和日志。', 'synced', ago(8)],
    ];
    for (const [id, itemId, source, kind, authorMember, login, githubId, body, delivery, at] of demoMessages) {
      db.prepare(`INSERT OR IGNORE INTO item_messages(id,item_id,source,kind,author_member_id,author_login,author_github_id,author_avatar_url,body,delivery_status,created_at,updated_at,synced_at)
        VALUES (?,?,?,?,?,?,?,'',?,?,?,?,?)`).run(id, itemId, source, kind, authorMember, login, githubId, body, delivery, at, at, at);
      for (const login of mentionLoginsForSeed(body)) {
        const member = fixtures.find(fixture => fixture[2] === login)?.[0];
        if (member) db.prepare('INSERT OR IGNORE INTO item_message_mentions(message_id,member_id,login) VALUES (?,?,?)').run(id, member, login);
      }
    }
    db.prepare(`UPDATE item_messages SET path=?,line=?,side=?,diff_hunk=?,github_comment_id=?,url=? WHERE id='demo-msg-9000-2'`)
      .run('src/benchmark/tasks.py', 42, 'RIGHT',
        '@@ -39,7 +39,9 @@ def run_task(task):\n     result = task.execute()\n-    return result\n+    if result is None:\n+        raise ValueError("empty result")\n+    return result\n \n def cleanup():',
        'review_comment:90002', `https://github.com/${repo}/pull/9000#discussion_r90002`);
    const demoEvents = [
      ['demo-event-ci-1', 'github:9000', 'ci', 'check_run', 'check:demo-9000', 'github-actions', '性能回归 / benchmark', JSON.stringify({ name: '性能回归 / benchmark', app: 'GitHub Actions', appSlug: 'github-actions', runId: 9000001, status: 'completed', conclusion: 'success', url: `https://github.com/${repo}/actions`, completedAt: ago(3) }), ago(3)],
      ['demo-event-ci-2', 'github:9000', 'ci', 'check_run', 'check:demo-9000-lint', 'github-actions', '代码风格检查', JSON.stringify({ name: '代码风格检查', app: 'GitHub Actions', appSlug: 'github-actions', runId: 9000002, status: 'completed', conclusion: 'failure', url: `https://github.com/${repo}/actions`, completedAt: ago(2) }), ago(2)],
      ['demo-event-op-1', 'github:9000', 'operation', 'labeled', 'timeline:9000:labeled:demo', 'demo-reviewer', '添加标签 enhancement', JSON.stringify({ label: 'enhancement' }), ago(26)],
      ['demo-event-op-2', 'github:9000', 'operation', 'review_requested', 'timeline:9000:review:demo', 'demo-maintainer', '请求 @reviewer-chen 评审', JSON.stringify({ reviewer: 'reviewer-chen' }), ago(24)],
      ['demo-event-op-3', 'github:9001', 'operation', 'assigned', 'timeline:9001:assigned:demo', 'demo-maintainer', '指派给 @demo-maintainer', JSON.stringify({ assignee: 'demo-maintainer' }), ago(16)],
    ];
    for (const [id, itemId, category, eventType, dedupeKey, actor, summary, detail, at] of demoEvents) {
      db.prepare(`INSERT OR IGNORE INTO item_events(id,item_id,category,event_type,dedupe_key,actor_login,actor_github_id,actor_avatar_url,summary,detail,occurred_at,synced_at)
        VALUES (?,?,?,?,?,?,NULL,'',?,?,?,?)`).run(id, itemId, category, eventType, dedupeKey, actor, summary, detail, at, at);
    }
    db.prepare("UPDATE item_events SET detail=json_set(detail,'$.appSlug','github-actions','$.runId',9000001) WHERE id='demo-event-ci-1'").run();
    db.prepare("UPDATE item_events SET detail=json_set(detail,'$.appSlug','github-actions','$.runId',9000002) WHERE id='demo-event-ci-2'").run();
    db.prepare("INSERT OR IGNORE INTO item_message_reads(message_id,member_id,read_at) VALUES ('demo-msg-9000-1','demo-admin',?)").run(ago(12));
    db.prepare("INSERT OR IGNORE INTO item_read_state(item_id,member_id,last_read_at,last_read_message_id,updated_at) VALUES ('github:9000','demo-admin',?,'demo-msg-9000-1',?)").run(ago(12), ago(12));
    db.prepare('UPDATE members SET conversation_baseline_at=COALESCE(conversation_baseline_at,?) WHERE id IN (?,?)').run(ago(72), 'demo-admin', 'demo-reviewer');
    setSetting(db, 'demoFixtureVersion', 2);
    if (db.prepare("SELECT 1 FROM members WHERE id='demo-admin' AND github_user_id='1001'").get()) setSetting(db, 'membershipInitialized', true);
    if (inserted) addActivity(db, '演示工作区已就绪', '所有数据与真实仓库隔离，不会发送飞书消息或修改 GitHub。');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
