export const WORKFLOWS = { todo: '待处理', in_progress: '进行中', blocked: '已阻塞', done: '已完成' };
export const PRIORITIES = { high: '高优先级', normal: '普通', low: '低优先级' };
export const ASSIGNEE_STATUS = { active: '已认证', pending_activation: '未激活', disabled: '已停用', unregistered: '未认证' };
export function localDateTime(value) { if (!value) return ''; const d = new Date(value); if (Number.isNaN(d.getTime())) return ''; const pad = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }

// Repository labels are not normalized (e.g. "i progress", "wait for reply",
// "bugfix"), so match forgivingly and only suggest; the user still confirms.
const WORKFLOW_RULES = [
  ['blocked', /wait|blocked|stuck|pedig|pending|onhold/],
  ['in_progress', /progress|doing|wip/],
  ['done', /^(done|completed|resolved|merged)$/],
];
const PRIORITY_RULES = [
  ['high', /^(bug|bugfix|largepr|urgent|blocker|high|p0|outage)$/],
  ['low', /^(docs?|documentation|documetatio|refactor|testcases?|tests?|ut|chore|minor|low)$/],
];
export function normalizeLabel(value) {
  return String(value || '').toLowerCase().replace(/[\s_\-/]+/g, '');
}
export function labelMapping(labels = []) {
  const names = (Array.isArray(labels) ? labels : []).map(label => typeof label === 'string' ? label : label?.name).filter(Boolean);
  const matches = [];
  const workflows = new Set(), priorities = new Set();
  for (const label of names) {
    const key = normalizeLabel(label);
    for (const [value, pattern] of WORKFLOW_RULES) if (pattern.test(key)) { workflows.add(value); matches.push({ label, kind: 'workflow', value }); break; }
    for (const [value, pattern] of PRIORITY_RULES) if (pattern.test(key)) { priorities.add(value); matches.push({ label, kind: 'priority', value }); break; }
  }
  return {
    workflow: WORKFLOW_RULES.map(rule => rule[0]).find(value => workflows.has(value)) || null,
    priority: PRIORITY_RULES.map(rule => rule[0]).find(value => priorities.has(value)) || null,
    matches,
  };
}
export function mapGithubAssignees(assignees = [], members = []) {
  const byLogin = new Map((members || []).filter(member => member?.login).map(member => [String(member.login).toLowerCase(), member]));
  return (Array.isArray(assignees) ? assignees : []).map(login => {
    const member = byLogin.get(String(login).toLowerCase()) || null;
    return {
      login,
      memberId: member?.id || null,
      name: member?.name || member?.displayName || login,
      status: member?.status || 'unregistered',
      avatarUrl: member?.avatarUrl || '',
    };
  });
}
