import React, { useEffect, useState } from 'react';
import { Bot, CircleAlert, LoaderCircle, Search } from 'lucide-react';
import { api } from './api.js';
import { Badge } from './ui.jsx';
import AgentTaskInbox from './AgentTaskInbox.jsx';

// Pick an open Issue and hand it to the member's Agent. Search reuses the
// platform item index (number/title/labels) so selecting an Issue is one click.
export default function IssuePicker({ notify, onCreated }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  async function load() {
    try {
      const params = new URLSearchParams({ kind: 'issue', state: 'open', q: query });
      const data = await api(`/api/items?${params}`);
      setItems((data.items || []).slice(0, 12));
      setError(null);
    } catch (e) { setError(e); }
  }
  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [query]);

  async function create(item) {
    setBusy(item.id); setError(null);
    try {
      const result = await api(`/api/items/${encodeURIComponent(item.id)}/agent-task`, { method: 'POST', body: { kind: 'pr_create' } });
      notify?.(result.created ? '已创建提 PR 任务，等待你的 Agent 领取。' : '该 Issue 已有进行中的提 PR 任务。');
      setReloadKey(value => value + 1);
      onCreated?.();
    } catch (e) { setError(e); notify?.(e.message, 'error'); }
    finally { setBusy(''); }
  }

  return <div className="agent-issue-picker">
    <label className="agent-issue-search">
      <Search size={14} />
      <input value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder="按编号、标题或标签搜索开放的 Issue" aria-label="搜索 Issue" />
    </label>
    {error && <p className="agent-adaptor-status is-red" role="alert"><CircleAlert size={14} />{error.message}</p>}
    <div className="agent-issue-results">
      {items.map(item => <div className="agent-issue-result" key={item.id}>
        <div>
          <strong>#{item.number} {item.title}</strong>
          <small>{item.state}{item.labels?.length ? ` · ${item.labels.slice(0, 4).join('、')}` : ''}</small>
        </div>
        <div className="agent-issue-result-actions">
          <a className="text-button" href={item.url} target="_blank" rel="noreferrer">GitHub</a>
          <button className="btn btn-secondary btn-small" disabled={busy === item.id} onClick={() => create(item)}>
            {busy === item.id ? <LoaderCircle size={13} className="spin" /> : <Bot size={13} />}让 Agent 提 PR
          </button>
        </div>
      </div>)}
      {!items.length && <p className="agent-muted">没有匹配的开放 Issue。可以换个关键词，或先在 GitHub 上确认 Issue 是否已同步。</p>}
    </div>
    <p className="agent-muted">Agent 会在本机按仓库的 aisbench-devflow skill 开发与验证，用你自己的 GitHub 身份推 fork 并创建 PR；平台只验收结果。</p>

    <AgentTaskInbox kinds={['pr_create']} reloadKey={reloadKey} notify={notify}
      title="我的提 PR 任务" emptyText="还没有提 PR 任务。选中 Issue 后可以在这里直接验收 Agent 提交的 PR 结果。" />
  </div>;
}
