import React, { useState } from 'react';
import { Check, CircleAlert, ExternalLink, LoaderCircle } from 'lucide-react';
import { api } from './api.js';
import { Badge } from './ui.jsx';
import Markdown from './Markdown.jsx';

const DRAFT_STATUS = { pending: ['amber', '待审阅'], published: ['green', '已创建'], declined: ['neutral', '已驳回'] };
const HIGH_SIMILARITY = 0.8;

// Issue drafts are rendered from the repository template, so the member reviews
// exactly what will be created: template fields, labels and duplicate evidence.
export default function AgentIssueDraft({ draft, notify, onChanged }) {
  const payload = draft.payload || {};
  const duplicates = Array.isArray(payload.duplicates) ? payload.duplicates : [];
  const highSimilarity = duplicates.filter(item => Number(item.similarity) >= HIGH_SIMILARITY);
  const [confirmed, setConfirmed] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pending = draft.status === 'pending';
  const [tone, label] = DRAFT_STATUS[draft.status] || ['neutral', draft.status];
  const fields = payload.fields || {};
  const template = payload.templateName || payload.templateId || '';

  function toggle(number) {
    setConfirmed(previous => previous.includes(number) ? previous.filter(value => value !== number) : [...previous, number]);
  }

  async function publish() {
    if (highSimilarity.some(item => !confirmed.includes(item.number))) {
      setError(new Error('请先逐条确认高相似度 Issue 不是重复'));
      return;
    }
    setBusy(true); setError(null);
    try {
      const result = await api(`/api/agent/drafts/${encodeURIComponent(draft.id)}/publish`, { method: 'POST', body: { confirmedDuplicates: confirmed } });
      notify?.(result.demo ? '演示模式：已模拟创建 Issue。' : '已由你的 GitHub 身份创建 Issue。');
      await onChanged?.();
    } catch (e) { setError(e); notify?.(e.message, 'error'); }
    finally { setBusy(false); }
  }

  async function decline() {
    if (!window.confirm('确认驳回该 Issue 草稿？驳回后不会创建 Issue。')) return;
    setBusy(true); setError(null);
    try { await api(`/api/agent/drafts/${encodeURIComponent(draft.id)}/decline`, { method: 'POST', body: {} }); notify?.('草稿已驳回'); await onChanged?.(); }
    catch (e) { setError(e); notify?.(e.message, 'error'); }
    finally { setBusy(false); }
  }

  return <div className="agent-draft-body agent-draft-inline">
    <div className="agent-draft-summary">
      <div><strong>{payload.title || draft.summary || '未命名 Issue'}</strong><small>模板：{template} · {new Date(draft.createdAt).toLocaleString('zh-CN')}{draft.agentName ? ` · Agent「${draft.agentName}」` : ''}{draft.model ? ` · ${draft.model}` : ''}</small></div>
      <Badge tone={tone}>{label}</Badge>
    </div>
    {error && <p className="agent-adaptor-status is-red" role="alert"><CircleAlert size={14} />{error.message}{error.status === 409 && /GitHub/.test(error.message) && <a className="text-button" href={`/auth/github?${new URLSearchParams({ returnTo: window.location.pathname })}`}>去授权 GitHub 写入</a>}</p>}
    {draft.publishError && <p className="agent-adaptor-status is-red"><CircleAlert size={13} />{draft.publishError}</p>}

    <h4>标签</h4>
    <p className="agent-issue-labels">{(payload.labels || []).map(name => <Badge key={name} tone="neutral">{name}</Badge>)}</p>

    <h4>模板字段</h4>
    <ul className="agent-issue-fields">{Object.entries(fields).map(([key, value]) => <li key={key}><strong>{key}</strong><span>{Array.isArray(value) ? value.join('；') : String(value)}</span></li>)}</ul>

    <h4>将创建的正文</h4>
    <Markdown text={payload.body || ''} empty="（空）" />
    {payload.supplement && <><h4>补充说明</h4><Markdown text={payload.supplement} /></>}

    <h4>查重候选（平台按标题/正文重新打分）</h4>
    <ul className="agent-duplicates">
      {duplicates.slice(0, 8).map(item => <li key={item.number} className={Number(item.similarity) >= HIGH_SIMILARITY ? 'is-warning' : ''}>
        {pending && Number(item.similarity) >= HIGH_SIMILARITY && <input type="checkbox" checked={confirmed.includes(item.number)} onChange={() => toggle(item.number)} aria-label={`确认 #${item.number} 不是重复`} />}
        <span>
          <a href={item.url || `https://github.com/AISBench/benchmark/issues/${item.number}`} target="_blank" rel="noreferrer">#{item.number} {item.title || '（无标题）'}<ExternalLink size={12} /></a>
          <small>{item.state || ''}{item.similarity !== undefined ? ` · 相似度 ${Math.round(Number(item.similarity) * 100)}%` : ''}</small>
        </span>
      </li>)}
    </ul>
    {payload.dedupe?.rationale && <><h4>Agent 查重结论</h4><p>{payload.dedupe.rationale}</p></>}
    {!!highSimilarity.length && pending && <p className="agent-muted">存在高相似度 Issue：请逐条勾选确认不是重复后才能创建。</p>}

    <div className="agent-draft-foot">
      <span>模型 {draft.model || '未标注'}</span>
      {pending ? <div>
        <button className="btn btn-secondary btn-small" disabled={busy} onClick={decline}>驳回</button>
        <button className="btn btn-primary btn-small" disabled={busy} onClick={publish}>{busy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}确认创建 Issue</button>
      </div> : draft.commentUrl ? <a className="external-text-link" href={draft.commentUrl} target="_blank" rel="noreferrer">查看已创建 Issue<ExternalLink size={12} /></a> : null}
    </div>
    {pending && <p className="agent-muted">确认后将以你的 GitHub 身份创建 Issue，正文按模板字段生成，并自动标注生成该草稿的 Agent 与审核人。</p>}
  </div>;
}
