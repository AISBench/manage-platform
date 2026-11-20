// MCP smoke test: spawns the stdio server and calls every tool against a
// running platform instance. Requires AISBENCH_URL, AISBENCH_TOKEN and TASK_ID.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { AISBENCH_URL, AISBENCH_TOKEN, TASK_ID, ITEM_ID = 'github:101' } = process.env;
if (!AISBENCH_URL || !AISBENCH_TOKEN || !TASK_ID) {
  console.error('需要 AISBENCH_URL / AISBENCH_TOKEN / TASK_ID');
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(root, 'bin', 'cli.js'), 'serve'],
  env: { ...process.env, AISBENCH_URL, AISBENCH_TOKEN },
  stderr: 'inherit',
});
const client = new Client({ name: 'aisbench-smoke', version: '1.0.0' });
await client.connect(transport);

function textOf(result) {
  return (result.content || []).map(part => part.text || '').join('\n');
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

const { tools } = await client.listTools();
const names = tools.map(tool => tool.name).sort();
assert(names.includes('aisbench_kb_search') && names.includes('aisbench_task_submit') && tools.length === 6, `tools/list 返回 6 个工具：${names.join(', ')}`);

const tasks = JSON.parse(textOf(await client.callTool({ name: 'aisbench_task_list', arguments: {} })));
assert(Array.isArray(tasks.tasks) && tasks.tasks.some(task => task.id === TASK_ID), 'task_list 能看到待处理任务');

const claimed = JSON.parse(textOf(await client.callTool({ name: 'aisbench_task_claim', arguments: { taskId: TASK_ID } })));
assert(claimed.ok === true, 'task_claim 幂等领取成功');

const context = JSON.parse(textOf(await client.callTool({ name: 'aisbench_issue_context', arguments: { itemId: ITEM_ID } })));
assert(context.number === 101 && !('workflow' in context) && !('priority' in context), 'issue_context 返回白名单事实');

const search = JSON.parse(textOf(await client.callTool({ name: 'aisbench_kb_search', arguments: { repo: 'AISBench/benchmark', question: '评测结果 JSON 有哪些字段', topK: 2 } })));
assert(Array.isArray(search.chunks) && search.chunks.length > 0 && search.chunks[0].path, 'kb_search 返回带路径的片段');

const submitted = JSON.parse(textOf(await client.callTool({
  name: 'aisbench_task_submit',
  arguments: { taskId: TASK_ID, draft: { summary: 'MCP 冒烟草稿', comment_md: '这是 MCP 冒烟测试草稿，不会自动发布。', references: [{ kind: 'file', path: search.chunks[0].path }], confidence: 0.3, model: 'smoke' } },
})));
assert(submitted.draft?.status === 'pending', 'task_submit 生成待审阅草稿');

await client.close();
console.log('MCP_SMOKE_OK');
