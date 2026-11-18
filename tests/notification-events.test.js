import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, setSetting } from '../server/db.js';
import { createServices, nextNotificationAt } from '../server/services.js';
import { addTestMember, bindTestMember, insertItem, testItem, configForTests, httpFixture } from './helpers.js';

const REPO = 'AISBench/benchmark';
const item = extra => ({ ...testItem({ kind: 'pr', title: 'Regression PR', author: 'bob', authorId: '502', assignees: ['carol'], assigneeIds: ['503'], url: `https://github.com/${REPO}/pull/101`, updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() }), ...extra });
function fixture(t,{itemExtra={}}={}) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const alice = addTestMember(db, { githubId: '501', login: 'alice', role: 'admin' });
  const bob = addTestMember(db, { githubId: '502', login: 'bob' });
  const carol = addTestMember(db, { githubId: '503', login: 'carol' });
  for (const member of [alice, bob, carol]) bindTestMember(db, member.id);
  setSetting(db, 'rules', { enabled: true, staleHours: 48, reminderCooldownHours: 24 });
  insertItem(db, item(itemExtra));
  const sent = [];
  const services = createServices(db, configForTests(), { sendMessage: async message => { sent.push(message); return { messageId: 'mock' }; } });
  const hook = (payload, delivery, event = 'pull_request') => services.onWebhook({ repository: { full_name: REPO }, ...payload }, delivery, event);
  return { db, alice, bob, carol, services, sent, hook };
}
const byOpenId = (sent, member) => sent.find(message => message.openId === `ou_${member.id}`);

test('administrators are notified for every new PR and issue, but not their own action', async t => {
  const { db, alice, bob, sent, hook } = fixture(t, { itemExtra: { authorId: '999', author: 'external', assigneeIds: [], assignees: [], reviewerIds: [] } });
  await hook({ action: 'opened', pull_request: { number: 101, merged: false }, sender: { id: 777, login: 'dave' } }, 'new-pr');
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /^\[新 PR\]/);
  assert.match(sent[0].text, /@dave 创建了 PR #101/);
  assert.equal(sent[0].openId, `ou_${alice.id}`);
  assert.equal(byOpenId(sent, bob), undefined);
  // An administrator creating the item does not notify themselves.
  sent.length = 0;
  await hook({ action: 'opened', pull_request: { number: 101, merged: false }, sender: { id: 501, login: 'alice' } }, 'new-pr-self');
  assert.equal(sent.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE event_type='new_pr'").get().n, 1);
});

test('GitHub assignee changes notify only the assigned member', async t => {
  const { bob, carol, sent, hook } = fixture(t);
  await hook({ action: 'assigned', assignee: { id: 503, login: 'carol' }, pull_request: { number: 101 }, sender: { id: 777, login: 'dave' } }, 'assign-carol');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].openId, `ou_${carol.id}`);
  assert.match(sent[0].title, /^\[指派给你\]/);
  assert.match(sent[0].text, /@dave 将 PR #101 指派给你/);
  assert.equal(byOpenId(sent, bob), undefined);
});

test('comments notify authors/assignees; mentions and direct replies are distinct', async t => {
  const { db, bob, carol, sent, hook } = fixture(t);
  await hook({ action: 'created', comment: { id: 1, body: 'please check @carol', user: { id: 777, login: 'dave' }, html_url: 'https://github.com/x/1' }, pull_request: { number: 101 } }, 'comment-1', 'issue_comment');
  assert.equal(sent.length, 2);
  assert.match(byOpenId(sent, bob).title, /^\[新评论\]/);
  assert.match(byOpenId(sent, carol).title, /^\[有人 @你\]/);
  assert.match(byOpenId(sent, carol).text, /@dave 在评论中 @你/);

  // Bot comments, including GitHub Actions, never create notifications.
  sent.length = 0;
  await hook({ action: 'created', comment: { id: 2, body: '@bob bot output', user: { id: 999, login: 'github-actions[bot]', type: 'Bot' } }, pull_request: { number: 101 } }, 'comment-bot', 'issue_comment');
  assert.equal(sent.length, 0);

  db.prepare(`INSERT INTO item_messages(id,item_id,source,kind,github_comment_id,author_member_id,author_login,body,created_at,updated_at,synced_at)
    VALUES ('parent','github:101','github','review_comment','review_comment:10',?,'carol','parent','now','now','now')`).run(carol.id);
  await hook({ action: 'created', comment: { id: 11, in_reply_to_id: 10, body: 'thanks', user: { id: 777, login: 'dave' }, path: 'src/a.js', line: 3 }, pull_request: { number: 101 } }, 'review-reply', 'pull_request_review_comment');
  assert.equal(sent.length, 2);
  assert.match(byOpenId(sent, bob).title, /^\[新行内评论\]/);
  assert.match(byOpenId(sent, carol).title, /^\[回复了你的评论\]/);
  assert.match(byOpenId(sent, carol).text, /src\/a.js/);
});

test('status changes still notify watchers after the item closes', async t => {
  const { bob, carol, sent, hook } = fixture(t);
  await hook({ action: 'closed', pull_request: { number: 101, merged: true }, sender: { id: 777, login: 'dave' } }, 'merged');
  assert.equal(sent.length, 2);
  assert.match(byOpenId(sent, bob).title, /^\[状态更新\]/);
  assert.match(byOpenId(sent, bob).text, /@dave 合并了 PR #101/);
  assert.match(byOpenId(sent, carol).text, /@dave 合并了 PR #101/);
});

test('CI failures and recovered successes notify watchers without first-time success noise', async t => {
  const { bob, carol, sent, hook } = fixture(t);
  const run = (id, name, conclusion) => ({ action: 'completed', check_run: { id, name, status: 'completed', conclusion, app: { slug: 'github-actions', name: 'GitHub Actions' }, pull_requests: [{ number: 101 }], html_url: `https://github.com/${REPO}/runs/${id}` }, sender: { id: 999, login: 'github-actions[bot]', type: 'Bot' } });
  await hook(run(1, 'tests', 'failure'), 'ci-failure', 'check_run');
  assert.equal(sent.length, 2);
  assert.match(byOpenId(sent, bob).title, /^\[CI 状态\]/);
  assert.match(byOpenId(sent, bob).text, /tests · 失败/);
  sent.length = 0;
  await hook(run(2, 'tests', 'success'), 'ci-recovered', 'check_run');
  assert.equal(sent.length, 2);
  assert.match(byOpenId(sent, carol).text, /tests · 通过（已恢复）/);
  sent.length = 0;
  await hook(run(3, 'lint', 'success'), 'ci-green-first', 'check_run');
  assert.equal(sent.length, 0);
});

test('hourly digest batches several events into one Feishu message', async t => {
  const { db, bob, carol, services, sent, hook } = fixture(t);
  db.prepare("UPDATE users SET notification_mode='hourly' WHERE member_id=?").run(bob.id);
  db.prepare('UPDATE users SET notifications_enabled=0 WHERE member_id=?').run(carol.id);
  await hook({ action: 'created', comment: { id: 21, body: 'first', user: { id: 777, login: 'dave' } }, pull_request: { number: 101 } }, 'digest-1', 'issue_comment');
  await hook({ action: 'created', comment: { id: 22, body: 'second', user: { id: 777, login: 'dave' } }, pull_request: { number: 101 } }, 'digest-2', 'issue_comment');
  assert.equal(sent.length, 0);
  db.prepare("UPDATE notifications SET next_at=0 WHERE recipient_member_id=? AND status='pending'").run(bob.id);
  const result = await services.runReminders();
  assert.equal(result.delivered, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /2 条更新/);
  assert.match(sent[0].text, /1\. \[新评论\]/);
  assert.match(sent[0].text, /2\. \[新评论\]/);
});

test('polling conversation sync notifies new mentions without replaying history', async t => {
  const { db, bob, carol, services, sent } = fixture(t, { itemExtra: { kind: 'issue' } });
  const comment = (id, body, login = 'dave', type = 'User') => ({ id, body, user: { id: 777, login, type }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), html_url: `https://github.com/${REPO}/issues/101#issuecomment-${id}` });
  const detail = { number: 101, state: 'open', title: 'Regression PR', body: '', html_url: `https://github.com/${REPO}/issues/101`, user: { id: 502, login: 'bob' }, assignees: [], labels: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const fetchFor = comments => async url => {
    const target = String(url);
    if (target.includes('/issues/101/comments')) return new Response(JSON.stringify(comments), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (target.includes('/issues/101/timeline')) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (target.includes('/issues/101')) return new Response(JSON.stringify(detail), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const old = comment(1, '旧评论 @carol');
  const fresh = comment(2, '请看一下 @carol');
  await services.syncConversations({ fetchImpl: fetchFor([old]) });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0, 'first sync establishes a baseline without notifying history');
  const past = new Date(Date.now() - 60000).toISOString();
  db.prepare("UPDATE item_conversation_sync SET messages_synced_at=?,events_synced_at=?,ci_synced_at=? WHERE item_id='github:101'").run(past, past, past);
  await services.syncConversations({ fetchImpl: fetchFor([old, fresh]) });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 2);
  await services.runReminders();
  assert.match(byOpenId(sent, bob).title, /^\[新评论\]/);
  assert.match(byOpenId(sent, carol).title, /^\[有人 @你\]/);
  assert.match(byOpenId(sent, carol).text, /@dave 在评论中 @你/);
  sent.length = 0;
  db.prepare("UPDATE item_conversation_sync SET messages_synced_at=?,events_synced_at=?,ci_synced_at=? WHERE item_id='github:101'").run(past, past, past);
  await services.syncConversations({ fetchImpl: fetchFor([old, fresh, comment(3, '@bob bot output', 'github-actions[bot]', 'Bot')]) });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 2, 'replayed comments and bot comments do not duplicate notifications');
  await services.runReminders();
  assert.equal(sent.length, 0);
});

test('digest scheduling uses Asia/Shanghai boundaries', () => {
  const now = Date.UTC(2026, 0, 1, 2, 30); // 10:30 Asia/Shanghai
  assert.equal(nextNotificationAt('realtime', 9, now), 0);
  assert.equal(nextNotificationAt('hourly', 9, now), Date.UTC(2026, 0, 1, 3, 0));
  assert.equal(nextNotificationAt('daily', 9, now), Date.UTC(2026, 0, 2, 1, 0));
  assert.equal(nextNotificationAt('daily', 9, Date.UTC(2026, 0, 1, 0, 30)), Date.UTC(2026, 0, 1, 1, 0));
});

test('preferences persist realtime/hourly/daily mode and digest hour', async t => {
  const f = await httpFixture(t), c = f.client('demo-reviewer');
  const saved = await c.request('/api/preferences', 'PATCH', { notificationsEnabled: true, quietStart: '', quietEnd: '', notificationMode: 'daily', digestHour: 8 });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.user.notificationMode, 'daily');
  assert.equal(saved.data.user.digestHour, 8);
  const row = f.db.prepare("SELECT notification_mode,digest_hour FROM users WHERE member_id='demo-reviewer'").get();
  assert.equal(row.notification_mode, 'daily');
  assert.equal(row.digest_hour, 8);
});
