import { parse as parseYaml } from 'yaml';
import { getSetting, setSetting } from './db.js';
import { fetchIssueTemplateFiles } from './integrations/github.js';

// Issue templates live in the repository as GitHub issue forms (YAML). The
// platform renders the body itself so an Agent cannot skip required sections,
// and it validates the template labels before anything reaches GitHub.
const CACHE_TTL_MS = 3600000;
const MAX_TEMPLATE_FILE = 200000;

// Demo deployments cannot reach GitHub; keep a minimal, clearly labelled set so
// the UI and tests can exercise the flow without pretending to be real data.
export const DEMO_TEMPLATES = [
  {
    id: '001_bug', name: '🔧 Bug&报错&异常报告', description: '提交程序中的错误或异常', title: '[Bug] ', labels: ['bug', '待处理'],
    fields: [
      { id: 'os_and_version', label: '操作系统及版本', type: 'input', required: true },
      { id: 'tool_version', label: 'AISBench工具版本', type: 'input', required: true },
      { id: 'input_cmd', label: 'AISBench执行命令', type: 'input', required: true },
      { id: 'actual', label: '实际行为', type: 'textarea', required: true },
      { id: 'checks', label: '前置检查', type: 'checkboxes', required: false, options: [
        { label: '我已读懂主页文档的快速入门，无法解决问题', required: true },
        { label: '我已搜索过现有Issue，无重复问题', required: true },
      ] },
    ],
  },
  {
    id: '004_feature', name: '✨ Feature request', description: '新功能的讨论提案', title: '[Feature]: ', labels: ['feature'],
    fields: [
      { id: 'requirement', label: '💻 需求背景、当前现状、期望实现的功能内容、具体的设计方案、以及测试方案', type: 'textarea', required: true },
      { id: 'alternatives', label: '替代方案', type: 'textarea', required: false },
    ],
  },
];

function normalizeField(item, index) {
  if (!item || typeof item !== 'object' || typeof item.type !== 'string') return null;
  if (item.type === 'markdown') return { type: 'markdown' };
  const id = typeof item.id === 'string' && item.id ? item.id : `field_${index}`;
  const label = typeof item.attributes?.label === 'string' ? item.attributes.label : id;
  const field = { id, label, type: item.type, required: item.validations?.required === true };
  if (Array.isArray(item.attributes?.options)) {
    field.options = item.attributes.options
      .map(option => (typeof option === 'string'
        ? { label: option, required: false }
        : { label: String(option?.label || ''), required: option?.required === true }))
      .filter(option => option.label);
  }
  return field;
}

export function parseIssueTemplates(files) {
  const templates = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file.text !== 'string' || file.text.length > MAX_TEMPLATE_FILE) continue;
    let document;
    try { document = parseYaml(file.text); } catch { continue; }
    if (!document || typeof document !== 'object' || !Array.isArray(document.body)) continue;
    const labels = Array.isArray(document.labels)
      ? document.labels.map(label => String(label)).filter(Boolean)
      : typeof document.labels === 'string' ? [document.labels] : [];
    const id = String(file.name || '').replace(/\.ya?ml$/i, '');
    if (!id) continue;
    templates.push({
      id,
      name: typeof document.name === 'string' ? document.name : '',
      description: typeof document.description === 'string' ? document.description : '',
      title: typeof document.title === 'string' ? document.title : '',
      labels,
      fields: document.body.map(normalizeField).filter(Boolean),
    });
  }
  return templates;
}

export async function getIssueTemplates(db, config, { force = false, fetchImpl = fetch, token } = {}) {
  const key = `issueTemplates:${config.repo}`;
  const cached = getSetting(db, key, null);
  if (!force && cached && Array.isArray(cached.templates) && cached.templates.length
    && Date.now() - Date.parse(cached.fetchedAt || '') < CACHE_TTL_MS) {
    return cached;
  }
  if (config.demo) {
    return { repo: config.repo, fetchedAt: new Date().toISOString(), source: 'demo', templates: DEMO_TEMPLATES };
  }
  const files = await fetchIssueTemplateFiles({ repo: config.repo, token: token ?? config.githubToken, fetchImpl });
  const templates = parseIssueTemplates(files);
  if (!templates.length) {
    throw Object.assign(new Error('未读取到可用的 Issue 模板（请检查仓库 .github/ISSUE_TEMPLATE）'), { status: 502, code: 'ISSUE_TEMPLATES_UNAVAILABLE' });
  }
  const payload = { repo: config.repo, fetchedAt: new Date().toISOString(), source: 'github', templates };
  setSetting(db, key, payload);
  return payload;
}

export function findTemplate(templates, templateId) {
  const id = String(templateId || '').trim();
  if (!id) return null;
  return (Array.isArray(templates) ? templates : []).find(template => template.id === id)
    || (Array.isArray(templates) ? templates : []).find(template => template.name === id)
    || null;
}

export function renderIssueBody(template, fields = {}, supplement = '') {
  const parts = [];
  for (const field of (template?.fields || [])) {
    if (!field.id || field.type === 'markdown') continue;
    const value = fields?.[field.id];
    if (field.type === 'checkboxes') {
      const selected = new Set(Array.isArray(value) ? value.map(String) : []);
      const lines = (field.options || []).map(option => `- [${selected.has(option.label) ? 'x' : ' '}] ${option.label}`);
      if (lines.length) parts.push(`### ${field.label}\n\n${lines.join('\n')}`);
      continue;
    }
    const text = typeof value === 'string'
      ? value.trim()
      : Array.isArray(value) ? value.filter(Boolean).join('\n').trim() : '';
    if (text) parts.push(`### ${field.label}\n\n${text}`);
  }
  if (typeof supplement === 'string' && supplement.trim()) parts.push(`### 补充说明\n\n${supplement.trim()}`);
  return parts.join('\n\n').slice(0, 65000);
}

// Template conformance: required fields, title prefix, template labels and
// required checkboxes. Repository-label existence is checked by the caller
// against the synced label catalogue (it needs a database read).
export function validateIssueDraft(template, draft) {
  const errors = [];
  const fields = draft?.fields && typeof draft.fields === 'object' ? draft.fields : {};
  for (const field of template?.fields || []) {
    if (!field.id || field.type === 'markdown') continue;
    const value = fields[field.id];
    if (field.type === 'checkboxes') {
      const selected = new Set(Array.isArray(value) ? value.map(String) : []);
      for (const option of field.options || []) {
        if (option.required && !selected.has(option.label)) errors.push(`模板必选项未勾选：${option.label}`);
      }
      continue;
    }
    if (field.required && !(typeof value === 'string' && value.trim())) errors.push(`模板必填字段缺失：${field.label}`);
  }
  const prefix = String(template?.title || '').trim();
  if (prefix && !String(draft?.title || '').startsWith(prefix)) errors.push(`标题需要以「${prefix}」开头`);
  const labels = Array.isArray(draft?.labels) ? draft.labels : [];
  const missing = (template?.labels || []).filter(label => !labels.includes(label));
  if (missing.length) errors.push(`缺少模板标签：${missing.join('、')}`);
  return errors;
}

// Character-bigram Jaccard works for Chinese and English without extra
// tokenizers or model calls, which keeps duplicate checks cheap and predictable.
function bigrams(value) {
  const text = String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const grams = new Set();
  for (let index = 0; index < text.length - 1; index += 1) grams.add(text.slice(index, index + 2));
  return grams;
}

export function textSimilarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function scoreDuplicates(draft, candidates) {
  const title = String(draft?.title || '');
  const body = renderIssueBody(
    draft?.template || { fields: [] },
    draft?.fields || {},
    draft?.supplement || '',
  ).slice(0, 800);
  return (Array.isArray(candidates) ? candidates : []).map(candidate => {
    const titleScore = textSimilarity(title, candidate.title || '');
    const bodyScore = textSimilarity(body, String(candidate.body || '').slice(0, 800));
    return { ...candidate, similarity: Math.round((titleScore * 0.65 + bodyScore * 0.35) * 100) / 100 };
  }).sort((a, b) => b.similarity - a.similarity);
}

export const DUPLICATE_BLOCK = 0.8;
export const DUPLICATE_WARN = 0.65;
