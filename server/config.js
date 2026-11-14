import path from 'node:path';

export function loadConfig(env = process.env) {
  const demo=env.DEMO_MODE==='true', port=Number(env.PORT || 3210);
  if (!Number.isInteger(port) || port<1 || port>65535) throw new Error('Invalid PORT');
  const base=new URL(env.BASE_URL || `http://127.0.0.1:${port}`);
  if (!['http:','https:'].includes(base.protocol) || base.username || base.password || base.pathname!=='/' || base.search || base.hash) throw new Error('BASE_URL must be an HTTP(S) origin without credentials or path');
  const list=value=>(value || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
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
