import React, { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Bot, CircleAlert, LoaderCircle, Sparkles } from 'lucide-react';
import { api } from './api.js';
import { Badge, Modal } from './ui.jsx';
import AgentDraft from './AgentDraft.jsx';

const STATUS = {
  queued: ['blue', '等待 Agent 领取', '任务已创建，Agent 下次拉取任务时会看到它。'],
  claimed: ['amber', 'Agent 处理中', 'Agent 已领取任务，正在读取上下文与检索知识库。'],
  submitted: ['teal', '草稿待审阅', 'Agent 已提交草稿，可直接在下方查看并确认发布。'],
};
const DRAFT_STATUS = {
  pending: ['amber', '草稿待审阅', 'Agent 已提交草稿，请查看并确认发布。'],
  published: ['green', '已发布', '草稿已由机器人身份发布到 GitHub。'],
  declined: ['neutral', '已驳回', '草稿已驳回，未发布到 GitHub。'],
};

export default function AgentTask({ item, notify }) {
  const [task, setTask] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [hint, setHint] = useState('');
  const [modal, setModal] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/items/${encodeURIComponent(item.id)}/agent-task`);
      setTask(data.task || null); setDraft(data.draft || null); setError(null);
    } catch (e) { setError(e); }
    finally { setLoading(false); }
  }, [item.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!task || !['queued', 'claimed'].includes(task.status)) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 8000);
    return () => clearInterval(timer);
  }, [task, load]);

  async function create() {
    setSubmitting(true);
    try {
      const result = await api(`/api/items/${encodeURIComponent(item.id)}/agent-task`, { method: 'POST', body: hint.trim() ? { hint: hint.trim() } : {} });
      setTask(result.task); setShowHint(false); setHint('');
      notify?.(result.created ? '已创建 Agent 任务，等待你的 Agent 领取。' : '已存在进行中的 Agent 任务。');
    } catch (e) { notify?.(e.message, 'error'); }
    finally { setSubmitting(false); }
  }

  if (item.kind !== 'issue' || item.state !== 'open') return null;
  const view = task ? STATUS[task.status] : draft ? DRAFT_STATUS[draft.status] : null;

  return <section className="detail-card agent-task-card">
    <div className="detail-card-title"><h3><Bot size={16} />交给我的 Agent</h3>{loading && !task && !draft ? <Badge tone="neutral">读取中…</Badge> : view ? <Badge tone={view[0]}>{view[1]}</Badge> : <Badge tone="neutral">未创建</Badge>}</div>
    <p className="agent-adaptor-note">任务只包含 GitHub 公开事实与知识库检索结果；Agent 生成的草稿仍需你在平台人工确认后才会发布。</p>
    {error && <p className="agent-adaptor-status is-red" role="alert"><CircleAlert size={14} />{error.message}</p>}
    {task && <p className="agent-adaptor-meta">任务 #{task.id}{task.createdAt ? ` · ${new Date(task.createdAt).toLocaleString('zh-CN')}` : ''}{view?.[2] ? ` · ${view[2]}` : ''}</p>}
    {draft && <div className="agent-task-draft">
      <p className="agent-adaptor-meta">草稿 · {draft.summary || '无摘要'}{draft.updatedAt ? ` · ${new Date(draft.updatedAt).toLocaleString('zh-CN')}` : ''}</p>
      <div className="agent-adaptor-actions">
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setModal(true)}>查看并处理草稿</button>
        {draft.status === 'pending' && <Badge tone="amber">待审阅</Badge>}
      </div>
    </div>}
    {!loading && !task && <div className="agent-adaptor-actions">
      <button type="button" className="btn btn-secondary btn-small" disabled={submitting} onClick={create}>{submitting ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}交给我的 agent</button>
      <button type="button" className="text-button" onClick={() => setShowHint(value => !value)}>{showHint ? '收起补充提示' : '补充提示（可选）'}</button>
    </div>}
    {showHint && !task && <textarea className="agent-adaptor-hint" rows={3} maxLength={500} value={hint} onChange={event => setHint(event.target.value)} placeholder="可选：告诉 Agent 重点关注什么（最多 500 字）" />}
    {!draft && <a className="external-text-link" href="/workspace?view=agent&tab=tasks">查看我的 Agent 任务<ArrowUpRight size={13} /></a>}
    {modal && draft && <Modal title={`Agent 草稿 · #${item.number}`} onClose={() => setModal(false)} wide>
      <AgentDraft draft={draft} notify={notify} onChanged={load} />
    </Modal>}
  </section>;
}
