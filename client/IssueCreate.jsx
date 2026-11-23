import React, { useEffect, useState } from 'react';
import { CircleAlert, LoaderCircle, Plus } from 'lucide-react';
import { api } from './api.js';
import AgentTaskInbox from './AgentTaskInbox.jsx';

// Ask the member's own Agent to draft an Issue. Publishing stays a human step:
// the Agent only produces a draft here, and the Issue is created from the
// review panel below (or from the Agent task tab).
export default function IssueCreate({ notify }) {
  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [requirement, setRequirement] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    api('/api/issue-templates').then(data => setTemplates(data.templates || [])).catch(setError);
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (requirement.trim().length < 10) { setError(new Error('请至少用 10 个字描述问题或需求')); return; }
    setBusy(true); setError(null);
    try {
      const body = { requirement: requirement.trim(), clientRequestId: crypto.randomUUID() };
      if (templateId) body.templateId = templateId;
      const result = await api('/api/agent/issue-tasks', { method: 'POST', body });
      setRequirement('');
      notify?.(result.created ? '已创建提 Issue 任务，等待你的 Agent 领取。' : '已有相同的提 Issue 任务。');
      setReloadKey(value => value + 1);
    } catch (e) { setError(e); notify?.(e.message, 'error'); }
    finally { setBusy(false); }
  }

  return <div className="agent-issue-create">
    <form onSubmit={submit}>
      <label className="agent-issue-label" htmlFor="agent-issue-requirement">要提的问题 / 需求</label>
      <textarea id="agent-issue-requirement" rows={4} maxLength={2000} value={requirement} onChange={event => setRequirement(event.target.value)}
        placeholder="例如：使用 vllm_api_stream_chat 做性能评测时进程直接退出，只有 traceback；希望按 bug 模板提交 Issue，说明复现命令、版本与环境。" />
      <div className="agent-issue-template-picker">
        <span>期望模板（可选，Agent 会按实际内容再确认）</span>
        <div>
          <button type="button" className={`agent-client-chip ${templateId === '' ? 'active' : ''}`} onClick={() => setTemplateId('')}>自动判断</button>
          {templates.map(template => <button key={template.id} type="button" className={`agent-client-chip ${templateId === template.id ? 'active' : ''}`} onClick={() => setTemplateId(template.id)}>
            {template.name || template.id}
          </button>)}
        </div>
      </div>
      {templateId && (() => {
        const template = templates.find(entry => entry.id === templateId);
        if (!template) return null;
        return <p className="agent-muted">模板标签：{(template.labels || []).join('、') || '无'}；必填字段：{(template.fields || []).filter(field => field.required).map(field => field.label).join('、') || '无'}。</p>;
      })()}
      {error && <p className="agent-adaptor-status is-red" role="alert"><CircleAlert size={14} />{error.message}</p>}
      <button className="btn btn-primary btn-small" type="submit" disabled={busy}>{busy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}{busy ? '创建中…' : '创建提 Issue 任务'}</button>
      <p className="agent-muted">Agent 会先检索已有 Issue 查重、核验合理性，再按模板字段生成草稿；确认不重复后可以直接在下方的任务里创建 Issue。</p>
    </form>

    <AgentTaskInbox kinds={['issue_create']} reloadKey={reloadKey} notify={notify}
      title="我的提 Issue 任务" emptyText="还没有提 Issue 任务。创建后可以在这里直接审阅草稿并创建 Issue。" />
  </div>;
}
