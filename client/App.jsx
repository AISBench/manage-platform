import React, { useEffect, useState } from 'react';
import { Activity, ArrowRight, ArrowUpRight, Bell, BellRing, BookOpen, CalendarDays, Check, CheckCircle2, ChevronRight, Circle, CircleAlert, CircleDot, Clock3, GitBranch, Github, GitPullRequest, Inbox, LayoutDashboard, Link2, LoaderCircle, LogOut, Menu, MessageCircle, RefreshCw, Send, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Unlink, UserRound, Users, X } from 'lucide-react';
import { api, setCsrfToken } from './api.js';
import MembersScreen from './Members.jsx';
import TasksScreen, { TaskTable } from './Tasks.jsx';
import ItemDetail from './ItemDetail.jsx';
import { IntegrationScreen, AuditScreen } from './Operations.jsx';
import { isMine, pendingItem } from './ui.jsx';
import PublicPortal from './Public.jsx';
import RegistrationScreen from './Registration.jsx';
import { AccessPolicyScreen } from './AccessAdmin.jsx';
import { safeReturnTo } from './access.js';

const WORKFLOWS = {
  todo: { label: '待处理', icon: Circle, className: 'neutral' },
  in_progress: { label: '进行中', icon: Clock3, className: 'teal' },
  blocked: { label: '已阻塞', icon: CircleAlert, className: 'amber' },
  done: { label: '已完成', icon: CheckCircle2, className: 'green' },
};
const NAV = [
  { key: 'dashboard', label: '工作台', icon: LayoutDashboard },
  { key: 'tasks', label: '全部任务', icon: Inbox },
  { key: 'mine', label: '我的任务', icon: UserRound },
  { key: 'members', label: '团队成员', icon: Users, admin: true },
  { key: 'access-policy', label: '访问策略', icon: ShieldCheck, admin: true },
  { key: 'rules', label: '提醒规则', icon: SlidersHorizontal, admin: true },
  { key: 'notifications', label: '通知记录', icon: Bell },
  { key: 'integrations', label: '运行状态', icon: Activity, admin: true },
  { key: 'audit', label: '操作审计', icon: ShieldCheck, admin: true },
];

function useResource(path, revision = 0, enabled = true) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState(previous => ({ ...previous, error: null, loading: true }));
    api(path, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ data, error: null, loading: false });
    }).catch(error => {
      if (error.name !== 'AbortError' && !controller.signal.aborted) setState(previous => ({ ...previous, error, loading: false }));
    });
    return () => controller.abort();
  }, [path, revision, enabled, attempt]);
  return { ...state, retry: () => setAttempt(n => n + 1) };
}

function dateLabel(value, includeTime = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', ...(includeTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(date);
}
function relativeDate(value) {
  if (!value) return '暂无记录';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '—';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)} 天前`;
  return dateLabel(value);
}
function Avatar({ login, src, size = 'normal' }) {
  const [failed, setFailed] = useState(false);
  return <span className={`avatar avatar-${size}`} title={login || '未分配'}>{src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : (login || '?').slice(0, 2).toUpperCase()}</span>;
}
function Badge({ tone = 'neutral', children, className = '' }) { return <span className={`badge badge-${tone} ${className}`}>{children}</span>; }
function Spinner({ label = '加载中…', compact = false }) { return <div className={compact ? 'loading-inline' : 'loading-state'} role="status"><LoaderCircle size={compact ? 16 : 25} className="spin" /><span>{label}</span></div>; }
function ErrorBox({ error, retry, compact = false }) {
  return <div className={`error-box ${compact ? 'compact' : ''}`} role="alert"><CircleAlert size={19} /><div><strong>暂时无法完成请求</strong><p>{error?.message || String(error || '请稍后重试')}</p>{error?.status === 401 && <a href={`/join?${new URLSearchParams({ returnTo: safeReturnTo(window.location.pathname + window.location.search) })}`}>重新验证登录 <ArrowUpRight size={13} /></a>}</div>{retry && <button className="btn btn-small btn-secondary" onClick={retry}>重试</button>}</div>;
}
function EmptyState({ title = '这里还没有任务', text = '同步 GitHub 后，仓库中的 Issue 和 Pull Request 会显示在这里。', icon: Icon = Inbox, action }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={25} /></span><h3>{title}</h3><p>{text}</p>{action}</div>;
}
function SectionHeader({ eyebrow, title, description, action }) {
  return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action && <div className="heading-action">{action}</div>}</div>;
}

export default function App() {
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    api('/api/session', { signal: controller.signal }).then(data => {
      if (controller.signal.aborted) return;
      setCsrfToken(data.csrfToken); setSession(data); setLoading(false);
    }).catch(e => { if (e.name !== 'AbortError' && !controller.signal.aborted) { setError(e); setLoading(false); } });
    return () => controller.abort();
  }, [attempt]);
  if (loading) return <div className="boot-screen"><Brand /><Spinner label="正在连接协作空间…" /></div>;
  if (error) return <div className="boot-screen"><Brand /><div className="boot-error"><ErrorBox error={error} retry={() => setAttempt(n => n + 1)} /></div></div>;
  const refreshSession = () => setAttempt(n => n + 1);
  const path = window.location.pathname;
  // Mounting Workspace starts member API requests; never mount it on a public or restricted route.
  if (path === '/') return <PublicPortal session={session} onLogout={refreshSession} />;
  if (path === '/join' || path === '/join/status') return <RegistrationScreen session={session} onLogout={refreshSession} />;
  const detailMatch = path.match(/^\/workspace\/items\/([^/]+)$/);
  if (detailMatch) {
    if (session.mode !== 'member' || !session.user) return <RegistrationScreen session={session} onLogout={refreshSession} workspaceRequired />;
    return <div className="detail-standalone"><ItemDetail itemId={decodeURIComponent(detailMatch[1])} user={session.user} session={session} notify={() => {}} onBack={() => window.location.assign('/workspace')} /></div>;
  }
  if (path === '/workspace' || path === '/admin/access-policy') {
    if (session.mode !== 'member' || !session.user) return <RegistrationScreen session={session} onLogout={refreshSession} workspaceRequired />;
    if (path.startsWith('/admin/') && !session.user.isAdmin) return <div className="boot-screen"><Brand /><h2>此页面仅供管理员访问</h2><a className="btn btn-primary" href="/workspace">返回工作区</a><a className="text-button" href="/">公开概览</a></div>;
    return <Workspace session={session} setSession={setSession} onLogout={refreshSession} />;
  }
  return <div className="boot-screen"><Brand /><h2>页面不存在</h2><a className="btn btn-primary" href="/">返回公开概览</a></div>;
}
function Brand() { return <div className="brand"><span className="brand-mark"><GitBranch size={24} strokeWidth={2.6} /></span><span><strong>AISBench</strong><small>协作工作台</small></span></div>; }

function Workspace({ session, setSession, onLogout }) {
  const [view, setView] = useState(() => window.location.pathname === '/admin/access-policy' ? 'access-policy' : 'dashboard');
  const [taskFocus, setTaskFocus] = useState('');
  const [taskVisit, setTaskVisit] = useState(0);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [revision, setRevision] = useState(0);
  const openItem = item => window.location.assign(`/workspace/items/${encodeURIComponent(item.id)}`);
  const [toast, setToast] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const dashboard = useResource('/api/dashboard', revision);
  const user = session.user;
  const activeNav = NAV.find(n => n.key === view);
  const notify = (message, tone = 'success') => setToast({ message, tone, id: Date.now() });
  useEffect(() => { if (!toast) return; const timeout = setTimeout(() => setToast(null), 6000); return () => clearTimeout(timeout); }, [toast]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('auth') === 'success') notify(session.demo ? '演示模式不会绑定外部账号或发送消息。' : user.feishuBound && !user.feishuVerified ? '飞书已关联，仍需发送测试消息确认，才可恢复提醒。' : '授权流程已完成，状态已从服务端更新。');
    if (params.get('error')) notify(`授权未完成：${params.get('error').slice(0, 180)}`, 'error');
    if (params.has('auth') || params.has('error')) {
      params.delete('auth'); params.delete('error');
      window.history.replaceState({}, '', `${window.location.pathname}${params.size ? `?${params}` : ''}${window.location.hash}`);
    }
  }, []);
  useEffect(() => {
    if (!dashboard.data) return;
    const params = new URLSearchParams(window.location.search);
    const itemId = params.get('item');
    if (!itemId) return;
    const item = dashboard.data.items?.find(entry => entry.id === itemId);
    if (item) window.location.assign(`/workspace/items/${encodeURIComponent(item.id)}`); else notify('提醒中的事务暂未同步或已不可用，请在全部任务中查找。', 'error');
    params.delete('item');
    window.history.replaceState({}, '', `${window.location.pathname}${params.size ? `?${params}` : ''}${window.location.hash}`);
  }, [dashboard.data]);
  useEffect(() => {
    const pop = () => { setView(window.location.pathname === '/admin/access-policy' ? 'access-policy' : 'dashboard'); setMobileMenu(false); };
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, []);
  const navigate = (next, focus = '') => { setView(next); setTaskFocus(focus); setTaskVisit(n => n + 1); setMobileMenu(false); window.history.pushState({}, '', next === 'access-policy' ? '/admin/access-policy' : '/workspace'); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const refresh = () => setRevision(n => n + 1);
  async function sync() {
    setSyncing(true); setSyncError(null);
    try { const result = await api('/api/sync', { method: 'POST', body: {} }); refresh(); notify(session.demo ? `演示数据已刷新，共 ${result.count} 项；未访问 GitHub。` : `同步完成，已获取 ${result.count} 项任务。`); }
    catch (e) { setSyncError(e); }
    finally { setSyncing(false); }
  }
  async function logout() {
    setLoggingOut(true);
    try { await api('/auth/logout', { method: 'POST', body: {} }); onLogout(); }
    catch (e) { notify(e.message, 'error'); setLoggingOut(false); }
  }
  return <div className="app-shell">
    {mobileMenu && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setMobileMenu(false)} />}
    <aside className={`sidebar ${mobileMenu ? 'is-open' : ''}`}><div className="sidebar-brand"><Brand /><button className="icon-button mobile-close" aria-label="关闭导航" onClick={() => setMobileMenu(false)}><X size={20} /></button></div>
      <div className="workspace-switch"><span className="repo-icon"><Github size={20} /></span><div><strong>AISBench</strong><small>{session.repo || 'AISBench/benchmark'}</small></div><span className="workspace-live" title="当前仓库" /></div>
      <div className="nav-label">工作空间</div><nav className="main-nav" aria-label="主导航">{NAV.filter(n => !n.admin || user.isAdmin).map(({ key, label, icon: Icon }) => <button key={key} className={`nav-item ${view === key ? 'active' : ''}`} onClick={() => navigate(key)} aria-label={label} aria-current={view === key ? 'page' : undefined}><Icon size={19} /><span>{label}</span>{key === 'mine' && dashboard.data?.stats?.myTasks > 0 && <span className="nav-count">{dashboard.data.stats.myTasks}</span>}{view === key && <span className="nav-active-dot" />}</button>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><span className="sidebar-note-icon"><Sparkles size={17} /></span><strong>代码之外，协作之内</strong><p>在这里管理本地工作流，<br />GitHub 状态始终保持独立。</p><a href={`https://github.com/${session.repo || 'AISBench/benchmark'}`} target="_blank" rel="noreferrer">前往 GitHub 仓库 <ArrowUpRight size={14} /></a></div><button className={`nav-item settings-nav ${view === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}><Settings2 size={19} /><span>个人设置与绑定</span></button><div className="user-profile"><Avatar login={user.login} src={user.avatarUrl} /><div><strong>{user.name || user.login}</strong><small><span className="tiny-dot" />{user.isAdmin ? '空间管理员' : '团队成员'}</small></div><button className="icon-button logout-button" title="退出登录" aria-label="退出登录" onClick={logout} disabled={loggingOut}>{loggingOut ? <LoaderCircle size={17} className="spin" /> : <LogOut size={17} />}</button></div></div>
    </aside>
    <div className="workspace-main"><header className="topbar"><div className="breadcrumbs"><button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setMobileMenu(true)}><Menu size={21} /></button><span className="breadcrumb-root">工作空间</span><ChevronRight size={14} /><strong>{activeNav?.label || '个人设置与绑定'}</strong></div><div className="topbar-right"><a className="text-button workspace-public-link" href="/">公开门户<ArrowUpRight size={13} /></a>{session.demo && <Badge tone="amber"><span className="tiny-dot" />演示模式</Badge>}<span className="topbar-repo"><Github size={15} />{session.repo || 'AISBench/benchmark'}</span><span className="topbar-divider" /><button className="icon-button notification-button" title="通知记录" aria-label="查看通知记录" onClick={() => navigate('notifications')}><Bell size={20} /></button><Avatar login={user.login} src={user.avatarUrl} size="small" /></div></header>
      <main className="main-content" id="main-content">
        {session.demo && <div className="demo-banner"><span className="demo-banner-icon"><Sparkles size={16} /></span><p><strong>正在体验演示工作空间</strong><span>所有更改仅保存在本地，不会修改 GitHub，也不会发送飞书消息。</span></p><Badge tone="neutral">DEMO</Badge></div>}
        {syncError && <div className="global-error"><ErrorBox compact error={syncError} retry={sync} /><button className="icon-button" aria-label="关闭错误提示" onClick={() => setSyncError(null)}><X size={17} /></button></div>}
        {view === 'dashboard' && <Dashboard resource={dashboard} user={user} session={session} onOpen={openItem} onNavigate={navigate} onSync={sync} syncing={syncing} />}
        {(view === 'tasks' || view === 'mine') && <TasksScreen key={`${view}:${taskVisit}`} mine={view === 'mine'} revision={revision} onOpen={openItem} onSync={sync} syncing={syncing} user={user} initialFocus={taskFocus} onChanged={refresh} notify={notify} />}
        {view === 'members' && user.isAdmin && <MembersScreen revision={revision} notify={notify} onChanged={refresh} />}
        {view === 'access-policy' && user.isAdmin && <AccessPolicyScreen revision={revision} notify={notify} onChanged={refresh} />}
        {view === 'integrations' && user.isAdmin && <IntegrationScreen revision={revision} />}
        {view === 'audit' && user.isAdmin && <AuditScreen revision={revision} />}
        {view === 'rules' && user.isAdmin && <RulesScreen revision={revision} demo={session.demo} notify={notify} />}
        {view === 'notifications' && <NotificationsScreen revision={revision} isAdmin={user.isAdmin} />}
        {view === 'settings' && <SettingsScreen session={session} onUserChange={updated => setSession(previous => ({ ...previous, user: updated }))} notify={notify} />}
        <footer className="content-footer"><span><span className="tiny-dot" />AISBench 协作工作台</span><span>本地工作流 · GitHub 是代码状态的唯一来源</span></footer>
      </main>
    </div>
    {toast && <div className={`toast toast-${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>{toast.tone === 'error' ? <CircleAlert size={19} /> : <CheckCircle2 size={19} />}<span>{toast.message}</span><button className="icon-button" aria-label="关闭消息" onClick={() => setToast(null)}><X size={16} /></button></div>}
  </div>;
}

function SyncButton({ onSync, syncing, isAdmin }) {
  if (!isAdmin) return null;
  return <button className="btn btn-primary" onClick={onSync} disabled={syncing}><RefreshCw size={16} className={syncing ? 'spin' : ''} />{syncing ? '正在同步…' : '同步 GitHub'}</button>;
}
function Dashboard({ resource, user, session, onOpen, onNavigate, onSync, syncing }) {
  const [tab, setTab] = useState('all');
  const { data, error, loading, retry } = resource;
  const date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  const items = data?.items || [];
  const filtered = tab === 'mine' ? items.filter(item => isMine(item, user) && pendingItem(item)) : tab === 'overdue' ? items.filter(item => item.overdue) : tab === 'unassigned' ? items.filter(item => !item.ownerMemberId) : tab === 'ownerIssue' ? items.filter(item => item.ownerIssue) : tab === 'needsReview' ? items.filter(item => item.needsReview) : items;
  return <>
    <SectionHeader eyebrow={<><span className="status-dot" /> TEAM OVERVIEW</>} title="让协作，有条不紊。" description={`你好，${user.name || user.login}。这里是你的团队协作概览。`} action={<><span className="today-label"><CalendarDays size={15} />{date}</span><SyncButton onSync={onSync} syncing={syncing} isAdmin={user.isAdmin} /></>} />
    {error ? <ErrorBox error={error} retry={retry} /> : loading && !data ? <DashboardSkeleton /> : data && <>
      {data.syncError && <div className="notice notice-warning"><CircleAlert size={17} /><span><strong>最近一次同步未完成</strong> · {data.syncError}。当前展示已保存的数据。</span></div>}
      <div className="stats-grid">
        <StatCard label="待处理 Issue" value={data.stats.openIssues} icon={CircleDot} tone="teal" description="GitHub · Open issues" onClick={() => onNavigate('tasks')} />
        <StatCard label="开放的 Pull Request" value={data.stats.openPRs} icon={GitPullRequest} tone="purple" description="GitHub · Open pull requests" onClick={() => onNavigate('tasks')} />
        <StatCard label="已逾期任务" value={data.stats.overdue} icon={Clock3} tone="amber" description="需要团队优先关注" onClick={() => setTab('overdue')} />
        <StatCard label="与我相关" value={data.stats.myTasks} icon={UserRound} tone="blue" description="固定身份关联 · 开放且未完成" onClick={() => onNavigate('mine')} />
      </div>
      <div className="attention-grid"><button className="attention-card" onClick={() => onNavigate('tasks', 'unassigned')}><UserRound size={18} /><span>待分派</span><strong>{data.stats.unassigned ?? '—'}</strong><ArrowRight size={15} /></button><button className="attention-card" onClick={() => onNavigate('tasks', 'ownerIssue')}><CircleAlert size={18} /><span>责任异常</span><strong>{data.stats.ownerIssues ?? '—'}</strong><ArrowRight size={15} /></button><button className="attention-card" onClick={() => onNavigate('tasks', 'needsReview')}><RefreshCw size={18} /><span>需复核</span><strong>{data.stats.needsReview ?? '—'}</strong><ArrowRight size={15} /></button><button className="attention-card" onClick={() => onNavigate('tasks')}><MessageCircle size={18} /><span>未读消息</span><strong>{data.stats.unreadMessages ?? '—'}</strong><ArrowRight size={15} /></button><button className="attention-card" onClick={() => onNavigate('tasks')}><BellRing size={18} /><span>@我</span><strong>{data.stats.mentions ?? '—'}</strong><ArrowRight size={15} /></button></div>
      <div className="dashboard-grid"><div className="dashboard-primary">
        <section className="panel task-panel"><div className="panel-title-row"><div><h2>任务速览 <span className="section-count">{items.length}</span></h2><p>把注意力，留给最重要的事。</p></div><button className="text-button" onClick={() => onNavigate('tasks')}>查看全部<ArrowRight size={15} /></button></div><div className="dashboard-tabs"><div className="tab-group" role="tablist" aria-label="任务速览筛选">{[{ key: 'all', label: '最近任务' }, { key: 'mine', label: '我的待办' }, { key: 'overdue', label: '已逾期' }, { key: 'unassigned', label: '待分派' }, { key: 'ownerIssue', label: '责任异常' }, { key: 'needsReview', label: '需复核' }].map(t => <button role="tab" aria-selected={tab === t.key} key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>{t.label}{t.key === 'overdue' && data.stats.overdue > 0 && <span className="tab-count">{data.stats.overdue}</span>}</button>)}</div><span className="table-hint">点击任务查看详情<ArrowUpRight size={12} /></span></div><TaskTable items={filtered.slice(0, 7)} onOpen={onOpen} compact emptyText={tab === 'overdue' ? '很棒，当前列表中没有逾期任务。' : tab === 'mine' ? '当前速览没有与你相关的任务，可前往“我的任务”查看完整列表。' : undefined} />{filtered.length > 7 && <button className="panel-bottom-action" onClick={() => onNavigate(tab === 'mine' ? 'mine' : 'tasks', ['unassigned', 'ownerIssue', 'needsReview', 'overdue'].includes(tab) ? tab : '')}>查看完整任务列表<ArrowRight size={14} /></button>}</section>
        <section className="panel activity-panel"><div className="panel-title-row"><div><h2><Activity size={17} />最近动态</h2><p>工作流的每一次推进，都有迹可循。</p></div><Badge>本地活动</Badge></div>{data.activity?.length ? <div className="activity-list">{data.activity.slice(0, 5).map((activity, index) => <div className="activity-item" key={activity.id}><span className={`activity-node ${index === 0 ? 'latest' : ''}`}><Check size={12} /></span><div><strong>{activity.title}</strong>{activity.detail && <p>{activity.detail}</p>}</div><time dateTime={activity.createdAt}>{relativeDate(activity.createdAt)}</time></div>)}</div> : <div className="quiet-empty"><Activity size={21} /><p>尚无活动记录。更新任务工作流后，动态将显示在这里。</p></div>}</section>
      </div><aside className="dashboard-secondary">
        <section className="panel repo-panel"><div className="repo-panel-top"><span className="repo-symbol"><Github size={25} /></span><Badge tone={session.demo || !data.lastSync || data.syncError ? 'amber' : 'teal'}><span className="tiny-dot" />{session.demo ? '本地演示数据' : data.syncError ? '同步异常' : data.lastSync ? '已同步快照' : '尚未同步'}</Badge></div><h2>{session.repo?.split('/').pop() || 'benchmark'}</h2><p>{session.repo || 'AISBench/benchmark'}</p><div className="repo-separator" /><div className="repo-detail"><span>数据来源</span><strong>{session.demo ? '本地演示数据' : 'GitHub API'}</strong></div><div className="repo-detail"><span>最近同步</span><strong title={data.lastSync ? new Date(data.lastSync).toLocaleString('zh-CN') : ''}>{data.lastSync ? relativeDate(data.lastSync) : '尚未同步'}</strong></div><a className="repo-link" href={`https://github.com/${session.repo || 'AISBench/benchmark'}`} target="_blank" rel="noreferrer">打开 GitHub 仓库<ArrowUpRight size={15} /></a></section>
        <WorkflowSummary items={items} />
        <section className="feishu-promo"><span className="promo-icon"><Send size={19} /></span><h3>{session.demo ? '演示不发送真实提醒' : user.feishuVerified ? '通知通道，已测试确认' : user.feishuBound ? '已关联，还差一步确认' : '让提醒，主动找到你'}</h3><p>{session.demo ? '本地数据用于体验成员和任务管理，不连接真实 GitHub 或飞书，也不会完成真实绑定。' : user.feishuVerified ? '飞书已完成自测，实际提醒仍受通知偏好、规则和应用权限限制。' : user.feishuBound ? 'OAuth 关联尚未验证，请前往个人设置发送测试消息确认绑定。' : '由本人授权绑定飞书，并发送测试消息确认后，才能接收任务提醒。'}</p><button className="promo-link" onClick={() => onNavigate('settings')}>{user.feishuBound ? '管理通知偏好' : '连接飞书账号'}<ArrowRight size={14} /></button><span className="promo-decoration" aria-hidden="true"><Send size={76} /></span></section>
      </aside></div>
    </>}
  </>;
}
function StatCard({ label, value, icon: Icon, tone, description, onClick }) { return <button className={`stat-card stat-${tone}`} onClick={onClick}><div className="stat-top"><span>{label}</span><span className="stat-icon"><Icon size={19} /></span></div><div className="stat-value">{value ?? '—'}<ArrowUpRight size={19} /></div><div className="stat-bottom"><span className="tiny-dot" />{description}</div></button>; }
function DashboardSkeleton() { return <div role="status" aria-label="正在加载工作台"><div className="stats-grid">{[1, 2, 3, 4].map(i => <div key={i} className="stat-card skeleton-stat"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>)}</div><div className="panel skeleton-panel"><Spinner label="正在获取仓库与任务数据…" /></div></div>; }
function WorkflowSummary({ items }) {
  const total = items.length;
  return <section className="panel workflow-summary"><div className="panel-title-row"><div><h2>本地工作流</h2><p>当前速览的 {total} 项任务</p></div><span className="section-icon"><GitBranch size={17} /></span></div><div className="workflow-bar" aria-hidden="true">{Object.entries(WORKFLOWS).map(([key, value]) => <span key={key} className={`segment-${value.className}`} style={{ width: total ? `${items.filter(i => i.workflow === key).length / total * 100}%` : 0 }} />)}</div><div className="workflow-legend">{Object.entries(WORKFLOWS).map(([key, value]) => <div key={key}><span className={`legend-dot legend-${value.className}`} /><span>{value.label}</span><strong>{items.filter(i => i.workflow === key).length}</strong></div>)}</div><p className="workflow-note"><BookOpen size={13} />独立于 GitHub 的 open / closed 状态</p></section>;
}

function RulesScreen({ revision, demo, notify }) {
  const resource = useResource('/api/rules', revision);
  const [rules, setRules] = useState(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [runResult, setRunResult] = useState(null);
  useEffect(() => { if (resource.data?.rules) setRules(resource.data.rules); }, [resource.data]);
  const canEdit = resource.data?.isAdmin === true;
  async function save(e) {
    e.preventDefault(); setSaving(true); setError(null);
    try { const result = await api('/api/rules', { method: 'PUT', body: { enabled: rules.enabled, staleHours: Number(rules.staleHours), reminderCooldownHours: Number(rules.reminderCooldownHours) } }); setRules(result.rules); notify('提醒规则已保存。'); }
    catch (e) { setError(e); } finally { setSaving(false); }
  }
  async function run() {
    setRunning(true); setError(null); setRunResult(null);
    try { const result = await api('/api/reminders/run', { method: 'POST', body: {} }); setRunResult(result); notify(demo ? '检查完成；演示模式不会发送外部通知。' : '提醒检查已完成。'); }
    catch (e) { setError(e); } finally { setRunning(false); }
  }
  return <><SectionHeader eyebrow="AUTOMATION" title="提醒规则" description="为需要关注的协作设置提醒，让团队保持同频。" action={<Badge tone="teal"><ShieldCheck size={13} />管理员配置</Badge>} />{resource.error ? <ErrorBox error={resource.error} retry={resource.retry} /> : resource.loading || !rules ? <Spinner label="正在加载提醒规则…" /> : <div className="settings-grid"><section className="panel settings-panel"><div className="panel-title-row"><div><h2><BellRing size={18} />自动提醒</h2><p>配置任务检查与消息提醒的全局规则</p></div></div><form onSubmit={save}><div className="settings-form-body"><div className="preference-row"><div><strong>启用任务提醒</strong><p>符合规则的任务将进入提醒检查流程</p></div><Toggle checked={rules.enabled} disabled={!canEdit || saving} onChange={enabled => setRules({ ...rules, enabled })} label="启用任务提醒" /></div><div className="form-field"><label htmlFor="stale-hours">任务静默阈值 <span>小时</span></label><input id="stale-hours" type="number" min="1" max="8760" required value={rules.staleHours} disabled={!canEdit || saving} onChange={e => setRules({ ...rules, staleHours: e.target.value })} /><small>超过此时长未更新的任务，将纳入提醒判断。</small></div><div className="form-field"><label htmlFor="cooldown-hours">提醒冷却时间 <span>小时</span></label><input id="cooldown-hours" type="number" min="1" max="720" required value={rules.reminderCooldownHours} disabled={!canEdit || saving} onChange={e => setRules({ ...rules, reminderCooldownHours: e.target.value })} /><small>同一任务的提醒至少间隔此时长，避免重复打扰。</small></div>{error && <ErrorBox compact error={error} />}{!canEdit && <div className="notice notice-warning"><ShieldCheck size={16} />当前账号没有修改规则的权限。</div>}</div><div className="form-footer"><span>更改仅对后续提醒检查生效</span><button className="btn btn-primary" type="submit" disabled={saving || !canEdit}>{saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{saving ? '保存中…' : '保存规则'}</button></div></form></section><aside className="settings-aside"><section className="panel manual-check"><span className="aside-icon"><RefreshCw size={21} /></span><h3>立即检查一次</h3><p>使用已保存的规则检查任务，并向符合条件、已绑定飞书的成员发送提醒。</p>{demo && <div className="notice notice-info"><Sparkles size={15} />演示模式只检查本地数据，不发送消息。</div>}<button className="btn btn-secondary full-width" onClick={run} disabled={running || saving || !canEdit}><RefreshCw size={15} className={running ? 'spin' : ''} />{running ? '正在检查…' : '运行提醒检查'}</button>{runResult && <div className="run-results" role="status">{[['queued', '进入队列'], ['delivered', '已送达'], ['failed', '失败'], ['skipped', '已跳过']].map(([key, label]) => <div key={key}><span>{label}</span><strong>{runResult[key]}</strong></div>)}</div>}</section><div className="context-note"><ShieldCheck size={17} /><div><strong>尊重每位成员的通知偏好</strong><p>提醒会遵循个人通知开关与免打扰设置。发送结果可在“通知记录”中查看。</p></div></div></aside></div>}</>;
}
function Toggle({ checked, onChange, label, disabled }) { return <button type="button" className={`toggle ${checked ? 'checked' : ''}`} role="switch" aria-checked={Boolean(checked)} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>; }

function NotificationsScreen({ revision, isAdmin }) {
  const resource = useResource('/api/notifications', revision);
  const [filter, setFilter] = useState('all');
  const all = resource.data?.notifications || [];
  const notifications = filter === 'all' ? all : all.filter(n => ['failed', 'error'].includes(n.status));
  const statusInfo = status => ({ delivered: ['green', '已送达'], sent: ['green', '已发送'], failed: ['red', '发送失败'], error: ['red', '错误'], queued: ['blue', '等待发送'], pending: ['blue', '等待发送'], sending: ['blue', '发送中'], cancelled: ['neutral', '已取消'], skipped: ['neutral', '已跳过'], demo: ['amber', '演示跳过'] }[status] || ['neutral', status || '未知']);
  return <><SectionHeader eyebrow="NOTIFICATION CENTER" title="通知记录" description={isAdmin ? '查看团队的提醒发送结果，及时发现未送达的消息。' : '查看发送给你的任务提醒与送达状态。'} action={<button className="btn btn-secondary" onClick={resource.retry} disabled={resource.loading}><RefreshCw size={15} className={resource.loading ? 'spin' : ''} />刷新记录</button>} /><section className="panel"><div className="notification-toolbar"><div className="tab-group" role="tablist" aria-label="通知筛选"><button role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部记录<span className="tab-count">{all.length}</span></button><button role="tab" aria-selected={filter === 'failed'} className={filter === 'failed' ? 'active' : ''} onClick={() => setFilter('failed')}>发送失败</button></div><Badge>{isAdmin ? '团队全部通知' : '仅我的通知'}</Badge></div>{resource.error ? <ErrorBox error={resource.error} retry={resource.retry} /> : resource.loading ? <Spinner label="正在加载通知记录…" /> : notifications.length ? <div className="notification-list">{notifications.map(notification => { const [tone, label] = statusInfo(notification.status); return <article className="notification-item" key={notification.id}><span className={`notification-icon notification-${tone}`}>{tone === 'red' ? <CircleAlert size={19} /> : <Bell size={19} />}</span><div className="notification-body"><div className="notification-title"><h3>{notification.title}</h3><Badge tone={tone}>{label}</Badge></div><p><UserRound size={12} />{notification.recipient || '未指定接收人'}<span>·</span><time dateTime={notification.createdAt}>{dateLabel(notification.createdAt, true)}</time></p>{notification.reason && <div className="notification-reason">{notification.reason}</div>}{(notification.error || notification.errorCode) && <div className="notification-error"><CircleAlert size={13} />{notification.error || notification.errorCode}</div>}{(notification.attempts > 0 || notification.nextAt > 0) && <div className="notification-reason">尝试 {notification.attempts || 0} 次{notification.nextAt ? ` · 下次检查 ${new Date(notification.nextAt).toLocaleString('zh-CN')}` : ''}</div>}</div></article>; })}</div> : <EmptyState icon={Bell} title={filter === 'failed' ? '没有失败的通知' : '暂时没有通知记录'} text={filter === 'failed' ? '当前没有记录到发送失败的通知。' : '任务提醒运行后，可以在这里查看送达状态与跳过原因。'} />}</section></>;
}

function SettingsScreen({ session, onUserChange, notify }) {
  const user = session.user;
  const [prefs, setPrefs] = useState({ notificationsEnabled: Boolean(user.notificationsEnabled), quietStart: user.quietStart || '', quietEnd: user.quietEnd || '' });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [unbinding, setUnbinding] = useState(false);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [githubBusy, setGithubBusy] = useState(false);
  const [error, setError] = useState(null);
  const [bindingError, setBindingError] = useState(null);
  const [testResult, setTestResult] = useState(null);
  async function save(e) {
    e.preventDefault(); setError(null);
    if (Boolean(prefs.quietStart) !== Boolean(prefs.quietEnd)) { setError(new Error('请同时填写免打扰开始与结束时间，或同时留空。')); return; }
    setSaving(true);
    try { const result = await api('/api/preferences', { method: 'PATCH', body: prefs }); onUserChange(result.user); notify('个人通知偏好已保存。'); }
    catch (e) { setError(e); } finally { setSaving(false); }
  }
  async function test() {
    setTesting(true); setBindingError(null); setTestResult(null);
    try { const result = await api('/api/feishu/test', { method: 'POST', body: {} }); setTestResult(result); if (!session.demo && !result.demo && result.sent) { const latest = await api('/api/session'); setCsrfToken(latest.csrfToken); if (latest.user) onUserChange(latest.user); } notify(result.demo || session.demo ? '演示模式：未发送飞书消息，未验证任何真实绑定。' : result.sent ? '测试消息已发送；绑定状态已重新读取，请在飞书中确认收信。' : '未发送测试消息，请检查绑定与应用配置。', result.sent && !session.demo ? 'success' : 'error'); }
    catch (e) { setBindingError(e); } finally { setTesting(false); }
  }
  async function unbind() {
    setUnbinding(true); setBindingError(null);
    try { await api('/api/feishu/binding', { method: 'DELETE', body: {} }); onUserChange({ ...user, feishuBound: false, feishuVerified: false }); setConfirmUnbind(false); setTestResult(null); notify('已解除飞书绑定。'); }
    catch (e) { setBindingError(e); } finally { setUnbinding(false); }
  }
  async function revokeGithub() {
    setGithubBusy(true); setBindingError(null);
    try { await api('/api/github/authorization/revoke', { method: 'POST', body: {} }); onUserChange({ ...user, githubWriteReady: false, githubWriteScopes: '' }); notify('已撤销 GitHub 评论写入授权。'); }
    catch (e) { setBindingError(e); } finally { setGithubBusy(false); }
  }
  return <><SectionHeader eyebrow="PERSONAL PREFERENCES" title="个人设置与绑定" description="连接你的账号，用适合自己的节奏接收协作提醒。" /><div className="settings-grid"><div className="settings-primary"><section className="panel settings-panel profile-card"><div className="panel-title-row"><div><h2><Github size={18} />GitHub 账号</h2><p>用于登录工作空间及识别任务权限</p></div><Badge tone="teal"><CheckCircle2 size={12} />已连接</Badge></div><div className="profile-account"><Avatar login={user.login} src={user.avatarUrl} size="large" /><div><strong>{user.name || user.login}</strong><a href={`https://github.com/${encodeURIComponent(user.login)}`} target="_blank" rel="noreferrer">@{user.login}<ArrowUpRight size={13} /></a></div><Badge>{user.isAdmin ? '管理员' : '成员'}</Badge></div><div className="settings-inline-note"><ShieldCheck size={15} />{session.demo ? <span>演示模式：发送到 GitHub 的评论仅保存在本地，不会写回仓库。</span> : user.githubWriteReady ? <><span>GitHub 评论写权限已授权（{user.githubWriteScopes || 'public_repo'}）。</span><button className="text-button danger-text" onClick={revokeGithub} disabled={githubBusy}>{githubBusy ? '撤销中…' : '撤销授权'}</button></> : <><span>尚未授权 GitHub 评论写权限，无法以本人身份在 Issue/PR 中发言。</span><a className="text-button" href={`/auth/github?${new URLSearchParams({ returnTo: '/workspace' })}`}>立即授权</a></>}</div></section>
      <section className="panel settings-panel feishu-settings"><div className="panel-title-row"><div><h2><Send size={18} />飞书账号绑定</h2><p>通过官方 OAuth 授权，安全连接个人飞书账号</p></div><Badge tone={user.feishuVerified ? 'teal' : user.feishuBound ? 'amber' : 'neutral'}>{user.feishuVerified ? <CheckCircle2 size={12} /> : <Link2 size={12} />}{user.feishuVerified ? '已绑定 · 已验证' : user.feishuBound ? '已关联 · 待测试确认' : '未绑定'}</Badge></div><div className="binding-content"><span className="feishu-brand"><Send size={28} /></span><div><h3>{user.feishuVerified ? '飞书绑定已完成测试确认' : user.feishuBound ? '已关联，仍需本人测试确认' : '把重要的提醒，送到飞书'}</h3><p>{user.feishuVerified ? '绑定通道已验证；实际发送仍需通知偏好、全局规则和应用权限允许。' : user.feishuBound ? 'OAuth 关联不等于可接收通知。请发送测试消息完成确认；重新启用或重绑后必须再次测试。' : '本人完成 OAuth 关联后，还需发送测试消息确认。无需填写任何飞书 ID 或凭据。'}</p></div></div>{!session.feishuConfigured && <div className="settings-inline-note"><CircleAlert size={15} />{session.demo ? '演示模式不发起飞书授权或发送外部消息。' : '飞书应用尚未配置，请联系管理员。'}</div>}{bindingError && <div className="settings-inline-error"><ErrorBox compact error={bindingError} /></div>}{testResult && <div className="settings-inline-note test-result" role="status"><CheckCircle2 size={15} />{testResult.demo || session.demo ? '演示检查未发送消息，也未验证任何真实绑定。' : testResult.sent ? '测试消息已发送；以服务端重新读取的绑定状态为准，请检查飞书。' : '消息未发送，绑定未验证，请检查通知配置。'}</div>}<div className="binding-actions">{user.feishuBound ? <><button className="btn btn-secondary" onClick={test} disabled={testing || unbinding}>{testing ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}{testing ? '检查中…' : session.demo ? '演示检查（不发送）' : user.feishuVerified ? '发送测试消息' : '发送测试并确认绑定'}</button><button className="text-button danger-text" onClick={() => setConfirmUnbind(true)} disabled={unbinding || testing}><Unlink size={14} />解除绑定</button></> : session.feishuConfigured && !session.demo ? <a className="btn btn-primary" href="/auth/feishu/bind"><Link2 size={16} />授权绑定飞书<ArrowUpRight size={15} /></a> : <button className="btn btn-secondary" disabled><Link2 size={16} />{session.demo ? '演示模式不连接外部账号' : '等待管理员配置飞书'}</button>}</div>{confirmUnbind && <div className="confirm-unbind" role="alert"><div><strong>确定解除飞书绑定？</strong><p>解绑后，将无法通过飞书接收新的任务提醒。</p></div><div><button className="btn btn-secondary btn-small" onClick={() => setConfirmUnbind(false)} disabled={unbinding}>取消</button><button className="btn btn-danger btn-small" onClick={unbind} disabled={unbinding}>{unbinding ? '解绑中…' : '确认解绑'}</button></div></div>}</section>
      <section className="panel settings-panel"><div className="panel-title-row"><div><h2><BellRing size={18} />通知偏好</h2><p>更少打扰，更有重点</p></div></div><form onSubmit={save}><div className="settings-form-body"><div className="preference-row"><div><strong>接收任务提醒</strong><p>允许向已绑定的飞书账号发送协作提醒</p></div><Toggle checked={prefs.notificationsEnabled} onChange={notificationsEnabled => setPrefs({ ...prefs, notificationsEnabled })} disabled={saving} label="接收任务提醒" /></div><div className="quiet-hours-heading"><div><strong><Clock3 size={16} />免打扰时段</strong><p>使用 Asia/Shanghai（北京时间）；留空不启用，支持跨午夜，例如 22:00 至 08:00。</p></div><button type="button" className="text-button" onClick={() => setPrefs({ ...prefs, quietStart: '', quietEnd: '' })} disabled={saving || (!prefs.quietStart && !prefs.quietEnd)}>清空</button></div>{prefs.quietStart && prefs.quietStart === prefs.quietEnd && <div className="notice notice-warning"><CircleAlert size={15} />开始与结束时间相同，按未启用免打扰处理。</div>}<div className="quiet-hours"><label className="form-field"><span>开始时间</span><input aria-label="免打扰开始时间" type="time" value={prefs.quietStart} onChange={e => setPrefs({ ...prefs, quietStart: e.target.value })} disabled={saving} /></label><span className="quiet-hours-separator">至</span><label className="form-field"><span>结束时间</span><input aria-label="免打扰结束时间" type="time" value={prefs.quietEnd} onChange={e => setPrefs({ ...prefs, quietEnd: e.target.value })} disabled={saving} /></label></div>{error && <ErrorBox compact error={error} />}</div><div className="form-footer"><span>偏好仅适用于当前账号</span><button className="btn btn-primary" type="submit" disabled={saving}>{saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{saving ? '保存中…' : '保存偏好'}</button></div></form></section>
    </div><aside className="settings-aside"><section className="panel privacy-card"><span className="aside-icon"><ShieldCheck size={22} /></span><h3>安全，始终在先</h3><p>GitHub 与飞书通过服务端 OAuth 完成授权。页面不会接触或保存应用密钥。</p><ul><li><Check size={14} />绑定操作仅适用于本人</li><li><Check size={14} />可随时关闭提醒或解除绑定</li><li><Check size={14} />工作流编辑不会修改 GitHub</li></ul></section><div className="context-note"><MessageCircle size={18} /><div><strong>没有收到提醒？</strong><p>先检查飞书是否已绑定且测试验证、通知是否开启，以及是否处于免打扰时段。管理员可通过通知记录排查具体原因。</p></div></div></aside></div></>;
}
