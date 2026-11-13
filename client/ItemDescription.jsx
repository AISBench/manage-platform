import React, { useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronUp, FileText } from 'lucide-react';
import Markdown from './Markdown.jsx';

const LONG_CHARS = 800;
const LONG_LINES = 12;

export default function ItemDescription({ item }) {
  const body = typeof item.body === 'string' ? item.body : '';
  const long = body.length > LONG_CHARS || body.split('\n').length > LONG_LINES;
  const [expanded, setExpanded] = useState(false);
  return <section className="description-card">
    <div className="description-head">
      <h2><FileText size={16} />{item.kind === 'pr' ? 'PR 描述' : 'Issue 描述'}</h2>
      <div className="description-meta">{item.author && <span>{item.author}</span>}{item.updatedAt && <span>更新于 {new Date(item.updatedAt).toLocaleString('zh-CN')}</span>}{item.url && <a className="external-text-link" href={item.url} target="_blank" rel="noreferrer">在 GitHub 查看<ArrowUpRight size={13} /></a>}</div>
    </div>
    <div className={`description-body ${long && !expanded ? 'is-collapsed' : ''}`}><Markdown text={body} empty="该 Issue/PR 没有填写描述。" /></div>
    {long && <button type="button" className="text-button description-expand" onClick={() => setExpanded(value => !value)}>{expanded ? <><ChevronUp size={13} />收起</> : <><ChevronDown size={13} />展开全文</>}</button>}
  </section>;
}
