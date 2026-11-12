# 初版验证记录

日期：2026-11-11（Asia/Shanghai）。环境：Windows、Node.js 24.18.0、Google Chrome。

## 已通过

- `npm test`：50 / 50，通过配置校验、真实 SQLite、API、权限、CSRF、GitHub OAuth 身份与白名单、飞书绑定账号切换防护、Webhook 签名与持久化重试、事件后快照、批次共享同步、提醒去重 / 失败重试 / 免打扰 / 权限撤销等测试。外部接口使用 mock，不发送真实消息。
- `npm run build`：生产前端构建成功。
- `npm run test:browser`：2 / 2，通过桌面 1440px 与手机 390px 的 Chrome 浏览器冒烟测试。覆盖页面加载、任务筛选、处理进度保存、个人通知偏好、提醒规则、通知记录与移动端导航；验证无页面脚本错误，手机页面无文档级横向溢出。
- `npm audit --omit=dev`：0 vulnerabilities。
- 真实 GitHub 只读接口验证：完整分页读取 `AISBench/benchmark` 共 607 条记录；其中开放 Issue 57 条、开放 PR 49 条；读取到 success / failure 两类 CI 状态。GitHub 数据会继续变化，此数字仅为验证时快照；未修改目标仓库。
- 工作台预览图由实际浏览器渲染生成：`docs/preview.png`。

## 在真实验证中发现并修复

- GitHub Link 使用 `/repositories/{numeric-id}/issues` 的 canonical 路径，不能仅按初始 `/repos/{owner}/{name}/issues` 路径判断。现允许精确资源后缀、同源且钉住 numeric repository ID 的安全别名分页，并保留跨源 / 资源替换拒绝及回归测试。
- 事件不能复用接收前已开始的同步快照；现持久化接收后另取快照，同批最多 50 条事件共享一次新同步。
- 免打扰积压超过冷却期不能重复生成催办；现任意 pending / sending 阻止重复入队，已发送冷却从 sent_at 起算。
- 已移除访问权限的旧成员不能继续接收私有事务消息；入队及发送前均重新检查白名单。
- 手机表头隐藏辅助文本造成的水平溢出，已通过正确定位祖先修复，并添加浏览器回归。

## 未验证 / 不宣称已完成

- 真实 GitHub OAuth App 登录：待部署者配置 Client ID、Secret、回调地址。
- 目标仓库 Webhook 注册和真实投递：需要仓库管理权限、外部 HTTPS 地址及 webhook secret；本版仅完成本地签名模拟和持久化重试验证。
- 真实飞书 OAuth 与个人收信：需要企业自建应用、发布与权限审批、成员可用范围以及凭证。仅完成协议级 mock 验证，不宣称已有真实账号绑定或消息送达。
- Docker 镜像构建、远程 HTTPS 部署、多实例负载：未执行。正式部署设计限定单实例。
