import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { openDatabase, seedDemo, listItems, getSetting, setSetting, addActivity, addAudit } from './db.js';
import { authMiddleware, requireUser, requireAdmin, csrfGuard, newOAuthState, consumeOAuthState, createSession, cookies, hashToken, sessionUser } from './auth.js';
import { createServices, isParticipant } from './services.js';
import { verifyGitHubSignature, identityId } from './integrations/github.js';
import { exchangeFeishuCode, feishuAuthorizeUrl, sendFeishuMessage } from './integrations/feishu.js';
import { requestJson } from './integrations/http.js';
import { autoProvisionMemberInTransaction, githubAvatar, getMemberView, listMemberViews, updateMember, setMemberStatus } from './members.js';
import { getAccessPolicy, updateAccessPolicy } from './access-policy.js';
import { saveGitHubToken, deleteGitHubToken } from './github-tokens.js';
import { listConversation, syncItemConversation, postPlatformMessage, retryPlatformMessage, rerunItemCI, recordReads, readsForMessage, unreadSummary, messageDto } from './conversation.js';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const version=z.number().int().positive(), id=z.string().min(1).max(100), short=z.string().trim().max(120);
const ruleSchema=z.object({enabled:z.boolean(),staleHours:z.number().int().min(1).max(8760),reminderCooldownHours:z.number().int().min(1).max(720)}).strict();
const time=z.union([z.literal(''),z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)]);
const preferenceSchema=z.object({notificationsEnabled:z.boolean(),quietStart:time,quietEnd:time}).strict().refine(p=>Boolean(p.quietStart)===Boolean(p.quietEnd));
const itemPatch=z.object({version,workflow:z.enum(['todo','in_progress','blocked','done']).optional(),ownerMemberId:z.union([id,z.null()]).optional(),priority:z.enum(['low','normal','high']).optional(),dueAt:z.union([z.iso.datetime({offset:true}),z.null()]).optional()}).strict().refine(v=>Object.keys(v).length>1);
const memberPatch=z.object({version,displayName:short.optional(),module:short.optional(),notes:z.string().max(2000).optional(),role:z.enum(['admin','member']).optional()}).strict().refine(v=>Object.keys(v).length>1);
function pagination(query) {return {page:z.coerce.number().int().min(1).max(100000).parse(query.page||1),pageSize:z.coerce.number().int().min(1).max(100).parse(query.pageSize||20)};}
const iso=()=>new Date().toISOString();

export function createApp(config,{db=openDatabase(config.dbPath),integrations={},fetchImpl=fetch}={}) {
  const repository=getSetting(db,'repositoryIdentity');
  const previousRepositories=db.prepare('SELECT DISTINCT repository_id FROM items WHERE repository_id IS NOT NULL').all();
  if((repository&&repository.toLowerCase()!==config.repo.toLowerCase())||previousRepositories.some(row=>row.repository_id.toLowerCase()!==config.repo.toLowerCase())) throw new Error('This database belongs to another GitHub repository; use a separate database instead of changing GITHUB_REPO');
  if(!repository) setSetting(db,'repositoryIdentity',config.repo);
  if(config.demo) seedDemo(db,config.repo);
  db.exec("UPDATE notifications SET status='pending' WHERE status='sending'");
  const services=createServices(db,config,{...integrations,fetchImpl});
  const app=express();app.disable('x-powered-by');app.set('trust proxy',config.trustProxy || false);
  const allItems=()=>listItems(db,Date.now(),config.feishuAppId || '');
  function withUnread(items,memberId) {
    const unread=unreadSummary(db,memberId);
    return items.map(item=>({...item,unreadCount:unread[item.id]?.unread || 0,mentionCount:unread[item.id]?.mentions || 0,lastMessageAt:unread[item.id]?.lastMessageAt || null}));
  }
  const memberView=memberId=>getMemberView(db,memberId,{appId:config.feishuAppId || ''});
  function clearBrowserSessions(req,res) {
    const jar=cookies(req);
    if(jar.triage_session) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(jar.triage_session));
    for(const name of ['triage_session','triage_registration']) res.clearCookie(name,{path:'/',secure:config.secure,sameSite:'lax'});
  }
  function safeReturnTo(value) {
    if(typeof value!=='string'||value.length>1000||value.includes('\\')||/[\r\n]/.test(value)) return '/workspace';
    try {const url=new URL(value,config.baseUrl);return url.origin===config.baseUrl&&url.pathname==='/workspace'?url.pathname+url.search+url.hash:'/workspace';} catch {return '/workspace';}
  }
  function signInMember(profile,req,res,{accessToken='',scopes=''}={}) {
    const githubId=identityId(profile.githubId ?? profile.id);
    const userId=transact(()=>{
      // GitHub login links or creates the member account automatically; no
      // application or administrator approval is involved.
      const member=autoProvisionMemberInTransaction(db,{profile:{...profile,githubId},requestId:req.requestId});
      const avatar=config.demo ? (profile.avatarUrl || '') : githubAvatar({...profile,githubId});
      if(accessToken&&!config.demo) {
        const stored=saveGitHubToken(db,{memberId:member.id,login:profile.login,githubUserId:githubId,token:accessToken,scopes:scopes || config.githubOAuthScope},config);
        if(stored) addAudit(db,{actorId:member.id,action:'github.write_authorized',targetType:'member',targetId:member.id,after:{scopes:scopes || config.githubOAuthScope},requestId:req.requestId});
      }
      const existing=db.prepare('SELECT id FROM users WHERE member_id=?').get(member.id),uid=existing?.id || githubId;
      db.prepare('UPDATE users SET login=? WHERE login=? COLLATE NOCASE AND id<>?').run(`archived-${randomUUID()}`,profile.login,uid);
      db.prepare('INSERT INTO users(id,member_id,login,name,avatar_url) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET member_id=excluded.member_id,login=excluded.login,name=excluded.name,avatar_url=excluded.avatar_url').run(uid,member.id,profile.login,profile.name || profile.login,avatar);
      db.prepare("UPDATE members SET github_login=?,avatar_url=?,status='active',first_login_at=COALESCE(first_login_at,?),last_login_at=?,updated_at=?,version=version+1 WHERE id=?").run(profile.login,avatar,iso(),iso(),iso(),member.id);
      addAudit(db,{actorId:member.id,action:member.status==='pending_activation'?'member.activate':'auth.login',targetType:'member',targetId:member.id,requestId:req.requestId});
      clearBrowserSessions(req,res);return uid;
    });
    createSession(db,res,userId,config);
  }
  // Keep the generation outside the binding row: deleting/recreating a row
  // must never recycle version 1 while an old OAuth/test request is in flight.
  function bindingEpoch(memberId) {
    const binding=db.prepare('SELECT binding_version FROM feishu_bindings WHERE member_id=?').get(memberId);
    return Math.max(Number(getSetting(db,`bindingEpoch:${memberId}`,0)) || 0,binding?.binding_version || 0);
  }
  function nextBindingEpoch(memberId) {
    const epoch=bindingEpoch(memberId)+1;setSetting(db,`bindingEpoch:${memberId}`,epoch);return epoch;
  }
  function audit(req,action,targetType,targetId,before=null,after=null) {addAudit(db,{actorId:req.member?.id || null,action,targetType,targetId,before,after,requestId:req.requestId});}
  function fresh(req,admin=false) {
    const current=db.prepare('SELECT * FROM members WHERE id=?').get(req.member.id);
    const valid=db.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND member_id=? AND expires_at>?').get(req.session.token_hash || hashToken(cookies(req).triage_session || ''),req.member.id,Date.now());
    if(!current||current.status!=='active'||!valid) throw fail(401,'成员或会话已失效，请重新登录');
    if(admin&&current.role!=='admin') throw fail(403,'管理员权限已失效');
    return current;
  }
  function transact(fn) {db.exec('BEGIN IMMEDIATE');try {const result=fn();db.exec('COMMIT');return result;} catch(error) {db.exec('ROLLBACK');throw error;}}
  function mutateItem(req,itemId,patch,{claim=false}={}) {
    const item=allItems().find(i=>i.id===itemId);if(!item) throw fail(404,'事务不存在');
    if(item.version!==patch.version) throw fail(409,'事务已更新，请刷新后重试');
    const current=fresh(req);
    if(claim) {
      if(item.ownerMemberId||item.ownerIssue==='legacy_unresolved') throw fail(409,'事务已有负责人或旧负责人待核实，不能抢占');
      if(item.state!=='open') throw fail(400,'已关闭事务不能认领');
      patch={...patch,ownerMemberId:current.id};
    } else {
      if(current.role!=='admin'&&!isParticipant(item,req.user)) throw fail(403,'只能编辑自己参与的事务');
      if('ownerMemberId' in patch&&current.role!=='admin'&&(patch.ownerMemberId!==item.ownerMemberId||item.ownerIssue==='legacy_unresolved')) throw fail(403,'请使用认领入口；只有管理员可以分派或改派');
    }
    if(patch.ownerMemberId&&patch.ownerMemberId!==item.ownerMemberId) {
      const owner=db.prepare('SELECT status FROM members WHERE id=?').get(patch.ownerMemberId);
      if(!owner||owner.status==='disabled') throw fail(400,'负责人不存在或已停用');
    }
    const owner='ownerMemberId' in patch?patch.ownerMemberId:item.ownerMemberId;
    const changed=db.prepare('UPDATE items SET workflow=?,owner_member_id=?,owner=CASE WHEN ? THEN NULL ELSE owner END,legacy_owner_unresolved=CASE WHEN ? THEN 0 ELSE legacy_owner_unresolved END,priority=?,due_at=?,needs_review=CASE WHEN ? THEN 0 ELSE needs_review END,version=version+1 WHERE id=? AND version=?').run(patch.workflow??item.workflow,owner,Number('ownerMemberId' in patch),Number('ownerMemberId' in patch),patch.priority??item.priority,'dueAt' in patch?patch.dueAt:item.dueAt,Number('workflow' in patch),item.id,item.version);
    if(!changed.changes) throw fail(409,'事务已更新，请刷新后重试');
    const updated=allItems().find(i=>i.id===item.id);
    audit(req,claim?'item.claim':'item.update','item',item.id,{ownerMemberId:item.ownerMemberId,workflow:item.workflow,priority:item.priority,dueAt:item.dueAt,version:item.version},{ownerMemberId:updated.ownerMemberId,workflow:updated.workflow,priority:updated.priority,dueAt:updated.dueAt,version:updated.version});
    if(owner!==item.ownerMemberId) services.queueAssignment(updated,req.member.id,req.requestId);
    addActivity(db,'更新平台处理信息',`${req.user.login} 更新 #${item.number}（未改变 GitHub 状态）`);
    return updated;
  }
  app.use((req,res,next)=>{req.requestId=randomUUID();res.set('X-Request-ID',req.requestId);next();});
  app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'https:','https://avatars.githubusercontent.com','https://github.com','https://*.githubusercontent.com','https://github.githubassets.com','https://img.shields.io','https://*.shields.io','https://github-production-user-asset-6210df.s3.amazonaws.com','data:'],connectSrc:["'self'"],upgradeInsecureRequests:config.secure?[]:null}},strictTransportSecurity:config.secure?undefined:false}));
  app.get('/api/health',(_req,res)=>res.json({ok:true}));
  app.post('/api/webhooks/github',rateLimit({windowMs:60000,limit:120}),express.raw({type:'application/json',limit:'2mb'}),(req,res)=>{
    if(config.demo) throw fail(400,'演示模式不接收外部事件');
    if(!Buffer.isBuffer(req.body)||!verifyGitHubSignature(req.body,req.headers['x-hub-signature-256'],config.webhookSecret)) throw fail(401,'Webhook 签名无效');
    const delivery=req.headers['x-github-delivery'],event=req.headers['x-github-event'];
    if(typeof delivery!=='string'||!delivery||delivery.length>100||typeof event!=='string') throw fail(400,'缺少事件标识');
    let payload;try {payload=JSON.parse(req.body.toString('utf8'));} catch {throw fail(400,'无效 JSON');}
    if(!payload||typeof payload!=='object') throw fail(400,'无效事件对象');
    if(event==='ping') return res.json({ok:true});
    if(payload.repository?.full_name?.toLowerCase()!==config.repo.toLowerCase()) return res.json({ok:true});
    if(payload.repository.private===true||payload.repository.visibility==='private') services.publicPortal.revoke('private');
    services.acceptWebhook(payload,delivery,event);res.status(202).json({ok:true});
  });
  app.use(express.json({limit:'64kb'}));app.use(authMiddleware(db,config));
  app.use(['/api','/auth'],(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  app.use('/auth',rateLimit({windowMs:60000,limit:40}));
  app.get('/api/session',(req,res)=>{
    const policy=getAccessPolicy(db);
    res.json({mode:req.user?'member':'guest',user:req.user || null,csrfToken:req.session?.csrf || null,demo:config.demo,githubConfigured:!!config.githubClientId,feishuConfigured:!!(config.feishuAppId&&config.feishuAppSecret),repo:config.repo,features:{publicOverviewEnabled:policy.publicOverviewEnabled,conversationEnabled:true}});
  });
  app.use('/api/public',rateLimit({windowMs:60000,limit:120}));
  app.get('/api/public/overview',(req,res)=>{z.object({}).strict().parse(req.query);res.json(services.publicPortal.overview());});
  app.get('/api/public/items',(req,res)=>{
    const query=z.object({kind:z.enum(['pr','issue']).optional(),state:z.enum(['open','closed','all']).default('all'),q:z.string().max(200).default(''),page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20)}).strict().parse(req.query);res.json(services.publicPortal.list(query));
  });
  function demoGuard(req,res,next) {
    if(!config.demo) return res.status(404).json({error:'Not found'});
    if(req.headers.origin!==config.baseUrl||req.headers['x-demo-intent']!=='1') return res.status(403).json({error:'请通过明确的演示入口操作'});
    next();
  }
  app.post('/auth/demo/member',demoGuard,(req,res)=>{
    const body=z.object({login:z.enum(['demo-maintainer','reviewer-chen'])}).strict().parse(req.body);
    const githubId={'demo-maintainer':'1001','reviewer-chen':'1002'}[body.login];
    signInMember({githubId,login:body.login,name:body.login,avatarUrl:'',type:'User'},req,res);res.json({next:'/workspace',demo:true});
  });
  app.get('/auth/github',(req,res)=>{
    if(config.demo) return res.redirect('/');
    const context=JSON.stringify({returnTo:safeReturnTo(req.query.returnTo)});
    const state=newOAuthState(db,res,'github',null,config,context),url=new URL('https://github.com/login/oauth/authorize');
    url.search=new URLSearchParams({client_id:config.githubClientId,redirect_uri:`${config.baseUrl}/auth/github/callback`,state,scope:config.githubOAuthScope}).toString();res.redirect(url.toString());
  });
  app.get('/auth/github/callback',async(req,res)=>{
    const oauth=consumeOAuthState(db,req,res,'github',config);
    let context={};try {context=JSON.parse(oauth.user_id || '{}');} catch { /* legacy state has no navigation context */ }
    if(typeof req.query.code!=='string') throw fail(400,'GitHub 授权未完成');
    const {data:token}=await requestJson('https://github.com/login/oauth/access_token',{fetchImpl,method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:config.githubClientId,client_secret:config.githubClientSecret,code:req.query.code,redirect_uri:`${config.baseUrl}/auth/github/callback`}),label:'GitHub OAuth'});
    if(typeof token.access_token!=='string') throw fail(502,'GitHub 登录换取授权失败');
    const {data:profile}=await requestJson('https://api.github.com/user',{fetchImpl,headers:{Authorization:`Bearer ${token.access_token}`,Accept:'application/vnd.github+json','User-Agent':'aisbench-triage','X-GitHub-Api-Version':'2022-11-28'},label:'GitHub identity'});
    const githubId=identityId(profile.id);if(!githubId||typeof profile.login!=='string'||profile.type!=='User') throw fail(502,'无效 GitHub 个人身份');
    const member=db.prepare('SELECT status FROM members WHERE github_user_id=?').get(githubId);
    if(member?.status==='disabled') throw fail(403,'该成员已停用，请联系管理员');
    signInMember(profile,req,res,{accessToken:token.access_token,scopes:typeof token.scope==='string'?token.scope:''});
    const target=safeReturnTo(context?.returnTo),url=new URL(target,config.baseUrl);url.searchParams.set('auth','success');
    res.redirect(url.pathname+url.search+url.hash);
  });
  app.get('/auth/feishu/bind',requireUser,(req,res)=>{
    if(config.demo) return res.redirect('/?error=演示模式不连接真实飞书');
    if(!config.feishuAppId||!config.feishuAppSecret) throw fail(400,'请先配置飞书应用');
    const tokenHash=req.session.token_hash || hashToken(cookies(req).triage_session || '');
    const state=transact(()=>{
      fresh(req);
      const epoch=nextBindingEpoch(req.member.id);
      return newOAuthState(db,res,'feishu',req.member.id,config,JSON.stringify({sessionHash:tokenHash,epoch}));
    });
    res.redirect(feishuAuthorizeUrl({appId:config.feishuAppId,redirectUri:`${config.baseUrl}/auth/feishu/callback`,state}));
  });
  app.get('/auth/feishu/callback',requireUser,async(req,res)=>{
    if(config.demo) throw fail(400,'演示模式不连接真实飞书');
    const state=consumeOAuthState(db,req,res,'feishu',config);
    let intent;try {intent=JSON.parse(state.user_id || 'null');} catch { /* invalid legacy intent */ }
    if(state.member_id!==req.member.id||intent?.sessionHash!==req.session.token_hash||intent?.epoch!==bindingEpoch(req.member.id)||typeof req.query.code!=='string') throw fail(400,'飞书授权与当前登录用户、会话或绑定操作不匹配');
    const identity=await (integrations.exchangeCode || exchangeFeishuCode)({appId:config.feishuAppId,appSecret:config.feishuAppSecret,code:req.query.code,redirectUri:`${config.baseUrl}/auth/feishu/callback`,fetchImpl});
    transact(()=>{
      fresh(req);
      if(intent.epoch!==bindingEpoch(req.member.id)) throw fail(409,'绑定操作已被撤销或替换，请重新授权');
      const existing=db.prepare('SELECT member_id FROM feishu_bindings WHERE app_id=? AND open_id=?').get(config.feishuAppId,identity.openId);
      if(existing&&existing.member_id!==req.member.id) throw fail(409,'该飞书账号已绑定其他平台成员');
      db.prepare("INSERT INTO feishu_bindings(member_id,app_id,open_id,status,binding_version,bound_at,verified_at) VALUES (?,?,?,'needs_confirmation',?,?,NULL) ON CONFLICT(member_id) DO UPDATE SET app_id=excluded.app_id,open_id=excluded.open_id,status='needs_confirmation',binding_version=excluded.binding_version,bound_at=excluded.bound_at,verified_at=NULL").run(req.member.id,config.feishuAppId,identity.openId,intent.epoch,iso());
      db.prepare("UPDATE notifications SET status='cancelled',error_code='BINDING_CHANGED' WHERE recipient_member_id=? AND status IN ('pending','sending')").run(req.member.id);
      audit(req,'feishu.bind','member',req.member.id,null,{bound:true,verified:false});
    });
    addActivity(db,'飞书账号已绑定，待发送测试消息',req.user.login);res.redirect('/workspace?auth=success');
  });
  app.post('/auth/logout',(req,res,next)=>{if(!req.user) return res.status(401).json({error:'当前没有可退出的会话'});next();},csrfGuard(config),(req,res)=>{
    clearBrowserSessions(req,res);res.json({ok:true});
  });
  app.use('/api',requireUser,csrfGuard(config),rateLimit({windowMs:60000,limit:240}));
  app.get('/api/dashboard',(req,res)=>{
    const items=withUnread(allItems(),req.member.id),open=items.filter(i=>i.state==='open');
    const unreadTotal=items.reduce((sum,item)=>sum+item.unreadCount,0),mentionTotal=items.reduce((sum,item)=>sum+item.mentionCount,0);
    res.json({stats:{openIssues:open.filter(i=>i.kind==='issue').length,openPRs:open.filter(i=>i.kind==='pr').length,overdue:open.filter(i=>i.overdue).length,myTasks:open.filter(i=>i.workflow!=='done'&&isParticipant(i,req.user)).length,unassigned:open.filter(i=>!i.ownerMemberId).length,ownerIssues:open.filter(i=>i.ownerIssue).length,needsReview:open.filter(i=>i.needsReview).length,unreadMessages:unreadTotal,mentions:mentionTotal},items,activity:db.prepare('SELECT id,title,detail,created_at AS createdAt FROM activity ORDER BY created_at DESC LIMIT 20').all(),lastSync:getSetting(db,'lastSync'),syncError:getSetting(db,'syncError')});
  });
  app.get('/api/items/unread',(req,res)=>{z.object({}).strict().parse(req.query);const summary=unreadSummary(db,req.member.id);res.json({items:summary,total:Object.values(summary).reduce((sum,item)=>sum+item.unread,0),mentions:Object.values(summary).reduce((sum,item)=>sum+item.mentions,0)});});
  app.get('/api/items',(req,res)=>{
    let items=allItems();const {kind,state='open',mine,q,ownerMemberId,unassigned,ownerIssue,needsReview,module}=req.query;
    if(kind) items=items.filter(i=>i.kind===kind);
    if(state!=='all') items=items.filter(i=>i.state===state);
    if(mine==='true') items=items.filter(i=>isParticipant(i,req.user));
    if(ownerMemberId) items=items.filter(i=>i.ownerMemberId===ownerMemberId);
    if(unassigned==='true') items=items.filter(i=>!i.ownerMemberId);
    if(ownerIssue==='true') items=items.filter(i=>i.ownerIssue);
    if(needsReview==='true') items=items.filter(i=>i.needsReview);
    if(module) items=items.filter(i=>i.module===module);
    if(typeof q==='string') {const search=q.slice(0,200).toLowerCase();items=items.filter(i=>`${i.title} ${i.number} ${i.author} ${(i.labels||[]).join(' ')}`.toLowerCase().includes(search));}
    res.json({items:withUnread(items,req.member.id)});
  });
  app.get('/api/items/search',(req,res)=>{
    const query=z.object({q:z.string().max(100).default('')}).strict().parse(req.query);
    const needle=query.q.trim().toLowerCase();
    const items=allItems().filter(item=>!needle||`${item.number} ${item.title}`.toLowerCase().includes(needle)).slice(0,8)
      .map(item=>({id:item.id,number:item.number,kind:item.kind,title:item.title,state:item.state}));
    res.json({items});
  });
  app.get('/api/items/:id/conversation',async(req,res)=>{
    const query=z.object({before:z.string().max(50).optional(),limit:z.coerce.number().int().min(1).max(100).default(50),refresh:z.enum(['0','1']).default('0')}).strict().parse(req.query);
    let syncError=null;
    if(query.refresh==='1') {
      try { await syncItemConversation(db,config,req.params.id,{fetchImpl}); }
      catch(error) { if(error.status===404) throw error; syncError=error.code || error.message; }
    }
    res.json({...listConversation(db,config,req.params.id,req.member.id,{before:query.before || '',limit:query.limit}),syncError});
  });
  app.post('/api/items/:id/conversation/sync',rateLimit({windowMs:60000,limit:6,keyGenerator:req=>`conversation-sync:${req.member.id}`}),async(req,res)=>{
    z.object({}).strict().parse(req.body);fresh(req);
    const result=await syncItemConversation(db,config,req.params.id,{force:true,fetchImpl});
    res.json({...result,conversation:listConversation(db,config,req.params.id,req.member.id)});
  });
  app.post('/api/items/:id/messages',rateLimit({windowMs:60000,limit:10,keyGenerator:req=>`comment:${req.member.id}`}),async(req,res)=>{
    fresh(req);const body=z.object({body:z.string().trim().min(1).max(20000),clientId:z.string().max(64).optional()}).strict().parse(req.body);
    const row=await postPlatformMessage(db,config,{member:req.member,itemId:req.params.id,body:body.body,clientId:body.clientId,fetchImpl});
    res.status(201).json({message:messageDto(db,row,req.member.id)});
  });
  app.post('/api/items/:id/messages/:messageId/retry',rateLimit({windowMs:60000,limit:10,keyGenerator:req=>`comment-retry:${req.member.id}`}),async(req,res)=>{
    fresh(req);z.object({}).strict().parse(req.body);
    const row=await retryPlatformMessage(db,config,{member:req.member,itemId:req.params.id,messageId:req.params.messageId,fetchImpl});
    res.json({message:messageDto(db,row,req.member.id)});
  });
  app.post('/api/items/:id/ci/:eventId/rerun',rateLimit({windowMs:60000,limit:6,keyGenerator:req=>`ci-rerun:${req.member.id}`}),async(req,res)=>{
    fresh(req);z.object({}).strict().parse(req.body);
    res.json(await rerunItemCI(db,config,{member:req.member,itemId:req.params.id,eventId:req.params.eventId,fetchImpl}));
  });
  app.post('/api/items/:id/read',(req,res)=>{
    fresh(req);const body=z.object({messageIds:z.array(z.string().min(1).max(100)).min(1).max(50)}).strict().parse(req.body);
    res.json({marked:recordReads(db,req.member.id,req.params.id,body.messageIds)});
  });
  app.get('/api/items/:id/messages/:messageId/reads',(req,res)=>{
    z.object({}).strict().parse(req.query);
    res.json({members:readsForMessage(db,req.params.id,req.params.messageId)});
  });
  app.post('/api/github/authorization/revoke',(req,res)=>{
    fresh(req);z.object({}).strict().parse(req.body);
    const removed=deleteGitHubToken(db,req.member.id);
    addAudit(db,{actorId:req.member.id,action:'github.write_revoked',targetType:'member',targetId:req.member.id,after:{removed:removed>0},requestId:req.requestId});
    res.json({ok:true,removed:removed>0});
  });
  app.post('/api/items/bulk-assign',requireAdmin,(req,res)=>{
    const body=z.object({items:z.array(z.object({id,version}).strict()).min(1).max(100),ownerMemberId:z.union([id,z.null()])}).strict().parse(req.body);
    if(new Set(body.items.map(i=>i.id)).size!==body.items.length) throw fail(400,'事务列表包含重复项');
    res.json({items:transact(()=>{fresh(req,true);return body.items.map(i=>mutateItem(req,i.id,{version:i.version,ownerMemberId:body.ownerMemberId}));})});
  });
  app.patch('/api/items/:id',(req,res)=>res.json({item:transact(()=>mutateItem(req,req.params.id,itemPatch.parse(req.body)))}));
  app.post('/api/items/:id/claim',(req,res)=>{const body=z.object({version}).strict().parse(req.body);res.json({item:transact(()=>mutateItem(req,req.params.id,body,{claim:true}))});});
  app.post('/api/sync',requireAdmin,async(req,res)=>{fresh(req,true);const result=await services.sync();audit(req,'integration.sync','repository',config.repo);res.json(result);});
  app.get('/api/assignable-members',(_req,res)=>res.json({members:listMemberViews(db,{appId:config.feishuAppId || '',includeNotes:false}).filter(m=>m.status!=='disabled').map(m=>({id:m.id,githubId:m.githubId,login:m.login,name:m.displayName||m.name,module:m.module,status:m.status,reachable:m.reachable}))}));
  app.get('/api/members',requireAdmin,(_req,res)=>res.json({members:listMemberViews(db,{appId:config.feishuAppId || ''})}));
  app.get('/api/admin/access-policy',requireAdmin,(_req,res)=>{
    const status=services.publicPortal.inspect();res.json({policy:getAccessPolicy(db),publicStatus:{available:status.available,reason:status.reason,checkedAt:status.checkedAt}});
  });
  app.put('/api/admin/access-policy',requireAdmin,async(req,res)=>{
    const body=z.object({version,publicOverviewEnabled:z.boolean()}).strict().parse(req.body);
    const before=getAccessPolicy(db);
    if(body.publicOverviewEnabled&&!before.publicOverviewEnabled) {
      const visibility=await services.publicPortal.checkVisibility({force:true});
      if(!visibility?.public) throw fail(400,'无法确认仓库为公开状态，不能启用游客数据');
    }
    fresh(req,true);
    const policy=updateAccessPolicy(db,body,{actorId:req.member.id,requestId:req.requestId});
    if(!policy.publicOverviewEnabled) services.publicPortal.revoke('disabled');
    res.json({policy});
  });
  app.get('/api/admin/members',requireAdmin,(req,res)=>{
    const {page,pageSize}=pagination(req.query);let members=listMemberViews(db,{appId:config.feishuAppId || ''});
    const {q,status,role,module,bound}=req.query;
    if(typeof q==='string') members=members.filter(m=>`${m.login} ${m.displayName} ${m.name}`.toLowerCase().includes(q.slice(0,200).toLowerCase()));
    if(status) members=members.filter(m=>m.status===status);if(role) members=members.filter(m=>m.role===role);if(module) members=members.filter(m=>m.module===module);
    if(bound==='true'||bound==='false') members=members.filter(m=>m.feishuBound===(bound==='true'));
    res.json({members:members.slice((page-1)*pageSize,page*pageSize),total:members.length,page,pageSize});
  });
  app.patch('/api/admin/members/:id',requireAdmin,(req,res)=>{fresh(req,true);const member=updateMember(db,req.params.id,memberPatch.parse(req.body),{actorId:req.member.id,requestId:req.requestId});res.json({member:memberView(member.id)});});
  for(const [action,enabled] of [['disable',false],['enable',true]]) app.post(`/api/admin/members/:id/${action}`,requireAdmin,(req,res)=>{
    fresh(req,true);const body=z.object({version}).strict().parse(req.body);const member=setMemberStatus(db,req.params.id,{...body,enabled},{actorId:req.member.id,requestId:req.requestId});res.json({member:memberView(member.id)});
  });
  app.get('/api/rules',(req,res)=>res.json({rules:getSetting(db,'rules'),isAdmin:req.user.isAdmin}));
  app.put('/api/rules',requireAdmin,(req,res)=>{fresh(req,true);const rules=ruleSchema.parse(req.body),before=getSetting(db,'rules');transact(()=>{setSetting(db,'rules',rules);audit(req,'rules.update','settings','rules',before,rules);});res.json({rules});});
  app.post('/api/reminders/run',requireAdmin,async(req,res)=>{fresh(req,true);res.json(await services.runReminders());});
  app.get('/api/notifications',(req,res)=>{
    const fields='n.id,n.title,COALESCE(m.github_login,n.recipient) AS recipient,n.recipient_member_id AS recipientMemberId,n.status,n.reason,n.created_at AS createdAt,n.error,n.error_code AS errorCode,n.attempts,n.next_at AS nextAt';
    const base=`SELECT ${fields} FROM notifications n LEFT JOIN members m ON m.id=n.recipient_member_id`;
    const notifications=req.user.isAdmin?db.prepare(`${base} ORDER BY n.created_at DESC LIMIT 200`).all():db.prepare(`${base} WHERE n.recipient_member_id=? ORDER BY n.created_at DESC LIMIT 200`).all(req.member.id);res.json({notifications});
  });
  app.patch('/api/preferences',(req,res)=>{
    const p=preferenceSchema.parse(req.body);transact(()=>{db.prepare('UPDATE users SET notifications_enabled=?,quiet_start=?,quiet_end=? WHERE member_id=?').run(Number(p.notificationsEnabled),p.quietStart,p.quietEnd,req.member.id);db.prepare("UPDATE notifications SET next_at=0 WHERE recipient_member_id=? AND status='pending'").run(req.member.id);audit(req,'preferences.update','member',req.member.id,null,p);});res.json({user:sessionUser(db,req.member.id,config)});
  });
  app.delete('/api/feishu/binding',(req,res)=>{
    transact(()=>{
      nextBindingEpoch(req.member.id);
      db.prepare("DELETE FROM oauth_states WHERE member_id=? AND provider='feishu'").run(req.member.id);
      db.prepare('DELETE FROM feishu_bindings WHERE member_id=?').run(req.member.id);
      db.prepare('UPDATE users SET feishu_open_id=NULL WHERE member_id=?').run(req.member.id);
      db.prepare("UPDATE notifications SET status='cancelled',error_code='UNBOUND' WHERE recipient_member_id=? AND status IN ('pending','sending')").run(req.member.id);
      audit(req,'feishu.unbind','member',req.member.id,null,{bound:false});
    });res.json({ok:true});
  });
  app.post('/api/feishu/test',rateLimit({windowMs:60000,limit:3}),async(req,res)=>{
    if(config.demo) return res.json({sent:false,demo:true});
    const binding=db.prepare('SELECT * FROM feishu_bindings WHERE member_id=? AND app_id=?').get(req.member.id,config.feishuAppId);
    if(!binding) throw fail(400,'请先绑定当前应用的个人飞书账号');
    await (integrations.sendMessage || sendFeishuMessage)({appId:config.feishuAppId,appSecret:config.feishuAppSecret,openId:binding.open_id,title:'AISBench 个人提醒已连接',text:'这是一条由你主动发起的测试消息。',url:config.baseUrl,uuid:randomUUID()});
    transact(()=>{fresh(req);const updated=db.prepare("UPDATE feishu_bindings SET status='active',verified_at=? WHERE member_id=? AND binding_version=? AND app_id=? AND open_id=?").run(iso(),req.member.id,binding.binding_version,config.feishuAppId,binding.open_id);if(!updated.changes) throw fail(409,'绑定已变更，测试结果不能激活旧绑定');audit(req,'feishu.verify','member',req.member.id,null,{verified:true});});
    res.json({sent:true,demo:false,user:sessionUser(db,req.member.id,config)});
  });
  app.get('/api/admin/audit-logs',requireAdmin,(req,res)=>{
    const {page,pageSize}=pagination(req.query),action=typeof req.query.action==='string'?req.query.action:'';
    const filter=action?' WHERE a.action=?':'',args=action?[action]:[];
    const total=db.prepare(`SELECT COUNT(*) AS n FROM audit_logs a${filter}`).get(...args).n;
    const rows=db.prepare(`SELECT a.*,m.github_login AS actor FROM audit_logs a LEFT JOIN members m ON m.id=a.actor_member_id${filter} ORDER BY a.created_at DESC,a.rowid DESC LIMIT ? OFFSET ?`).all(...args,pageSize,(page-1)*pageSize);
    res.json({logs:rows.map(r=>({id:r.id,actor:r.actor || '本地运维',action:r.action,targetType:r.target_type,targetId:r.target_id,before:r.before_json?JSON.parse(r.before_json):null,after:r.after_json?JSON.parse(r.after_json):null,requestId:r.request_id,createdAt:r.created_at})),total,page,pageSize});
  });
  app.get('/api/admin/integration-status',requireAdmin,(_req,res)=>{
    const counts=table=>Object.fromEntries(db.prepare(`SELECT status,COUNT(*) AS n FROM ${table} GROUP BY status`).all().map(r=>[r.status,r.n]));
    const wc=counts('webhook_inbox'),nc=counts('notifications'),mc=counts('members');
    res.json({demo:config.demo,repo:config.repo,lastSync:getSetting(db,'lastSync'),syncError:getSetting(db,'syncError'),nextSyncAllowedAt:getSetting(db,'nextSyncAllowedAt'),githubConfigured:!!config.githubClientId,feishuConfigured:!!(config.feishuAppId&&config.feishuAppSecret),syncIntervalMinutes:config.syncIntervalMs/60000,webhookIntervalSeconds:15,webhook:{pending:wc.pending||0,done:wc.done||0,oldestPendingAt:db.prepare("SELECT MIN(received_at) AS at FROM webhook_inbox WHERE status='pending'").get().at},notifications:{...Object.fromEntries(['pending','sending','sent','failed','skipped','cancelled'].map(k=>[k,nc[k]||0])),oldestPendingAt:db.prepare("SELECT MIN(created_at) AS at FROM notifications WHERE status='pending'").get().at},membership:{active:mc.active||0,pending:mc.pending_activation||0,disabled:mc.disabled||0},schemaVersion:db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version});
  });
  app.post('/api/admin/webhooks/:id/retry',requireAdmin,(req,res)=>{
    fresh(req,true);const job=db.prepare('SELECT status FROM webhook_inbox WHERE id=?').get(req.params.id);if(!job) throw fail(404,'事件不存在');if(job.status==='done') throw fail(409,'已完成事件不能重复执行');
    db.prepare("UPDATE webhook_inbox SET next_at=0,status='pending' WHERE id=?").run(req.params.id);audit(req,'webhook.retry','webhook',req.params.id);res.json({ok:true});
  });
  app.use('/api',(_req,res)=>res.status(404).json({error:'API 不存在'}));app.use('/auth',(_req,res)=>res.status(404).json({error:'授权地址不存在'}));
  const dist=path.resolve('dist');
  if(existsSync(path.join(dist,'index.html'))) {app.use(express.static(dist,{index:false}));app.get('/{*path}',(_req,res)=>res.sendFile(path.join(dist,'index.html')));}
  else app.get('/',(_req,res)=>res.status(503).type('text').send('前端尚未构建，请先运行 npm run build。'));
  app.use((error,_req,res,_next)=>{
    if(res.headersSent) return;
    if(error instanceof z.ZodError) return res.status(400).json({error:'输入参数不合法，请检查字段格式和范围'});
    const status=error.status>=400&&error.status<600?error.status:502;
    res.status(status).json({error:status<500?error.message:'外部服务或平台请求失败，请检查配置与连接',requestId:_req.requestId});
  });
  return {app,db,services};
}
