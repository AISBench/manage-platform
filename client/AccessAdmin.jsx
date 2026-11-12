import React, { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Globe2, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from './api.js';
import { Badge, ErrorBox, Heading, Spinner, date, useResource } from './ui.jsx';
import { publicReasons } from './access.js';

export function AccessPolicyScreen({ revision, notify, onChanged }) {
  const resource = useResource('/api/admin/access-policy', revision);
  const [form, setForm] = useState(null); const [saving, setSaving] = useState(false); const [error, setError] = useState(null);
  useEffect(() => { if (resource.data?.policy) setForm(resource.data.policy); }, [resource.data]);
  async function save(e) {
    e.preventDefault(); setSaving(true); setError(null);
    try { const result = await api('/api/admin/access-policy', { method: 'PUT', body: { version: form.version, publicOverviewEnabled: form.publicOverviewEnabled } }); setForm(result.policy); resource.retry(); onChanged?.(); notify('访问策略已保存。公开可用性以服务端核验状态为准。'); }
    catch (e) { setError(e); } finally { setSaving(false); }
  }
  const publicStatus = resource.data?.publicStatus;
  return <><Heading eyebrow="ACCESS & PUBLIC BOUNDARY" title="访问策略" description="公开数据开关独立控制。公开开关开启不等于存在可用快照。" action={<button className="btn btn-secondary" onClick={() => { setError(null); resource.retry(); }} disabled={resource.loading || saving}><RefreshCw size={15} />刷新策略</button>} />{resource.error ? <ErrorBox error={resource.error} retry={resource.retry} /> : !form || resource.loading ? <Spinner label="正在读取访问策略…" /> : <div className="settings-grid"><section className="panel settings-panel"><div className="panel-title-row"><div><h2><ShieldCheck size={18} />公开边界</h2><p>策略版本 {form.version} · 服务端实时检查权限</p></div></div><form onSubmit={save}><div className="settings-form-body"><div className="preference-row"><div><strong>启用公开仓库概览</strong><p>启用前服务端须核验仓库公开性；关闭立即撤销公开快照与缓存。</p></div><button type="button" className={`toggle ${form.publicOverviewEnabled ? 'checked' : ''}`} role="switch" aria-label="启用公开仓库概览" aria-checked={Boolean(form.publicOverviewEnabled)} disabled={saving} onClick={() => setForm({ ...form, publicOverviewEnabled: !form.publicOverviewEnabled })}><span /></button></div>{error && <ErrorBox error={error} retry={error.status === 409 ? () => { setError(null); resource.retry(); } : undefined} />}</div><div className="form-footer"><span>不会自动同步 GitHub 数据</span><button type="submit" className="btn btn-primary" disabled={saving || error?.status === 409}>{saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}保存访问策略</button></div></form></section><aside className="settings-aside"><section className="panel policy-status-card"><span className="aside-icon"><Globe2 size={23} /></span><h3>公开数据实际状态</h3><Badge tone={publicStatus?.available ? 'teal' : 'amber'}>{publicStatus?.available ? '可用' : '暂不可用'}</Badge><p>{publicReasons[publicStatus?.reason] || publicStatus?.reason || '服务器未提供状态'}</p><dl className="application-details"><dt>最近核验</dt><dd>{date(publicStatus?.checkedAt)}</dd></dl><a className="text-button" href="/" target="_blank" rel="noreferrer">查看公开门户<ArrowUpRight size={14} /></a></section><div className="context-note"><ShieldCheck size={19} /><div><strong>没有安全快照，就不展示数据</strong><p>仓库私有、核验过期或尚无快照时，公开页保持不可用。不使用内部数据伪装实时公开统计。</p></div></div></aside></div>}</>;
}
