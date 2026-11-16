import test from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture } from './helpers.js';

test('label catalogue, dashboard counts and label filter stay consistent', async t => {
  const f = await httpFixture(t, { config: { demo: true } });
  const c = f.client('demo-admin');
  const labels = await c.request('/api/labels');
  assert.equal(labels.status, 200);
  assert.equal(labels.data.canEdit, true);
  assert.equal(labels.data.labels.find(label => label.name === 'bug').color, 'd73a4a', 'colours come from the repository catalogue');
  assert.ok(labels.data.labels.every(label => /^[0-9a-f]{6}$/.test(label.color)));

  const dashboard = await c.request('/api/dashboard');
  assert.ok(dashboard.data.stats.bugIssues >= 1);
  assert.ok(dashboard.data.stats.featureIssues >= 1);

  const bugItems = await c.request('/api/items?state=open&kind=issue&label=bug');
  assert.equal(bugItems.status, 200);
  assert.equal(bugItems.data.items.length, dashboard.data.stats.bugIssues, 'the dashboard count matches the filtered list');
  assert.ok(bugItems.data.items.every(item => item.labels.some(name => name.toLowerCase() === 'bug')));

  const featureItems = await c.request('/api/items?state=open&kind=issue&label=Feature');
  assert.equal(featureItems.data.items.length, dashboard.data.stats.featureIssues, 'label filtering is case-insensitive');
  assert.equal((await f.client(null).request('/api/labels')).status, 401);
});

test('demo members can edit labels through the API with validation', async t => {
  const f = await httpFixture(t, { config: { demo: true } });
  const c = f.client('demo-admin');
  const before = (await c.request('/api/items?state=all&q=9001')).data.items.find(item => item.number === 9001);

  const updated = await c.request('/api/items/github:9001/labels', 'PUT', { labels: ['bug', 'feature'] });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data.item.labels, ['bug', 'feature']);
  assert.equal(updated.data.item.version, before.version + 1);
  assert.ok((await c.request('/api/dashboard')).data.stats.featureIssues >= 1);

  assert.equal((await c.request('/api/items/github:9001/labels', 'PUT', { labels: Array.from({ length: 21 }, (_, index) => `label-${index}`) })).status, 400);
  assert.equal((await c.request('/api/items/github:9001/labels', 'PUT', {})).status, 400);
  assert.equal((await c.request('/api/items/github:9999/labels', 'PUT', { labels: ['bug'] })).status, 404);
  assert.equal((await f.client(null).request('/api/items/github:9001/labels', 'PUT', { labels: ['bug'] })).status, 401);
});
