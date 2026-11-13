import { test,expect } from '@playwright/test';

test.beforeEach(async({page})=>{await page.goto('/');await page.getByRole('button',{name:'演示管理员登录',exact:true}).click();await page.waitForURL('**/workspace');});

test('conversation detail shows newest-first messages, collapse, read receipts and side columns',async({page})=>{
  await page.goto('/workspace/items/github%3A9000');
  await expect(page.getByRole('heading',{name:'支持服务化模型的流式性能评测',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'对话',exact:true})).toBeVisible();
  await expect(page.getByText('最新消息在前',{exact:false})).toBeVisible();
  await expect(page.getByRole('heading',{name:'CI 状态',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'操作记录',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'其他信息',exact:true})).toBeVisible();
  const expand=page.getByRole('button',{name:/展开全文/}).first();
  await expect(expand).toBeVisible();await expand.click();await expect(page.getByRole('button',{name:/收起/}).first()).toBeVisible();
  const receipt=page.locator('.read-receipt').first();await receipt.click();await expect(page.locator('.read-list')).toBeVisible();
});

test('inline review comments show the related code and link to the PR Files changed view',async({page})=>{
  await page.goto('/workspace/items/github%3A9000');
  const code=page.locator('.review-code').first();
  await expect(code).toBeVisible();
  await expect(code.getByText('src/benchmark/tasks.py')).toBeVisible();
  await expect(code.getByText('L42')).toBeVisible();
  await expect(code.locator('.diff-line.is-add').first()).toBeVisible();
  await expect(code.locator('.diff-line.is-target')).toHaveCount(1);
  const link=code.getByRole('link',{name:/在 Files changed 中定位/});
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href','https://github.com/AISBench/benchmark/pull/9000/changes#r90002');
});

test('detail page shows the original GitHub description',async({page})=>{
  await page.goto('/workspace/items/github%3A9000');
  const card=page.locator('.description-card');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading',{name:'PR 描述',exact:true})).toBeVisible();
  await expect(card.getByText('这是本地演示数据',{exact:false})).toBeVisible();
  await expect(card.getByRole('link',{name:/在 GitHub 查看/})).toBeVisible();
});

test('local workflow maps GitHub assignees and suggests state from labels',async({page})=>{
  await page.goto('/workspace/items/github%3A9001');
  const block=page.locator('.github-link');
  await expect(block).toBeVisible();
  await expect(block.getByText('GitHub Assignee',{exact:true})).toBeVisible();
  const assignee=block.locator('.assignee-chip').first();
  await expect(assignee).toContainText('demo-maintainer');
  await expect(assignee).toContainText('已认证');
  const mapped=block.locator('.label-chip.is-mapped').first();
  await expect(mapped).toContainText('bug');
  await expect(mapped).toContainText('高优先级');
  await expect(block.getByText('GitHub 标签建议',{exact:false})).toContainText('高优先级');
  await expect(block.getByRole('button',{name:'采用建议',exact:true})).toBeVisible();
});

test('GitHub Actions CI row triggers a demo rerun with inline feedback',async({page})=>{
  await page.goto('/workspace/items/github%3A9000');
  page.on('dialog',dialog=>dialog.accept());
  const rerun=page.getByRole('button',{name:'全量重试'}).first();
  await expect(rerun).toBeVisible();
  await rerun.click();
  await expect(page.getByText('演示模式：已模拟触发全量重试。',{exact:false})).toBeVisible();
});

test('conversation editor provides markdown toolbar, preview, mentions, references and drafts',async({page})=>{
  await page.goto('/workspace/items/github%3A9000');
  const editor=page.locator('.markdown-editor');
  const textarea=editor.locator('textarea');
  await expect(editor.getByRole('toolbar',{name:'Markdown 工具栏'})).toBeVisible();
  await textarea.fill('hello');
  await textarea.selectText();
  await editor.getByRole('button',{name:'粗体'}).click();
  await expect(textarea).toHaveValue('**hello**');
  await editor.getByRole('tab',{name:'预览'}).click();
  await expect(editor.locator('.editor-preview strong')).toHaveText('hello');
  await editor.getByRole('tab',{name:'写'}).click();
  await textarea.fill('hi @demo-mai');
  await expect(editor.locator('.editor-suggest')).toBeVisible();
  await expect(editor.getByRole('option').first()).toContainText('demo-maintainer');
  await textarea.press('Enter');
  await expect(textarea).toHaveValue(/@demo-maintainer\s$/);
  await textarea.fill('see #9000');
  await expect(editor.getByRole('option').first()).toContainText('#9000');
  await textarea.press('Enter');
  await expect(textarea).toHaveValue(/see #9000\s$/);
  await textarea.fill('draft survives reload');
  await page.reload();
  await expect(page.locator('.markdown-editor textarea')).toHaveValue('draft survives reload');
});

test('demo member can send a conversation message from the detail page',async({page})=>{
  await page.goto('/workspace/items/github%3A9000');
  await expect(page.getByRole('heading',{name:'对话',exact:true})).toBeVisible();
  const composer=page.locator('.composer textarea');
  await composer.fill('浏览器演示消息 **hello** @reviewer-chen');
  await page.getByRole('button',{name:'发送到 GitHub',exact:true}).click();
  await expect(page.getByText('浏览器演示消息',{exact:false})).toBeVisible();
});

test('mobile detail page uses conversation / CI / operations / info tabs',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/workspace/items/github%3A9000');
  await expect(page.getByRole('heading',{name:'支持服务化模型的流式性能评测',exact:true})).toBeVisible();
  await expect(page.getByRole('tab',{name:'对话'})).toBeVisible();
  await page.getByRole('tab',{name:'CI'}).click();await expect(page.getByRole('heading',{name:'CI 状态',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'全量重试'}).first()).toBeVisible();
  await page.getByRole('tab',{name:'操作记录'}).click();await expect(page.getByRole('heading',{name:'操作记录',exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'信息'}).click();await expect(page.getByRole('heading',{name:'其他信息',exact:true})).toBeVisible();
});
