import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, X } from 'lucide-react';
import { api } from './api.js';
import { safeReturnTo } from './access.js';

export const STATUS = { pending_activation: '待激活', active: '正常', disabled: '已停用' };
export const OWNER_ISSUES = { disabled: '负责人已停用', pending_activation: '负责人待激活', unbound: '未绑定飞书', needs_confirmation: '飞书待测试确认', notifications_disabled: '通知已关闭', legacy_unresolved: '历史负责人待核对' };
export function isMine(item, user) {
  const githubId = String(user.githubId || '');
  return Boolean(user.memberId && item.ownerMemberId === user.memberId) || Boolean(githubId && [item.authorId, ...(item.assigneeIds || []), ...(item.reviewerIds || [])].some(id => String(id) === githubId));
}
export function pendingItem(item) { return !['closed', 'merged'].includes(item.state) && item.workflow !== 'done'; }
export function date(value) { if (value === null || value === undefined || value === '') return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN'); }
export function safeUrl(url) { try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : undefined; } catch { return undefined; } }
export function Badge({ tone = 'neutral', children }) { return <span className={`badge badge-${tone}`}>{children}</span>; }
export function MemberStatus({ status }) { return <Badge tone={status === 'active' ? 'teal' : status === 'disabled' ? 'red' : 'amber'}>{STATUS[status] || status}</Badge>; }
export function BindingStatus({ member }) { return <Badge tone={member.feishuVerified ? 'teal' : member.feishuBound ? 'amber' : 'neutral'}>{member.feishuVerified ? '已绑定 · 已验证' : member.feishuBound ? '已绑定 · 待测试确认' : '未绑定'}</Badge>; }
export function Avatar({ login, src }) { const [failed, setFailed] = useState(false); useEffect(() => setFailed(false), [src]); return <span className="avatar">{src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : (login || '?').slice(0, 2).toUpperCase()}</span>; }
export function Spinner({ label = '加载中…' }) { return <div className="loading-state" role="status"><LoaderCircle className="spin" size={24} /><span>{label}</span></div>; }
export function ErrorBox({ error, retry }) { return <div className="error-box compact" role="alert"><CircleAlert size={18} /><div><strong>{error?.status === 409 ? '数据已变化或操作存在冲突' : '暂时无法完成请求'}</strong><p>{error?.message || '请稍后重试。'}</p>{error?.status === 409 && <p>未覆盖其他人的更改。请刷新数据后重新确认并提交。</p>}{error?.status === 401 && <a href={`/join?${new URLSearchParams({ returnTo: safeReturnTo(window.location.pathname + window.location.search) })}`}>重新验证登录 <ArrowUpRight size={13} /></a>}</div>{retry && <button className="btn btn-secondary btn-small" type="button" onClick={retry}>刷新数据</button>}</div>; }
export function Empty({ text = '没有匹配的数据，试试调整筛选条件。' }) { return <div className="empty-state"><h3>暂无记录</h3><p>{text}</p></div>; }
export function Heading({ eyebrow, title, description, action }) { return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div><div className="heading-action">{action}</div></div>; }
export function useResource(path, revision = 0, enabled = true) {
  const [state, setState] = useState({ data: null, error: null, loading: enabled });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState(old => ({ ...old, error: null, loading: true }));
    api(path, { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setState({ data, error: null, loading: false }); }).catch(error => { if (!controller.signal.aborted) setState(old => ({ ...old, error, loading: false })); });
    return () => controller.abort();
  }, [path, revision, enabled, attempt]);
  return { ...state, retry: () => setAttempt(n => n + 1) };
}
export function useDebounce(value) { const [result, setResult] = useState(value); useEffect(() => { const timeout = setTimeout(() => setResult(value), 300); return () => clearTimeout(timeout); }, [value]); return result; }
export function Pagination({ data, page, setPage, loading }) {
  const total = data?.total || 0; const size = data?.pageSize || 20; const pages = Math.max(1, Math.ceil(total / size));
  useEffect(() => { if (!loading && page > pages) setPage(pages); }, [page, pages, loading, setPage]);
  return <div className="pagination"><span>共 {total} 条 · 第 {page} / {pages} 页</span><div><button className="btn btn-secondary btn-small" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft size={14} />上一页</button><button className="btn btn-secondary btn-small" disabled={loading || page >= pages} onClick={() => setPage(page + 1)}>下一页<ChevronRight size={14} /></button></div></div>;
}
export function Modal({ title, onClose, children, wide = false }) {
  const ref = useRef(null); const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const before = document.activeElement; const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; ref.current?.focus();
    const handler = e => { if (e.key === 'Escape') closeRef.current(); if (e.key === 'Tab') { const elements = ref.current?.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])'); if (!elements?.length) return; const first = elements[0], last = elements[elements.length - 1]; if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } } };
    document.addEventListener('keydown', handler); return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', handler); before?.focus?.(); };
  }, []);
  return <div className="modal-layer"><div className="drawer-backdrop" onClick={onClose} aria-hidden="true" /><section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`v2-modal ${wide ? 'modal-wide' : ''}`}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><X size={20} /></button></div>{children}</section></div>;
}
export function OwnerOptions({ members }) { return <>{members.map(m => <option key={m.id} value={m.id}>{m.name || m.login} (@{m.login}){m.module ? ` · ${m.module}` : ''}{m.status === 'pending_activation' ? ' · 待激活 / 不可达' : !m.reachable ? ' · 通知不可达' : ''}</option>)}</>; }
