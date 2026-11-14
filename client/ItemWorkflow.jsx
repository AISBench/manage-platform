import React, { useEffect, useState } from 'react';
import { Check, LoaderCircle, UserRound } from 'lucide-react';
import { api } from './api.js';
import { Avatar, ErrorBox, OWNER_ISSUES, OwnerOptions, isMine, useResource } from './ui.jsx';
import { ASSIGNEE_STATUS, PRIORITIES, WORKFLOWS, labelMapping, localDateTime, mapGithubAssignees } from './workflow.js';

export default function ItemWorkflow({ item, user, onSaved }) {
  const [current, setCurrent] = useState(item);
  const makeForm = source => ({ workflow: source.workflow || 'todo', priority: source.priority || 'normal', ownerMemberId: source.ownerMemberId || '', dueAt: localDateTime(source.dueAt) });
  const [form, setForm] = useState(() => makeForm(item));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const members = useResource('/api/assignable-members');
  const related = user.isAdmin || isMine(current, user);
  const dirty = form.workflow !== (current.workflow || 'todo') || form.priority !== (current.priority || 'normal') || form.dueAt !== localDateTime(current.dueAt) || (user.isAdmin && form.ownerMemberId !== (current.ownerMemberId || ''));
  const memberList = members.data?.members || [];
  const assignees = mapGithubAssignees(current.assignees, memberList);
  const mapping = labelMapping(current.labels);
  const suggestionText = [mapping.workflow && WORKFLOWS[mapping.workflow], mapping.priority && PRIORITIES[mapping.priority]].filter(Boolean);
  const needsApply = Boolean((mapping.workflow && mapping.workflow !== (current.workflow || 'todo')) || (mapping.priority && mapping.priority !== (current.priority || 'normal')));
  const mappedFor = label => mapping.matches.filter(match => match.label === label).map(match => match.kind === 'workflow' ? WORKFLOWS[match.value] : PRIORITIES[match.value]);
  useEffect(() => { setCurrent(item); setForm(makeForm(item)); }, [item.id, item.version]);
  async function applySuggestions() {
    if (!related) return;
    const nextWorkflow = mapping.workflow || current.workflow || 'todo';
    const nextPriority = mapping.priority || current.priority || 'normal';
    const changes = { version: current.version };
    if (nextWorkflow !== (current.workflow || 'todo')) changes.workflow = nextWorkflow;
    if (nextPriority !== (current.priority || 'normal')) changes.priority = nextPriority;
    if (Object.keys(changes).length === 1) return;
    setSaving(true); setError(null);
    try {
      const result = await api(`/api/items/${encodeURIComponent(current.id)}`, { method: 'PATCH', body: changes });
      setCurrent(result.item); setForm(makeForm(result.item)); onSaved?.(result.item);
    } catch (e) { setError(e); } finally { setSaving(false); }
  }
  async function mutate(claim, event) {
    event?.preventDefault();
    if (!claim && !dirty) return;
    setSaving(true); setError(null);
    const changes = { version: current.version };
    if (form.workflow !== (current.workflow || 'todo')) changes.workflow = form.workflow;
    if (form.priority !== (current.priority || 'normal')) changes.priority = form.priority;
    if (form.dueAt !== localDateTime(current.dueAt)) changes.dueAt = form.dueAt ? new Date(form.dueAt).toISOString() : null;
    if (user.isAdmin && form.ownerMemberId !== (current.ownerMemberId || '')) changes.ownerMemberId = form.ownerMemberId || null;
    try {
      const result = await api(`/api/items/${encodeURIComponent(current.id)}${claim ? '/claim' : ''}`, { method: claim ? 'POST' : 'PATCH', body: claim ? { version: current.version } : changes });
      setCurrent(result.item); setForm(makeForm(result.item)); onSaved?.(result.item);
    } catch (e) { setError(e); } finally { setSaving(false); }
  }
  const unavailable = current.ownerMemberId && !(members.data?.members || []).some(m => m.id === current.ownerMemberId);
  return <div className="item-workflow">
    <div className="notice notice-info">仅修改平台工作流，不改变 GitHub 状态。</div>
    {current.ownerIssue && <div className="notice notice-warning">{OWNER_ISSUES[current.ownerIssue] || '负责人不可达'}；分派保留，不代表通知已发送。</div>}
    {!related && <div className="notice notice-warning">仅管理员或按固定身份关联的成员可编辑；未分派任务可先显式认领。</div>}
    {!user.isAdmin && !current.ownerMemberId && current.state === 'open' && current.ownerIssue !== 'legacy_unresolved' && <div className="claim-action"><button className="btn btn-primary" onClick={() => mutate(true)} disabled={saving || error?.status === 409}><UserRound size={15} />认领给我</button><p>原子校验尚未分派，不可抢占他人任务。</p></div>}
    <div className="github-link">
      <div className="github-link-row"><span className="github-link-label">GitHub Assignee</span><div className="assignee-chips">{assignees.length ? assignees.map(assignee => <span key={assignee.login} className={`assignee-chip is-${assignee.status}`} title={assignee.status === 'active' ? '该 GitHub 用户已在平台认证' : '该 GitHub 用户尚未在平台认证，无法分派或接收提醒'}><Avatar login={assignee.login} src={assignee.avatarUrl} size="tiny" />{assignee.name}{assignee.name !== assignee.login ? ` @${assignee.login}` : ''}<em>{ASSIGNEE_STATUS[assignee.status] || '未认证'}</em></span>) : <span className="muted">无</span>}</div></div>
      <div className="github-link-row"><span className="github-link-label">GitHub 标签</span><div className="label-map-chips">{(current.labels || []).length ? current.labels.map(label => { const mapped = mappedFor(label); return <span key={label} className={`label-chip ${mapped.length ? 'is-mapped' : ''}`}>{label}{mapped.length > 0 && <em>→ {mapped.join(' / ')}</em>}</span>; }) : <span className="muted">无</span>}</div></div>
      {suggestionText.length > 0 && <div className="label-suggestion"><span>GitHub 标签建议：{suggestionText.join(' · ')}</span>{needsApply ? <button type="button" className="text-button" disabled={!related || saving} onClick={applySuggestions}>采用建议</button> : <span className="muted">已与标签一致</span>}</div>}
    </div>
    <form onSubmit={e => mutate(false, e)}>
      <div className="drawer-form-grid">
        <label className="form-field"><span>工作流状态</span><select value={form.workflow} onChange={e => setForm({ ...form, workflow: e.target.value })} disabled={!related || saving}>{Object.entries(WORKFLOWS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="form-field"><span>优先级</span><select value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })} disabled={!related || saving}>{Object.entries(PRIORITIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="form-field drawer-owner-field"><span>平台负责人 {user.isAdmin ? '' : '（仅管理员可改派）'}</span><select aria-label="平台负责人" value={form.ownerMemberId} onChange={e => setForm({ ...form, ownerMemberId: e.target.value })} disabled={!user.isAdmin || saving || members.loading || Boolean(members.error)}><option value="">未分派</option>{unavailable && <option value={current.ownerMemberId} disabled>{current.ownerName || current.owner || '历史成员'} · 不可接受新分派</option>}<OwnerOptions members={members.data?.members || []} /></select><small>固定成员 ID 关联；待激活成员可预分派，但不可达。</small></label>
        <label className="form-field drawer-due-field"><span>截止时间 <small>浏览器本地时间</small></span><input type="datetime-local" value={form.dueAt} disabled={!related || saving} onChange={e => setForm({ ...form, dueAt: e.target.value })} /></label>
      </div>
      {members.error && <ErrorBox error={members.error} retry={members.retry} />}
      {error && <ErrorBox error={error} retry={error.status === 409 ? () => window.location.reload() : undefined} />}
      <div className="workflow-actions"><span>版本 {current.version}</span><button type="submit" className="btn btn-primary btn-small" disabled={saving || !related || !dirty || error?.status === 409 || (user.isAdmin && Boolean(members.error || members.loading))}>{saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{saving ? '保存中…' : '保存本地工作流'}</button></div>
    </form>
  </div>;
}
