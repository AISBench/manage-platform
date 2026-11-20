# aisbench-mcp

把 AISBench Triage 平台接入任意支持 MCP 的 Agent 客户端（Claude Code、Cursor、Windsurf、VS Code、Cline、Roo、Continue、Zed、Codex CLI 等）。

- 只读：Issue / PR 上下文、知识库检索（不生成答案）、任务列表
- 唯一写操作：提交草稿，**提交后仍需成员在平台人工确认才会发布到 GitHub**

## 1. 生成令牌

登录 <https://aisbench.cn> → 左侧「Agent 接入」→ 生成令牌。令牌形如 `ask_...`，只显示一次。

## 2. 配置客户端

通用 JSON（Claude Desktop / Cursor / Windsurf / VS Code / Cline / Roo / Kilo / Continue / Zed）：

```json
{
  "mcpServers": {
    "aisbench": {
      "command": "npx",
      "args": ["-y", "aisbench-mcp"],
      "env": {
        "AISBENCH_URL": "https://aisbench.cn",
        "AISBENCH_TOKEN": "ask_你的令牌"
      }
    }
  }
}
```

需要固定版本时把 `aisbench-mcp` 换成 `aisbench-mcp@0.1.0`。

Claude Code：

```bash
claude mcp add aisbench \
  --env AISBENCH_URL=https://aisbench.cn \
  --env AISBENCH_TOKEN=ask_你的令牌 \
  -- npx -y aisbench-mcp
```

Codex CLI（`~/.codex/config.toml`）：

```toml
[mcp_servers.aisbench]
command = "npx"
args = ["-y", "aisbench-mcp"]

[mcp_servers.aisbench.env]
AISBENCH_URL = "https://aisbench.cn"
AISBENCH_TOKEN = "ask_你的令牌"
```

也可以让本工具探测并写入本机已有客户端配置：

```bash
AISBENCH_URL=https://aisbench.cn AISBENCH_TOKEN=ask_xxx npx -y aisbench-mcp init --write
```

## 3. 工具

| 工具 | 说明 |
| --- | --- |
| `aisbench_task_list` | 列出等待处理的 Agent 任务（Issue / PR；带 `replyTo` 表示回复某条评论或检视意见） |
| `aisbench_task_claim` | 领取任务（幂等） |
| `aisbench_issue_context` | Issue / PR 白名单事实（PR 含变更文件与 patch；带 `replyTo` 时含目标评论或检视意见与线程历史） |
| `aisbench_kb_search` | 只检索知识库，返回路径/行号/片段 |
| `aisbench_kb_wiki` | 读取 wiki 页面正文 |
| `aisbench_task_submit` | 提交草稿（PR 检视需带多条 `comments` 行内意见；进入人工审阅，不直接发布） |

## 4. 常见问题

### Windows 首次使用 npx 报 `ENOENT ... AppData\Roaming\npm`

这是本机缺少 npm 全局目录，不是 MCP 包本身的问题。先创建目录再重试：

```powershell
New-Item -ItemType Directory -Force "$env:APPDATA\npm" | Out-Null
```

然后重启客户端的 MCP 服务。

## 5. 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AISBENCH_URL` | 是 | 平台地址，如 `https://aisbench.cn` |
| `AISBENCH_TOKEN` | 是 | 个人访问令牌 |
| `AISBENCH_TIMEOUT_MS` | 否 | 请求超时，默认 30000 |
