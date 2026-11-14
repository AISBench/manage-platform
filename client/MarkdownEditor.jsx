import React, { useEffect, useRef, useState } from 'react';
import {
  AtSign, Bold, Braces, Code, Eye, Hash, Heading2, Image as ImageIcon, Italic, Link2,
  List, ListChecks, ListOrdered, Pencil, Quote, Strikethrough,
} from 'lucide-react';
import Markdown from './Markdown.jsx';
import { Avatar } from './ui.jsx';
import { api } from './api.js';

function ToolButton({ label, onClick, disabled, children }) {
  return <button type="button" className="editor-tool" title={label} aria-label={label} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={onClick}>{children}</button>;
}

export default function MarkdownEditor({ value, onChange, onSubmit, disabled, placeholder, participants = [], maxLength = 20000 }) {
  const input = useRef(null);
  const [mode, setMode] = useState('write');
  const [suggest, setSuggest] = useState(null);
  const [members, setMembers] = useState(null);
  const [references, setReferences] = useState([]);
  const [notice, setNotice] = useState('');

  const participantList = participants.filter(Boolean);
  useEffect(() => {
    if (suggest?.kind !== 'mention' || members) return;
    let active = true;
    api('/api/assignable-members').then(result => { if (active) setMembers(result.members || []); }).catch(() => { if (active) setMembers([]); });
    return () => { active = false; };
  }, [suggest?.kind, members]);

  const referenceQuery = suggest?.kind === 'reference' ? suggest.query : null;
  useEffect(() => {
    if (referenceQuery === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api(`/api/items/search?q=${encodeURIComponent(referenceQuery)}`, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) setReferences(result.items || []); })
        .catch(() => { if (!controller.signal.aborted) setReferences([]); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [referenceQuery]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const mentionOptions = (() => {
    const map = new Map();
    for (const member of members || []) if (member?.login) map.set(member.login.toLowerCase(), { login: member.login, name: member.name || member.login, avatarUrl: member.avatarUrl || '' });
    for (const login of participantList) if (login && !map.has(String(login).toLowerCase())) map.set(String(login).toLowerCase(), { login, name: login, avatarUrl: '' });
    const query = (suggest?.kind === 'mention' ? suggest.query : '').toLowerCase();
    return [...map.values()].filter(candidate => !query || candidate.login.toLowerCase().includes(query) || candidate.name.toLowerCase().includes(query)).slice(0, 8);
  })();
  const options = suggest?.kind === 'mention' ? mentionOptions : suggest?.kind === 'reference' ? references.slice(0, 8) : [];
  const activeIndex = suggest ? Math.min(suggest.index, Math.max(options.length - 1, 0)) : 0;

  function replaceRange(start, end, text, selectStart, selectEnd) {
    onChange(value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => {
      const element = input.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(selectStart ?? start + text.length, selectEnd ?? start + text.length);
    });
  }
  function wrap(prefix, suffix, sample) {
    const element = input.current;
    if (!element) return;
    const { selectionStart: start, selectionEnd: end } = element;
    const selected = value.slice(start, end) || sample;
    replaceRange(start, end, prefix + selected + suffix, start + prefix.length, start + prefix.length + selected.length);
  }
  function linePrefix(prefix, ordered = false) {
    const element = input.current;
    if (!element) return;
    const { selectionStart: start, selectionEnd: end } = element;
    const from = value.lastIndexOf('\n', start - 1) + 1;
    let to = value.indexOf('\n', end);
    if (to === -1) to = value.length;
    const block = value.slice(from, to);
    const result = block.split('\n').map((line, index) => `${ordered ? `${index + 1}. ` : prefix}${line}`).join('\n');
    replaceRange(from, to, result, from, from + result.length);
  }
  function codeBlock() {
    const element = input.current;
    if (!element) return;
    const { selectionStart: start, selectionEnd: end } = element;
    const selected = value.slice(start, end) || '代码';
    const text = `\n\`\`\`\n${selected}\n\`\`\`\n`;
    replaceRange(start, end, text, start + 5, start + 5 + selected.length);
  }
  function insertLink() {
    const element = input.current;
    if (!element) return;
    const { selectionStart: start, selectionEnd: end } = element;
    const label = value.slice(start, end) || '链接文字';
    const text = `[${label}](https://)`;
    replaceRange(start, end, text, start + label.length + 3, start + label.length + 11);
  }
  function insertImage() {
    const url = window.prompt('输入图片 URL（需可公开访问；GitHub 不支持通过 API 上传附件）', 'https://');
    if (!url) return;
    if (!/^https?:\/\/\S+$/i.test(url.trim())) { setNotice('图片地址必须以 http:// 或 https:// 开头。'); return; }
    const element = input.current;
    const start = element ? element.selectionStart : value.length;
    const end = element ? element.selectionEnd : value.length;
    replaceRange(start, end, `![图片](${url.trim()})`);
  }
  function insertAtCursor(text) {
    const element = input.current;
    const start = element ? element.selectionStart : value.length;
    const end = element ? element.selectionEnd : value.length;
    replaceRange(start, end, text);
  }
  function insertTrigger(symbol) {
    const element = input.current;
    const start = element ? element.selectionStart : value.length;
    const end = element ? element.selectionEnd : value.length;
    onChange(value.slice(0, start) + symbol + value.slice(end));
    setSuggest({ kind: symbol === '@' ? 'mention' : 'reference', query: '', start, index: 0 });
    requestAnimationFrame(() => {
      if (!element) return;
      element.focus();
      element.setSelectionRange(start + 1, start + 1);
    });
  }
  function chooseOption(option) {
    if (!suggest) return;
    const element = input.current;
    const caret = element ? element.selectionStart : value.length;
    const text = suggest.kind === 'mention' ? `@${option.login} ` : `#${option.number} `;
    const next = value.slice(0, suggest.start) + text + value.slice(caret);
    onChange(next);
    setSuggest(null);
    requestAnimationFrame(() => {
      if (!element) return;
      element.focus();
      const position = suggest.start + text.length;
      element.setSelectionRange(position, position);
    });
  }
  function detectSuggest(text, caret) {
    const before = text.slice(0, caret);
    const mention = before.match(/(?:^|[\s(（])@([a-zA-Z0-9-]{0,38})$/);
    if (mention) {
      setSuggest(previous => ({ kind: 'mention', query: mention[1], start: caret - mention[1].length - 1, index: previous?.kind === 'mention' && previous.query === mention[1] ? previous.index : 0 }));
      return;
    }
    const reference = before.match(/(?:^|[\s(（])#([0-9]{0,5})$/);
    if (reference) {
      setSuggest(previous => ({ kind: 'reference', query: reference[1], start: caret - reference[1].length - 1, index: previous?.kind === 'reference' && previous.query === reference[1] ? previous.index : 0 }));
      return;
    }
    setSuggest(null);
  }
  function handleChange(event) {
    const text = event.target.value;
    onChange(text);
    detectSuggest(text, event.target.selectionStart);
  }
  function handleKeyDown(event) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (!disabled) onSubmit?.();
      return;
    }
    if (suggest && options.length) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setSuggest({ ...suggest, index: (activeIndex + 1) % options.length }); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setSuggest({ ...suggest, index: (activeIndex - 1 + options.length) % options.length }); return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); chooseOption(options[activeIndex]); return; }
      if (event.key === 'Escape') { event.preventDefault(); setSuggest(null); return; }
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey) {
      const key = event.key.toLowerCase();
      if (key === 'b') { event.preventDefault(); wrap('**', '**', '粗体'); }
      else if (key === 'i') { event.preventDefault(); wrap('*', '*', '斜体'); }
      else if (key === 'k') { event.preventDefault(); insertLink(); }
    }
  }

  return <div className={`markdown-editor ${disabled ? 'is-disabled' : ''}`}>
    <div className="editor-tabs" role="tablist" aria-label="编辑器模式">
      <button type="button" role="tab" aria-selected={mode === 'write'} className={mode === 'write' ? 'active' : ''} onClick={() => setMode('write')}><Pencil size={12} />写</button>
      <button type="button" role="tab" aria-selected={mode === 'preview'} className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}><Eye size={12} />预览</button>
    </div>
    {mode === 'write' ? <>
      <div className="editor-toolbar" role="toolbar" aria-label="Markdown 工具栏">
        <ToolButton label="标题" disabled={disabled} onClick={() => linePrefix('## ')}><Heading2 size={14} /></ToolButton>
        <ToolButton label="粗体" disabled={disabled} onClick={() => wrap('**', '**', '粗体')}><Bold size={14} /></ToolButton>
        <ToolButton label="斜体" disabled={disabled} onClick={() => wrap('*', '*', '斜体')}><Italic size={14} /></ToolButton>
        <ToolButton label="删除线" disabled={disabled} onClick={() => wrap('~~', '~~', '删除线')}><Strikethrough size={14} /></ToolButton>
        <ToolButton label="引用" disabled={disabled} onClick={() => linePrefix('> ')}><Quote size={14} /></ToolButton>
        <ToolButton label="行内代码" disabled={disabled} onClick={() => wrap('`', '`', '代码')}><Code size={14} /></ToolButton>
        <ToolButton label="代码块" disabled={disabled} onClick={codeBlock}><Braces size={14} /></ToolButton>
        <ToolButton label="链接" disabled={disabled} onClick={insertLink}><Link2 size={14} /></ToolButton>
        <ToolButton label="图片外链" disabled={disabled} onClick={insertImage}><ImageIcon size={14} /></ToolButton>
        <ToolButton label="无序列表" disabled={disabled} onClick={() => linePrefix('- ')}><List size={14} /></ToolButton>
        <ToolButton label="有序列表" disabled={disabled} onClick={() => linePrefix('', true)}><ListOrdered size={14} /></ToolButton>
        <ToolButton label="任务列表" disabled={disabled} onClick={() => linePrefix('- [ ] ')}><ListChecks size={14} /></ToolButton>
        <ToolButton label="@ 提及成员" disabled={disabled} onClick={() => insertTrigger('@')}><AtSign size={14} /></ToolButton>
        <ToolButton label="# 引用事务" disabled={disabled} onClick={() => insertTrigger('#')}><Hash size={14} /></ToolButton>
      </div>
      <div className="editor-input-wrap">
        <textarea
          ref={input}
          value={value}
          rows={5}
          maxLength={maxLength}
          disabled={disabled}
          placeholder={placeholder}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={() => setTimeout(() => setSuggest(null), 120)}
          onDrop={event => {
            if (event.dataTransfer.files?.length) {
              event.preventDefault();
              setNotice('GitHub 不支持通过 API 上传附件；请先把图片上传到可公开访问的图床，再插入外链。');
              return;
            }
            const url = (event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain') || '').trim();
            if (/^https?:\/\/\S+$/i.test(url)) {
              event.preventDefault();
              insertAtCursor(`![图片](${url})`);
            }
          }}
        />
        {suggest && options.length > 0 && <div className="editor-suggest" role="listbox" aria-label={suggest.kind === 'mention' ? '选择成员' : '引用事务'}>
          {options.map((option, index) => <button key={suggest.kind === 'mention' ? option.login : option.id} type="button" role="option" aria-selected={index === activeIndex} className={index === activeIndex ? 'active' : ''} onMouseDown={event => { event.preventDefault(); chooseOption(option); }}>
            {suggest.kind === 'mention'
              ? <><Avatar login={option.login} src={option.avatarUrl} size="tiny" /><span>{option.name}</span><em>@{option.login}</em></>
              : <><code>#{option.number}</code><span>{option.title}</span><em>{option.kind === 'pr' ? 'PR' : 'Issue'}</em></>}
          </button>)}
        </div>}
        {notice && <div className="editor-hint">{notice}</div>}
      </div>
    </> : <div className="editor-preview"><Markdown text={value} empty="还没有内容。" /></div>}
  </div>;
}
