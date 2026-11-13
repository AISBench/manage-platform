import { createHmac, timingSafeEqual } from 'node:crypto';
import { IntegrationError, requestJson, requiredString } from './http.js';

const API = 'https://api.github.com';
const PAGE_LIMIT = 1000; // Fail instead of publishing a silently truncated sync.
export function identityId(value) {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}
const strings = (values, select) => [...new Set((Array.isArray(values) ? values : []).map(select).filter(value => typeof value === 'string' && value))];

export function normalizeIssue(issue, pull) {
  if (!issue || !Number.isSafeInteger(issue.number) || issue.number < 1 || !['open', 'closed'].includes(issue.state)) {
    throw new IntegrationError('GitHub returned invalid issue data');
  }
  const isPR = Boolean(issue.pull_request || pull);
  const item = {
    id: `github:${issue.number}`,
    number: issue.number,
    kind: isPR ? 'pr' : 'issue',
    title: typeof issue.title === 'string' ? issue.title : '',
    body: typeof issue.body === 'string' ? issue.body : '',
    url: typeof issue.html_url === 'string' ? issue.html_url : '',
    state: issue.state,
    author: issue.user?.login || '',
    authorId: identityId(issue.user?.id),
    assignees: strings(issue.assignees, user => user?.login),
    assigneeIds: strings(issue.assignees, user => identityId(user?.id)),
    reviewers: strings(pull?.requested_reviewers ?? issue.requested_reviewers, user => user?.login),
    reviewerIds: strings(pull?.requested_reviewers ?? issue.requested_reviewers, user => identityId(user?.id)),
    labels: strings(issue.labels, label => typeof label === 'string' ? label : label?.name),
    updatedAt: issue.updated_at ?? null,
    createdAt: issue.created_at ?? null,
    ciStatus: null,
  };
  if (isPR) {
    item.draft = Boolean(pull?.draft ?? issue.draft);
    item.mergeableState = typeof pull?.mergeable_state === 'string' ? pull.mergeable_state : 'unknown';
    if (typeof pull?.head?.sha === 'string' && /^[a-fA-F0-9]{7,64}$/.test(pull.head.sha)) item.headSha = pull.head.sha;
    if (pull?.merged_at || issue.pull_request?.merged_at) item.merged = true;
  }
  return item;
}

export function verifyGitHubSignature(rawBody, signature, secret) {
  if (typeof secret !== 'string' || !secret || typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody) && !(rawBody instanceof Uint8Array)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(signature.slice(7), 'hex');
  return timingSafeEqual(expected, actual);
}

function nextPage(headers, current, initial, count, pagination) {
  const link = headers?.get?.('link');
  if (link) {
    for (const entry of link.split(',')) {
      const match = entry.match(/^\s*<([^>]+)>\s*;(.*)$/);
      if (!match || !/\brel\s*=\s*(?:"[^"]*\bnext\b[^"]*"|next)(?:\s*;|\s*$)/i.test(match[2])) continue;
      let target;
      try { target = new URL(match[1], current); } catch { throw new IntegrationError('GitHub returned invalid pagination'); }
      // GitHub canonicalizes /repos/{owner}/{repo}/... to the numeric
      // /repositories/{id}/... alias in Link headers (including cursor links).
      // Allow only the identical resource suffix, and pin the first canonical
      // repository ID so later pages cannot switch to another repository.
      if (target.origin !== API || target.username || target.password || target.hash) {
        throw new IntegrationError('GitHub returned unsafe pagination');
      }
      if (target.pathname !== initial.pathname) {
        const original = initial.pathname.match(/^\/repos\/[^/]+\/[^/]+(\/.*)$/);
        const canonical = target.pathname.match(/^\/repositories\/([1-9]\d*)(\/.*)$/);
        if (!original || !canonical || canonical[2] !== original[1] || (pagination.canonicalPath && pagination.canonicalPath !== target.pathname)) {
          throw new IntegrationError('GitHub returned unsafe pagination');
        }
        pagination.canonicalPath = target.pathname;
      }
      for (const [key, value] of initial.searchParams) {
        if (key !== 'page' && target.searchParams.get(key) !== value) throw new IntegrationError('GitHub returned inconsistent pagination');
      }
      return target;
    }
    return null;
  }
  // GitHub supplies Link, but this fallback also supports compliant proxies
  // that omit it. One extra empty request is safe when exactly 100 results.
  if (count === 100) {
    const target = new URL(current);
    target.searchParams.set('page', String(Number(current.searchParams.get('page') || 1) + 1));
    return target;
  }
  return null;
}

async function paginate(url, request, select) {
  const initial = new URL(url);
  let current = initial;
  const visited = new Set();
  const pagination = { canonicalPath: null };
  const all = [];
  while (current) {
    if (visited.has(current.href) || visited.size >= PAGE_LIMIT) throw new IntegrationError('GitHub pagination limit or loop detected');
    visited.add(current.href);
    const { data, headers } = await request(current.href);
    const entries = select(data);
    if (!Array.isArray(entries)) throw new IntegrationError('GitHub returned invalid list data');
    all.push(...entries);
    current = nextPage(headers, current, initial, entries.length, pagination);
  }
  return all;
}

function checkState(run) {
  if (run?.status !== 'completed') return 'pending';
  if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'].includes(run.conclusion)) return 'failure';
  if (['success', 'neutral', 'skipped'].includes(run.conclusion)) return 'success';
  return 'unknown';
}

async function ciStatus(base, sha, request) {
  if (typeof sha !== 'string' || !/^[a-fA-F0-9]{7,64}$/.test(sha)) throw new IntegrationError('GitHub returned invalid PR head');
  const states = [];
  for (const type of ['status', 'check-runs']) {
    try {
      const path = `${base}/commits/${sha}/${type}?per_page=100&page=1${type === 'check-runs' ? '&filter=latest' : ''}`;
      const entries = await paginate(path, request, data => type === 'status' ? data.statuses : data.check_runs);
      if (type === 'status') {
        // The combined status lists newest statuses first. Ignore superseded
        // statuses for the same context, including those on subsequent pages.
        const seen = new Set();
        for (const status of entries) {
          if (seen.has(status.context)) continue;
          seen.add(status.context);
          states.push(['failure', 'error'].includes(status.state) ? 'failure' : status.state === 'success' ? 'success' : status.state === 'pending' ? 'pending' : 'unknown');
        }
      } else {
        const latest = new Map();
        for (const run of entries) {
          const key = `${run.app?.id ?? ''}:${run.name}`;
          if (!latest.has(key) || (run.id ?? 0) > (latest.get(key).id ?? 0)) latest.set(key, run);
        }
        states.push(...[...latest.values()].map(checkState));
      }
    } catch (error) {
      if (error instanceof IntegrationError && error.status === 403 && !error.retryAt) states.push('unknown');
      else throw error;
    }
  }
  if (states.includes('failure')) return 'failure';
  if (states.includes('pending')) return 'pending';
  if (!states.length || states.includes('unknown')) return 'unknown';
  return 'success';
}

export async function fetchRepositoryItems({ repo, token, fetchImpl = fetch, timeoutMs = 10000 }) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) {
    throw new IntegrationError('Invalid GitHub repository');
  }
  if (token !== undefined && token !== null && token !== '') requiredString(token, 'GitHub token');
  const base = `${API}/repos/${repo}`;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'aisbench-triage' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const request = url => requestJson(url, { fetchImpl, timeoutMs, headers, method: 'GET', label: 'GitHub' });
  const issues = await paginate(`${base}/issues?state=all&per_page=100&page=1`, request, data => data);
  const items = new Map();
  // Deliberately sequential: bounded API concurrency avoids a rate-limit burst
  // on larger repositories. Only open PRs need live review/check enrichment.
  for (const issue of issues) {
    // Validate the core issue before using its number in any request path.
    let item = normalizeIssue(issue);
    let pull;
    if (issue.pull_request && issue.state === 'open') {
      ({ data: pull } = await request(`${base}/pulls/${issue.number}`));
      if (pull.number !== issue.number || !Array.isArray(pull.requested_reviewers) || !pull.head?.sha) {
        throw new IntegrationError('GitHub returned invalid pull request data');
      }
    }
    if (pull) {
      item = normalizeIssue(issue, pull);
      item.ciStatus = await ciStatus(base, pull.head.sha, request);
    }
    // Concurrent changes during pagination can repeat an issue; keep one row.
    items.set(item.id, item);
  }
  return [...items.values()];
}

function repoBase(repo) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) {
    throw new IntegrationError('Invalid GitHub repository');
  }
  return `${API}/repos/${repo}`;
}
function issueNumber(number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new IntegrationError('Invalid GitHub issue number');
  return number;
}
function refValue(ref) {
  if (typeof ref !== 'string' || !/^[a-fA-F0-9]{7,64}$/.test(ref)) throw new IntegrationError('GitHub returned invalid PR head');
  return ref;
}
function reader(repo, token, fetchImpl, timeoutMs = 15000) {
  const base = repoBase(repo);
  if (token !== undefined && token !== null && token !== '') requiredString(token, 'GitHub token');
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'aisbench-triage' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return { base, request: url => requestJson(url, { fetchImpl, timeoutMs, headers, method: 'GET', label: 'GitHub' }) };
}

export async function fetchIssueComments({ repo, number, token, fetchImpl = fetch }) {
  const { base, request } = reader(repo, token, fetchImpl);
  return paginate(`${base}/issues/${issueNumber(number)}/comments?per_page=100&page=1`, request, data => data);
}
export async function fetchPullReviews({ repo, number, token, fetchImpl = fetch }) {
  const { base, request } = reader(repo, token, fetchImpl);
  return paginate(`${base}/pulls/${issueNumber(number)}/reviews?per_page=100&page=1`, request, data => data);
}
export async function fetchPullReviewComments({ repo, number, token, fetchImpl = fetch }) {
  const { base, request } = reader(repo, token, fetchImpl);
  return paginate(`${base}/pulls/${issueNumber(number)}/comments?per_page=100&page=1`, request, data => data);
}
export async function fetchIssueTimeline({ repo, number, token, fetchImpl = fetch }) {
  const { base, request } = reader(repo, token, fetchImpl);
  return paginate(`${base}/issues/${issueNumber(number)}/timeline?per_page=100&page=1`, request, data => data);
}
export async function fetchPullRequestDetail({ repo, number, token, fetchImpl = fetch }) {
  const { base, request } = reader(repo, token, fetchImpl);
  const { data } = await request(`${base}/pulls/${issueNumber(number)}`);
  if (!data || data.number !== number) throw new IntegrationError('GitHub returned invalid pull request data');
  return data;
}
export async function fetchPullCheckRuns({ repo, ref, token, fetchImpl = fetch }) {
  const { base, request } = reader(repo, token, fetchImpl);
  return paginate(`${base}/commits/${refValue(ref)}/check-runs?per_page=100&page=1&filter=latest`, request, data => data.check_runs);
}
export async function fetchCommitStatuses({ repo, ref, token, fetchImpl = fetch }) {
  const { base, request } = reader(repo, token, fetchImpl);
  return paginate(`${base}/commits/${refValue(ref)}/statuses?per_page=100&page=1`, request, data => data);
}

export async function createIssueComment({ repo, number, token, body, fetchImpl = fetch }) {
  const { base } = reader(repo, token, fetchImpl, 20000);
  if (typeof body !== 'string' || !body.trim() || body.length > 65536 || body.includes('\u0000')) throw new IntegrationError('Invalid GitHub comment');
  requiredString(token, 'GitHub write token');
  const headers = { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'aisbench-triage', Authorization: `Bearer ${token}` };
  const { data } = await requestJson(`${base}/issues/${issueNumber(number)}/comments`, {
    fetchImpl, timeoutMs: 20000, headers, method: 'POST', body: JSON.stringify({ body }), label: 'GitHub comment',
  });
  if (!data || !Number.isSafeInteger(data.id) || typeof data.html_url !== 'string' || typeof data.created_at !== 'string') {
    throw new IntegrationError('GitHub returned invalid comment data');
  }
  return data;
}

// Re-run all jobs of a GitHub Actions workflow run. The endpoint answers 201
// with an empty body, so requestJson (which requires JSON) cannot be reused.
export async function rerunGitHubWorkflow({ repo, runId, token, fetchImpl = fetch }) {
  const base = repoBase(repo);
  requiredString(token, 'GitHub write token');
  if (!Number.isSafeInteger(runId) || runId < 1) throw new IntegrationError('Invalid workflow run');
  const headers = {
    Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'aisbench-triage', Authorization: `Bearer ${token}`,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    let response;
    try {
      response = await fetchImpl(`${base}/actions/runs/${runId}/rerun`, {
        method: 'POST', headers, body: JSON.stringify({}), redirect: 'error', signal: controller.signal,
      });
    } catch {
      throw new IntegrationError('GitHub workflow rerun request failed');
    }
    if (!response?.ok) {
      const status = response?.status;
      const error = new IntegrationError(`GitHub workflow rerun failed${Number.isInteger(status) ? ` (HTTP ${status})` : ''}`, status);
      if (status === 429 || (status === 403 && response.headers?.get('x-ratelimit-remaining') === '0')) {
        const reset = Number(response.headers?.get('x-ratelimit-reset')) * 1000;
        error.retryAt = Number.isFinite(reset) && reset > Date.now() ? reset : Date.now() + 60000;
      } else if (status === 403) {
        // Organization-level OAuth App restrictions reject writes before any
        // repository permission check; distinguish it for actionable guidance.
        try { if ((await response.text()).includes('OAuth App access restrictions')) error.code = 'GITHUB_ORG_RESTRICTED'; } catch { /* ignore */ }
      }
      throw error;
    }
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

