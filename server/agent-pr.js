import { z } from 'zod';
import { fetchCommitStatuses, fetchPullCheckRuns, fetchPullRequestDetail } from './integrations/github.js';

const gateEntry = z.object({
  name: z.string().trim().min(1).max(80),
  status: z.enum(['PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE']),
  evidence: z.string().max(2000).default(''),
}).strict();

// A PR result is the Agent's report after it developed and opened the PR with
// the user's own GitHub identity. The platform never pushes code; it verifies
// the URL, ownership, linked issue and head commit, then lets the member accept.
export const prDraftSchema = z.object({
  kind: z.literal('pr_result'),
  issueNumber: z.number().int().min(1).max(100000000),
  prUrl: z.string().trim().min(1).max(500),
  prNumber: z.number().int().min(1).max(100000000),
  headSha: z.string().regex(/^[a-fA-F0-9]{7,64}$/),
  baseRef: z.string().trim().max(200).default('master'),
  headRef: z.string().trim().min(1).max(200),
  forkOwner: z.string().trim().max(100).default(''),
  prTitle: z.string().trim().max(300).default(''),
  gate: z.array(gateEntry).min(1).max(20),
  unverified: z.array(z.string().max(500)).max(20).default([]),
  summary: z.string().max(500).default(''),
  model: z.string().max(100).default(''),
}).strict();

export function formatPrDraftError(error) {
  const issue = error?.issues?.[0];
  if (!issue) return 'PR 草稿格式不合法';
  const where = issue.path?.length ? `${issue.path.join('.')}: ` : '';
  return `PR 草稿格式不合法（${where}${issue.message}）`;
}

function prUrlFor(repo, number) {
  return `https://github.com/${repo}/pull/${number}`;
}

// Windows argv/codepage conversion can silently turn Chinese into '?' (0x3F).
// That is lossy, so the platform refuses to accept a PR whose description is
// already damaged instead of asking a reviewer to guess the original text.
export function looksGarbled(text) {
  const value = typeof text === 'string' ? text : '';
  if (!value.trim()) return false;
  const replacement = (value.match(/\uFFFD/g) || []).length;
  const question = (value.match(/\?/g) || []).length;
  return replacement > 0 || question >= 10 || (value.length > 20 && question / value.length > 0.15);
}

export function validatePrShape(payload, { repo }) {
  const errors = [];
  if (payload.prUrl !== prUrlFor(repo, payload.prNumber)) errors.push(`PR 链接需要是 ${prUrlFor(repo, payload.prNumber)}`);
  if (payload.forkOwner && payload.forkOwner.toLowerCase() !== payload.headRef.split(':')[0]?.toLowerCase() && payload.headRef.includes(':')) {
    // headRef may be "owner:branch"; fork owner is informational, keep it loose.
  }
  if (payload.gate.some(entry => entry.status === 'FAIL')) errors.push('存在未通过的门禁（FAIL），不能提交或验收');
  if (!payload.gate.some(entry => entry.status === 'PASS')) errors.push('至少需要一项 PASS 门禁及证据');
  return errors;
}

function summarizeRuns(runs) {
  const states = (Array.isArray(runs) ? runs : []).map(run => {
    if (run?.status !== 'completed') return 'pending';
    if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'].includes(run?.conclusion)) return 'failure';
    if (['success', 'neutral', 'skipped'].includes(run?.conclusion)) return 'success';
    return 'unknown';
  });
  if (states.includes('failure')) return 'failure';
  if (states.includes('pending')) return 'pending';
  if (!states.length) return 'unknown';
  return 'success';
}

function summarizeStatuses(statuses) {
  const states = (Array.isArray(statuses) ? statuses : []).map(status => status?.state).filter(Boolean);
  if (states.includes('failure') || states.includes('error')) return 'failure';
  if (states.includes('pending')) return 'pending';
  if (!states.length) return 'unknown';
  return 'success';
}

export async function verifyPrResult({ payload, repo, memberLogin, token, fetchImpl = fetch }) {
  const errors = validatePrShape(payload, { repo });
  const result = { errors, pr: null, checks: { state: 'unknown', checkRuns: 'unknown', statuses: 'unknown' } };
  if (errors.length) return result;

  const pr = await fetchPullRequestDetail({ repo, number: payload.prNumber, token, fetchImpl });
  result.pr = {
    number: pr.number,
    state: pr.state,
    title: typeof pr.title === 'string' ? pr.title : '',
    body: typeof pr.body === 'string' ? pr.body : '',
    author: pr.user?.login || '',
    base: pr.base?.repo?.full_name || '',
    baseRef: pr.base?.ref || '',
    head: pr.head?.repo?.full_name || '',
    headRef: pr.head?.ref || '',
    headSha: pr.head?.sha || '',
    fork: pr.head?.repo?.fork === true,
    merged: Boolean(pr.merged_at),
  };
  const login = String(memberLogin || '').toLowerCase();
  if (looksGarbled(result.pr.title) || looksGarbled(result.pr.body)) {
    errors.push('PR 标题或正文疑似编码损坏（出现大量 ? 或替换字符），请用 UTF-8 文件重建描述后再提交');
  }
  if (result.pr.state !== 'open') errors.push('PR 不是 open 状态');
  if (result.pr.merged) errors.push('PR 已被合并，不能作为 Agent 开发结果验收');
  if (result.pr.base.toLowerCase() !== repo.toLowerCase()) errors.push(`PR 目标仓库不是 ${repo}`);
  if (result.pr.author.toLowerCase() !== login) errors.push('PR 作者不是当前成员');
  if (!result.pr.fork) errors.push('PR 来源不是成员本人的 fork');
  if (result.pr.headSha !== payload.headSha) errors.push('PR 当前 head 与提交的 head_sha 不一致，请刷新后重新提交');
  if (!new RegExp(`(?:#|issues/)${payload.issueNumber}(?:\\b|$)`).test(result.pr.body || '')) {
    errors.push(`PR 正文需要关联 Issue #${payload.issueNumber}`);
  }

  try {
    const runs = await fetchPullCheckRuns({ repo, ref: payload.headSha, token, fetchImpl });
    result.checks.checkRuns = summarizeRuns(runs);
  } catch {
    result.checks.checkRuns = 'unknown';
  }
  try {
    const statuses = await fetchCommitStatuses({ repo, ref: payload.headSha, token, fetchImpl });
    result.checks.statuses = summarizeStatuses(statuses);
  } catch {
    result.checks.statuses = 'unknown';
  }
  const states = [result.checks.checkRuns, result.checks.statuses].filter(state => state !== 'unknown');
  result.checks.state = states.includes('failure') ? 'failure' : states.includes('pending') ? 'pending' : states.length ? 'success' : 'unknown';
  return result;
}

export { prUrlFor };
