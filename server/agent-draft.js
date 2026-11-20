import { z } from 'zod';

// Drafts produced by external Agents are untrusted input: validate shape,
// lengths, action whitelist and citation format before they can be reviewed.
const actionSchema = z.object({
  kind: z.enum(['add_label', 'remove_label', 'assign', 'close', 'reopen']),
  value: z.string().max(100).default(''),
  reason: z.string().max(500).default(''),
}).strict();

export const agentActionSchema = actionSchema;

const referenceSchema = z.object({
  kind: z.enum(['file', 'wiki', 'commit']),
  path: z.string().max(500).default(''),
  url: z.string().max(500).optional(),
  snippet: z.string().max(1000).default(''),
}).strict();

const githubUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com';
  } catch { return false; }
};

const safePath = value => value === '' || (!value.startsWith('/') && !value.split('/').includes('..') && !/^[A-Za-z]:/.test(value));

export const agentDraftSchema = z.object({
  summary: z.string().max(500).default(''),
  root_cause_hypothesis: z.string().max(2000).default(''),
  comment_md: z.string().trim().min(1).max(20000),
  actions: z.array(actionSchema).max(10).default([]),
  references: z.array(referenceSchema).max(20).default([]),
  confidence: z.number().min(0).max(1).default(0),
  model: z.string().max(100).default(''),
}).strict().superRefine((draft, ctx) => {
  draft.actions.forEach((action, index) => {
    if (['add_label', 'remove_label', 'assign'].includes(action.kind) && !action.value.trim()) {
      ctx.addIssue({ code: 'custom', path: ['actions', index, 'value'], message: `${action.kind} 需要非空 value` });
    }
  });
  draft.references.forEach((reference, index) => {
    if (!safePath(reference.path)) {
      ctx.addIssue({ code: 'custom', path: ['references', index, 'path'], message: '引用路径不能是绝对路径或包含 ..' });
    }
    if (reference.url && !githubUrl(reference.url)) {
      ctx.addIssue({ code: 'custom', path: ['references', index, 'url'], message: '引用链接必须是 https://github.com/...' });
    }
    if (!reference.path && !reference.url) {
      ctx.addIssue({ code: 'custom', path: ['references', index], message: '引用至少需要 path 或 url' });
    }
  });
});

// Map zod errors into a single readable message for API responses.
export function formatDraftError(error) {
  const issue = error?.issues?.[0];
  if (!issue) return '草稿格式不合法';
  const where = issue.path?.length ? `${issue.path.join('.')}: ` : '';
  return `草稿格式不合法（${where}${issue.message}）`;
}
