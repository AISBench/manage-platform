import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, CircleAlert, CircleCheck, CircleDot, GitPullRequest, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { api } from './api.js';
import { Badge, ErrorBox, Spinner } from './ui.jsx';
import Conversation from './Conversation.jsx';
import ItemDescription from './ItemDescription.jsx';
import { CIColumn, InfoColumn, OperationsColumn } from './ItemEvents.jsx';
import IssueMaster from './IssueMaster.jsx';
import AgentTask from './AgentTask.jsx';

const TABS = [['conversation', '对话'], ['ci', 'CI'], ['operations', '操作记录'], ['info', '信息']];

export default function ItemDetail({ itemId, user, session, notify, onBack }) {
  const [data, setData] = useState(null);
  const [older, setOlder] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState('conversation');
  const [authNotice, setAuthNotice] = useState(null);
  const resumedAuth = useRef(false);
  // After a CI rerun, poll GitHub until the new run reaches a terminal state
  // instead of forcing the user to reload the whole page.
  const followUp = useRef(null);
  const followUpTimer = useRef(null);

  async function load({ refresh = false, before = '', append = false } = {}) {
    const params = new URLSearchParams({ limit: '50', refresh: refresh ? '1' : '0' });
    if (before) params.set('before', before);
    if (refresh) setRefreshing(true);
    try {
      const result = await api(`/api/items/${encodeURIComponent(itemId)}/conversation?${params}`);
      if (append) {
        setOlder(previous => {
          const known = new Set(previous.map(m => m.id));
          return [...previous, ...(result.messages || []).filter(m => !known.has(m.id))];
        });
      } else {
        setData(result); setOlder([]);
      }
      setError(null);
      return result;
    } catch (e) { setError(e); return null; } finally { setLoading(false); setRefreshing(false); }
  }

  function trackCi(name) {
    followUp.current = { until: Date.now() + 10 * 60 * 1000, name: name || '' };
    clearTimeout(followUpTimer.current);
    followUpTimer.current = setTimeout(() => { if (document.visibilityState === 'visible') load({ refresh: true }); }, 8000);
  }

  useEffect(() => {
    setLoading(true); setData(null); setOlder([]); setError(null);
    followUp.current = null;
    load({ refresh: true });
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      const tracking = followUp.current && followUp.current.until > Date.now() ? followUp.current : null;
      const result = await load({ refresh: !!tracking });
      if (!tracking || !result) return;
      const settled = (result.events?.ci || []).some(event => (event.detail?.name || '') === tracking.name && event.detail?.status === 'completed');
      if (settled) { followUp.current = null; clearTimeout(followUpTimer.current); }
    }, 20000);
    return () => { clearInterval(timer); clearTimeout(followUpTimer.current); };
  }, [itemId]);

  async function loadOlder() {
    const last = [...(data?.messages || []), ...older].at(-1);
    if (!last) return;
    await load({ before: last.createdAt, append: true });
  }

  useEffect(() => {
    if (resumedAuth.current) return;
    resumedAuth.current = true;
    const params = new URLSearchParams(window.location.search);
    const eventId = params.get('ci');
    const ciName = params.get('ciName') || '';
    const authorized = params.get('auth') === 'success';
    const failure = params.get('error');
    if (!eventId && !authorized && !failure) return;
    for (const key of ['ci', 'ciName', 'auth', 'error']) params.delete(key);
    window.history.replaceState({}, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`);
    if (failure) { setAuthNotice({ tone: 'error', text: `GitHub 授权未完成：${String(failure).slice(0, 180)}` }); return; }
    // Returning without a pending retry means the member only re-authorized.
    if (!eventId) { setAuthNotice({ tone: 'ok', text: 'GitHub 授权已完成，可以重新触发 CI 全量重试。' }); return; }
    if (!session.demo && !user.githubWriteReady) { setAuthNotice({ tone: 'error', text: 'GitHub 写入授权仍未生效，请确认授权范围包含 public_repo 后重新授权。' }); return; }
    (async () => {
      try {
        const result = await api(`/api/items/${encodeURIComponent(itemId)}/ci/${encodeURIComponent(eventId)}/rerun`, { method: 'POST', body: {} });
        setAuthNotice({ tone: 'ok', text: result.demo ? '演示模式：已模拟触发全量重试。' : '授权已完成，已自动重新触发全量重试，正在跟踪状态…' });
        trackCi(ciName);
        await load({ refresh: true });
      } catch (e) { setAuthNotice({ tone: 'error', text: e.message }); }
    })();
  }, [itemId]);

  if (loading && !data) return <div className="item-detail"><div className="detail-loading"><Spinner label="正在读取会话…" /></div></div>;
  if (error && !data) return <div className="item-detail"><ErrorBox error={error} retry={() => { setLoading(true); load({ refresh: true }); }} /></div>;
  const item = data.item;
  const sideEvents = data.events || { ci: [], operation: [] };
  return <div className="item-detail">
    <header className="item-detail-header">
      <button className="text-button" onClick={onBack}><ArrowLeft size={15} />返回任务列表</button>
      <div className="item-detail-title"><span className={`item-kind-icon ${item.kind === 'pr' ? 'is-pr' : 'is-issue'}`}>{item.kind === 'pr' ? <GitPullRequest size={20} /> : <CircleDot size={20} />}</span><div><div className="item-detail-eyebrow">{item.kind === 'pr' ? 'Pull Request' : 'Issue'} #{item.number}</div><h1>{item.title}</h1><div className="item-detail-meta"><Badge tone={item.state === 'open' ? 'green' : 'purple'}>{item.state === 'open' ? 'Open' : 'Closed'}</Badge><span>{item.author}</span>{item.updatedAt && <span>更新于 {new Date(item.updatedAt).toLocaleString('zh-CN')}</span>}<a className="external-text-link" href={item.url} target="_blank" rel="noreferrer">在 GitHub 打开<ArrowUpRight size={13} /></a></div></div></div>
      <button className="btn btn-secondary btn-small" onClick={() => load({ refresh: true })} disabled={refreshing}>{refreshing ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{refreshing ? '同步中…' : '刷新'}</button>
    </header>
    {authNotice && <div className={`detail-sync-error auth-notice is-${authNotice.tone}`} role={authNotice.tone === 'error' ? 'alert' : 'status'}>{authNotice.tone === 'ok' ? <CircleCheck size={15} /> : <CircleAlert size={15} />}<span>{authNotice.text}</span><button type="button" className="icon-button" aria-label="关闭授权提示" onClick={() => setAuthNotice(null)}><X size={14} /></button></div>}
    {data.syncError && <div className="detail-sync-error"><CircleAlert size={15} />会话同步暂时失败：{String(data.syncError)}。当前显示已缓存内容。</div>}
    <div className="detail-tabs" role="tablist">{TABS.map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}{key === 'ci' && sideEvents.ci.length ? ` ${sideEvents.ci.length}` : ''}{key === 'operations' && sideEvents.operation.length ? ` ${sideEvents.operation.length}` : ''}</button>)}</div>
    <div className="item-detail-layout">
      <div className={`item-detail-main ${tab === 'conversation' ? 'is-active' : ''}`}><ItemDescription item={item} /><Conversation itemId={itemId} data={data} user={user} session={session} notify={notify} reload={load} loading={loading} error={error} older={older} onLoadOlder={loadOlder} /></div>
      <aside className="item-detail-side"><div className="side-inner">
        {user?.isAdmin && item.kind === 'issue' && <IssueMaster item={item} notify={notify} />}
        <AgentTask item={item} user={user} notify={notify} />
        <div className={tab === 'info' ? 'side-active' : ''}><InfoColumn item={item} user={user} notify={notify} onSaved={() => load({ refresh: false })} /></div>
        <div className={tab === 'ci' ? 'side-active' : ''}><CIColumn events={sideEvents.ci} itemId={itemId} user={user} session={session} notify={notify} onChanged={() => load({ refresh: false })} onCiTriggered={trackCi} /></div>
        <div className={tab === 'operations' ? 'side-active' : ''}><OperationsColumn events={sideEvents.operation} /></div>
      </div></aside>
    </div>
  </div>;
}
