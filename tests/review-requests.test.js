import test from 'node:test';
import assert from 'node:assert/strict';
import { addTestMember, httpFixture, insertItem, testItem } from './helpers.js';

test('reviewRequested=me lists only open PRs inviting the current fixed GitHub identity', async t => {
  const f = await httpFixture(t, { seed: false });
  const alice = addTestMember(f.db, { githubId: '501', login: 'alice' });
  const bob = addTestMember(f.db, { githubId: '502', login: 'bob' });
  for (const item of [
    testItem({ id: 'github:201', number: 201, kind: 'pr', title: 'Invited by immutable ID', reviewers: ['someone-else'], reviewerIds: ['501'] }),
    testItem({ id: 'github:202', number: 202, kind: 'pr', title: 'Same login, different identity', reviewers: ['alice'], reviewerIds: ['502'] }),
    testItem({ id: 'github:203', number: 203, kind: 'pr', title: 'Closed review invitation', state: 'closed', reviewerIds: ['501'] }),
    testItem({ id: 'github:204', number: 204, kind: 'issue', title: 'Issue is not a PR review', reviewerIds: ['501'] }),
    testItem({ id: 'github:205', number: 205, kind: 'pr', title: 'Login alone is not authoritative', reviewers: ['alice'], reviewerIds: [] }),
  ]) insertItem(f.db, item);

  const mine = await f.client(alice.id).request('/api/items?reviewRequested=me');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.data.items.map(item => item.id), ['github:201']);

  const allStates = await f.client(alice.id).request('/api/items?reviewRequested=me&state=all');
  assert.deepEqual(allStates.data.items.map(item => item.id).sort(), ['github:201', 'github:203']);
  assert.deepEqual((await f.client(bob.id).request('/api/items?reviewRequested=me')).data.items.map(item => item.id), ['github:202']);
  assert.equal((await f.client().request('/api/items?reviewRequested=me')).status, 401);
  assert.equal((await f.client(alice.id).request('/api/items?reviewRequested=all')).status, 400);
});
