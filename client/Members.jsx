import React, { useState } from 'react';
import { ArrowUpRight, Check, LoaderCircle, Search, ShieldCheck } from 'lucide-react';
import { api } from './api.js';
import { Avatar, Badge, BindingStatus, Empty, ErrorBox, Heading, MemberStatus, Modal, Pagination, Spinner, date, useDebounce, useResource } from './ui.jsx';

export default function MembersScreen({ revision, notify, onChanged }) {
  const [query, setQuery] = useState(''); const q = useDebounce(query);
  const [filters, setFilters] = useState({ status: '', role: '', module: '', bound: '' });
  const [page, setPage] = useState(1); const [localRevision, setRevision] = useState(0);
  const [editing, setEditing] = useState(null); const [statusTarget, setStatusTarget] = useState(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(null);
  const params = new URLSearchParams({ q, ...filters, page: String(page), pageSize: '20' });
  const resource = useResource(`/api/admin/members?${params}`, `${revision}:${localRevision}`);
  const refresh = () => { setRevision(n => n + 1); onChanged?.(); };
  function filter(key, value) { setFilters(old => ({ ...old, [key]: value })); setPage(1); }
  async function changeStatus() {
    setBusy(true); setError(null);
    const enabled = statusTarget.status === 'disabled';
    try { await api(`/api/admin/members/${encodeURIComponent(statusTarget.id)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST', body: { version: statusTarget.version } }); setStatusTarget(null); refresh(); notify(enabled ? '成员已重新启用；飞书仍需本人测试确认。' : '成员已停用，历史分派保留，待发通知已取消。'); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return <><Heading eyebrow="PEOPLE & COLLABORATION" title="团队成员" description="成员首次 GitHub 登录时自动创建账号；管理员可编辑资料、调整角色或停用。" />
    <section className="panel"><div className="panel-title-row"><div><h2>成员目录 <span className="section-count">{resource.data?.total ?? '—'}</span></h2><p>团队资料、准入角色与通知可达性</p></div><Badge tone="teal"><ShieldCheck size={13} />管理员</Badge></div>
      <div className="filter-bar v2-filter"><label className="search-input"><Search size={16} /><input placeholder="搜索 GitHub、团队姓名…" aria-label="搜索成员" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} /></label><div className="filter-selects"><select aria-label="成员状态" value={filters.status} onChange={e => filter('status', e.target.value)}><option value="">全部状态</option><option value="pending_activation">待激活</option><option value="active">正常</option><option value="disabled">已停用</option></select><select aria-label="成员角色" value={filters.role} onChange={e => filter('role', e.target.value)}><option value="">全部角色</option><option value="admin">管理员</option><option value="member">成员</option></select><input className="module-filter" placeholder="负责模块" aria-label="成员模块筛选" value={filters.module} onChange={e => filter('module', e.target.value)} /><select aria-label="飞书绑定筛选" value={filters.bound} onChange={e => filter('bound', e.target.value)}><option value="">全部绑定情况</option><option value="true">已绑定</option><option value="false">未绑定</option></select></div></div>
      {resource.error ? <ErrorBox error={resource.error} retry={resource.retry} /> : resource.loading ? <Spinner label="正在获取成员目录…" /> : resource.data?.members?.length ? <div className="table-scroll"><table className="members-table v2-members"><thead><tr><th>成员 / GitHub 身份</th><th>角色 / 模块</th><th>准入状态</th><th>飞书 / 可达性</th><th>操作</th></tr></thead><tbody>{resource.data.members.map(member => <tr key={member.id}><td><div className="member-name"><Avatar login={member.login} src={member.avatarUrl} /><div><strong>{member.displayName || member.name || member.login}</strong><a className="member-sub external-text-link" href={`https://github.com/${encodeURIComponent(member.login)}`} target="_blank" rel="noreferrer">@{member.login}<ArrowUpRight size={12} /></a><small className="member-sub">GitHub ID: {member.githubId}</small></div></div></td><td><Badge>{member.role === 'admin' ? '管理员' : '成员'}</Badge><small className="member-sub">{member.module || '未设置模块'}</small></td><td><MemberStatus status={member.status} /><small className="member-sub">{member.firstLoginAt ? `最近登录 ${date(member.lastLoginAt)}` : '尚未首次登录'}</small></td><td><BindingStatus member={member} /><small className={`member-sub ${member.reachable ? 'reachable' : 'muted'}`}>{member.reachable ? '可接收个人提醒' : member.status === 'disabled' ? '已停用 · 不可达' : member.status === 'pending_activation' ? '待激活 · 不可达' : !member.notificationsEnabled ? '通知关闭 · 不可达' : '尚不可达'}</small></td><td><div className="row-buttons"><button className="btn btn-small btn-secondary" onClick={() => setEditing(member)}>编辑</button><button className={`text-button ${member.status !== 'disabled' ? 'danger-text' : ''}`} onClick={() => { setStatusTarget(member); setError(null); }}>{member.status === 'disabled' ? '启用' : '停用'}</button></div></td></tr>)}</tbody></table></div> : <Empty text="还没有成员。成员首次使用 GitHub 登录后会自动出现在这里。" />}
      <Pagination data={resource.data} page={page} setPage={setPage} loading={resource.loading} />
    </section>
    {editing && <MemberEditor member={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); notify('成员资料已保存。'); }} onConflict={() => { setEditing(null); refresh(); }} />}
    {statusTarget && <Modal title={statusTarget.status === 'disabled' ? '重新启用成员' : '确认停用成员'} onClose={() => { if (!busy) setStatusTarget(null); }}><div className="modal-body"><p className="modal-description">{statusTarget.status === 'disabled' ? `重新启用 @${statusTarget.login}？有首次登录记录的成员恢复正常，否则恢复待激活。飞书须由本人重新测试确认，才能恢复通知。` : `停用 @${statusTarget.login} 将撤销其会话和待发通知，禁止访问和新分派。已有负责人关系保留，需管理员重新分派。`}</p><div className="notice notice-warning"><ShieldCheck size={16} />最后一名正常且已激活管理员不能被停用或降级，服务端会校验保护。</div>{error && <ErrorBox error={error} retry={error.status === 409 ? () => { setStatusTarget(null); refresh(); } : undefined} />}</div><div className="modal-footer"><button className="btn btn-secondary" disabled={busy} onClick={() => setStatusTarget(null)}>取消</button><button className={`btn ${statusTarget.status === 'disabled' ? 'btn-primary' : 'btn-danger'}`} disabled={busy || error?.status === 409} onClick={changeStatus}>{busy && <LoaderCircle size={15} className="spin" />}{statusTarget.status === 'disabled' ? '确认启用' : '确认停用'}</button></div></Modal>}
  </>;
}
function MemberEditor({ member, onClose, onSaved, onConflict }) {
  const [form, setForm] = useState({ displayName: member.displayName || '', module: member.module || '', notes: member.notes || '', role: member.role || 'member' });
  const [saving, setSaving] = useState(false); const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    try { await api(`/api/admin/members/${encodeURIComponent(member.id)}`, { method: 'PATCH', body: { ...form, version: member.version } }); onSaved(); }
    catch (e) { setError(e); } finally { setSaving(false); }
  }
  return <Modal title="编辑成员资料" onClose={() => { if (!saving) onClose(); }}><form onSubmit={submit}><div className="modal-body">
    <div className="resolved-profile"><Avatar login={member.login} src={member.avatarUrl} /><div><strong>@{member.login}</strong><p>固定 GitHub ID: {member.githubId}</p><small>头像与身份来自 GitHub · 版本 {member.version}</small></div></div>
    <div className="form-two-columns"><label className="form-field"><span>团队姓名 / 昵称</span><input maxLength={100} value={form.displayName} disabled={saving} onChange={e => setForm({ ...form, displayName: e.target.value })} /></label><label className="form-field"><span>负责模块</span><input maxLength={100} value={form.module} disabled={saving} onChange={e => setForm({ ...form, module: e.target.value })} /></label></div>
    <label className="form-field"><span>平台角色</span><select value={form.role} disabled={saving} onChange={e => setForm({ ...form, role: e.target.value })}><option value="member">普通成员</option><option value="admin">管理员</option></select><small>角色与准入由数据库维护。最后一名正常且已激活管理员不能被降级。</small></label><label className="form-field"><span>管理备注 <small>仅管理员可见</small></span><textarea maxLength={2000} rows={3} value={form.notes} disabled={saving} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>
    <div className="notice notice-info"><ShieldCheck size={16} />飞书由成员本人 OAuth 授权；管理员不能填写或查看完整飞书身份。</div>{error && <ErrorBox error={error} retry={error.status === 409 ? onConflict : undefined} />}
  </div><div className="modal-footer"><button className="btn btn-secondary" type="button" disabled={saving} onClick={onClose}>取消</button><button className="btn btn-primary" type="submit" disabled={saving || error?.status === 409}>{saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}保存资料</button></div></form></Modal>;
}
