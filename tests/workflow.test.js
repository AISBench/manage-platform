import test from 'node:test';
import assert from 'node:assert/strict';
import { labelMapping, mapGithubAssignees, normalizeLabel } from '../client/workflow.js';

const pick = mapping => ({ workflow: mapping.workflow, priority: mapping.priority });

test('label mapping tolerates the repository label spellings', () => {
  assert.deepEqual(pick(labelMapping(['i progress', 'bug'])), { workflow: 'in_progress', priority: 'high' });
  assert.deepEqual(pick(labelMapping(['wait for reply', 'docs'])), { workflow: 'blocked', priority: 'low' });
  assert.deepEqual(pick(labelMapping(['bugfix'])), { workflow: null, priority: 'high' });
  assert.deepEqual(pick(labelMapping(['ot_fixed'])), { workflow: null, priority: null }, 'ot_fixed must not be read as done');
  assert.deepEqual(pick(labelMapping(['需求讨论', 'enhancement'])), { workflow: null, priority: null });
  assert.equal(labelMapping(['i progress', 'wait for reply']).workflow, 'blocked', 'blocked wins over in progress');
  assert.equal(labelMapping(['docs']).priority, 'low');
  assert.equal(labelMapping(['outage']).priority, 'high');
  assert.equal(normalizeLabel('Wait_For-Reply'), 'waitforreply');
});

test('assignees map to platform members; unknown users stay unregistered', () => {
  const rows = mapGithubAssignees(['Alice', 'bob'], [{ id: 'm1', login: 'alice', name: 'Alice', status: 'active' }]);
  assert.deepEqual(rows, [
    { login: 'Alice', memberId: 'm1', name: 'Alice', status: 'active', avatarUrl: '' },
    { login: 'bob', memberId: null, name: 'bob', status: 'unregistered', avatarUrl: '' },
  ]);
  assert.deepEqual(mapGithubAssignees([], [{ id: 'm1', login: 'alice' }]), []);
});
