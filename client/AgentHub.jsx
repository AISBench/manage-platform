import React, { useEffect, useMemo, useState } from 'react';
import { Bot, Check, CircleAlert, Clock3, Copy, ExternalLink, KeyRound, LoaderCircle, Plus, Terminal, Trash2, Wrench } from 'lucide-react';
import { api } from './api.js';
import { Badge, Empty, Spinner } from './ui.jsx';
import Markdown from './Markdown.jsx';

const STATUS = {
  queued: ['blue', '等待 Agent 领取'],
  claimed: ['amber', 'Agent 处理中'],
  submitted: ['teal', '草稿待审阅'],
  published: ['green', '已发布'],
  declined: ['neutral', '已驳回'],
  expired: ['neutral', '已过期'],
};
const DRAFT_STATUS = { pending: ['amber', '待审阅'], published: ['green', '已发布'], declined: ['neutral', '已驳回'] };
const ACTION_LABELS = { add_label: '添加标签', remove_label: '移除标签', assign: '指派', close: '关闭 Issue', reopen: '重新打开' };

function copyText(text, notify) {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => notify?.('已复制到剪贴板'), () => notify?.('复制失败，请手动选择', 'error'));
    return;
  }
  notify?.('当前浏览器不支持自动复制，请手动选择', 'error');
}

function envOf(origin, token) {
  return { AISBENCH_URL: origin, AISBENCH_TOKEN: token };
}
const DEFAULT_MCP = { command: 'npx', args: ['-y', 'aisbench-mcp'] };
function mcpOf(mcp) {
  const command = (mcp?.command || DEFAULT_MCP.command).trim();
  const args = Array.isArray(mcp?.args) && mcp.args.length ? mcp.args : DEFAULT_MCP.args;
  return { command, args };
}
function genericJson(origin, token, mcp) {
  const { command, args } = mcpOf(mcp);
  return JSON.stringify({ mcpServers: { aisbench: { command, args, env: envOf(origin, token) } } }, null, 2);
}
function codexToml(origin, token, mcp) {
  const { command, args } = mcpOf(mcp);
  return `[mcp_servers.aisbench]\ncommand = "${command}"\nargs = ${JSON.stringify(args)}\n\n[mcp_servers.aisbench.env]\nAISBENCH_URL = "${origin}"\nAISBENCH_TOKEN = "${token}"`;
}
function claudeCli(origin, token, mcp) {
  const { command, args } = mcpOf(mcp);
  return `claude mcp add aisbench \\\n  --env AISBENCH_URL=${origin} \\\n  --env AISBENCH_TOKEN=${token} \\\n  -- ${command} ${args.join(' ')}`;
}
function vscodeJson(origin, token, mcp) {
  const { command, args } = mcpOf(mcp);
  return JSON.stringify({ servers: { aisbench: { type: 'stdio', command, args, env: envOf(origin, token) } } }, null, 2);
}
function zedJson(origin, token, mcp) {
  const { command, args } = mcpOf(mcp);
  return JSON.stringify({ context_servers: { aisbench: { command, args, env: envOf(origin, token) } } }, null, 2);
}
function continueYaml(origin, token, mcp) {
  const { command, args } = mcpOf(mcp);
  return `mcpServers:\n  - name: aisbench\n    command: ${command}\n    args:\n${args.map(arg => `      - ${arg}`).join('\n')}\n    env:\n      AISBENCH_URL: ${origin}\n      AISBENCH_TOKEN: ${token}`;
}
function httpCurl(origin, token) {
  return `curl -s ${origin}/api/agent/me -H "Authorization: Bearer ${token}"\ncurl -s ${origin}/api/agent/tasks -H "Authorization: Bearer ${token}"\ncurl -s -X POST ${origin}/api/agent/kb/search \\\n  -H "Authorization: Bearer ${token}" -H 'Content-Type: application/json' \\\n  -d '{"repo":"AISBench/benchmark","question":"评测结果 JSON 有哪些字段"}'`;
}

const CLIENTS = [
  { id: 'claude-code', label: 'Claude Code', group: '命令行', kind: 'cli', file: '在项目目录执行下面的命令', verify: '在 Claude Code 中执行 /mcp，能看到 aisbench 及 6 个工具。' },
  { id: 'codex', label: 'Codex CLI', group: '命令行', kind: 'toml', file: '~/.codex/config.toml', verify: '重启 codex 后执行 /mcp，能看到 aisbench。' },
  { id: 'gemini', label: 'Gemini CLI', group: '命令行', kind: 'json', file: '~/.gemini/settings.json', verify: '重启后执行 /mcp，能看到 aisbench 的工具列表。' },
  { id: 'claude-desktop', label: 'Claude Desktop', group: '桌面 / IDE', kind: 'json', file: 'macOS：~/Library/Application Support/Claude/claude_desktop_config.json；Windows：%APPDATA%\\Claude\\claude_desktop_config.json', verify: '重启 Claude Desktop，在工具入口看到 aisbench。' },
  { id: 'cursor', label: 'Cursor', group: '桌面 / IDE', kind: 'json', file: '~/.cursor/mcp.json（或在 Settings → MCP 中编辑）', verify: '在 Cursor 的 MCP 面板看到 aisbench 已连接。' },
  { id: 'windsurf', label: 'Windsurf', group: '桌面 / IDE', kind: 'json', file: '~/.codeium/windsurf/mcp_config.json', verify: '在 Cascade 的 MCP 面板确认 aisbench 已连接。' },
  { id: 'vscode', label: 'VS Code (Copilot)', group: '桌面 / IDE', kind: 'vscode', file: '.vscode/mcp.json（工作区）或用户级 mcp.json', verify: '在 MCP 面板启动 aisbench 并看到工具列表。' },
  { id: 'cline', label: 'Cline', group: '桌面 / IDE', kind: 'json', file: '扩展：MCP Servers → Configure MCP Servers（cline_mcp_settings.json）；CLI：~/.cline/mcp.json', verify: '保存后在 MCP 面板看到 6 个工具。' },
  { id: 'continue', label: 'Continue', group: '桌面 / IDE', kind: 'yaml', file: '~/.continue/config.yaml（旧版为 config.json）', verify: '重载窗口后，工具出现在 Continue 的可用工具中。' },
  { id: 'zed', label: 'Zed', group: '桌面 / IDE', kind: 'zed', file: 'Settings → AI → MCP Servers（写入 settings.json 的 context_servers）', verify: '在 Agent 面板看到自定义 server 已连接。' },
  { id: 'trae', label: 'Trae', group: '国产 IDE', kind: 'json', file: '设置 → MCP → 添加（粘贴 mcpServers JSON）', verify: '在 MCP 列表确认 aisbench 已连接。' },
  { id: 'tongyi', label: '通义灵码', group: '国产 IDE', kind: 'json', file: 'MCP 服务 → 我的服务 → 添加（STDIO 表单：命令/参数/环境变量）', verify: '在 MCP 服务列表确认连接状态。' },
  { id: 'qoder', label: 'Qoder', group: '国产 IDE', kind: 'json', file: '~/.qoder/mcp.json（国内版 ~/.qoder-cn/mcp.json）', verify: '在 MCP 列表确认 aisbench 已连接。' },
  { id: 'codebuddy', label: 'CodeBuddy', group: '国产 IDE', kind: 'json', file: '设置 → MCP（写入 mcpServers 配置）', verify: '在 MCP 列表确认 aisbench 已连接。' },
  { id: 'wenxin', label: '文心快码', group: '国产 IDE', kind: 'json', file: '官方 MCP 面板（JSON 字段以当前版本文档为准）', verify: '在 MCP 列表确认 aisbench 已连接。' },
  { id: 'http', label: 'HTTP 兜底（无 MCP）', group: '其他', kind: 'http', file: '无需配置客户端，直接调用平台 API', verify: '/api/agent/me 返回你的账号信息即接通。' },
];
const CLIENT_GROUPS = ['命令行', '桌面 / IDE', '国产 IDE', '其他'];

// MCP has no server-to-client wake-up: the client must poll on a schedule.
// Keep one shared prompt so every client schedules the same safe behaviour.
const AUTO_PROMPT = `检查并处理 AISBench 平台上派给我的 Agent 任务。

1. 调用 aisbench_task_list 查看任务。
2. 只处理 status=queued 的任务；claimed 表示已有另一轮在处理，直接跳过；claimed 超过 30 分钟未更新可视为中断并重新领取。
3. 没有可处理任务时直接结束，不要发送任何通知。
4. 每轮最多处理 1 个，优先创建时间最早的：调用 aisbench_task_claim 领取。
5. 调用 aisbench_issue_context 读取该 Issue / PR 的白名单事实；PR 会附带变更文件与 patch。需要时调用 aisbench_kb_search 检索 AISBench/benchmark 知识库。
6. 若任务带 replyTo，只针对该条评论 / 检视意见与线程历史写回复，严格按 hint 中我的意图表达，comments 留空；否则 PR 检视：comment_md 只写不超过 600 字的总体摘要；必须输出多条 comments，每条 body 严格为「[review] [严重程度] 具体问题」换行「[suggestion] 可行解决方式」，line 使用 @@ 头中的新文件/旧文件行号，只对改动或上下文行提意见，严重程度建议 blocker/major/minor/nit，不要只写总体概述。Issue 则给出排查结论与修复或验证建议。引用真实文件路径，不要编造出处。
7. 调用 aisbench_task_submit 提交草稿；若返回行内意见定位无效，按错误修正 comments 后重试。不要发布，发布由我在平台人工确认。
8. 全程不修改 GitHub、不发布评论、不执行强副作用动作。`;

const TRAE_SCHEDULE = {
  badge: '内置自动化', tone: 'teal',
  steps: [
    '打开 TRAE 的 Agent 窗口，在左侧导航栏点击「自动化」。',
    '选择「在对话中创建」或「手动创建」，间隔设为 10 分钟（本机验证的最小间隔；以当前版本为准）。',
    '把下方「定时任务提示词」粘贴为任务内容并启用；本地任务需要电脑保持唤醒。',
    '平台点「交给我的 agent」后，下一轮会自动领取，状态变为「Agent 处理中」。',
  ],
};

function cliSchedule(command) {
  return {
    badge: '需系统计划任务', tone: 'amber',
    steps: [
      '确认上方 MCP 配置已生效（先手动调用一次工具验证）。',
      '把下方「定时任务提示词」保存为项目根目录的 aisbench-agent-task.md。',
      '用系统计划任务（cron / 任务计划程序）每 10 分钟执行一次该客户端的无头命令，示例见下。',
      '先手动执行一次示例命令，确认能提交草稿后再启用定时。',
    ],
    code: `# 每 10 分钟检查一次（Linux / macOS crontab；Windows 用任务计划程序执行同一命令）
*/10 * * * * cd /path/to/your/project && ${command} >> /tmp/aisbench-agent.log 2>&1`,
  };
}

const DEFAULT_SCHEDULE = {
  badge: '无统一内置调度', tone: 'amber',
  steps: [
    '先确认该客户端是否提供「自动化 / 定时任务」入口；有则直接使用，并把间隔设为不小于 10 分钟。',
    '没有内置调度时，用系统计划任务（cron / 任务计划程序）每 10 分钟执行一次它的 CLI 或无头命令，并把提示词作为输入。',
    '若既没有内置调度也没有 CLI：只能手动触发，或改用支持定时的客户端（如 TRAE、Cline CLI）。',
    '队列中的任务保留 24 小时，暂时没有 Agent 也不会丢失。',
  ],
};

const CLINE_SCHEDULE = {
  badge: '内置定时（CLI）', tone: 'teal',
  steps: [
    '确认 Cline 的 MCP 配置已生效（扩展或 CLI 均可）。',
    '使用 Cline CLI 创建定时任务，cron 支持 */10 * * * * 这类表达式。',
    '把下方提示词作为 --prompt 参数，或先保存为文件后粘贴。',
    '先手动执行一次 cline schedule 命令，确认能提交草稿后再保持启用。',
  ],
  code: `cline schedule create "AISBench Agent 自动处理任务" \\
  --cron "*/10 * * * *" \\
  --prompt "<粘贴下方提示词>" \\
  --workspace /path/to/your/project`,
};

const HTTP_SCHEDULE = {
  badge: '需自建轮询', tone: 'amber',
  steps: [
    '你的脚本定时 GET /api/agent/tasks（Authorization: Bearer 令牌）。',
    '对 status=queued 的任务 POST /api/agent/tasks/{id}/claim。',
    'GET /api/agent/tasks/{id}/context 读取 Issue / PR 事实（PR 含变更文件与 patch），并按需调用知识库接口，用你的模型生成草稿。',
    'POST /api/agent/tasks/{id}/submit 提交草稿；建议轮询间隔不小于 10 分钟。',
  ],
};

const CLI_SCHEDULES = {
  'claude-code': cliSchedule('claude -p "$(cat aisbench-agent-task.md)"'),
  codex: cliSchedule('codex exec "$(cat aisbench-agent-task.md)"'),
  gemini: cliSchedule('gemini -p "$(cat aisbench-agent-task.md)"'),
};
function scheduleFor(client) {
  if (client.kind === 'http') return HTTP_SCHEDULE;
  if (client.id === 'trae') return TRAE_SCHEDULE;
  if (client.id === 'cline') return CLINE_SCHEDULE;
  return CLI_SCHEDULES[client.id] || DEFAULT_SCHEDULE;
}

function snippetFor(client, origin, token, mcp) {
  if (client.kind === 'cli') return claudeCli(origin, token, mcp);
  if (client.kind === 'toml') return codexToml(origin, token, mcp);
  if (client.kind === 'http') return httpCurl(origin, token);
  if (client.kind === 'vscode') return vscodeJson(origin, token, mcp);
  if (client.kind === 'zed') return zedJson(origin, token, mcp);
  if (client.kind === 'yaml') return continueYaml(origin, token, mcp);
  return genericJson(origin, token, mcp);
}

function Snippet({ title, code, notify }) {
  return <div className="agent-snippet">
    <div className="agent-snippet-head"><strong>{title}</strong><button className="text-button" onClick={() => copyText(code, notify)}><Copy size={13} />复制</button></div>
    <pre>{code}</pre>
  </div>;
}

export default function AgentHub({ session, notify }) {
  const enabled = session?.features?.agentAccessEnabled !== false;
  const configured = session?.agentAdaptorConfigured !== false;
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get('tab') === 'tasks' ? 'tasks' : 'guide');
  const [tokens, setTokens] = useState([]);
  const [tokensLoading, setTokensLoading] = useState(true);
  const [tokenError, setTokenError] = useState(null);
  const [newToken, setNewToken] = useState('');
  const [name, setName] = useState('我的 Agent');
  const [creating, setCreating] = useState(false);
  const [drafts, setDrafts] = useState([]);
  const [draftsLoading, setDraftsLoading] = useState(true);
  const [draftError, setDraftError] = useState(null);
  const [expanded, setExpanded] = useState('');
  const [selected, setSelected] = useState({});
  const [busy, setBusy] = useState('');
  const [clientId, setClientId] = useState('claude-code');

  const origin = window.location.origin;
  const sampleToken = newToken || 'ask_在下方生成你的令牌';
  const client = CLIENTS.find(entry => entry.id === clientId) || CLIENTS[0];
  const mcpCommand = session?.features?.agentMcp?.command || '';
  const mcpArgs = session?.features?.agentMcp?.args;
  const snippet = useMemo(() => snippetFor(client, origin, sampleToken, { command: mcpCommand, args: mcpArgs }), [client, origin, sampleToken, mcpCommand, mcpArgs]);
  const schedule = scheduleFor(client);

  async function loadTokens() {
    setTokensLoading(true);
    try { const data = await api('/api/agent/tokens'); setTokens(data.tokens || []); setTokenError(null); }
    catch (error) { setTokenError(error); }
    finally { setTokensLoading(false); }
  }
  async function loadDrafts() {
    setDraftsLoading(true);
    try { const data = await api('/api/agent/drafts'); setDrafts(data.drafts || []); setDraftError(null); }
    catch (error) { setDraftError(error); }
    finally { setDraftsLoading(false); }
  }
  useEffect(() => { if (enabled) loadTokens(); }, [enabled]);
  useEffect(() => { if (enabled && tab === 'tasks') loadDrafts(); }, [enabled, tab]);

  async function createToken(event) {
    event.preventDefault(); setCreating(true); setTokenError(null);
    try {
      const data = await api('/api/agent/tokens', { method: 'POST', body: { name: name.trim() || '我的 Agent' } });
      setNewToken(data.token); setTokens(previous => [{ id: data.id, name: data.name, prefix: data.prefix, createdAt: new Date().toISOString(), lastUsedAt: null }, ...previous]);
      notify?.('令牌已生成，请立即复制保存（只显示一次）');
    } catch (error) { setTokenError(error); }
    finally { setCreating(false); }
  }
  async function revokeToken(id) {
    setBusy(id);
    try { await api(`/api/agent/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }); setTokens(previous => previous.filter(token => token.id !== id)); notify?.('令牌已撤销'); }
    catch (error) { notify?.(error.message, 'error'); }
    finally { setBusy(''); }
  }
  function toggleAction(draftId, index) {
    setSelected(previous => {
      const current = new Set(previous[draftId] || []);
      current.has(index) ? current.delete(index) : current.add(index);
      return { ...previous, [draftId]: [...current] };
    });
  }
  async function publish(draft) {
    setBusy(draft.id);
    try {
      const actions = (draft.actions || []).filter((_, index) => (selected[draft.id] || []).includes(index));
      const result = await api(`/api/agent/drafts/${encodeURIComponent(draft.id)}/publish`, { method: 'POST', body: { actions } });
      notify?.(result.demo ? '演示模式：已模拟发布。' : '已由你的 GitHub 身份发布到 GitHub。');
      await loadDrafts();
    } catch (error) { notify?.(error.message, 'error'); }
    finally { setBusy(''); }
  }
  async function decline(draft) {
    setBusy(draft.id);
    try { await api(`/api/agent/drafts/${encodeURIComponent(draft.id)}/decline`, { method: 'POST', body: {} }); notify?.('草稿已驳回'); await loadDrafts(); }
    catch (error) { notify?.(error.message, 'error'); }
    finally { setBusy(''); }
  }

  if (!enabled) return <section className="panel"><Empty text="当前部署已关闭 Agent 接入（AGENT_ACCESS_ENABLED=false）。" /></section>;

  return <>
    <div className="page-heading">
      <div><div className="eyebrow">AGENT ACCESS</div><h1>Agent 接入</h1><p>把自己的模型 Agent 接进来：只读检索知识库、领取 Issue / PR 任务；草稿经你人工确认后才会发布。</p></div>
      <div className="heading-action">
        <Badge tone={configured ? 'teal' : 'amber'}>{configured ? '知识库已连接' : '知识库未配置'}</Badge>
        <Badge tone="neutral">人工确认后发布</Badge>
      </div>
    </div>
    <div className="tab-group agent-tabs" role="tablist">
      <button role="tab" aria-selected={tab === 'guide'} className={tab === 'guide' ? 'active' : ''} onClick={() => setTab('guide')}><Wrench size={14} />接入指南</button>
      <button role="tab" aria-selected={tab === 'tasks'} className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}><Bot size={14} />我的 Agent 任务</button>
    </div>

    {tab === 'guide' && <>
      <section className="panel agent-panel">
        <div className="panel-title-row"><div><h2><KeyRound size={18} />个人令牌</h2><p>令牌只在生成时显示一次；库里只保存哈希，可随时撤销。</p></div><Badge>{tokens.length} 个有效令牌</Badge></div>
        <form className="agent-token-form" onSubmit={createToken}>
          <input value={name} maxLength={60} onChange={event => setName(event.target.value)} placeholder="令牌名称，例如：Claude Code / 本机脚本" aria-label="令牌名称" />
          <button className="btn btn-primary btn-small" type="submit" disabled={creating}>{creating ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}{creating ? '生成中…' : '生成令牌'}</button>
        </form>
        {tokenError && <div className="agent-adaptor-status is-red" role="alert"><CircleAlert size={14} />{tokenError.message}</div>}
        {newToken && <div className="agent-token-once" role="status">
          <div><strong>请立即复制并妥善保存</strong><p>关闭页面后将无法再次查看该令牌。</p></div>
          <code>{newToken}</code>
          <button className="btn btn-secondary btn-small" onClick={() => copyText(newToken, notify)}><Copy size={13} />复制令牌</button>
        </div>}
        {tokensLoading ? <Spinner label="正在读取令牌…" compact /> : tokens.length ? <div className="agent-token-list">
          {tokens.map(token => <div className="agent-token-item" key={token.id}>
            <div><strong>{token.name}</strong><small><code>{token.prefix}…</code> · 创建于 {new Date(token.createdAt).toLocaleString('zh-CN')}{token.lastUsedAt ? ` · 最近使用 ${new Date(token.lastUsedAt).toLocaleString('zh-CN')}` : ' · 尚未使用'}</small></div>
            <button className="text-button danger-text" disabled={busy === token.id} onClick={() => revokeToken(token.id)}><Trash2 size={14} />撤销</button>
          </div>)}
        </div> : <p className="agent-muted">还没有令牌。生成一个后按下面的配置粘贴到 MCP 客户端。</p>}
      </section>

      <section className="panel agent-panel">
        <div className="panel-title-row"><div><h2><Terminal size={18} />三步接入</h2><p>先选择你使用的 Agent，页面只展示它对应的配置方式。</p></div></div>
        <ol className="agent-steps">
          <li><strong>生成令牌</strong><span>复制上方一次性显示的 <code>ask_…</code> 令牌。</span></li>
          <li><strong>选择你的 Agent</strong><span>在下方选择客户端，配置片段会自动切换到对应格式。</span></li>
          <li><strong>粘贴并验证</strong><span>{client.verify}</span></li>
        </ol>
        <div className="agent-client-groups" role="radiogroup" aria-label="选择你的 Agent">
          {CLIENT_GROUPS.map(group => <div className="agent-client-group" key={group}>
            <span>{group}</span>
            {CLIENTS.filter(entry => entry.group === group).map(entry => <button key={entry.id} type="button" role="radio" aria-checked={clientId === entry.id} className={`agent-client-chip ${clientId === entry.id ? 'active' : ''}`} onClick={() => setClientId(entry.id)}>{entry.label}</button>)}
          </div>)}
        </div>
        <p className="agent-client-path"><strong>{client.label}</strong> · {client.file}</p>
        <Snippet title={`${client.label} 配置`} code={snippet} notify={notify} />
        <p className="agent-muted">以上片段已填入当前站点地址；把令牌替换成你刚生成的即可。字段名以客户端当前版本为准，若客户端使用不同的配置键（如 <code>servers</code> / <code>context_servers</code>），按它的 MCP 导入流程粘贴命令与 env。</p>
        <p className="agent-muted">Windows 首次使用 npx 若报 <code>ENOENT ... \AppData\Roaming\npm</code>，先执行 <code>mkdir "%APPDATA%\npm"</code>，再重启 MCP 服务。</p>
      </section>

      <section className="panel agent-panel">
        <div className="panel-title-row"><div><h2><Clock3 size={18} />自动领取任务（定时任务）</h2><p>MCP 只能被客户端拉取，不会主动唤醒 Agent。配置定时任务后，平台点「交给我的 agent」即可在下一轮自动处理。</p></div><Badge tone={schedule.tone}>{schedule.badge}</Badge></div>
        <ol className="agent-steps">{schedule.steps.map((step, index) => <li key={index}><strong>{index + 1}</strong><span>{step}</span></li>)}</ol>
        {schedule.code && <Snippet title={`${client.label} 定时命令示例`} code={schedule.code} notify={notify} />}
        <Snippet title="定时任务提示词（复制到定时任务）" code={AUTO_PROMPT} notify={notify} />
        <p className="agent-muted">建议间隔不小于 10 分钟；同一任务在多轮并发时会被状态保护跳过。Agent 未运行时任务保持排队，24 小时后过期。</p>
      </section>
    </>}

    {tab === 'tasks' && <section className="panel agent-panel">
      <div className="panel-title-row"><div><h2><Bot size={18} />我的 Agent 任务</h2><p>Agent 提交草稿后会出现在这里；发布前请核对评论正文、引用与动作。</p></div><button className="btn btn-secondary btn-small" onClick={loadDrafts} disabled={draftsLoading}>刷新</button></div>
      {draftError ? <div className="agent-adaptor-status is-red" role="alert"><CircleAlert size={14} />{draftError.message}</div> : draftsLoading ? <Spinner label="正在读取草稿…" /> : !drafts.length ? <Empty text="还没有 Agent 草稿。到 Issue / PR 详情页点「交给我的 agent」创建任务。" /> : <div className="agent-draft-list">
        {drafts.map(draft => {
          const [tone, label] = DRAFT_STATUS[draft.status] || ['neutral', draft.status];
          const isOpen = expanded === draft.id;
          return <article className={`agent-draft ${isOpen ? 'is-open' : ''}`} key={draft.id}>
            <button className="agent-draft-head" onClick={() => setExpanded(isOpen ? '' : draft.id)} aria-expanded={isOpen}>
              <div><strong>#{draft.task?.number} {draft.task?.item?.title || '（标题缺失）'}</strong><small>{draft.summary || '无摘要'} · {new Date(draft.createdAt).toLocaleString('zh-CN')}{draft.agentName ? ` · Agent「${draft.agentName}」` : ''}{draft.model ? ` · ${draft.model}` : ''}</small></div>
              <Badge tone={tone}>{label}</Badge>
            </button>
            {draft.publishError && <p className="agent-adaptor-status is-red"><CircleAlert size={13} />{draft.publishError}</p>}
            {isOpen && <div className="agent-draft-body">
              <h4>Review 摘要 / 评论正文</h4>
              <Markdown text={draft.commentMd} empty="（空）" />
              {!!draft.comments?.length && <><h4>行内检视意见（{draft.comments.length} 条）</h4><div className="agent-comments">{draft.comments.map((comment, index) => <div className="agent-comment is-selected" key={index}><span><strong>{comment.path}:{comment.line} · {comment.side === 'LEFT' ? '旧代码' : '新代码'}</strong><Markdown text={comment.body} /></span></div>)}</div></>}
              {draft.rootCauseHypothesis && <><h4>根因假设</h4><p>{draft.rootCauseHypothesis}</p></>}
              {!!draft.references?.length && <><h4>引用（未自动核实）</h4><ul className="agent-refs">{draft.references.map((ref, index) => <li key={index}><Badge tone="neutral">{ref.kind}</Badge>{ref.url ? <a href={ref.url} target="_blank" rel="noreferrer">{ref.path || ref.url}<ExternalLink size={12} /></a> : <code>{ref.path}</code>}{ref.snippet && <span>{ref.snippet}</span>}</li>)}</ul></>}
              {!!draft.actions?.length && <><h4>强副作用动作（勾选后才会执行）</h4><div className="agent-actions">{draft.actions.map((action, index) => <label key={index} className="agent-action"><input type="checkbox" disabled={draft.status !== 'pending'} checked={(selected[draft.id] || []).includes(index)} onChange={() => toggleAction(draft.id, index)} /><span><strong>{ACTION_LABELS[action.kind] || action.kind}{action.value ? `：${action.value}` : ''}</strong>{action.reason && <small>{action.reason}</small>}</span></label>)}</div></>}
              <div className="agent-draft-foot">
                <span>置信度 {Math.round((draft.confidence || 0) * 100)}%</span>
                {draft.status === 'pending' ? <div>
                  <button className="btn btn-secondary btn-small" disabled={busy === draft.id} onClick={() => decline(draft)}>驳回</button>
                  <button className="btn btn-primary btn-small" disabled={busy === draft.id} onClick={() => publish(draft)}>{busy === draft.id ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}确认发布</button>
                </div> : draft.commentUrl ? <a className="external-text-link" href={draft.commentUrl} target="_blank" rel="noreferrer">查看已发布评论<ExternalLink size={12} /></a> : null}
              </div>
            </div>}
          </article>;
        })}
      </div>}
    </section>}
  </>;
}
