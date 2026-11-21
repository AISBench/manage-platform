import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERVER_KEY = 'aisbench';

function candidates() {
  const home = os.homedir();
  return [
    path.join(home, '.cursor', 'mcp.json'),
    path.join(home, '.windsurf', 'mcp.json'),
    path.join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    path.join(home, '.config', 'Code', 'User', 'mcp.json'),
  ];
}

function entry(url, token) {
  return { command: 'npx', args: ['-y', 'aisbench-mcp'], env: { AISBENCH_URL: url, AISBENCH_TOKEN: token } };
}

export function configSnippet(url, token) {
  return JSON.stringify({ mcpServers: { [SERVER_KEY]: entry(url, token) } }, null, 2);
}

export function init({ url, token, write = false, stdout = process.stdout } = {}) {
  if (!url || !token) throw new Error('需要提供 --url 与 --token，或设置 AISBENCH_URL / AISBENCH_TOKEN');
  const targets = candidates().filter(file => existsSync(file));
  const snippet = configSnippet(url.replace(/\/+$/, ''), token);
  if (!write || !targets.length) {
    stdout.write(`${snippet}\n`);
    if (!targets.length) stdout.write('\n未检测到已安装的 MCP 客户端配置，请把上面的 JSON 粘贴到你的客户端。\n');
    return { written: [] };
  }
  const written = [];
  for (const file of targets) {
    let data = {};
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { data = {}; }
    data.mcpServers = data.mcpServers || {};
    data.mcpServers[SERVER_KEY] = entry(url.replace(/\/+$/, ''), token);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    written.push(file);
  }
  stdout.write(`${snippet}\n\n已写入：\n${written.map(file => `- ${file}`).join('\n')}\n`);
  return { written };
}
