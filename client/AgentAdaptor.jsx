import React, { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, CircleAlert, CircleCheck, LoaderCircle, Sparkles } from 'lucide-react';
import { api } from './api.js';
import { Badge } from './ui.jsx';

function viewOf(state) {
  if (!state) return { tone: 'neutral', label: '读取中…' };
  if (state.demo) return { tone: 'neutral', label: '演示模式', hint: '演示模式不会调用 Agent 适配器。' };
  if (state.configured === false) return { tone: 'neutral', label: '未配置', hint: '服务端未配置 AGENT_ADAPTOR_URL / AGENT_ADAPTOR_TOKEN。' };
  if (state.available === false) return { tone: 'red', label: '服务暂不可达', hint: state.error || '请确认 platform-agent-adaptor 已启动且网络可达。' };
  const task = state.task, draft = state.draft;
  if (!task) return { tone: 'neutral', label: '尚未触发', hint: '触发后由 Agent 适配器生成处理草稿。' };
  if (task.status === 'open') return { tone: 'amber', label: '处理中', hint: '正在拉取 issue 事实与知识库并生成草稿，请稍候。' };
  if (task.status === 'failed') return { tone: 'red', label: '处理失败', hint: state.error || '请查看 platform-agent-adaptor 日志后重试。' };
  if (task.status === 'consumed' && draft?.status === 'pending_confirm') {
    if (state.feishuNotifyReady === false) return { tone: 'amber', label: '草稿已生成', hint: '适配器未配置通知渠道，草稿暂无法在飞书确认发布。' };
    return { tone: 'green', label: '待确认', hint: '草稿已推送通知渠道，请确认发布或丢弃。' };
  }
  if (draft?.status === 'published') return { tone: 'green', label: '已发布', hint: '处理结果已回写 GitHub。' };
  if (draft?.status === 'rejected') return { tone: 'neutral', label: '已丢弃', hint: '该草稿已被人工丢弃，未对外发布。' };
  if (task.status === 'closed') return { tone: 'neutral', label: '已结束', hint: '该处理任务已关闭。' };
  return { tone: 'neutral', label: task.status || '未知状态' };
}

export default function AgentAdaptor({ item, notify }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [hint, setHint] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/items/${encodeURIComponent(item.id)}/agent-adaptor`);
      setState(data); setError(null);
      return data;
    } catch (e) {
      setError(e);
      return null;
    } finally { setLoading(false); }
  }, [item.id]);

  useEffect(() => { load(); }, [load]);

  const running = state?.task?.status === 'open';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 5000);
    return () => clearInterval(timer);
  }, [running, load]);

  async function trigger() {
    setSubmitting(true); setNote(null);
    try {
      const result = await api(`/api/items/${encodeURIComponent(item.id)}/agent-adaptor/handle`, { method: 'POST', body: hint.trim() ? { hint: hint.trim() } : {} });
      const text = result.demo ? '演示模式：未真正触发 Agent 适配器。' : '已提交，Agent 适配器正在生成处理草稿…';
      setNote({ tone: 'ok', text });
      notify?.(text);
      if (!result.demo) { setShowHint(false); setHint(''); await load(); }
    } catch (e) {
      setNote({ tone: 'error', text: e.message });
      notify?.(e.message, 'error');
    } finally { setSubmitting(false); }
  }

  const view = viewOf(state);
  const configured = state ? state.configured !== false && !state.demo : true;
  const canTrigger = configured && !submitting && !running;
  const Icon = note?.tone === 'error' || view.tone === 'red' ? CircleAlert : CircleCheck;

  return <section className="detail-card">
    <div className="detail-card-title"><h3><Sparkles size={16} />Agent 适配器智能处理</h3>{loading && !state ? <Badge tone="neutral">读取中…</Badge> : <Badge tone={view.tone}>{view.label}</Badge>}</div>
    <p className="agent-adaptor-note">触发后由 platform-agent-adaptor 生成处理草稿；平台不会直接修改 GitHub。</p>
    {view.hint && <p className={`agent-adaptor-status is-${view.tone}`}>{view.hint}</p>}
    {state?.task && <p className="agent-adaptor-meta">最近任务 #{state.task.id}{state.task.createdAt ? ` · ${new Date(state.task.createdAt).toLocaleString('zh-CN')}` : ''}</p>}
    {state?.draft?.commentUrl && <a className="external-text-link" href={state.draft.commentUrl} target="_blank" rel="noreferrer">查看已发布评论<ArrowUpRight size={13} /></a>}
    {note && <p className={`agent-adaptor-status is-${note.tone}`} role={note.tone === 'error' ? 'alert' : 'status'}><Icon size={14} />{note.text}</p>}
    {error && <div className="agent-adaptor-status is-red" role="alert"><CircleAlert size={14} />{error.message}</div>}
    {configured && !state?.demo && <div className="agent-adaptor-actions">
      <button type="button" className="btn btn-secondary btn-small" disabled={!canTrigger} onClick={trigger}>{submitting ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}{running ? '处理中…' : state?.task ? '重新生成草稿' : '让 Agent 适配器开始处理'}</button>
      <button type="button" className="text-button" onClick={() => setShowHint(value => !value)}>{showHint ? '收起补充提示' : '补充提示（可选）'}</button>
    </div>}
    {showHint && <textarea className="agent-adaptor-hint" rows={3} maxLength={500} value={hint} onChange={event => setHint(event.target.value)} placeholder="可选：告诉 Agent 适配器重点关注什么（最多 500 字）" />}
  </section>;
}
