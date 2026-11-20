// Validate that each inline review comment anchors to a line present in the PR
// diff. GitHub rejects the whole review when one anchor is invalid, so catching
// it at submit lets the Agent fix its draft before a human reviews it.
const INLINE_FORMAT = /^\s*\[review\]\s*\[([^\]\r\n]{1,20})\]\s*([\s\S]*?)\r?\n\s*\[suggestion\]\s*([\s\S]*)$/i;

export function inlineCommentFormatError(body) {
  const match = String(body || '').match(INLINE_FORMAT);
  if (!match) return '格式必须为「[review] [严重程度] 具体问题」换行「[suggestion] 可行解决方式」';
  if (!match[2].trim()) return '[review] 后需要具体问题';
  if (!match[3].trim()) return '[suggestion] 后需要可行解决方式';
  return '';
}

function lineSets(patch) {
  const left = new Set();
  const right = new Set();
  let oldLine = 0;
  let newLine = 0;
  for (const text of String(patch || '').split('\n')) {
    const header = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (!text || text.startsWith('\\')) continue;
    if (text.startsWith('+')) right.add(newLine++);
    else if (text.startsWith('-')) left.add(oldLine++);
    else {
      right.add(newLine++);
      left.add(oldLine++);
    }
  }
  return { left, right };
}

export function validateInlineComments(files, comments) {
  const byPath = new Map((Array.isArray(files) ? files : []).map(file => [file.filename, file]));
  for (const [index, comment] of comments.entries()) {
    const file = byPath.get(comment.path);
    if (!file) return `comments.${index}.path：${comment.path} 不在该 PR 的变更文件中`;
    const sets = lineSets(file.patch);
    const lines = comment.side === 'LEFT' ? sets.left : sets.right;
    if (!lines.has(comment.line)) return `comments.${index}.line：第 ${comment.line} 行不在 ${comment.side} 侧的可评论范围内`;
    if (comment.start_line && !lines.has(comment.start_line)) return `comments.${index}.start_line：第 ${comment.start_line} 行不在 ${comment.side} 侧的可评论范围内`;
  }
  return '';
}
