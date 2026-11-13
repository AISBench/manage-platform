import React, { useState } from 'react';
import { CircleAlert, CircleCheck, CircleDot, Clock3, GitBranch, Info, ListChecks, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { Avatar, Badge, Empty, useResource } from './ui.jsx';
import { api } from './api.js';
import ItemWorkflow from './ItemWorkflow.jsx';
import { ASSIGNEE_STATUS, mapGithubAssignees } from './workflow.js';

function ciTone(event) {
  const status = event.detail?.conclusion || event.detail?.state || event.detail?.status || '';
  if (['failure', 'timed_out', 'cancelled', 'error', 'action_required'].includes(status)) return ['red', CircleAlert];
  if (['success', 'neutral', 'skipped'].includes(status)) return ['green', CircleCheck];
  if (['pending', 'queued', 'in_progress', 'waiting', 'requested'].includes(status)) return ['amber', Clock3];
  return ['neutral', CircleDot];
}

function isActionsEvent(event) {
  return event.type === 'check_run' && !!event.detail?.runId
    && (event.detail?.appSlug === 'github-actions' || event.detail?.app === 'GitHub Actions');
}

function CIRow({ event, itemId, canWrite, notify, onChanged, onCiTriggered }) {
  const [rerunning, setRerunning] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [tone, Icon] = ciTone(event);
  const rerunnable = isActionsEvent(event);
  async function rerun() {
    if (!window.confirm(`将重新运行「${event.detail?.name || '该检查'}」所属的整个 GitHub Actions 工作流，确定继续？`)) return;
    setRerunning(true); setFeedback(null);
    try {
      const result = await api(`/api/items/${encodeURIComponent(itemId)}/ci/${encodeURIComponent(event.id)}/rerun`, { method: 'POST', body: {} });
      const text = result.demo ? '演示模式：已模拟触发全量重试。'
        : result.via === 'server' ? '已通过服务器 Actions Token 触发全量重试，正在自动跟踪新状态…'
          : '已触发全量重试，正在自动跟踪新状态…';
      setFeedback({ tone: 'ok', text });
      notify(text);
      onChanged?.();
      onCiTriggered?.(event.detail?.name || '');
    } catch (error) { setFeedback({ tone: 'error', text: error.message }); notify(error.message, 'error'); } finally { setRerunning(false); }
  }
  return <article className="ci-item"><span className={`ci-icon tone-${tone}`}><Icon size={15} /></span><div><strong>{event.detail?.name || event.detail?.context || event.summary}</strong><p>{event.detail?.app ? `${event.detail.app} · ` : ''}{event.detail?.conclusion || event.detail?.state || event.detail?.status || 'unknown'}{event.detail?.completedAt ? ` · ${new Date(event.detail.completedAt).toLocaleString('zh-CN')}` : ''}</p>{feedback && <p className={`ci-feedback is-${feedback.tone}`}>{feedback.text}</p>}</div><div className="ci-actions">{event.detail?.url && <a className="text-button" href={event.detail.url} target="_blank" rel="noreferrer">详情</a>}{rerunnable && (canWrite ? <button type="button" className="btn btn-secondary btn-small" disabled={rerunning} onClick={rerun}>{rerunning ? <LoaderCircle size={12} className="spin" /> : <RotateCcw size={12} />}{rerunning ? '触发中…' : '全量重试'}</button> : <a className="text-button" href={`/auth/github?${new URLSearchParams({ returnTo: `/workspace/items/${itemId}` })}`}>授权重试</a>)}</div></article>;
}

export function CIColumn({ events = [], itemId, user, session, notify, onChanged, onCiTriggered }) {
  const byKey = new Map();
  for (const event of events) {
    const key = (event.detail?.name || event.detail?.context || event.summary || event.id).toLowerCase();
    const previous = byKey.get(key);
    if (!previous || event.type === 'check_run' && previous.type !== 'check_run' || event.type === previous.type && Date.parse(event.occurredAt) >= Date.parse(previous.occurredAt)) byKey.set(key, event);
  }
  const unique = [...byKey.values()].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const canWrite = !!session?.demo || !!user?.githubWriteReady;
  return <section className="detail-card"><div className="detail-card-title"><h3><ListChecks size={16} />CI 状态</h3><Badge tone={unique.length ? 'neutral' : 'neutral'}>{unique.length} 项</Badge></div>{unique.length ? <div className="ci-list">{unique.map(event => <CIRow key={event.id} event={event} itemId={itemId} canWrite={canWrite} notify={notify} onChanged={onChanged} onCiTriggered={onCiTriggered} />)}</div> : <Empty text="开放 PR 的检查会在同步后显示在这里。" />}</section>;
}

export function OperationsColumn({ events = [] }) {
  return <section className="detail-card"><div className="detail-card-title"><h3><RefreshCw size={16} />操作记录</h3><Badge>{events.length} 条</Badge></div>{events.length ? <div className="operation-list">{events.map(event => <article className="operation-item" key={event.id}><Avatar login={event.actor.login} src={event.actor.avatarUrl} size="tiny" /><div><p><strong>{event.actor.login || 'GitHub'}</strong> {event.summary}</p><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString('zh-CN')}</time></div></article>)}</div> : <Empty text="标签、指派、关闭、重命名等动态会显示在这里。" />}</section>;
}

export function InfoColumn({ item, user, onSaved }) {
  const members = useResource('/api/assignable-members');
  const assignees = mapGithubAssignees(item.assignees, members.data?.members || []);
  return <section className="detail-card"><div className="detail-card-title"><h3><Info size={16} />其他信息</h3></div><dl className="info-list"><dt>类型</dt><dd>{item.kind === 'pr' ? 'Pull Request' : 'Issue'} · #{item.number}</dd><dt>GitHub 状态</dt><dd><Badge tone={item.state === 'open' ? 'green' : 'purple'}>{item.state === 'open' ? 'Open' : 'Closed'}</Badge></dd><dt>作者</dt><dd>{item.author || '—'}</dd><dt>Labels</dt><dd className="info-badges">{item.labels?.length ? item.labels.map(label => <Badge key={label}>{label}</Badge>) : '—'}</dd><dt>Assignees</dt><dd className="assignee-chips">{assignees.length ? assignees.map(assignee => <span key={assignee.login} className={`assignee-chip is-${assignee.status}`} title={assignee.status === 'active' ? '该 GitHub 用户已在平台认证' : '该 GitHub 用户尚未在平台认证'}><Avatar login={assignee.login} src={assignee.avatarUrl} size="tiny" />{assignee.name}<em>{ASSIGNEE_STATUS[assignee.status] || '未认证'}</em></span>) : '—'}</dd><dt>Reviewers</dt><dd>{item.reviewers?.join('、') || '—'}</dd><dt>分支 / Head</dt><dd>{item.headSha ? <span className="mono">{item.headSha.slice(0, 12)}</span> : '—'}</dd><dt>合并状态</dt><dd>{item.mergeableState || '—'}{item.draft ? ' · Draft' : ''}</dd><dt>创建时间</dt><dd>{item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '—'}</dd><dt>更新时间</dt><dd>{item.updatedAt ? new Date(item.updatedAt).toLocaleString('zh-CN') : '—'}</dd></dl><div className="workflow-block"><h4><GitBranch size={15} />本地工作流</h4><ItemWorkflow item={item} user={user} onSaved={onSaved} /></div></section>;
}
