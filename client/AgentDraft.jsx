import React, { useState } from 'react';
import { Check, CircleAlert, ExternalLink, LoaderCircle } from 'lucide-react';
import { api } from './api.js';
import { Badge } from './ui.jsx';
import Markdown from './Markdown.jsx';

const DRAFT_STATUS = { pending: ['amber', '待审阅'], published: ['green', '已发布'], declined: ['neutral', '已驳回'] };
const ACTION_LABELS = { add_label: '添加标签', remove_label: '移除标签', assign: '指派', close: '关闭 Issue', reopen: '重新打开' };

// Shared by the Agent Hub list and the issue detail dialog. Drafts are always
// human-confirmed: nothing is written to GitHub until 确认发布 is clicked.
export default function AgentDraft({ draft, notify, onChanged }) {
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [tone, label] = DRAFT_STATUS[draft.status] || ['neutral', draft.status];
  const pending = draft.status === 'pending';

  function toggleAction(index) {
    setSelected(previous => previous.includes(index) ? previous.filter(value => value !== index) : [...previous, index]);
  }

  async function publish() {
    setBusy(true); setError(null);
    try {
      const actions = (draft.actions || []).filter((_, index) => selected.includes(index));
      const result = await api(`/api/agent/drafts/${encodeURIComponent(draft.id)}/publish`, { method: 'POST', body: { actions } });
      notify?.(result.demo ? '演示模式：已模拟发布。' : '已由你的 GitHub 身份发布评论。');
      await onChanged?.();
    } catch (e) { setError(e); notify?.(e.message, 'error'); }
    finally { setBusy(false); }
  }

  async function decline() {
    if (!window.confirm('确认驳回该草稿？驳回后不会发布到 GitHub。')) return;
    setBusy(true); setError(null);
    try { await api(`/api/agent/drafts/${encodeURIComponent(draft.id)}/decline`, { method: 'POST', body: {} }); notify?.('草稿已驳回'); await onChanged?.(); }
    catch (e) { setError(e); notify?.(e.message, 'error'); }
    finally { setBusy(false); }
  }

  return <div className="agent-draft-body agent-draft-inline">
    <div className="agent-draft-summary">
      <div><strong>{draft.summary || '无摘要'}</strong><small>{new Date(draft.createdAt).toLocaleString('zh-CN')}{draft.agentName ? ` · Agent「${draft.agentName}」` : ''}{draft.model ? ` · ${draft.model}` : ''}</small></div>
      <Badge tone={tone}>{label}</Badge>
    </div>
    {error && <p className="agent-adaptor-status is-red" role="alert"><CircleAlert size={14} />{error.message}{error.status === 409 && /GitHub/.test(error.message) && <a className="text-button" href={`/auth/github?${new URLSearchParams({ returnTo: window.location.pathname })}`}>去授权 GitHub 写入</a>}</p>}
    {draft.publishError && <p className="agent-adaptor-status is-red"><CircleAlert size={13} />{draft.publishError}</p>}
    <h4>评论正文</h4>
    <Markdown text={draft.commentMd} empty="（空）" />
    {draft.rootCauseHypothesis && <><h4>根因假设</h4><p>{draft.rootCauseHypothesis}</p></>}
    {!!draft.references?.length && <><h4>引用（未自动核实）</h4><ul className="agent-refs">{draft.references.map((ref, index) => <li key={index}><Badge tone="neutral">{ref.kind}</Badge>{ref.url ? <a href={ref.url} target="_blank" rel="noreferrer">{ref.path || ref.url}<ExternalLink size={12} /></a> : <code>{ref.path}</code>}{ref.snippet && <span>{ref.snippet}</span>}</li>)}</ul></>}
    {!!draft.actions?.length && <><h4>强副作用动作（勾选后才会执行）</h4><div className="agent-actions">{draft.actions.map((action, index) => <label key={index} className="agent-action"><input type="checkbox" disabled={!pending} checked={selected.includes(index)} onChange={() => toggleAction(index)} /><span><strong>{ACTION_LABELS[action.kind] || action.kind}{action.value ? `：${action.value}` : ''}</strong>{action.reason && <small>{action.reason}</small>}</span></label>)}</div></>}
    <div className="agent-draft-foot">
      <span>置信度 {Math.round((draft.confidence || 0) * 100)}%</span>
      {pending ? <div>
        <button className="btn btn-secondary btn-small" disabled={busy} onClick={decline}>驳回</button>
        <button className="btn btn-primary btn-small" disabled={busy} onClick={publish}>{busy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}确认发布</button>
      </div> : draft.commentUrl ? <a className="external-text-link" href={draft.commentUrl} target="_blank" rel="noreferrer">查看已发布评论<ExternalLink size={12} /></a> : null}
    </div>
    {pending && <p className="agent-muted">确认发布后将以你的 GitHub 身份发表评论，并自动标注生成该草稿的 Agent 与审核人。</p>}
  </div>;
}
