import { getSetting, setSetting } from './db.js';
import { fetchLatestCommitSha, fetchRepositoryFile } from './integrations/github.js';

// The repository owns its development workflow: the Agent is told to follow
// .agents/skills/aisbench-devflow/SKILL.md, and the platform pins the exact
// commit so the evidence in a PR result can be traced back to the same text.
const TTL_MS = 3600000;
const SKILL_PATH = '.agents/skills/aisbench-devflow/SKILL.md';
const REFERENCE_SKILLS = [
  { name: 'pr-checklist', path: '.agents/skills/pr-checklist/SKILL.md' },
  { name: 'ci-failure-triage', path: '.agents/skills/ci-failure-triage/SKILL.md' },
];

export async function getDevflowSkill(db, config, { force = false, token, fetchImpl = fetch } = {}) {
  const key = `agentSkill:${config.repo}:aisbench-devflow`;
  const cached = getSetting(db, key, null);
  if (!force && cached && Date.now() - Date.parse(cached.fetchedAt || '') < TTL_MS) return cached;
  if (config.demo) {
    return {
      repo: config.repo, source: 'demo', sha: '', fetchedAt: new Date().toISOString(),
      skill: { name: 'aisbench-devflow', path: SKILL_PATH, text: '演示模式未拉取技能正文，真实环境会注入仓库内 SKILL.md。' },
      references: [],
    };
  }
  const sha = await fetchLatestCommitSha({ repo: config.repo, token: token ?? config.githubToken, fetchImpl });
  const text = await fetchRepositoryFile({ repo: config.repo, path: SKILL_PATH, ref: sha, token: token ?? config.githubToken, fetchImpl });
  const references = [];
  for (const reference of REFERENCE_SKILLS) {
    try {
      const referenceText = await fetchRepositoryFile({
        repo: config.repo, path: reference.path, ref: sha, token: token ?? config.githubToken, fetchImpl,
      });
      references.push({
        name: reference.name,
        path: reference.path,
        url: `https://github.com/${config.repo}/blob/${sha}/${reference.path}`,
        text: referenceText.slice(0, 20000),
      });
    } catch { /* a missing optional reference must not block the task */ }
  }
  const payload = {
    repo: config.repo,
    source: 'github',
    sha,
    fetchedAt: new Date().toISOString(),
    skill: { name: 'aisbench-devflow', path: SKILL_PATH, text: text.slice(0, 60000) },
    references,
  };
  setSetting(db, key, payload);
  return payload;
}
