import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, CircleAlert, ExternalLink, Eye, LoaderCircle, MessageCircle, RefreshCw, Send } from 'lucide-react';
import { api } from './api.js';
import { Avatar, Badge, ErrorBox, Spinner, date } from './ui.jsx';
import Markdown from './Markdown.jsx';
import MarkdownEditor from './MarkdownEditor.jsx';

const LONG_CHARS = 800;
const LONG_LINES = 12;

function parseDiffHunk(hunk, targetLine, side) {
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  for (const text of String(hunk || '').split('\n')) {
    const header = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      rows.push({ type: 'header', text });
      continue;
    }
    if (!text) { rows.push({ type: 'context', text: '', old: null, new: null }); continue; }
    let type = 'context';
    let old = null;
    let now = null;
    if (text.startsWith('+')) { type = 'add'; now = newLine++; }
    else if (text.startsWith('-')) { type = 'del'; old = oldLine++; }
    else { old = oldLine++; now = newLine++; }
    const hit = side === 'LEFT' ? old === targetLine : side === 'RIGHT' ? now === targetLine : now === targetLine || old === targetLine;
    rows.push({ type, text: text.slice(1), old, new: now, target: hit });
  }
  if (!rows.some(row => row.target)) {
    const fallback = [...rows].reverse().find(row => row.type === 'add') || rows.find(row => row.type !== 'header');
    if (fallback) fallback.target = true;
  }
  return rows;
}

function ReviewCode({ message, itemUrl }) {
  if (!message.path && !message.diffHunk) return null;
  const line = message.line || message.startLine;
  const base = (message.url || '').split('#')[0] || itemUrl;
  const href = message.reviewCommentId ? `${base}/changes#r${message.reviewCommentId}` : message.url || itemUrl;
  const rows = message.diffHunk ? parseDiffHunk(message.diffHunk, line, message.side) : [];
  return <div className="review-code">
    <div className="review-code-head"><code>{message.path || '代码文件'}</code>{line && <span>L{line}</span>}{href && <a className="btn btn-secondary btn-small review-code-link" href={href} target="_blank" rel="noreferrer"><ExternalLink size={13} />在 Files changed 中定位</a>}</div>
    {rows.length > 0 && <div className="review-code-body" role="region" aria-label={`${message.path || '代码'} 的差异片段`}>{rows.map((row, index) => row.type === 'header'
      ? <div className="diff-line is-header" key={index}><span className="diff-no" /><span className="diff-no" /><span className="diff-sign" /><code>{row.text}</code></div>
      : <div className={`diff-line is-${row.type} ${row.target ? 'is-target' : ''}`} key={index}><span className="diff-no">{row.old ?? ''}</span><span className="diff-no">{row.new ?? ''}</span><span className="diff-sign">{row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}</span><code>{row.text || ' '}</code></div>)}</div>}
  </div>;
}

function MessageCard({ message, user, itemUrl, expanded, onToggle, onReads, reads, onRetry, retrying }) {
  const elementRef = useRef(null);
  const own = message.author.memberId && message.author.memberId === user.memberId;
  const mentionSelf = (message.mentions || []).some(mention => mention.isSelf);
  const long = message.body.length > LONG_CHARS || message.body.split('\n').length > LONG_LINES;
  return <article ref={elementRef} data-message-id={message.id} className={`message-card ${own ? 'is-own' : ''} ${mentionSelf ? 'is-mention' : ''} ${message.deliveryStatus === 'failed' ? 'is-failed' : ''}`}>
    <Avatar login={message.author.login} src={message.author.avatarUrl} size="small" />
    <div className="message-main">
      <div className="message-meta"><strong>{message.author.name || message.author.login}</strong><span>@{message.author.login}</span><Badge tone={message.source === 'platform' ? 'teal' : 'neutral'}>{message.source === 'platform' ? (message.deliveryStatus === 'demo' ? '平台 · 演示' : '平台') : 'GitHub'}</Badge>{message.kind === 'review' && <Badge tone="purple">Review {message.state || ''}</Badge>}{message.kind === 'review_comment' && <Badge tone="purple">行内评论</Badge>}{mentionSelf && <Badge tone="amber">@你</Badge>}{message.remoteDeleted && <Badge tone="red">已删除</Badge>}<time dateTime={message.createdAt}>{date(message.createdAt, true)}</time>{message.url && <a className="external-text-link" href={message.url} target="_blank" rel="noreferrer">GitHub</a>}</div>
      {mentionSelf && <div className="message-mention-banner">有人在这条消息中提到了你</div>}
      {message.kind === 'review_comment' && <ReviewCode message={message} itemUrl={itemUrl} />}
      <div className={`message-body ${long && !expanded ? 'is-collapsed' : ''}`}><Markdown text={message.body || '（无正文）'} /></div>
      {long && <button className="text-button message-expand" onClick={() => onToggle(message.id)}>{expanded ? <><ChevronUp size={13} />收起</> : <><ChevronDown size={13} />展开全文</>}</button>}
      {message.deliveryStatus === 'failed' && <div className="message-failed"><CircleAlert size={14} /><span>{message.deliveryError === 'GITHUB_TOKEN_INVALID' ? 'GitHub 授权失效，请重新授权' : message.deliveryError === 'GITHUB_FORBIDDEN' ? '没有评论权限' : '同步到 GitHub 失败'}</span><button className="text-button" disabled={retrying} onClick={() => onRetry(message.id)}>{retrying ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}重试</button></div>}
      <div className="message-footer"><button type="button" className={`read-receipt ${message.readByMe ? 'is-read' : ''}`} onClick={() => onReads(message.id)}><Eye size={13} />{message.readCount ? `已读 ${message.readCount}` : '暂无已读'}</button></div>
      {reads?.messageId === message.id && <div className="read-list">{reads.loading ? <Spinner compact label="读取已读成员…" /> : reads.members?.length ? reads.members.map(member => <span key={member.memberId} className="read-member"><Avatar login={member.login} src={member.avatarUrl} size="tiny" />{member.displayName || member.login}</span>) : <span className="muted">还没有其他平台成员读过这条消息</span>}{reads.error && <ErrorBox compact error={reads.error} />}</div>}
    </div>
  </article>;
}

export default function Conversation({ itemId, data, user, session, notify, reload, loading, error, older, onLoadOlder }) {
  const draftKey = `conversation-draft:${itemId}`;
  const [draft, setDraft] = useState(() => { try { return localStorage.getItem(draftKey) || ''; } catch { return ''; } });
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [reads, setReads] = useState(null);
  const [retrying, setRetrying] = useState('');
  const pendingReads = useRef(new Set());
  const observer = useRef(null);
  const flushTimer = useRef(null);
  const messages = [...(data?.messages || []), ...(older || [])];
  const canWrite = session.demo || user.githubWriteReady;
  const open = data?.item?.state === 'open';
  const participants = data?.item ? [data.item.author, ...(data.item.assignees || []), ...(data.item.reviewers || [])].filter(Boolean) : [];

  useEffect(() => { try { setDraft(localStorage.getItem(draftKey) || ''); } catch { setDraft(''); } }, [draftKey]);
  useEffect(() => { try { if (draft) localStorage.setItem(draftKey, draft); else localStorage.removeItem(draftKey); } catch { /* drafts are best-effort */ } }, [draft, draftKey]);

  useEffect(() => {
    observer.current = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) pendingReads.current.add(entry.target.dataset.messageId);
    }, { threshold: 0.6 });
    flushTimer.current = setInterval(async () => {
      const ids = [...pendingReads.current];
      if (!ids.length) return;
      pendingReads.current.clear();
      try { await api(`/api/items/${encodeURIComponent(itemId)}/read`, { method: 'POST', body: { messageIds: ids.slice(0, 50) } }); }
      catch { /* read receipts are best-effort */ }
    }, 2500);
    return () => { observer.current?.disconnect(); clearInterval(flushTimer.current); };
  }, [itemId]);

  useEffect(() => {
    for (const element of document.querySelectorAll('.message-card[data-message-id]')) observer.current?.observe(element);
    return () => { for (const element of document.querySelectorAll('.message-card[data-message-id]')) observer.current?.unobserve(element); };
  }, [messages.length]);

  function toggle(id) { setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  async function showReads(messageId) {
    if (reads?.messageId === messageId) { setReads(null); return; }
    setReads({ messageId, loading: true, members: [] });
    try { const result = await api(`/api/items/${encodeURIComponent(itemId)}/messages/${encodeURIComponent(messageId)}/reads`); setReads({ messageId, loading: false, members: result.members }); }
    catch (e) { setReads({ messageId, loading: false, members: [], error: e }); }
  }
  async function send(event) {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true); setSendError(null);
    try {
      await api(`/api/items/${encodeURIComponent(itemId)}/messages`, { method: 'POST', body: { body, clientId: crypto.randomUUID() } });
      setDraft(''); notify?.('消息已发送'); await reload({ refresh: true });
    } catch (e) { setSendError(e); } finally { setSending(false); }
  }
  async function retry(messageId) {
    setRetrying(messageId);
    try { await api(`/api/items/${encodeURIComponent(itemId)}/messages/${encodeURIComponent(messageId)}/retry`, { method: 'POST', body: {} }); notify?.('已重新同步到 GitHub'); await reload({ refresh: true }); }
    catch (e) { setSendError(e); } finally { setRetrying(''); }
  }
  const unread = data?.unread?.unread || 0;
  return <section className="conversation-panel">
    <div className="conversation-head"><div><h2><MessageCircle size={17} />对话</h2><p>最新消息在前 · 平台发言以你的 GitHub 身份同步</p></div><Badge tone={unread ? 'amber' : 'neutral'}>{unread ? `${unread} 条未读` : '已读'}{data?.unread?.mentions ? ` · @我 ${data.unread.mentions}` : ''}</Badge></div>
    <form className="composer" onSubmit={send}>
      {!canWrite && !session.demo && <div className="composer-auth"><CircleAlert size={15} /><span>需要 GitHub 评论写权限后才能发言。</span><a className="btn btn-small btn-secondary" href={`/auth/github?${new URLSearchParams({ returnTo: `/workspace/items/${itemId}` })}`}>授权 GitHub</a></div>}
      <MarkdownEditor value={draft} onChange={setDraft} disabled={!canWrite || !open || sending} placeholder={!open ? '已关闭的事项不能继续发言' : canWrite ? '写下你的回复… 支持 Markdown、@成员、#事务引用（Cmd/Ctrl+Enter 发送）' : '授权后即可发言'} participants={participants} maxLength={20000} onSubmit={send} />
      <div className="composer-footer"><span>{draft.length} / 20000</span><button className="btn btn-primary btn-small" type="submit" disabled={!canWrite || !open || sending || !draft.trim()}>{sending ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}{sending ? '发送中…' : '发送到 GitHub'}</button></div>
      {sendError && <ErrorBox compact error={sendError} retry={sendError.authUrl ? undefined : () => setSendError(null)} />}
      {sendError?.authUrl && <a className="text-button" href={sendError.authUrl}>重新授权 GitHub 评论权限</a>}
    </form>
    {error ? <ErrorBox error={error} retry={() => reload({ refresh: true })} /> : loading && !data ? <Spinner label="正在读取对话…" /> : <>
      {unread > 0 && <div className="unread-banner">有 {unread} 条未读消息{data.unread.mentions ? `，其中 ${data.unread.mentions} 条 @你` : ''}</div>}
      <div className="message-list">{messages.length ? messages.map(message => <MessageCard key={message.id} message={message} user={user} itemUrl={data?.item?.url} expanded={expanded.has(message.id)} onToggle={toggle} onReads={showReads} reads={reads} onRetry={retry} retrying={retrying === message.id} />) : <div className="conversation-empty">还没有评论，发送第一条消息吧。</div>}</div>
      {messages.length >= 50 && <button className="btn btn-secondary btn-small conversation-more" onClick={onLoadOlder}>加载更早消息</button>}
    </>}
  </section>;
}
