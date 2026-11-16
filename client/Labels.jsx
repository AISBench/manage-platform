import React, { useEffect, useState } from 'react';
import { LoaderCircle, Tag, X } from 'lucide-react';
import { api } from './api.js';
import { ErrorBox, useResource } from './ui.jsx';

const HEX = /^[0-9a-f]{6}$/i;

// GitHub encodes label colours as bare hex; pick readable text per luminance.
export function labelStyle(color) {
  const hex = HEX.test(color || '') ? color : '8b949e';
  const [r, g, b] = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return { background: `#${hex}`, color: luminance > 0.62 ? '#1f2328' : '#ffffff', borderColor: `#${hex}` };
}

export function colorOf(catalog, name) {
  const entry = (catalog || []).find(label => label.name.toLowerCase() === String(name || '').toLowerCase());
  return entry?.color || '';
}

export function LabelChip({ name, color, mapped = [], onRemove, disabled = false }) {
  return <span className="label-chip is-colored" style={labelStyle(color)}>
    <span className="label-chip-name">{name}</span>
    {mapped.length > 0 && <em>→ {mapped.join(' / ')}</em>}
    {onRemove && <button type="button" className="label-chip-remove" aria-label={`移除标签 ${name}`} disabled={disabled} onClick={() => onRemove(name)}><X size={10} /></button>}
  </span>;
}

// Label editing is only offered when the signed-in member can also edit labels on
// GitHub; the server re-checks before writing, so the UI is never the authority.
export function LabelEditor({ item, catalog, canEdit, reason, onSaved, notify }) {
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(item.labels || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { setSelected(item.labels || []); }, [item.id, item.version]);
  useEffect(() => { setEditing(false); }, [item.id]);
  const current = item.labels || [];
  const known = new Set(catalog.map(label => label.name.toLowerCase()));
  const extras = current.filter(name => !known.has(name.toLowerCase()));
  const available = [...catalog.map(label => label.name), ...extras];
  const addable = available.filter(name => !selected.some(picked => picked.toLowerCase() === name.toLowerCase()));

  function add(name) { if (name && !selected.some(picked => picked.toLowerCase() === name.toLowerCase()) && selected.length < 20) setSelected([...selected, name]); }
  async function save(event) {
    event?.preventDefault();
    setSaving(true); setError(null);
    try {
      const result = await api(`/api/items/${encodeURIComponent(item.id)}/labels`, { method: 'PUT', body: { labels: selected } });
      setEditing(false);
      notify?.('标签已同步到 GitHub。');
      onSaved?.(result.item);
    } catch (e) { setError(e); } finally { setSaving(false); }
  }
  if (!canEdit && !current.length) return <span className="muted">无</span>;
  return <>
    <span className="info-badges">
      {current.length ? current.map(name => <LabelChip key={name} name={name} color={colorOf(catalog, name)} />) : <span className="muted">无</span>}
      {canEdit && !editing && <button type="button" className="text-button label-edit-trigger" onClick={() => { setSelected(current); setEditing(true); }}><Tag size={12} />编辑</button>}
    </span>
    {!canEdit && reason && <small className="label-edit-reason">{reason === 'NO_GITHUB_WRITE_TOKEN' ? '未授权 GitHub 写权限，只能查看标签。' : '你在 GitHub 上没有修改标签的权限。'}</small>}
    {editing && <form className="label-editor" onSubmit={save}>
      <div className="label-editor-current">{selected.length ? selected.map(name => <LabelChip key={name} name={name} color={colorOf(catalog, name)} onRemove={label => setSelected(selected.filter(picked => picked !== label))} disabled={saving} />) : <span className="muted">尚未选择标签</span>}</div>
      <div className="label-editor-add"><select aria-label="添加 GitHub 标签" value="" disabled={saving || !addable.length} onChange={e => add(e.target.value)}><option value="">{addable.length ? '选择要添加的标签…' : '没有可添加的标签'}</option>{addable.map(name => <option key={name} value={name}>{name}</option>)}</select></div>
      {error && <ErrorBox compact error={error} />}
      <div className="row-buttons"><button type="button" className="btn btn-secondary btn-small" disabled={saving} onClick={() => { setSelected(current); setEditing(false); setError(null); }}>取消</button><button type="submit" className="btn btn-primary btn-small" disabled={saving || selected.join('\u0000') === current.join('\u0000')}>{saving ? <LoaderCircle size={13} className="spin" /> : <Tag size={13} />}{saving ? '同步中…' : '保存到 GitHub'}</button></div>
    </form>}
  </>;
}

export function useLabelCatalog(revision = 0) {
  return useResource('/api/labels', revision);
}
