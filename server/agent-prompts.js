// Task instructions injected into Agent context. They restate the rules the
// platform enforces, so an Agent can act correctly without guessing.

export function issueTaskInstructions({ repo }) {
  return [
    `目标仓库：${repo}。这是「新建 Issue」任务，不涉及代码修改。`,
    '1. 先按需求提炼 2-4 组关键词，调用 aisbench_issue_search 检索已有 Issue（可分别查 open 与 all），把候选写进 dedupe.candidates。',
    '2. 逐个比较候选的标题、现象与复现条件；只要存在实质相同的 Issue，就不要提交，直接在草稿 dedupe.rationale 说明重复对象并终止。',
    '3. 调用 aisbench_issue_templates 选择最匹配的模板：bug / feature / doc / consult / rfc / roadmap 或对应英文模板。',
    '4. 按模板字段填写 fields：所有 required 字段必填；下拉与复选框只能使用模板给出的选项；不要编造版本号、命令或日志。',
    '5. labels 必须包含模板声明的全部标签，可按实际情况补充仓库已有标签；不要使用仓库里不存在的标签。',
    '6. 提交前自检合理性：问题是否可复现、是否与本仓库相关、是否已有规避方式、需求是否已有替代方案。',
    '7. 用 aisbench_task_submit 提交草稿（kind=issue_create）。不要自己创建 Issue，发布由成员在平台人工确认。',
  ].join('\n');
}

export function prTaskInstructions({ repo, baseRef = 'master' }) {
  return [
    `目标仓库：${repo}，目标分支：${baseRef}。这是「基于 Issue 提 PR」任务。`,
    '本任务允许的写操作：在本地修改代码、运行门禁、把分支推送到你本人的 fork，并以你本人身份在目标仓库创建 PR。定时任务提示词里「不修改 GitHub」的通用限制不适用于本任务的上述写路径。',
    '必须严格遵循上下文中的 aisbench-devflow SKILL.md（skillSha 固定），按 develop → pr 的顺序执行；规范检查参考 pr-checklist，CI 诊断参考 ci-failure-triage。',
    '硬边界：不执行合入、不启用 auto-merge、不代签 DCO/CLA、不修改 PR 模板与标签工作流、不 force push、不使用 --no-verify。',
    '1. 检出仓库并确认 remotes、源分支与目标分支；用脚本或等价方式读取门禁与仓库画像。',
    '2. 按 Issue 描述实现修复或功能，补充/更新测试；逐条运行受影响门禁，记录命令、退出码与输出摘要。',
    '3. 用你自己的 GitHub 身份（gh 登录）将分支推送到你的 fork，并向目标仓库创建 PR；PR 正文必须关联该 Issue（如 Fixes #<编号>），标题与模板遵循仓库规范。',
    '编码要求：标题与正文写成 UTF-8（无 BOM）文件，正文用 gh pr create --body-file 提交；Windows 下不要把中文内联进命令行参数（会被替换成 ?）。创建后回读 PR，若标题/正文出现大量 ? 或替换字符，先用 gh api -X PATCH -F title=@title.txt -F body=@body.md 修正，再提交 pr_result。',
    '4. 不要创建新的 Issue，不要代替他人 push，不要合并或关闭 PR。',
    '5. 用 aisbench_task_submit 提交 PR 结果草稿（kind=pr_result）：prUrl、prNumber、headSha、baseRef、headRef、forkOwner、prTitle，gate 每项填 PASS/FAIL/UNKNOWN/NOT_APPLICABLE 与证据，未验证项写入 unverified。',
    '6. 门禁有任何 FAIL 时不要提交为通过；如实报告失败项与下一步建议。平台只验收、不代推代码。',
  ].join('\n');
}
