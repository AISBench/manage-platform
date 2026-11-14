import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, CircleAlert, CircleDot, GitPullRequest, LoaderCircle, RefreshCw } from 'lucide-react';
import { api } from './api.js';
import { Badge, ErrorBox, Spinner } from './ui.jsx';
import Conversation from './Conversation.jsx';
import ItemDescription from './ItemDescription.jsx';
import { CIColumn, InfoColumn, OperationsColumn } from './ItemEvents.jsx';

const TABS = [['conversation', '对话'], ['ci', 'CI'], ['operations', '操作记录'], ['info', '信息']];

export default function ItemDetail({ itemId, user, session, notify, onBack }) {
  const [data, setData] = useState(null);
  const [older, setOlder] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState('conversation');
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
    {data.syncError && <div className="detail-sync-error"><CircleAlert size={15} />会话同步暂时失败：{String(data.syncError)}。当前显示已缓存内容。</div>}
    <div className="detail-tabs" role="tablist">{TABS.map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}{key === 'ci' && sideEvents.ci.length ? ` ${sideEvents.ci.length}` : ''}{key === 'operations' && sideEvents.operation.length ? ` ${sideEvents.operation.length}` : ''}</button>)}</div>
    <div className="item-detail-layout">
      <div className={`item-detail-main ${tab === 'conversation' ? 'is-active' : ''}`}><ItemDescription item={item} /><Conversation itemId={itemId} data={data} user={user} session={session} notify={notify} reload={load} loading={loading} error={error} older={older} onLoadOlder={loadOlder} /></div>
      <aside className="item-detail-side">
        <div className={tab === 'ci' ? 'side-active' : ''}><CIColumn events={sideEvents.ci} itemId={itemId} user={user} session={session} notify={notify} onChanged={() => load({ refresh: false })} onCiTriggered={trackCi} /></div>
        <div className={tab === 'operations' ? 'side-active' : ''}><OperationsColumn events={sideEvents.operation} /></div>
        <div className={tab === 'info' ? 'side-active' : ''}><InfoColumn item={item} user={user} onSaved={() => load({ refresh: false })} /></div>
      </aside>
    </div>
  </div>;
}
