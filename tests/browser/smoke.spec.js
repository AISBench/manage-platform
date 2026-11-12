import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

test.beforeEach(async({page})=>{await page.goto('/');await page.getByRole('button',{name:'演示管理员登录',exact:true}).click();await page.waitForURL('**/workspace');});

test('desktop dashboard, workflow edit, filters, preferences, rules and notifications',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('/workspace');
  await expect(page.getByRole('heading',{name:'让协作，有条不紊。'})).toBeVisible();
  await expect(page.getByText('正在体验演示工作空间')).toBeVisible();
  await expect(page.getByText('待处理 Issue',{exact:true})).toBeVisible();
  mkdirSync('docs',{recursive:true});
  await page.screenshot({path:'docs/preview.png',fullPage:true});
  await page.getByRole('button',{name:'全部任务',exact:true}).first().click();
  await expect(page.getByRole('heading',{name:'全部任务',exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'Pull Requests',exact:true}).click();
  await expect(page.getByRole('button',{name:'修复并发请求场景下的 token 统计',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'修复并发请求场景下的 token 统计',exact:true}).click();
  const drawer=page.getByRole('dialog');await expect(drawer).toBeVisible();
  await drawer.getByRole('combobox').first().selectOption('in_progress');
  const saved=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().includes('/api/items/'));
  await drawer.getByRole('button',{name:/保存/}).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText('本地工作流已更新，GitHub 状态未改变。')).toBeVisible();
  await drawer.getByRole('button',{name:'关闭任务详情'}).click();
  await page.getByRole('button',{name:'个人设置与绑定',exact:true}).click();
  await expect(page.getByRole('heading',{name:'飞书账号绑定',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'演示模式不连接外部账号'})).toBeDisabled();
  await page.getByLabel('免打扰开始时间').fill('22:00');await page.getByLabel('免打扰结束时间').fill('08:00');
  const pref=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().endsWith('/api/preferences'));
  await page.getByRole('button',{name:'保存偏好',exact:true}).click();expect((await pref).status()).toBe(200);
  await expect(page.getByText('个人通知偏好已保存。')).toBeVisible();
  await page.getByRole('button',{name:'提醒规则',exact:true}).click();
  await expect(page.getByRole('heading',{name:'提醒规则',exact:true})).toBeVisible();
  await page.getByLabel('任务静默阈值').fill('72');
  const rules=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/api/rules'));
  await page.getByRole('button',{name:'保存规则',exact:true}).click();expect((await rules).status()).toBe(200);
  await page.getByRole('button',{name:'通知记录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'通知记录',exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile navigation and responsive layout',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/workspace');
  await expect(page.getByRole('heading',{name:'让协作，有条不紊。'})).toBeVisible();
  const fits=await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1);expect(fits).toBe(true);
  await page.getByRole('button',{name:'打开导航',exact:true}).click();
  await page.getByRole('button',{name:'我的任务',exact:true}).click();
  await expect(page.getByRole('heading',{name:'我的待办',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'打开导航',exact:true}).click();
  await page.getByRole('button',{name:'个人设置与绑定',exact:true}).click();
  await expect(page.getByRole('heading',{name:'个人设置与绑定',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
});
