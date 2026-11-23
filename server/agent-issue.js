import { z } from 'zod';
import { findTemplate, renderIssueBody, scoreDuplicates, validateIssueDraft, DUPLICATE_BLOCK } from './issue-templates.js';

// Drafts are untrusted Agent input: validate shape, template conformance and
// duplicate-check evidence before the member sees them.
const duplicateCandidate = z.object({
  number: z.number().int().min(1).max(100000000),
  title: z.string().max(500).default(''),
  url: z.string().max(500).default(''),
  state: z.string().max(20).default(''),
  similarity: z.number().min(0).max(1).optional(),
}).strict();

export const issueDraftSchema = z.object({
  kind: z.literal('issue_create'),
  templateId: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(300),
  fields: z.record(z.string(), z.union([z.string().max(20000), z.array(z.string().max(200)).max(30)])).default({}),
  labels: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  supplement: z.string().max(5000).default(''),
  dedupe: z.object({
    queries: z.array(z.string().trim().min(1).max(200)).min(2).max(6),
    candidates: z.array(duplicateCandidate).min(3).max(20),
    conclusion: z.literal('not_duplicate'),
    rationale: z.string().trim().min(40).max(2000),
  }).strict(),
  summary: z.string().max(500).default(''),
  model: z.string().max(100).default(''),
}).strict();

export function formatIssueDraftError(error) {
  const issue = error?.issues?.[0];
  if (!issue) return 'Issue 草稿格式不合法';
  const where = issue.path?.length ? `${issue.path.join('.')}: ` : '';
  return `Issue 草稿格式不合法（${where}${issue.message}）`;
}

// Template + label validation shared by submit and publish.
export function inspectIssueDraft(draft, { templates, repoLabels = [] }) {
  const template = findTemplate(templates, draft.templateId);
  if (!template) return { template: null, errors: [`未知的 Issue 模板：${draft.templateId}`], duplicates: [] };
  const errors = validateIssueDraft(template, draft);
  if (repoLabels.length) {
    const unknown = draft.labels.filter(label => !repoLabels.includes(label));
    if (unknown.length) errors.push(`标签不存在于仓库：${unknown.join('、')}`);
  }
  return { template, errors, duplicates: [], body: renderIssueBody(template, draft.fields, draft.supplement) };
}

// Re-score GitHub search results against the rendered draft so an Agent cannot
// understate similarity in its own candidate list.
export function attachDuplicateScores(draft, template, candidates) {
  return scoreDuplicates({ ...draft, template }, candidates);
}

export function duplicateBlockers(duplicates, confirmedNumbers = []) {
  const confirmed = new Set((Array.isArray(confirmedNumbers) ? confirmedNumbers : []).map(Number));
  return (Array.isArray(duplicates) ? duplicates : [])
    .filter(item => Number(item?.similarity) >= DUPLICATE_BLOCK && !confirmed.has(Number(item?.number)));
}

export function buildIssuePayload(draft, { template, duplicates = [] }) {
  return {
    templateId: template.id,
    templateName: template.name || template.id,
    title: draft.title,
    fields: draft.fields || {},
    labels: draft.labels || [],
    supplement: draft.supplement || '',
    dedupe: draft.dedupe,
    duplicates,
    body: renderIssueBody(template, draft.fields, draft.supplement),
  };
}
