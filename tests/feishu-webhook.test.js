import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, setSetting } from '../server/db.js';
import { createServices } from '../server/services.js';
import { saveWebhook, normalizeWebhookUrl, webhookView, decryptWebhookUrl } from '../server/feishu-webhooks.js';
import { sendFeishuWebhookMessage } from '../server/integrations/feishu.js';
import { setMemberStatus } from '../server/members.js';
import { addTestMember, bindTestMember, insertItem, configForTests, httpFixture } from './helpers.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/abcd-1234';
const LARK_WEBHOOK = 'https://open.larksuite.com/open-apis/bot/v2/hook/abcd-1234';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('webhook URL validation only accepts Feishu/Lark custom-bot endpoints', () => {
  assert.deepEqual(normalizeWebhookUrl(WEBHOOK), { url: WEBHOOK, host: 'open.feishu.cn' });
  assert.equal(normalizeWebhookUrl(LARK_WEBHOOK).host, 'open.larksuite.com');
  for (const value of [
    'http://open.feishu.cn/open-apis/bot/v2/hook/abcd-1234',
    'https://evil.example/open-apis/bot/v2/hook/abcd-1234',
    'https://open.feishu.cn/open-apis/bot/v2/hook/short',
    'https://open.feishu.cn/open-apis/bot/v2/hook/abcd-1234?x=1',
    'https://user:pass@open.feishu.cn/open-apis/bot/v2/hook/abcd-1234',
    'https://open.feishu.cn:8443/open-apis/bot/v2/hook/abcd-1234',
    `https://open.feishu.cn/open-apis/bot/v2/hook/${'a'.repeat(129)}`,
    '',
    123,
  ]) {
    assert.throws(() => normalizeWebhookUrl(value), /飞书机器人地址不合法/, String(value));
  }
});

test('webhook sender posts plain text and handles new and legacy success shapes', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return json({ code: 0, msg: 'success' }); };
  assert.deepEqual(await sendFeishuWebhookMessage({ webhookUrl: WEBHOOK, title: '提醒', text: '需要处理', url: 'https://github.com/AISBench/benchmark/issues/1', fetchImpl }), { messageId: null });
  assert.equal(calls[0].url, WEBHOOK);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.msg_type, 'text');
  assert.equal(body.content.text, '提醒\n\n需要处理\n\nhttps://github.com/AISBench/benchmark/issues/1');
  assert.deepEqual(await sendFeishuWebhookMessage({ webhookUrl: LARK_WEBHOOK, title: 'ok', fetchImpl: async () => json({ StatusCode: 0, StatusMessage: 'success' }) }), { messageId: null });
});

test('webhook sender sanitizes application errors and marks invalid tokens permanent', async () => {
  await assert.rejects(
    sendFeishuWebhookMessage({ webhookUrl: WEBHOOK, title: 'x', fetchImpl: async () => json({ code: 19001, msg: 'invalid webhook' }) }),
    error => { assert.equal(error.code, 'FEISHU_19001'); assert.equal(error.permanent, true); assert.ok(!error.message.includes(WEBHOOK)); assert.equal(Object.hasOwn(error, 'cause'), false); return true; },
  );
  await assert.rejects(
    sendFeishuWebhookMessage({ webhookUrl: WEBHOOK, title: 'x', fetchImpl: async () => { throw new Error(`network ${WEBHOOK}`); } }),
    error => { assert.match(error.message, /Feishu webhook network request failed/); assert.ok(!error.message.includes(WEBHOOK)); return true; },
  );
  await assert.rejects(sendFeishuWebhookMessage({ webhookUrl: WEBHOOK, fetchImpl: () => assert.fail('no outbound request') }), /empty/);
});

test('webhook storage encrypts the URL and exposes only host and status', t => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const config = { tokenEncryptionKey: KEY };
  const member = addTestMember(db);
  saveWebhook(db, member.id, WEBHOOK, config, 3);
  const row = db.prepare('SELECT * FROM feishu_webhooks WHERE member_id=?').get(member.id);
  assert.equal(row.host, 'open.feishu.cn');
  assert.equal(row.binding_version, 3);
  assert.equal(row.status, 'needs_confirmation');
  assert.ok(!JSON.stringify(row).includes('abcd-1234'));
  assert.equal(decryptWebhookUrl(row, config), WEBHOOK);
  const view = webhookView(db, member.id);
  assert.equal(view.bound, true); assert.equal(view.verified, false); assert.equal(view.host, 'open.feishu.cn');
  assert.ok(!JSON.stringify(view).includes('abcd-1234'));
  assert.throws(() => saveWebhook(db, member.id, WEBHOOK, {}, 4), /TOKEN_ENCRYPTION_KEY/);
});

test('personal webhook can be bound, tested and removed over HTTP without exposing the URL', async t => {
  const sent = [];
  const f = await httpFixture(t, { config: { tokenEncryptionKey: KEY }, integrations: { sendWebhook: async message => { sent.push(message); return { messageId: null }; } } });
  const c = f.client('demo-reviewer');
  const put = await c.request('/api/feishu/webhook', 'PUT', { url: WEBHOOK });
  assert.equal(put.status, 200);
  assert.equal(put.data.user.feishuWebhookBound, true);
  assert.equal(put.data.user.feishuWebhookVerified, false);
  assert.equal(put.data.webhook.host, 'open.feishu.cn');
  assert.ok(!JSON.stringify(put.data).includes('abcd-1234'));

  const tested = await c.request('/api/feishu/webhook/test', 'POST', {});
  assert.equal(tested.status, 200);
  assert.equal(tested.data.user.feishuWebhookVerified, true);
  assert.equal(tested.data.channel, 'webhook');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].webhookUrl, WEBHOOK);
  assert.ok(!JSON.stringify(tested.data).includes('abcd-1234'));

  f.db.prepare("INSERT INTO notifications(id,dedupe_key,item_id,recipient,recipient_member_id,binding_version,title,reason,status,created_at) VALUES ('pending-webhook','pending-webhook','github:9000','reviewer-chen','demo-reviewer',1,'T','R','pending',?)").run(new Date().toISOString());
  const removed = await c.request('/api/feishu/webhook', 'DELETE', {});
  assert.equal(removed.status, 200);
  assert.equal(removed.data.user.feishuWebhookBound, false);
  assert.equal(f.db.prepare("SELECT status FROM notifications WHERE id='pending-webhook'").get().status, 'cancelled');
});

test('invalid webhook URLs and demo mode are rejected before any outbound request', async t => {
  const f = await httpFixture(t, { config: { tokenEncryptionKey: KEY }, integrations: { sendWebhook: async () => assert.fail('no outbound request') } });
  const c = f.client('demo-reviewer');
  assert.equal((await c.request('/api/feishu/webhook', 'PUT', { url: 'https://evil.example/open-apis/bot/v2/hook/abcd-1234' })).status, 400);
  const demo = await httpFixture(t, { config: { tokenEncryptionKey: KEY, demo: true }, integrations: { sendWebhook: async () => assert.fail('no outbound request') } });
  assert.equal((await demo.client('demo-reviewer').request('/api/feishu/webhook', 'PUT', { url: WEBHOOK })).status, 400);
});

test('replacing the webhook while a test is in flight cannot activate the new address', async t => {
  let f;
  f = await httpFixture(t, {
    config: { tokenEncryptionKey: KEY },
    integrations: {
      sendWebhook: async () => {
        f.db.prepare("UPDATE feishu_webhooks SET binding_version=binding_version+1,status='needs_confirmation',verified_at=NULL WHERE member_id='demo-reviewer'").run();
        return { messageId: null };
      },
    },
  });
  const c = f.client('demo-reviewer');
  assert.equal((await c.request('/api/feishu/webhook', 'PUT', { url: WEBHOOK })).status, 200);
  assert.equal((await c.request('/api/feishu/webhook/test', 'POST', {})).status, 409);
  const row = f.db.prepare("SELECT * FROM feishu_webhooks WHERE member_id='demo-reviewer'").get();
  assert.equal(row.status, 'needs_confirmation');
  assert.equal(row.verified_at, null);
});

test('verified personal webhook takes precedence over a verified OAuth binding', async t => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const member = addTestMember(db);
  bindTestMember(db, member.id);
  const config = configForTests({ tokenEncryptionKey: KEY });
  saveWebhook(db, member.id, WEBHOOK, config, 2);
  db.prepare("UPDATE feishu_webhooks SET status='active',verified_at=? WHERE member_id=?").run(new Date().toISOString(), member.id);
  setSetting(db, 'rules', { enabled: true, staleHours: 1, reminderCooldownHours: 1 });
  insertItem(db);
  const webhookSent = [], oauthSent = [];
  const services = createServices(db, config, {
    sendMessage: async message => { oauthSent.push(message); return { messageId: 'oauth' }; },
    sendWebhook: async message => { webhookSent.push(message); return { messageId: null }; },
  });
  const result = await services.runReminders();
  assert.equal(result.delivered, 1);
  assert.equal(oauthSent.length, 0);
  assert.equal(webhookSent.length, 1);
  assert.equal(webhookSent[0].webhookUrl, WEBHOOK);
});

test('pending personal webhook is reported as skipped rather than delivered', async t => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const member = addTestMember(db);
  const config = configForTests({ tokenEncryptionKey: KEY });
  saveWebhook(db, member.id, WEBHOOK, config, 1);
  setSetting(db, 'rules', { enabled: true, staleHours: 1, reminderCooldownHours: 1 });
  insertItem(db);
  const services = createServices(db, config, { sendWebhook: async () => ({ messageId: null }) });
  const result = await services.runReminders();
  assert.equal(result.delivered, 0);
  const notice = db.prepare('SELECT status,error_code FROM notifications').get();
  assert.equal(notice.status, 'skipped');
  assert.equal(notice.error_code, 'WEBHOOK_CONFIRMATION');
});

test('disabling a member invalidates the personal webhook verification', t => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const member = addTestMember(db);
  const config = configForTests({ tokenEncryptionKey: KEY });
  saveWebhook(db, member.id, WEBHOOK, config, 5);
  db.prepare("UPDATE feishu_webhooks SET status='active',verified_at=? WHERE member_id=?").run(new Date().toISOString(), member.id);
  setMemberStatus(db, member.id, { version: 1, enabled: false });
  const row = db.prepare('SELECT * FROM feishu_webhooks WHERE member_id=?').get(member.id);
  assert.ok(row.binding_version > 5);
  assert.equal(row.status, 'needs_confirmation');
  assert.equal(row.verified_at, null);
});
