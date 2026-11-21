import { test, expect } from '@playwright/test';

async function openTasks(page) {
  await page.goto('/workspace');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '全部任务', exact: true }).click();
}

test('admin sees exactly the open PRs requesting their review in the new task tab', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '演示管理员登录', exact: true }).click();
  await page.waitForURL('**/workspace');
  await openTasks(page);

  const filtered = page.waitForResponse(response => response.url().includes('/api/items?') && response.url().includes('reviewRequested=me') && response.status() === 200);
  await page.getByRole('tab', { name: '待我检视', exact: true }).click();
  await filtered;
  await expect(page.getByRole('tab', { name: '待我检视', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('2 项待检视', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '修复并发请求场景下的 token 统计', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '优化数据集缓存与加载性能', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '支持服务化模型的流式性能评测', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '多轮对话数据集评测结果异常', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('GitHub 状态', { exact: true })).toHaveValue('open');
  await expect(page.getByLabel('GitHub 状态', { exact: true })).toBeDisabled();
  await page.screenshot({ path: 'docs/review-requested-tasks.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: '待我检视', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'docs/review-requested-tasks-mobile.png', fullPage: true });
});

test('ordinary member sees their own review invitations, not the administrator queue', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '演示成员登录', exact: true }).click();
    await page.waitForURL('**/workspace');
    await openTasks(page);
    await page.getByRole('tab', { name: '待我检视', exact: true }).click();
    await expect(page.getByText('1 项待检视', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '支持服务化模型的流式性能评测', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '修复并发请求场景下的 token 统计', exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});
