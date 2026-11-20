#!/usr/bin/env node
import { init } from '../src/init.js';
import { serveFromEnv } from '../src/server.js';

function usage() {
  process.stderr.write(`aisbench-mcp\n\n用法：\n  aisbench-mcp serve            通过 stdio 启动 MCP 服务（AISBENCH_URL / AISBENCH_TOKEN）\n  aisbench-mcp init [--write]   输出（或写入）客户端 MCP 配置\n     --url <url> --token <ask_...>\n\n示例：\n  AISBENCH_URL=https://aisbench.cn AISBENCH_TOKEN=ask_xxx npx -y aisbench-mcp serve\n`);
}

const [command = 'serve', ...rest] = process.argv.slice(2);

function option(name) {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : '';
}

if (command === 'serve') {
  try {
    await serveFromEnv(process.env);
  } catch (error) {
    process.stderr.write(`aisbench-mcp 启动失败：${error.message}\n`);
    process.exit(1);
  }
} else if (command === 'init') {
  try {
    init({
      url: option('url') || process.env.AISBENCH_URL,
      token: option('token') || process.env.AISBENCH_TOKEN,
      write: rest.includes('--write'),
    });
  } catch (error) {
    process.stderr.write(`aisbench-mcp init 失败：${error.message}\n`);
    process.exit(1);
  }
} else {
  usage();
  process.exit(2);
}
