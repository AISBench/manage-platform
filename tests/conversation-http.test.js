import test from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture } from './helpers.js';

test('conversation API returns seeded messages, events, unread and read receipts', async t => {
  const f = await httpFixture(t, { config: { demo: true } });
  const c = f.client('demo-admin');
  const conversation = await c.request('/api/items/github:9000/conversation?refresh=1&limit=50');
  assert.equal(conversation.status, 200);
  assert.equal(conversation.data.item.number, 9000);
  assert.equal(typeof conversation.data.item.body, 'string');
  assert.ok(conversation.data.item.body.length > 0);
  assert.ok(conversation.data.messages.length >= 4);
  assert.ok(conversation.data.events.ci.length >= 2);
  assert.ok(conversation.data.events.operation.length >= 2);
  assert.equal(typeof conversation.data.unread.unread, 'number');
  assert.ok(conversation.data.messages.some(message => message.mentions.some(mention => mention.isSelf)));
  const inline = conversation.data.messages.find(message => message.kind === 'review_comment');
  assert.equal(inline.path, 'src/benchmark/tasks.py');
  assert.equal(inline.line, 42);
  assert.equal(inline.side, 'RIGHT');
  assert.equal(inline.reviewCommentId, '90002');
  assert.match(inline.diffHunk, /@@ -39,7 \+39,9 @@/);
  assert.equal(inline.url, 'https://github.com/AISBench/benchmark/pull/9000#discussion_r90002');

  const target = conversation.data.messages[0].id;
  const read = await c.request('/api/items/github:9000/read', 'POST', { messageIds: [target] });
  assert.equal(read.status, 200);
  assert.ok(read.data.marked >= 0);
  const reads = await c.request(`/api/items/github:9000/messages/${encodeURIComponent(target)}/reads`);
  assert.equal(reads.status, 200);
  assert.ok(Array.isArray(reads.data.members));

  const unread = await c.request('/api/items/unread');
  assert.equal(unread.status, 200);
  assert.equal(typeof unread.data.total, 'number');
  assert.equal(typeof unread.data.mentions, 'number');

  const list = await c.request('/api/items?state=open');
  assert.ok(list.data.items.every(item => typeof item.unreadCount === 'number' && typeof item.mentionCount === 'number'));
});

test('demo GitHub Actions checks can be rerun from the CI column API', async t => {
  const f = await httpFixture(t, { config: { demo: true } });
  const c = f.client('demo-admin');
  const conversation = await c.request('/api/items/github:9000/conversation');
  const event = conversation.data.events.ci.find(entry => entry.detail?.runId);
  assert.ok(event, 'demo GitHub Actions check exposes a run id');
  const result = await c.request(`/api/items/github:9000/ci/${encodeURIComponent(event.id)}/rerun`, 'POST', {});
  assert.equal(result.status, 200);
  assert.equal(result.data.demo, true);
  assert.equal(result.data.runId, event.detail.runId);
  assert.equal((await f.client(null).request(`/api/items/github:9000/ci/${encodeURIComponent(event.id)}/rerun`, 'POST', {})).status, 401);
  assert.equal((await c.request('/api/items/github:9000/ci/unknown/rerun', 'POST', {})).status, 404);
});

test('item search returns lightweight references for the # picker', async t => {
  const f = await httpFixture(t, { config: { demo: true } });
  const c = f.client('demo-admin');
  const result = await c.request('/api/items/search?q=9000');
  assert.equal(result.status, 200);
  assert.ok(result.data.items.some(item => item.number === 9000));
  assert.deepEqual(Object.keys(result.data.items[0]).sort(), ['id', 'kind', 'number', 'state', 'title'], 'search results never include bodies');
  const empty = await c.request('/api/items/search?q=');
  assert.equal(empty.status, 200);
  assert.ok(empty.data.items.length <= 8);
  assert.equal((await f.client(null).request('/api/items/search?q=9000')).status, 401);
});

test('demo member can send a local conversation message without GitHub', async t => {
  const f = await httpFixture(t, { config: { demo: true } });
  const c = f.client('demo-admin');
  const before = (await c.request('/api/items/github:9000/conversation')).data.messages.length;
  const sent = await c.request('/api/items/github:9000/messages', 'POST', { body: '演示消息 **hello** @reviewer-chen', clientId: 'demo-client-1' });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.deliveryStatus, 'demo');
  assert.equal(sent.data.message.source, 'platform');
  const after = (await c.request('/api/items/github:9000/conversation')).data.messages.length;
  assert.equal(after, before + 1);
  const duplicate = await c.request('/api/items/github:9000/messages', 'POST', { body: '演示消息 **hello** @reviewer-chen', clientId: 'demo-client-1' });
  assert.equal(duplicate.status, 201);
  assert.equal(duplicate.data.message.id, sent.data.message.id);
});

test('conversation writes require an authenticated member and CSRF', async t => {
  const f = await httpFixture(t, { config: { demo: true } });
  const guest = f.client(null);
  assert.equal((await guest.request('/api/items/github:9000/conversation')).status, 401);
  const c = f.client('demo-admin');
  assert.equal((await c.request('/api/items/github:9000/messages', 'POST', { body: 'hello' }, { 'X-CSRF-Token': 'bad' })).status, 403);
  assert.equal((await c.request('/api/items/github:9000/messages', 'POST', { body: 'x'.repeat(20001), clientId: 'too-long' })).status, 400);
});

test('GitHub write authorization can be revoked from settings', async t => {
  const f = await httpFixture(t, { config: { demo: true } });
  const c = f.client('demo-admin');
  const result = await c.request('/api/github/authorization/revoke', 'POST', {});
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
});
