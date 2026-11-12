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

test('GitHub-style demo application is limited until approval and a separate NEW member login',async({browser})=>{
  const context=await browser.newContext(),adminContext=await browser.newContext();const applicant=await context.newPage(),admin=await adminContext.newPage();
  try {
    const appRequests=[];applicant.on('request',req=>{if(req.url().includes('/api/')) appRequests.push(new URL(req.url()).pathname);});
    await applicant.goto('/');await applicant.getByRole('button',{name:'演示申请加入',exact:true}).click();await applicant.waitForURL('**/join');
    await expect(applicant.getByRole('heading',{name:'向团队介绍你自己',exact:true})).toBeVisible();
    await applicant.getByPlaceholder('你希望大家如何称呼你').fill('浏览器申请者');await applicant.getByPlaceholder('如：模型评测、文档').fill('文档');await applicant.getByPlaceholder('介绍你希望如何参与项目，以及相关经验或兴趣…').fill('我希望参与文档建设和公开仓库事务的评审跟进。');
    const submit=applicant.getByRole('button',{name:/提交.*申请/});await expect(submit).toBeDisabled();await applicant.getByRole('checkbox').check();
    const sent=applicant.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/registration/applications'));await submit.click();expect((await sent).status()).toBe(201);
    await expect(applicant.getByRole('heading',{name:'申请正在审核中',exact:true})).toBeVisible();expect(appRequests.every(path=>path==='/api/session'||path.startsWith('/api/public/')||path.startsWith('/api/registration/'))).toBe(true);
    await demoAdmin(admin);await nav(admin,'加入申请');await expect(admin.getByRole('heading',{name:'加入申请',exact:true})).toBeVisible();
    const row=admin.getByRole('row').filter({hasText:'demo-applicant'});await row.getByRole('button').click();const dialog=admin.getByRole('dialog',{name:'审核加入申请'});
    await dialog.getByRole('button',{name:/通过申请/}).click();await dialog.getByRole('textbox',{name:/^公开反馈/}).fill('欢迎参与，请重新登录。');await dialog.getByRole('textbox',{name:/内部备注/}).fill('E2E_ADMIN_ONLY_NOTE');
    const decision=admin.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/approve'));await dialog.getByRole('button',{name:/确认通过/}).click();expect((await decision).status()).toBe(200);
    await applicant.getByRole('button',{name:'刷新本人状态',exact:true}).click();await expect(applicant.getByRole('heading',{name:'申请已通过',exact:true})).toBeVisible();
    const restricted=await applicant.evaluate(async()=>await(await fetch('/api/session')).json());expect(restricted.mode).toBe('applicant');expect(restricted.user).toBeNull();expect(JSON.stringify(restricted)).not.toContain('E2E_ADMIN_ONLY_NOTE');
    expect(await applicant.evaluate(async()=>(await fetch('/api/items')).status)).toBe(401);
    await applicant.getByRole('button',{name:'重新演示成员登录',exact:true}).click();await applicant.waitForURL('**/workspace');await expect(applicant.getByRole('heading',{name:'让协作，有条不紊。'})).toBeVisible();
    const member=await applicant.evaluate(async()=>await(await fetch('/api/session')).json());expect(member.mode).toBe('member');expect(member.user.login).toBe('demo-applicant');expect(member.user.isAdmin).toBe(false);
    await applicant.goto('/');await expect(applicant.getByRole('heading',{name:/看见进展/})).toBeVisible();await expect(applicant.getByRole('navigation',{name:'主导航'})).toHaveCount(0);
  } finally {await context.close();await adminContext.close();}
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
    await admin.setViewportSize({width:390,height:844});for(const label of ['加入申请','访问策略']) {await admin.getByRole('button',{name:'打开导航',exact:true}).click();await nav(admin,label);await expect(admin.getByRole('heading',{name:label,exact:true})).toBeVisible();expect(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}
  } finally {await adminContext.close();await guestContext.close();}
});
