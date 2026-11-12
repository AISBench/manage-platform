import { test,expect } from '@playwright/test';

test.beforeEach(async({page})=>{await page.goto('/');await page.getByRole('button',{name:'演示管理员登录',exact:true}).click();await page.waitForURL('**/workspace');});

async function nav(page,name) {await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name,exact:true}).click();}

test('administrator resolves, confirms, creates, edits, disables and enables pre-entered member',async({page})=>{
  await page.goto('/workspace');await nav(page,'团队成员');await expect(page.getByRole('heading',{name:'团队成员',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'新增成员',exact:true}).click();
  let dialog=page.getByRole('dialog',{name:'预录入团队成员'});
  await dialog.getByLabel('GitHub 用户名').fill('new-contributor');await dialog.getByRole('button',{name:'核验账号',exact:true}).click();
  await expect(dialog.getByText('GitHub ID: 1005',{exact:true})).toBeVisible();
  await dialog.getByRole('checkbox').check();await dialog.getByLabel('团队姓名 / 昵称').fill('测试预录入成员');await dialog.getByLabel('负责模块',{exact:true}).fill('模型适配');
  const created=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/admin/members'));
  await dialog.getByRole('button',{name:'确认录入',exact:true}).click();expect((await created).status()).toBe(201);
  const row=page.getByRole('row').filter({hasText:'new-contributor'});await expect(row.getByText('待激活',{exact:true})).toBeVisible();
  await row.getByRole('button',{name:'编辑',exact:true}).click();dialog=page.getByRole('dialog',{name:'编辑成员资料'});
  await dialog.getByLabel('团队姓名 / 昵称').fill('更新后的团队姓名');await dialog.getByRole('button',{name:'保存资料'}).click();await expect(row.getByText('更新后的团队姓名',{exact:true})).toBeVisible();
  await row.getByRole('button',{name:'停用',exact:true}).click();dialog=page.getByRole('dialog',{name:'确认停用成员'});await dialog.getByRole('button',{name:'确认停用',exact:true}).click();await expect(row.getByText('已停用',{exact:true})).toBeVisible();
  await row.getByRole('button',{name:'启用',exact:true}).click();dialog=page.getByRole('dialog',{name:'重新启用成员'});await dialog.getByRole('button',{name:'确认启用',exact:true}).click();await expect(row.getByText('待激活',{exact:true})).toBeVisible();
  await page.getByLabel('成员状态',{exact:true}).selectOption('disabled');await expect(row).toHaveCount(0);await page.getByLabel('成员状态',{exact:true}).selectOption('');
  const admin=page.getByRole('row').filter({hasText:'demo-maintainer'});await admin.getByRole('button',{name:'停用',exact:true}).click();
  const rejected=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/demo-admin/disable'));
  await page.getByRole('dialog').getByRole('button',{name:'确认停用',exact:true}).click();expect((await rejected).status()).toBe(409);
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  await nav(page,'操作审计');await expect(page.getByRole('heading',{name:'操作审计',exact:true})).toBeVisible();await page.getByLabel('审计操作类型').fill('member.create');await expect(page.getByRole('cell',{name:'member.create',exact:true}).first()).toBeVisible();
  await nav(page,'运行状态');await expect(page.getByRole('heading',{name:'运行状态',exact:true})).toBeVisible();await expect(page.getByText('Schema v3',{exact:true})).toBeVisible();
});

test('versioned bulk assignment and stale drawer conflict reload are functional',async({page})=>{
  await page.goto('/workspace');await nav(page,'全部任务');
  await page.getByLabel('选择任务 #9000',{exact:true}).check();await page.getByLabel('选择任务 #9002',{exact:true}).check();
  await page.getByRole('button',{name:'批量分派',exact:true}).click();let dialog=page.getByRole('dialog',{name:'批量分派 2 项任务'});
  await dialog.getByRole('combobox').selectOption('demo-pending');const bulk=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/items/bulk-assign'));
  await dialog.getByRole('button',{name:'确认整批分派',exact:true}).click();expect((await bulk).status()).toBe(200);
  await page.getByRole('button',{name:'支持服务化模型的流式性能评测',exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.getByLabel('平台负责人',{exact:true})).toHaveValue('demo-pending');
  const other=await page.evaluate(async()=>{
    const session=await (await fetch('/api/session')).json();const all=await (await fetch('/api/items?state=all')).json();const item=all.items.find(i=>i.id==='github:9000');
    return (await fetch('/api/items/github:9000',{method:'PATCH',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({version:item.version,priority:item.priority==='low'?'high':'low'})})).status;
  });expect(other).toBe(200);
  await dialog.getByRole('combobox').first().selectOption('done');const stale=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().includes('/api/items/'));
  await dialog.getByRole('button',{name:'保存本地工作流',exact:true}).click();expect((await stale).status()).toBe(409);await expect(dialog.getByText('数据已变化或操作存在冲突',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'刷新数据',exact:true}).click();await expect(dialog.getByRole('alert')).toHaveCount(0);await dialog.getByRole('button',{name:'关闭任务详情'}).click();
});

test('notification platform link opens the referenced transaction',async({page})=>{
  await page.goto('/workspace?item=github%3A9001');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading',{name:'多轮对话数据集评测结果异常',exact:true})).toBeVisible();
});

test('mobile member management, operations and audit screens fit viewport',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/workspace');
  for(const [name,heading] of [['团队成员','团队成员'],['运行状态','运行状态'],['操作审计','操作审计']]) {
    await page.getByRole('button',{name:'打开导航',exact:true}).click();await nav(page,name);await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  }
});
