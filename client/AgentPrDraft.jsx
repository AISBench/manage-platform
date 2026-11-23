import React, { useState } from 'react';
import { Check, CircleAlert, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react';
import { api } from './api.js';
import { Badge } from './ui.jsx';

const DRAFT_STATUS = { pending: ['amber', '待验收'], published: ['green', '已验收'], declined: ['neutral', '已驳回'] };
const GATE_TONE = { PASS: 'green', FAIL: 'red', UNKNOWN: 'amber', NOT_APPLICABLE: 'neutral' };
const CHECK_LABEL = { success: '通过', pending: '进行中', failure: '失败', unknown: '未知' };

// PR results are reported by the Agent after it developed and opened the PR.
// The platform verifies ownership and head_sha; the member accepts the result.
export default function AgentPrDraft({ draft, notify, onChanged }) {
  const [current, setCurrent] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const payload = current.payload || {};
  const gate = Array.isArray(payload.gate) ? payload.gate : [];
  const checks = payload.checks || {};
  const pending = current.status === 'pending';
  const [tone, label] = DRAFT_STATUS[current.status] || ['neutral', current.status];

  async function refresh() {
    setBusy(true); setError(null);
    try {
      const result = await api(`/api/agent/drafts/${encodeURIComponent(current.id)}/refresh`, { method: 'POST', body: {} });
      setCurrent(result.draft);
      notify?.('已刷新 PR 状态');
    } catch (e) { setError(e); notify?.(e.message, 'error'); }
    finally { setBusy(false); }
  }

  async function accept() {
    setBusy(true); setError(null);
    try {
      const result = await api(`/api/agent/drafts/${encodeURIComponent(current.id)}/publish`, { method: 'POST', body: {} });
      notify?.(result.demo ? '演示模式：已模拟验收。' : '已验收该 PR 结果。');
      await onChanged?.();
    } catch (e) { setError(e); notify?.(e.message, 'error'); }
    finally { setBusy(false); }
  }

  async function decline() {
    if (!window.confirm('确认驳回该 PR 结果？驳回不会关闭或删除 GitHub 上的 PR。')) return;
    setBusy(true); setError(null);
    try { await api(`/api/agent/drafts/${encodeURIComponent(current.id)}/decline`, { method: 'POST', body: {} }); notify?.('草稿已驳回'); await onChanged?.(); }
    catch (e) { setError(e); notify?.(e.message, 'error'); }
    finally { setBusy(false); }
  }

  return <div className="agent-draft-body agent-draft-inline">
    <div className="agent-draft-summary">
      <div><strong>{payload.prTitle || current.summary || 'PR 结果'}</strong><small>关联 Issue #{payload.issueNumber} · {new Date(current.createdAt).toLocaleString('zh-CN')}{current.agentName ? ` · Agent「${current.agentName}」` : ''}</small></div>
      <Badge tone={tone}>{label}</Badge>
    </div>
    {error && <p className="agent-adaptor-status is-red" role="alert"><CircleAlert size={14} />{error.message}</p>}
    {current.publishError && <p className="agent-adaptor-status is-red"><CircleAlert size={13} />{current.publishError}</p>}

    <h4>PR</h4>
    <p className="agent-pr-meta">
      <a href={payload.prUrl} target="_blank" rel="noreferrer">{payload.prUrl}<ExternalLink size={12} /></a>
      <small>{payload.baseRef || 'master'} ← {payload.headRef || ''}{payload.forkOwner ? `（fork: ${payload.forkOwner}）` : ''}</small>
      <code>{payload.headSha || ''}</code>
    </p>

    <h4>本地门禁结论</h4>
    <table className="agent-gate-table">
      <thead><tr><th>门禁</th><th>结论</th><th>证据</th></tr></thead>
      <tbody>
        {gate.map((entry, index) => <tr key={index}>
          <td>{entry.name}</td>
          <td><Badge tone={GATE_TONE[entry.status] || 'neutral'}>{entry.status}</Badge></td>
          <td>{entry.evidence || '—'}</td>
        </tr>)}
      </tbody>
    </table>

    <h4>平台回读的 CI 状态</h4>
    <p className="agent-pr-meta"><Badge tone={GATE_TONE[checks.state === 'success' ? 'PASS' : checks.state === 'failure' ? 'FAIL' : 'UNKNOWN']}>{CHECK_LABEL[checks.state] || '未知'}</Badge><small>check-runs：{CHECK_LABEL[checks.checkRuns] || '未知'} · statuses：{CHECK_LABEL[checks.statuses] || '未知'}</small></p>

    {!!(payload.unverified || []).length && <><h4>未验证项</h4><ul className="agent-unverified">{payload.unverified.map((entry, index) => <li key={index}>{entry}</li>)}</ul></>}
    {!!(payload.verifyErrors || []).length && <><h4>校验问题</h4><ul className="agent-unverified is-red">{payload.verifyErrors.map((entry, index) => <li key={index}>{entry}</li>)}</ul></>}

    <div className="agent-draft-foot">
      <span>{payload.refreshedAt ? `刷新于 ${new Date(payload.refreshedAt).toLocaleString('zh-CN')}` : '未刷新'}</span>
      <div>
        <button className="btn btn-secondary btn-small" disabled={busy} onClick={refresh}><RefreshCw size={13} />刷新状态</button>
        {pending && <>
          <button className="btn btn-secondary btn-small" disabled={busy} onClick={decline}>驳回</button>
          <button className="btn btn-primary btn-small" disabled={busy} onClick={accept}>{busy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}确认验收</button>
        </>}
      </div>
    </div>
    {pending && <p className="agent-muted">平台只验收你本机 Agent 创建的 PR，不会代推代码、不会合并；head 变更后请先刷新再验收。</p>}
  </div>;
}
