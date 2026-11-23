import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { PlatformClient } from './client.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const asText = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

const draftShape = {
  kind: z.enum(['item_comment', 'issue_create', 'pr_result']).optional().describe('草稿类型；以任务上下文里的 kind 为准'),
  summary: z.string().max(500).optional().describe('一句话结论'),
  root_cause_hypothesis: z.string().max(2000).optional().describe('分析 / 根因假设；PR 检视时可写检视结论，依据不足时留空'),
  comment_md: z.string().max(20000).optional().describe('Issue 评论正文；PR 检视时作为 Review 摘要（600 字以内）；issue_create / pr_result 草稿留空'),
  comments: z.array(z.object({
    path: z.string().min(1).max(500).describe('变更文件路径'),
    line: z.number().int().min(1).describe('RIGHT 用新文件行号，LEFT 用旧文件行号'),
    side: z.enum(['LEFT', 'RIGHT']).optional().describe('默认 RIGHT'),
    start_line: z.number().int().min(1).optional().describe('多行意见的起始行'),
    body: z.string().min(1).max(4000).describe('严格使用「[review] [严重程度] 具体问题」换行「[suggestion] 可行解决方式」，严重程度建议 blocker/major/minor/nit'),
  })).max(20).optional().describe('PR 行内检视意见；普通 Issue 处理与 issue_create / pr_result 时留空'),
  actions: z.array(z.object({
    kind: z.enum(['add_label', 'remove_label', 'assign', 'close', 'reopen']),
    value: z.string().max(100).optional(),
    reason: z.string().max(500).optional(),
  })).max(10).optional().describe('强副作用动作，需人工勾选后才会执行'),
  references: z.array(z.object({
    kind: z.enum(['file', 'wiki', 'commit']),
    path: z.string().max(500).optional(),
    url: z.string().max(500).optional(),
    snippet: z.string().max(1000).optional(),
  })).max(20).optional().describe('真实出处；不联网核实'),
  confidence: z.number().min(0).max(1).optional(),
  model: z.string().max(100).optional().describe('生成草稿所用模型'),
  // ---- issue_create ----
  templateId: z.string().max(100).optional().describe('issue_create：使用的 Issue 模板 id'),
  title: z.string().max(300).optional().describe('issue_create：Issue 标题（包含模板要求的前缀）'),
  fields: z.record(z.string(), z.union([z.string().max(20000), z.array(z.string().max(200)).max(30)])).optional().describe('issue_create：按模板字段 id 填写的内容'),
  labels: z.array(z.string().max(100)).max(20).optional().describe('issue_create：必须包含模板全部标签，可补充仓库已有标签'),
  supplement: z.string().max(5000).optional().describe('issue_create：模板外的补充说明'),
  dedupe: z.object({
    queries: z.array(z.string().max(200)).min(2).max(6),
    candidates: z.array(z.object({
      number: z.number().int().min(1),
      title: z.string().max(500).default(''),
      url: z.string().max(500).default(''),
      state: z.string().max(20).default(''),
      similarity: z.number().min(0).max(1).optional(),
    }).strict()).min(3).max(20),
    conclusion: z.literal('not_duplicate'),
    rationale: z.string().min(40).max(2000),
  }).strict().optional().describe('issue_create：查重检索词、候选与不重复理由'),
  // ---- pr_result ----
  issueNumber: z.number().int().min(1).optional().describe('pr_result：关联的 Issue 编号'),
  prUrl: z.string().max(500).optional().describe('pr_result：PR 链接'),
  prNumber: z.number().int().min(1).optional().describe('pr_result：PR 编号'),
  headSha: z.string().regex(/^[a-fA-F0-9]{7,64}$/).optional().describe('pr_result：提交 PR 时的 head commit'),
  baseRef: z.string().max(200).optional().describe('pr_result：目标分支'),
  headRef: z.string().max(200).optional().describe('pr_result：来源分支'),
  forkOwner: z.string().max(100).optional().describe('pr_result：fork 所有者'),
  prTitle: z.string().max(300).optional().describe('pr_result：PR 标题'),
  gate: z.array(z.object({
    name: z.string().min(1).max(80),
    status: z.enum(['PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE']),
    evidence: z.string().max(2000).default(''),
  }).strict()).max(20).optional().describe('pr_result：本地门禁结论与证据'),
  unverified: z.array(z.string().max(500)).max(20).optional().describe('pr_result：未验证项，必须如实列出'),
};

export function createMcpServer(client) {
  const server = new McpServer({ name: 'aisbench-mcp', version });

  server.tool(
    'aisbench_task_list',
    '列出平台派给当前令牌成员、等待处理的 Issue / PR 任务（queued/claimed）。带 replyTo 的任务表示回复某条行内检视意见。',
    {},
    async () => asText(await client.tasks()),
  );

  server.tool(
    'aisbench_task_claim',
    '领取一个任务（幂等）。领取后可读取上下文并提交草稿。',
    { taskId: z.string().min(1) },
    async ({ taskId }) => asText(await client.claim(taskId)),
  );

  server.tool(
    'aisbench_issue_context',
    '读取一条 Issue / PR 的白名单事实（标题/正文/评论/timeline；PR 另含元数据与变更文件 patch）；带 replyTo 的任务还会返回目标评论或检视意见与线程历史。不含平台内部字段。优先用 itemId；也可用 repo+number 匹配已派发的任务。',
    { itemId: z.string().optional(), repo: z.string().optional(), number: z.number().int().positive().optional() },
    async ({ itemId, repo, number }) => {
      if (itemId) {
        const tasks = (await client.tasks()).tasks || [];
        const task = tasks.find(entry => entry.itemId === itemId);
        if (task) return asText(await client.taskContext(task.id));
        return asText(await client.itemContext(itemId));
      }
      if (repo && number) {
        const tasks = (await client.tasks()).tasks || [];
        const task = tasks.find(entry => entry.repo === repo && Number(entry.number) === Number(number));
        if (task) return asText({ task, context: await client.taskContext(task.id) });
        throw new Error('未找到该 Issue / PR 的待处理任务；请提供 itemId 或先在平台创建 Agent 任务');
      }
      throw new Error('需要 itemId，或同时提供 repo 和 number');
    },
  );

  server.tool(
    'aisbench_kb_search',
    '只检索知识库（deepwiki），返回文件路径、行号与片段；不会生成答案。请基于片段自行推理并给出来源。',
    {
      repo: z.string().min(1).describe('owner/name'),
      question: z.string().min(1).max(2000),
      topK: z.number().int().min(1).max(12).optional(),
    },
    async ({ repo, question, topK }) => asText(await client.kbSearch({ repo, question, topK })),
  );

  server.tool(
    'aisbench_kb_wiki',
    '读取仓库知识库中某个 wiki 页面的 markdown 正文（按标题/主题匹配）。',
    { repo: z.string().min(1), topic: z.string().min(1).max(200) },
    async ({ repo, topic }) => asText(await client.kbWiki({ repo, topic })),
  );

  server.tool(
    'aisbench_issue_templates',
    '读取目标仓库的 Issue 模板（GitHub issue forms）：模板 id、标题前缀、默认标签与必填字段。提 Issue 前先调用。',
    {},
    async () => asText(await client.issueTemplates()),
  );

  server.tool(
    'aisbench_issue_search',
    '检索仓库已有 Issue 用于查重：返回编号、标题、状态、链接、正文片段与标签。只查询当前配置的仓库。',
    {
      query: z.string().min(1).max(200),
      state: z.enum(['open', 'closed', 'all']).optional(),
      label: z.string().max(100).optional(),
    },
    async ({ query, state, label }) => asText(await client.issueSearch({ query, state, label })),
  );

  server.tool(
    'aisbench_task_submit',
    '提交 Agent 草稿。任务 kind=item_review 时提交 Issue 评论或 PR 检视；kind=issue_create 时提交 Issue 草稿（模板字段/标签/查重）；kind=pr_create 时提交 PR 结果（PR 链接、head_sha、门禁证据）。提交只进入平台人工审阅，不会立即发布到 GitHub。',
    { taskId: z.string().min(1), draft: z.object(draftShape) },
    async ({ taskId, draft }) => asText(await client.submit(taskId, draft)),
  );

  return server;
}

export async function serveFromEnv(env = process.env) {
  const client = new PlatformClient({ baseUrl: env.AISBENCH_URL, token: env.AISBENCH_TOKEN, timeoutMs: Number(env.AISBENCH_TIMEOUT_MS || 30000) });
  const server = createMcpServer(client);
  await server.connect(new StdioServerTransport());
  return server;
}
