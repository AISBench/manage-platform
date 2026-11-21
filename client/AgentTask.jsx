import React, { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Bot, CircleAlert, LoaderCircle, Sparkles } from 'lucide-react';
import { api } from './api.js';
import { Badge, Modal } from './ui.jsx';
import AgentDraft from './AgentDraft.jsx';

const STATUS = {
  queued: ['blue', '等待 Agent 领取'],
  claimed: ['amber', 'Agent 处理中'],
  submitted: ['teal', '草稿待审阅'],
  published: ['green', '已发布'],
  declined: ['neutral', '已驳回'],
  expired: ['neutral', '已过期'],
};
const ACTIVE = ['queued', 'claimed', 'submitted'];

function TaskRow({ task, isPr, onOpen }) {
  const [tone, label] = STATUS[task.status] || ['neutral', task.status];
  const draft = task.draft;
  const anchor = task.replyTo
    ? `回复 @${task.replyTo.author || '评论人'}${task.replyTo.path ? ` · ${task.replyTo.path}${task.replyTo.line ? `:${task.replyTo.line}` : ''}` : ''}`
    : (isPr ? 'PR 整体检视' : '整体处理');
  const statusText = task.status === 'queued' ? '等待你的 Agent 领取…' : task.status === 'claimed' ? 'Agent 正在处理…' : task.draft ? '' : '未生成草稿';
  return <div className="agent-task-row">
    <div className="agent-task-row-head"><strong>{anchor}</strong><Badge tone={tone}>{label}</Badge></div>
    {task.hint && <p className="agent-adaptor-meta">我的意图：{task.hint}</p>}
    {draft && <p className="agent-adaptor-meta">草稿 · {draft.summary || '无摘要'}{draft.comments?.length ? ` · ${draft.comments.length} 条行内意见` : ''}</p>}
    {!draft && task.status !== 'queued' && task.status !== 'claimed' && <p className="agent-adaptor-meta">未生成草稿</p>}
    <div className="agent-task-row-foot">
      {draft ? <button type="button" className="text-button" onClick={() => onOpen(task)}>{task.status === 'submitted' ? '查看并处理草稿' : '查看草稿'}</button> : statusText ? <span className="agent-muted">{statusText}</span> : null}
      {draft?.commentUrl && <a className="external-text-link" href={draft.commentUrl} target="_blank" rel="noreferrer">已发布内容<ArrowUpRight size={12} /></a>}
    </div>
  </div>;
}

export default function AgentTask({ item, notify }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [hint, setHint] = useState('');
  const [modalTask, setModalTask] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/items/${encodeURIComponent(item.id)}/agent-tasks`);
      setTasks(data.tasks || []); setError(null);
    } catch (e) { setError(e); }
    finally { setLoading(false); }
  }, [item.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const refresh = () => load();
    window.addEventListener('aisbench-agent-task-created', refresh);
    return () => window.removeEventListener('aisbench-agent-task-created', refresh);
  }, [load]);
  const waiting = tasks.some(task => task.status === 'queued' || task.status === 'claimed');
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 8000);
    return () => clearInterval(timer);
  }, [waiting, load]);

  async function create() {
    setSubmitting(true);
    try {
      const result = await api(`/api/items/${encodeURIComponent(item.id)}/agent-task`, { method: 'POST', body: hint.trim() ? { hint: hint.trim() } : {} });
      setShowHint(false); setHint('');
      notify?.(result.created ? (isPr ? '已创建 PR 检视任务，等待你的 Agent 领取。' : '已创建 Agent 任务，等待你的 Agent 领取。') : '已有进行中的整体任务。');
      await load();
    } catch (e) { notify?.(e.message, 'error'); }
    finally { setSubmitting(false); }
  }

  if (!['issue', 'pr'].includes(item.kind) || item.state !== 'open') return null;
  const isPr = item.kind === 'pr';
  const active = tasks.filter(task => ACTIVE.includes(task.status));
  const history = tasks.filter(task => !ACTIVE.includes(task.status)).slice(0, 8);

  return <section className="detail-card agent-task-card">
    <div className="detail-card-title"><h3><Bot size={16} />Agent 任务队列</h3>{loading && !tasks.length ? <Badge tone="neutral">读取中…</Badge> : active.length ? <Badge tone="teal">{active.length} 个进行中</Badge> : <Badge tone="neutral">暂无进行中</Badge>}</div>
    <p className="agent-adaptor-note">{isPr ? '可以同时回复多条评论或发起 PR 检视；每条任务独立生成草稿，完成后在这里逐条审阅发布。' : '可以同时回复多条评论；每条任务独立生成草稿，完成后在这里逐条审阅发布。'}</p>
    {error && <p className="agent-adaptor-status is-red" role="alert"><CircleAlert size={14} />{error.message}</p>}

    {!!active.length && <div className="agent-task-list">{active.map(task => <TaskRow key={task.id} task={task} isPr={isPr} onOpen={setModalTask} />)}</div>}
    {!!history.length && <details className="agent-task-history"><summary>已完成的 Agent 任务（{history.length}）</summary><div className="agent-task-list">{history.map(task => <TaskRow key={task.id} task={task} isPr={isPr} onOpen={setModalTask} />)}</div></details>}

    <div className="agent-adaptor-actions">
      <button type="button" className="btn btn-secondary btn-small" disabled={submitting} onClick={create}>{submitting ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}{isPr ? '新建 PR 检视任务' : '交给我的 agent'}</button>
      <button type="button" className="text-button" onClick={() => setShowHint(value => !value)}>{showHint ? '收起补充提示' : '补充提示（可选）'}</button>
    </div>
    {showHint && <textarea className="agent-adaptor-hint" rows={3} maxLength={500} value={hint} onChange={event => setHint(event.target.value)} placeholder={isPr ? '可选：告诉 Agent 本轮检视重点（正确性、兼容性、测试覆盖、风险等，最多 500 字）' : '可选：告诉 Agent 重点关注什么（最多 500 字）'} />}
    <a className="external-text-link agent-task-hub-link" href="/workspace?view=agent&tab=tasks">查看我的全部 Agent 草稿<ArrowUpRight size={13} /></a>

    {modalTask?.draft && <Modal title={modalTask.replyTo ? 'Agent 回复草稿' : `Agent 草稿 · #${item.number}`} onClose={() => setModalTask(null)} wide>
      <AgentDraft draft={modalTask.draft} replyTo={modalTask.replyTo} notify={notify} onChanged={async () => { await load(); setModalTask(null); }} />
    </Modal>}
  </section>;
}
