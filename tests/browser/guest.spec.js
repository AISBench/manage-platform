import { test,expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

async function nav(page,label) {await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:label,exact:true}).click();}
async function demoAdmin(page) {await page.goto('/');await page.getByRole('button',{name:'演示管理员登录',exact:true}).click();await page.waitForURL('**/workspace');}

test('anonymous public portal has only public requests, no personal widgets or implicit cookies',async({page,context})=>{
  const requests=[],errors=[];page.on('request',req=>{if(req.url().includes('/api/')) requests.push(new URL(req.url()).pathname);});page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1440,height:1000});await page.goto('/');await expect(page.getByRole('heading',{name:/看见进展/})).toBeVisible();
  await expect(page.getByText('开放 Pull Request',{exact:true})).toBeVisible();await expect(page.getByLabel('事务类型')).toBeVisible();
  expect(requests.every(path=>path==='/api/session'||path.startsWith('/api/public/'))).toBe(true);expect(await context.cookies()).toEqual([]);
  for(const label of ['个人设置与绑定','我的任务','团队成员','通知记录']) await expect(page.getByRole('button',{name:label,exact:true})).toHaveCount(0);
  await page.getByLabel('事务类型').selectOption('pr');const list=page.waitForResponse(r=>r.url().includes('/api/public/items')&&r.url().includes('kind=pr'));await page.getByLabel('搜索公开事务').fill('token');await list;
  mkdirSync('docs',{recursive:true});await page.getByLabel('搜索公开事务').fill('');await page.getByLabel('事务类型').selectOption('');await expect(page.getByRole('link',{name:/支持服务化模型的流式性能评测/})).toBeVisible();await page.screenshot({path:'docs/preview-public.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(errors).toEqual([]);
});

test('anonymous private deep link prompts authentication without mounting member API',async({page})=>{
  const requests=[];page.on('request',req=>{if(req.url().includes('/api/')) requests.push(new URL(req.url()).pathname);});
  await page.goto('/workspace?item=github%3A9001');await expect(page.getByRole('heading',{name:'请先登录成员账号',exact:true})).toBeVisible();expect(requests.every(path=>path==='/api/session')).toBe(true);await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('demo member login enters the workspace directly; the public portal stays separate',async({browser})=>{
  const context=await browser.newContext();const member=await context.newPage();
  try {
    await member.goto('/');await member.getByRole('button',{name:'演示成员登录',exact:true}).click();await member.waitForURL('**/workspace');
    await expect(member.getByRole('heading',{name:'让协作，有条不紊。'})).toBeVisible();
    const session=await member.evaluate(async()=>await(await fetch('/api/session')).json());expect(session.mode).toBe('member');expect(session.user.login).toBe('reviewer-chen');expect(session.user.isAdmin).toBe(false);
    await member.goto('/');await expect(member.getByRole('heading',{name:/看见进展/})).toBeVisible();await expect(member.getByRole('navigation',{name:'主导航'})).toHaveCount(0);
  } finally {await context.close();}
});

test('public policy shutdown is fail-closed and re-enable accurately waits for a new snapshot',async({browser})=>{
  const adminContext=await browser.newContext(),guestContext=await browser.newContext();const admin=await adminContext.newPage(),guest=await guestContext.newPage();
  try {
    await demoAdmin(admin);await nav(admin,'访问策略');await admin.getByRole('switch',{name:'启用公开仓库概览',exact:true}).click();
    let save=admin.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/api/admin/access-policy'));await admin.getByRole('button',{name:'保存访问策略',exact:true}).click();expect((await save).status()).toBe(200);
    await guest.goto('/');await expect(guest.getByText('公开概览暂未开放',{exact:true})).toBeVisible();await expect(guest.getByLabel('事务类型')).toHaveCount(0);
    await admin.getByRole('switch',{name:'启用公开仓库概览',exact:true}).click();save=admin.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/api/admin/access-policy'));await admin.getByRole('button',{name:'保存访问策略',exact:true}).click();expect((await save).status()).toBe(200);
    await guest.reload();await expect(guest.getByText('还没有可展示的公开快照',{exact:true})).toBeVisible();
    await nav(admin,'工作台');await admin.getByRole('button',{name:'同步 GitHub',exact:true}).click();await expect(admin.getByText(/演示数据已刷新/)).toBeVisible();await guest.reload();await expect(guest.getByLabel('事务类型')).toBeVisible();
    await admin.setViewportSize({width:390,height:844});for(const label of ['访问策略']) {await admin.getByRole('button',{name:'打开导航',exact:true}).click();await nav(admin,label);await expect(admin.getByRole('heading',{name:label,exact:true})).toBeVisible();expect(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}
  } finally {await adminContext.close();await guestContext.close();}
});
