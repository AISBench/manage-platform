import React, { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from './api.js';
import { Badge, Modal } from './ui.jsx';
import AgentDraft from './AgentDraft.jsx';

const STATUS = {
  queued: ['blue', '等待 Agent 领取'],
  claimed: ['amber', 'Agent 处理中'],
  submitted: ['teal', '草稿待审阅'],
  published: ['green', '已处理'],
  declined: ['neutral', '已驳回'],
  expired: ['neutral', '已过期'],
};

// Inline inbox for tasks that have no item page (issue drafts and PR results).
// Drafts can be reviewed and published right here instead of switching tabs.
export default function AgentTaskInbox({ kinds, notify, reloadKey = 0, title = '我的任务', emptyText = '还没有任务。' }) {
  const [tasks, setTasks] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [modal, setModal] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    const [taskData, draftData] = await Promise.all([api('/api/agent/my-tasks'), api('/api/agent/drafts')]);
    setTasks((taskData.tasks || []).filter(task => kinds.includes(task.kind)));
    setDrafts(Object.fromEntries((draftData.drafts || []).filter(draft => draft.taskId).map(draft => [draft.taskId, draft])));
    setError(null);
  }

  useEffect(() => { load().catch(setError); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [reloadKey]);
  useEffect(() => {
    if (!tasks.some(task => ['queued', 'claimed'].includes(task.status))) return undefined;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load().catch(setError); }, 8000);
    return () => clearInterval(timer);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [tasks]);

  const modalDraft = modal ? drafts[modal] : null;

  return <div className="agent-task-inbox">
    <h4>{title}</h4>
    {error && <p className="agent-adaptor-status is-red" role="alert">{error.message}</p>}
    {!tasks.length && <p className="agent-muted">{emptyText}</p>}
    {tasks.slice(0, 12).map(task => {
      const [tone, label] = STATUS[task.status] || ['neutral', task.status];
      const draft = drafts[task.id];
      return <div className="agent-task-row" key={task.id}>
        <div className="agent-task-row-head">
          <strong>{(task.hint || '').split('\n')[0].slice(0, 80) || (task.kind === 'pr_create' ? `Issue #${task.number} 提 PR` : '提 Issue')}</strong>
          <Badge tone={tone}>{label}</Badge>
        </div>
        {draft?.summary && <p className="agent-adaptor-meta">草稿 · {draft.summary}</p>}
        <div className="agent-task-row-foot">
          {draft ? <button type="button" className="text-button" onClick={() => setModal(task.id)}>{task.status === 'submitted' ? '查看并处理草稿' : '查看草稿'}</button> : null}
          {draft?.commentUrl && <a className="external-text-link" href={draft.commentUrl} target="_blank" rel="noreferrer">查看已处理结果<ExternalLink size={12} /></a>}
          {!draft && task.status === 'queued' && <span className="agent-muted">等待你的 Agent 领取…</span>}
          {!draft && task.status === 'claimed' && <span className="agent-muted">Agent 正在处理…</span>}
        </div>
      </div>;
    })}
    {modalDraft && <Modal title={modalDraft.kind === 'pr_result' ? 'PR 结果草稿' : 'Issue 草稿'} onClose={() => setModal(null)} wide>
      <AgentDraft draft={modalDraft} notify={notify} onChanged={async () => { setModal(null); await load(); }} />
    </Modal>}
  </div>;
}
