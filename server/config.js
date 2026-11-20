import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

function validKey(key) {
  return typeof key === 'string' && key.length > 0 && Buffer.from(key, 'base64').length === 32;
}

// Keep zero-config deployments usable without making tokens undecryptable on
// every restart: generate once next to the database and reuse that file.
export function ensureTokenEncryptionKey(config) {
  if (config.demo) return '';
  if (config.tokenEncryptionKey) {
    if (!validKey(config.tokenEncryptionKey)) throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    return config.tokenEncryptionKey;
  }
  const file = path.join(path.dirname(config.dbPath), 'token-encryption.key');
  if (existsSync(file)) {
    const key = readFileSync(file, 'utf8').trim();
    if (!validKey(key)) throw new Error(`Invalid token encryption key file: ${file}`);
    config.tokenEncryptionKey = key;
    config.tokenEncryptionKeyFile = file;
    return key;
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const key = randomBytes(32).toString('base64');
    writeFileSync(file, `${key}\n`, { mode: 0o600 });
    config.tokenEncryptionKey = key;
    config.tokenEncryptionKeyFile = file;
    config.tokenEncryptionKeyGenerated = true;
    return key;
  } catch {
    console.warn(`Unable to create ${file}; GitHub write tokens stay disabled until TOKEN_ENCRYPTION_KEY is configured.`);
    return '';
  }
}

export function loadConfig(env = process.env) {
  const demo=env.DEMO_MODE==='true', port=Number(env.PORT || 3210);
  if (!Number.isInteger(port) || port<1 || port>65535) throw new Error('Invalid PORT');
  const base=new URL(env.BASE_URL || `http://127.0.0.1:${port}`);
  if (!['http:','https:'].includes(base.protocol) || base.username || base.password || base.pathname!=='/' || base.search || base.hash) throw new Error('BASE_URL must be an HTTP(S) origin without credentials or path');
  const list=value=>(value || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  const issueMasterUrl=(env.AGENT_ADAPTOR_URL || env.ISSUE_MASTER_URL || '').trim().replace(/\/+$/,'');
  const issueMasterTimeoutMs=Number(env.AGENT_ADAPTOR_TIMEOUT_MS || env.ISSUE_MASTER_TIMEOUT_MS || 15000);
  if (issueMasterUrl) {
    let parsed;try {parsed=new URL(issueMasterUrl);} catch {throw new Error('AGENT_ADAPTOR_URL must be a valid HTTP(S) URL');}
    if (!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash) throw new Error('AGENT_ADAPTOR_URL must not contain credentials, query or hash');
  }
  if (!Number.isInteger(issueMasterTimeoutMs)||issueMasterTimeoutMs<1000||issueMasterTimeoutMs>120000) throw new Error('AGENT_ADAPTOR_TIMEOUT_MS must be an integer from 1000 to 120000');
  const agentMcpCommand=(env.AGENT_MCP_COMMAND || 'npx').trim();
  if (!agentMcpCommand) throw new Error('AGENT_MCP_COMMAND must not be empty');
  let agentMcpArgs=['-y','aisbench-mcp'];
  if (env.AGENT_MCP_ARGS) {
    try {
      const parsed=JSON.parse(env.AGENT_MCP_ARGS);
      if (!Array.isArray(parsed)||parsed.some(value=>typeof value!=='string'||!value)) throw new Error();
      agentMcpArgs=parsed;
    } catch { throw new Error('AGENT_MCP_ARGS must be a JSON array of non-empty strings'); }
  }
  const config={
    demo,port,baseUrl:base.origin,host:env.HOST || '127.0.0.1',secure:base.protocol==='https:',
    dbPath:path.resolve(env.DATA_DIR || 'data',demo?'demo.sqlite':'platform.sqlite'),
    repo:env.GITHUB_REPO || 'AISBench/benchmark',
    githubClientId:env.GITHUB_CLIENT_ID || '',githubClientSecret:env.GITHUB_CLIENT_SECRET || '',
    githubToken:env.GITHUB_TOKEN || '',webhookSecret:env.GITHUB_WEBHOOK_SECRET || '',
    githubActionsToken:env.GITHUB_ACTIONS_TOKEN || '',
    githubOAuthScope:env.GITHUB_OAUTH_SCOPE || 'read:user public_repo',
    tokenEncryptionKey:env.TOKEN_ENCRYPTION_KEY || '',
    conversationPollMinutes:Number(env.CONVERSATION_POLL_MINUTES || 5),
    feishuAppId:env.FEISHU_APP_ID || '',feishuAppSecret:env.FEISHU_APP_SECRET || '',
    // Optional platform-agent-adaptor integration. Both URL and token are required.
    issueMasterUrl,issueMasterToken:env.AGENT_ADAPTOR_TOKEN || env.ISSUE_MASTER_TOKEN || '',issueMasterTimeoutMs,
    // How MCP clients should start the aisbench server. Defaults to the published
    // npm package; local/source deployments set node + the local cli.js path.
    agentMcpCommand,agentMcpArgs,
    // Agent access (personal tokens + task/draft API). Disabled only by explicit opt-out.
    agentEnabled:env.AGENT_ACCESS_ENABLED !== 'false',
    // Legacy migration inputs ONLY. These never grant access or overwrite database roles.
    admins:list(env.ADMIN_GITHUB_LOGINS),allowed:list(env.ALLOWED_GITHUB_LOGINS),
    syncIntervalMs:Number(env.SYNC_INTERVAL_MINUTES || 10)*60000,
    trustProxy:env.TRUST_PROXY || false,
    eventRetentionDays:Number(env.EVENT_RETENTION_DAYS || 30),
    recordRetentionDays:Number(env.RECORD_RETENTION_DAYS || 180),
  };
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repo) || config.repo.split('/').some(v=>v==='.'||v==='..')) throw new Error('Invalid GITHUB_REPO');
  if (!Number.isFinite(config.syncIntervalMs) || config.syncIntervalMs<60000) throw new Error('SYNC_INTERVAL_MINUTES must be >=1');
  if (!Number.isInteger(config.conversationPollMinutes) || config.conversationPollMinutes < 1 || config.conversationPollMinutes > 1440) throw new Error('CONVERSATION_POLL_MINUTES must be an integer from 1 to 1440');
  if ([config.eventRetentionDays,config.recordRetentionDays].some(n=>!Number.isInteger(n)||n<1||n>3650)) throw new Error('Retention days must be integers from 1 to 3650');
  if (['true','1'].includes(String(config.trustProxy).toLowerCase())) throw new Error('TRUST_PROXY must be an explicit trusted proxy address/subnet, not true or hop count');
  if (!demo && (!config.githubClientId || !config.githubClientSecret)) throw new Error('Production requires GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET. Initialize members using the local CLI. Use npm run demo for preview.');
  if (env.NODE_ENV==='production' && demo) throw new Error('DEMO_MODE is forbidden with NODE_ENV=production');
  if (env.NODE_ENV==='production' && !config.secure) throw new Error('Production BASE_URL must use HTTPS');
  return config;
}
