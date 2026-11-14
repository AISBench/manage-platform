import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';

function ExternalLink({ node, ...props }) { return <a {...props} target="_blank" rel="noreferrer noopener" />; }
function LazyImage({ node, alt = '', ...props }) { return <img {...props} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" />; }
function ScrollTable({ node, ...props }) { return <div className="markdown-table-wrap"><table {...props} /></div>; }

export default function Markdown({ text, empty = '暂无描述。', className = '' }) {
  if (typeof text !== 'string' || !text.trim()) return <div className="item-body markdown-body is-empty">{empty}</div>;
  return <div className={`item-body markdown-body ${className}`.trim()}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
      components={{ a: ExternalLink, img: LazyImage, table: ScrollTable }}
    >{text}</ReactMarkdown>
  </div>;
}
