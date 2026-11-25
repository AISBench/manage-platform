import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { openDatabase, seedDemo, listItems, getSetting, setSetting, addActivity, addAudit } from './db.js';
import { authMiddleware, requireUser, requireAdmin, csrfGuard, newOAuthState, consumeOAuthState, createSession, cookies, hashToken, sessionUser } from './auth.js';
import { createServices, isParticipant, nextNotificationAt } from './services.js';
import { verifyGitHubSignature, identityId, fetchPullRequestFiles, createIssue, searchIssues } from './integrations/github.js';
import { exchangeFeishuCode, feishuAuthorizeUrl, sendFeishuMessage, sendFeishuWebhookMessage } from './integrations/feishu.js';
import { deleteWebhook, decryptWebhookUrl, getWebhook, saveWebhook, webhookView } from './feishu-webhooks.js';
import { requestJson } from './integrations/http.js';
import { autoProvisionMemberInTransaction, githubAvatar, getMemberView, listMemberViews, updateMember, setMemberStatus } from './members.js';
import { getAccessPolicy, updateAccessPolicy } from './access-policy.js';
import { saveGitHubToken, deleteGitHubToken, getGitHubToken } from './github-tokens.js';
import { listConversation, syncItemConversation, postPlatformMessage, postPlatformReview, retryPlatformMessage, resolveItemReviewThread, rerunItemCI, recordReads, readsForMessage, unreadSummary, messageDto, getMessage } from './conversation.js';
import { listLabels, labelWriteAccess, updateItemLabels, hasLabel } from './labels.js';
import { createAgentAdaptorClient } from './integrations/platform-agent-adaptor.js';
import { buildItemContext } from './agent-context.js';
import { agentDraftSchema, agentActionSchema, formatDraftError } from './agent-draft.js';
import { validateInlineComments, inlineCommentFormatError } from './inline-review.js';
import { createAgentToken, listAgentTokens, revokeAgentToken, resolveAgentToken } from './agent-tokens.js';
import { createTask as createAgentTask, listTasksForMember, listTasksForItem, listQueuedForToken, getTask as getAgentTask, claimTask as claimAgentTask, submitDraft as submitAgentDraft, getDraft as getAgentDraft, getLatestDraftForItem, listDraftsForMember, markPublished, markPublishError, markDeclined, updateDraftPayload } from './agent-tasks.js';
import { issueDraftSchema, formatIssueDraftError, inspectIssueDraft, attachDuplicateScores, duplicateBlockers, buildIssuePayload } from './agent-issue.js';
import { prDraftSchema, formatPrDraftError, verifyPrResult } from './agent-pr.js';
import { getIssueTemplates } from './issue-templates.js';
import { getDevflowSkill } from './agent-skill.js';
import { issueTaskInstructions, prTaskInstructions } from './agent-prompts.js';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const version=z.number().int().positive(), id=z.string().min(1).max(100), short=z.string().trim().max(120);
const ruleSchema=z.object({enabled:z.boolean(),staleHours:z.number().int().min(1).max(8760),reminderCooldownHours:z.number().int().min(1).max(720)}).strict();
const time=z.union([z.literal(''),z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)]);
const preferenceSchema=z.object({notificationsEnabled:z.boolean(),quietStart:time,quietEnd:time,notificationMode:z.enum(['realtime','hourly','daily']).optional(),digestHour:z.number().int().min(0).max(23).optional()}).strict().refine(p=>Boolean(p.quietStart)===Boolean(p.quietEnd));
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
  const agentAdaptor=integrations.agentAdaptor || createAgentAdaptorClient(config,{fetchImpl});
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
    try {
      const url=new URL(value,config.baseUrl);
      // Detail pages need to be a legal post-OAuth target so a CI or comment
      // authorization returns to the exact item instead of the workspace root.
      const allowed=url.pathname==='/workspace'||/^\/workspace\/items\/[^/]+$/.test(url.pathname);
      return url.origin===config.baseUrl&&allowed?url.pathname+url.search+url.hash:'/workspace';
    } catch {return '/workspace';}
  }
  function signInMember(profile,req,res,{accessToken='',scopes=''}={}) {
    const githubId=identityId(profile.githubId ?? profile.id);
    let writeStored=false;
    const userId=transact(()=>{
      // GitHub login links or creates the member account automatically; no
      // application or administrator approval is involved.
      const member=autoProvisionMemberInTransaction(db,{profile:{...profile,githubId},requestId:req.requestId});
      const avatar=config.demo ? (profile.avatarUrl || '') : githubAvatar({...profile,githubId});
      if(accessToken&&!config.demo) {
        writeStored=saveGitHubToken(db,{memberId:member.id,login:profile.login,githubUserId:githubId,token:accessToken,scopes:scopes || config.githubOAuthScope},config);
        if(writeStored) addAudit(db,{actorId:member.id,action:'github.write_authorized',targetType:'member',targetId:member.id,after:{scopes:scopes || config.githubOAuthScope},requestId:req.requestId});
      }
      const existing=db.prepare('SELECT id FROM users WHERE member_id=?').get(member.id),uid=existing?.id || githubId;
      db.prepare('UPDATE users SET login=? WHERE login=? COLLATE NOCASE AND id<>?').run(`archived-${randomUUID()}`,profile.login,uid);
      db.prepare('INSERT INTO users(id,member_id,login,name,avatar_url) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET member_id=excluded.member_id,login=excluded.login,name=excluded.name,avatar_url=excluded.avatar_url').run(uid,member.id,profile.login,profile.name || profile.login,avatar);
      db.prepare("UPDATE members SET github_login=?,avatar_url=?,status='active',first_login_at=COALESCE(first_login_at,?),last_login_at=?,updated_at=?,version=version+1 WHERE id=?").run(profile.login,avatar,iso(),iso(),iso(),member.id);
      addAudit(db,{actorId:member.id,action:member.status==='pending_activation'?'member.activate':'auth.login',targetType:'member',targetId:member.id,requestId:req.requestId});
      clearBrowserSessions(req,res);return uid;
    });
    createSession(db,res,userId,config);
    return writeStored;
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
    res.json({mode:req.user?'member':'guest',user:req.user || null,csrfToken:req.session?.csrf || null,demo:config.demo,githubConfigured:!!config.githubClientId,githubWriteConfigured:!!config.tokenEncryptionKey,githubOAuthScopes:config.githubOAuthScope,feishuConfigured:!!(config.feishuAppId&&config.feishuAppSecret),feishuOAuthConfigured:!!(config.feishuAppId&&config.feishuAppSecret),feishuWebhookConfigured:!!config.tokenEncryptionKey&&!config.demo,agentAdaptorConfigured:Boolean(config.agentAdaptorUrl&&config.agentAdaptorToken),repo:config.repo,features:{publicOverviewEnabled:policy.publicOverviewEnabled,conversationEnabled:true,agentAccessEnabled:config.agentEnabled,agentMcp:{command:config.agentMcpCommand,args:config.agentMcpArgs}}});
  });
  app.use('/api/public',rateLimit({windowMs:60000,limit:120}));
  // ---- Agent access: personal token routes (Bearer, no browser session) ----
  // Registered before the session/CSRF guards so an external Agent never needs
  // a cookie. Tokens are personal, revocable and only stored as SHA-256 hashes.
  const agentEnabled=Boolean(config.agentEnabled);
  const agentNotFound=res=>res.status(404).json({error:'Not found'});
  function agentBearer(req) {
    const header=req.headers.authorization || '';
    if(header.startsWith('Bearer ')) return header.slice(7).trim();
    const direct=req.headers['x-agent-token'];
    return typeof direct==='string'?direct.trim():'';
  }
  function requireAgentToken(req,res,next) {
    if(!agentEnabled) return agentNotFound(res);
    const agent=resolveAgentToken(db,agentBearer(req));
    if(!agent) return res.status(401).json({error:'AGENT_TOKEN_INVALID'});
    req.agent=agent;next();
  }
  const agentLimiter=rateLimit({windowMs:60000,limit:120,keyGenerator:req=>`agent:${req.agent.tokenId}`});
  const agentItemContext=async (itemId,replyToMessageId='')=>{
    const item=allItems().find(entry=>entry.id===itemId);
    if(!item) return null;
    const replyTo=agentReplyContext(item.id,replyToMessageId);
    const reviewTask=item.kind==='pr'&&!replyToMessageId;
    if(item.kind!=='pr') return buildItemContext(db,item,{repo:config.repo,replyTo});
    // PR review needs the actual change. Fetch it read-only from GitHub on
    // demand; failure is surfaced to the Agent instead of silently reviewing
    // the title/comments only.
    try {
      const files=await fetchPullRequestFiles({repo:config.repo,number:item.number,token:config.githubToken,fetchImpl});
      return buildItemContext(db,item,{repo:config.repo,pullFiles:files,replyTo,reviewTask});
    } catch(error) {
      console.warn(`[agent-context] pull request files unavailable (#${item.number}, ${error?.status || error?.name || 'Error'})`);
      return buildItemContext(db,item,{repo:config.repo,pullFiles:[],filesError:'暂时无法读取该 PR 的变更文件，请仅基于标题、正文、评论与知识库检视',replyTo,reviewTask});
    }
  };
  function agentReplyContext(itemId,messageId) {
    if(!messageId) return null;
    const target=getMessage(db,itemId,messageId);
    if(!target || target.remote_deleted) return null;
    const reviewCommentId=target.kind==='review_comment'?String(target.github_comment_id||'').replace(/^review_comment:/,''):'';
    const thread=target.kind==='review_comment'?db.prepare(`SELECT author_login,body,created_at,in_reply_to_id FROM item_messages
      WHERE item_id=? AND kind='review_comment' AND remote_deleted=0
        AND (id=? OR (?<>'' AND thread_id=?) OR in_reply_to_id=?)
      ORDER BY created_at ASC`).all(itemId,target.id,target.thread_id||'',target.thread_id||'',reviewCommentId)
      :[{author_login:target.author_login,body:target.body,created_at:target.created_at,in_reply_to_id:target.in_reply_to_id}];
    return {
      messageId:target.id,
      kind:target.kind,
      reviewCommentId,
      author:target.author_login||'',
      body:String(target.body||'').slice(0,2000),
      path:target.path||'',
      line:target.line ?? null,
      startLine:target.start_line ?? null,
      side:target.side||'',
      url:target.url||'',
      thread:thread.map(row=>({author:row.author_login||'',body:String(row.body||'').slice(0,1000),createdAt:row.created_at,inReplyTo:row.in_reply_to_id||''})),
    };
  }
  // ---- Agent write paths: issue drafting (human publishes) and PR results ----
  const issueSearchCache=new Map();
  async function agentIssueSearch({query,state='open',label=''}) {
    const cacheKey=`${query}|${state}|${label}`;
    const cached=issueSearchCache.get(cacheKey);
    if(cached&&Date.now()-cached.at<60000) return cached.items;
    let items;
    if(config.demo) {
      const needle=query.toLowerCase();
      items=allItems().filter(item=>item.kind==='issue'&&(!label||(item.labels||[]).includes(label))&&(state==='all'||item.state===state)
        &&(`${item.number} ${item.title}`.toLowerCase().includes(needle))).slice(0,10)
        .map(item=>({number:item.number,title:item.title||'',state:item.state||'',url:item.url||'',body:String(item.body||'').slice(0,4000),labels:item.labels||[],updatedAt:item.updatedAt||null}));
    } else {
      items=await searchIssues({repo:config.repo,token:config.githubToken,query,state,labels:label?[label]:[],perPage:10,fetchImpl});
    }
    issueSearchCache.set(cacheKey,{at:Date.now(),items});
    if(issueSearchCache.size>200) issueSearchCache.delete(issueSearchCache.keys().next().value);
    return items;
  }
  async function submitItemDraft({task,payload,agent}) {
    const parsed=agentDraftSchema.safeParse(payload);
    if(!parsed.success) throw fail(400,formatDraftError(parsed.error));
    const item=allItems().find(entry=>entry.id===task.item_id);
    if(!item) throw fail(404,'事务不存在');
    const comments=parsed.data.comments||[];
    if(comments.length&&item.kind!=='pr') throw fail(400,'只有 PR 检视可以提交行内意见','INLINE_COMMENT_INVALID');
    if(task.message_id&&comments.length) throw fail(400,'回复检视意见时不能附带行内意见','INLINE_COMMENT_INVALID');
    if(item.kind==='pr'&&!task.message_id&&!comments.length) throw fail(400,'PR 检视草稿至少需要一条行内意见','INLINE_COMMENT_REQUIRED');
    if(item.kind==='pr'&&!task.message_id&&parsed.data.comment_md.length>600) throw fail(400,'PR 检视摘要请控制在 600 字以内，具体问题写到行内意见','REVIEW_SUMMARY_TOO_LONG');
    for(const [index,comment] of comments.entries()) {
      const formatError=inlineCommentFormatError(comment.body);
      if(formatError) throw fail(400,`comments.${index}.body：${formatError}`,'INLINE_COMMENT_FORMAT');
    }
    if(comments.length&&!config.demo) {
      let files;
      try { files=await fetchPullRequestFiles({repo:config.repo,number:item.number,token:config.githubToken,fetchImpl}); }
      catch { throw fail(502,'无法校验行内意见：读取 PR 文件失败，请稍后重试','REVIEW_FILES_UNAVAILABLE'); }
      const error=validateInlineComments(files,comments);
      if(error) throw fail(400,`行内意见定位无效：${error}`,'INLINE_COMMENT_INVALID');
    }
    return submitAgentDraft(db,{taskId:task.id,memberId:agent.memberId,draft:parsed.data,agentName:agent.agentName,agentTokenPrefix:agent.tokenPrefix});
  }
  async function submitIssueDraft({task,payload,agent}) {
    // MCP clients fill defaults for their own tool schema; keep only the fields
    // this draft kind owns so strict validation stays meaningful.
    const allowed=['kind','templateId','title','fields','labels','supplement','dedupe','summary','model'];
    const picked=Object.fromEntries(Object.entries(payload&&typeof payload==='object'?payload:{}).filter(([key])=>allowed.includes(key)));
    const parsed=issueDraftSchema.safeParse({...picked,kind:'issue_create'});
    if(!parsed.success) throw fail(400,formatIssueDraftError(parsed.error));
    const templates=await getIssueTemplates(db,config,{fetchImpl});
    const repoLabels=listLabels(db).map(label=>label.name);
    const inspection=inspectIssueDraft(parsed.data,{templates:templates.templates,repoLabels});
    if(inspection.errors.length) throw fail(400,inspection.errors.join('；'),'ISSUE_DRAFT_INVALID');
    let duplicates=parsed.data.dedupe.candidates;
    if(!config.demo) {
      const found=[];
      for(const query of parsed.data.dedupe.queries.slice(0,3)) {
        try { found.push(...await searchIssues({repo:config.repo,token:config.githubToken,query,state:'all',perPage:10,fetchImpl})); } catch { /* keep Agent evidence */ }
      }
      const unique=[...new Map(found.map(item=>[item.number,item])).values()];
      if(unique.length) duplicates=attachDuplicateScores(parsed.data,inspection.template,unique);
    }
    return submitAgentDraft(db,{taskId:task.id,memberId:agent.memberId,agentName:agent.agentName,agentTokenPrefix:agent.tokenPrefix,
      draft:{kind:'issue_create',summary:parsed.data.summary||parsed.data.title,comment_md:'',comments:[],actions:[],references:[],confidence:0,model:parsed.data.model,
        payload:buildIssuePayload(parsed.data,{template:inspection.template,duplicates})}});
  }
  async function submitPrDraft({task,payload,agent}) {
    const allowed=['kind','issueNumber','prUrl','prNumber','headSha','baseRef','headRef','forkOwner','prTitle','gate','unverified','summary','model'];
    const picked=Object.fromEntries(Object.entries(payload&&typeof payload==='object'?payload:{}).filter(([key])=>allowed.includes(key)));
    const parsed=prDraftSchema.safeParse({...picked,kind:'pr_result'});
    if(!parsed.success) throw fail(400,formatPrDraftError(parsed.error));
    if(Number(task.number)!==parsed.data.issueNumber) throw fail(400,'PR 关联的 Issue 与任务不一致','PR_ISSUE_MISMATCH');
    let verification={errors:[],checks:{state:'unknown',checkRuns:'unknown',statuses:'unknown'},pr:null};
    if(!config.demo) verification=await verifyPrResult({payload:parsed.data,repo:config.repo,memberLogin:agent.login,token:config.githubToken,fetchImpl});
    if(verification.errors.length) throw fail(400,verification.errors.join('；'),'PR_DRAFT_INVALID');
    return submitAgentDraft(db,{taskId:task.id,memberId:agent.memberId,agentName:agent.agentName,agentTokenPrefix:agent.tokenPrefix,
      draft:{kind:'pr_result',summary:parsed.data.summary||parsed.data.prTitle||`PR #${parsed.data.prNumber}`,comment_md:'',comments:[],actions:[],references:[],confidence:0,model:parsed.data.model,
        payload:{...parsed.data,checks:verification.checks,pr:verification.pr}}});
  }
  async function publishIssueDraft(req,res,body,draft) {
    const payload=draft.payload||{};
    const templates=await getIssueTemplates(db,config,{fetchImpl});
    const repoLabels=listLabels(db).map(label=>label.name);
    const shape={templateId:payload.templateId,title:payload.title,fields:payload.fields||{},labels:payload.labels||[],supplement:payload.supplement||'',
      dedupe:payload.dedupe||{queries:[],candidates:[],conclusion:'not_duplicate',rationale:''}};
    const inspection=inspectIssueDraft(shape,{templates:templates.templates,repoLabels});
    if(inspection.errors.length) throw fail(400,inspection.errors.join('；'),'ISSUE_DRAFT_INVALID');
    if(!config.demo) {
      const found=[];
      for(const query of (shape.dedupe.queries||[]).slice(0,3)) {
        try { found.push(...await searchIssues({repo:config.repo,token:config.githubToken,query,state:'all',perPage:10,fetchImpl})); } catch { /* comment search failure below */ }
      }
      const unique=[...new Map(found.map(item=>[item.number,item])).values()];
      if(unique.length) {
        const duplicates=attachDuplicateScores(shape,inspection.template,unique);
        const blockers=duplicateBlockers(duplicates,body.confirmedDuplicates||[]);
        if(blockers.length) throw fail(409,`存在相近 Issue 未确认：${blockers.map(item=>`#${item.number} ${item.title}（相似度 ${Math.round(item.similarity*100)}%）`).join('；')}`,'ISSUE_DUPLICATE');
      }
    }
    if(config.demo) {
      markPublished(db,draft.id,'');
      audit(req,'agent.issue_publish','agent_draft',draft.id,null,{demo:true});
      return res.json({demo:true,simulated:true,draft:getAgentDraft(db,draft.id,req.member.id),issueUrl:'',issueNumber:null});
    }
    const token=getGitHubToken(db,req.member.id,config);
    if(!token) throw fail(409,'需要 GitHub 写权限，请重新登录授权（public_repo）','GITHUB_WRITE_AUTH_REQUIRED');
    const agentLabel=(draft.agentName||(draft.agentTokenPrefix?`${draft.agentTokenPrefix}…`:draft.model||'未命名 Agent')).replace(/[\r\n]+/g,' ').slice(0,120);
    const modelNote=draft.model&&draft.model!==draft.agentName?`（模型：${draft.model}）`:'';
    const annotation=`\n\n---\n> 本 Issue 由 Agent「${agentLabel}」生成${modelNote}，经 @${req.user.login} 审核后以本人身份创建。`;
    let issue;
    try { issue=await createIssue({repo:config.repo,token,title:payload.title,body:`${inspection.body}${annotation}`,labels:payload.labels||[],fetchImpl}); }
    catch(error) { markPublishError(db,draft.id,error.message); throw error; }
    markPublished(db,draft.id,issue.html_url);
    audit(req,'agent.issue_publish','agent_draft',draft.id,null,{issueNumber:issue.number,issueUrl:issue.html_url,identity:'member',agentName:agentLabel});
    try { await services.sync(); } catch { /* the issue exists on GitHub; sync is best-effort */ }
    res.json({draft:getAgentDraft(db,draft.id,req.member.id),issueUrl:issue.html_url,issueNumber:issue.number});
  }
  async function publishPrDraft(req,res,draft) {
    const payload=draft.payload||{};
    if(!config.demo) {
      const verification=await verifyPrResult({payload,repo:config.repo,memberLogin:req.user.login,token:config.githubToken,fetchImpl});
      if(verification.errors.length) throw fail(409,verification.errors.join('；'),'PR_DRAFT_INVALID');
    }
    markPublished(db,draft.id,payload.prUrl||'');
    audit(req,'agent.pr_accept','agent_draft',draft.id,null,{prUrl:payload.prUrl||'',prNumber:payload.prNumber||null});
    res.json({draft:getAgentDraft(db,draft.id,req.member.id),prUrl:payload.prUrl||''});
  }
  app.use('/api/agent',(req,res,next)=>{if(!agentEnabled) return agentNotFound(res);next();});
  if(agentEnabled) {
    app.get('/api/agent/me',requireAgentToken,(req,res)=>res.json({memberId:req.agent.memberId,login:req.agent.login,name:req.agent.name,scopes:req.agent.scopes}));
    app.get('/api/agent/tasks',requireAgentToken,agentLimiter,(req,res)=>{z.object({}).strict().parse(req.query);res.json({tasks:listQueuedForToken(db,req.agent.memberId)});});
    app.post('/api/agent/tasks/:id/claim',requireAgentToken,agentLimiter,(req,res)=>{
      z.object({}).strict().parse(req.body||{});
      if(!claimAgentTask(db,req.params.id,req.agent.memberId)) throw fail(404,'任务不存在或已过期');
      res.json({ok:true});
    });
    app.get('/api/agent/tasks/:id/context',requireAgentToken,agentLimiter,async(req,res)=>{
      z.object({}).strict().parse(req.query);
      const task=getAgentTask(db,req.params.id,req.agent.memberId);
      if(!task) throw fail(404,'任务不存在');
      // Keep the requester's intent next to the facts so a claimed task never
      // loses the hint if the Agent did not cache the task list response.
      const taskInfo={id:task.id,kind:task.kind,hint:task.hint,replyTo:task.replyTo,item:task.item};
      if(task.kind==='issue_create') {
        const templates=await getIssueTemplates(db,config,{fetchImpl});
        return res.json({kind:'issue_create',repo:config.repo,requirement:task.hint,task:taskInfo,
          templates:templates.templates,labels:listLabels(db).map(label=>label.name),
          instructions:issueTaskInstructions({repo:config.repo})});
      }
      const context=await agentItemContext(task.itemId,task.messageId);
      if(!context) throw fail(404,'事务不存在');
      if(task.kind==='pr_create') {
        let devflow=null,devflowError='';
        try { devflow=await getDevflowSkill(db,config,{fetchImpl}); } catch(error) { devflowError=error.message; }
        return res.json({...context,kind:'pr_create',repo:config.repo,baseRef:'master',devflow,devflowError,task:taskInfo,
          instructions:prTaskInstructions({repo:config.repo})});
      }
      res.json({...context,task:taskInfo});
    });
    app.get('/api/agent/items/:id/context',requireAgentToken,agentLimiter,async(req,res)=>{
      z.object({}).strict().parse(req.query);
      const item=allItems().find(entry=>entry.id===req.params.id);
      if(!item) throw fail(404,'事务不存在');
      if(item.state!=='open') throw fail(400,'只有开放事项可以获取 Agent 上下文');
      res.json(await agentItemContext(item.id));
    });
    app.post('/api/agent/kb/search',requireAgentToken,agentLimiter,async(req,res)=>{
      const body=z.object({repo:z.string().trim().max(200).min(1),question:z.string().trim().min(1).max(2000),topK:z.number().int().min(1).max(12).optional()}).strict().parse(req.body||{});
      if(config.demo) throw fail(503,'演示模式不连接知识库（AGENT_DEMO）');
      res.json(await agentAdaptor.searchKb({repo:body.repo,question:body.question,topK:body.topK}));
    });
    app.get('/api/agent/kb/wiki',requireAgentToken,agentLimiter,async(req,res)=>{
      const query=z.object({repo:z.string().trim().max(200).min(1),topic:z.string().trim().min(1).max(200)}).strict().parse(req.query);
      if(config.demo) throw fail(503,'演示模式不连接知识库（AGENT_DEMO）');
      res.json(await agentAdaptor.wiki({repo:query.repo,topic:query.topic}));
    });
    app.post('/api/agent/tasks/:id/submit',requireAgentToken,agentLimiter,async(req,res)=>{
      const task=db.prepare('SELECT * FROM agent_tasks WHERE id=? AND member_id=?').get(req.params.id,req.agent.memberId);
      if(!task) throw fail(404,'任务不存在或不属于当前令牌');
      const payload=req.body?.draft ?? req.body;
      const draft=task.kind==='issue_create'?await submitIssueDraft({task,payload,agent:req.agent})
        :task.kind==='pr_create'?await submitPrDraft({task,payload,agent:req.agent})
        :await submitItemDraft({task,payload,agent:req.agent});
      addAudit(db,{actorId:req.agent.memberId,action:'agent.draft.submit',targetType:'agent_draft',targetId:draft.id,after:{taskId:req.params.id,kind:draft.kind},requestId:req.requestId});
      res.status(201).json({draft});
    });
    app.get('/api/agent/issue-templates',requireAgentToken,agentLimiter,async(req,res)=>{
      z.object({}).strict().parse(req.query);
      res.json(await getIssueTemplates(db,config,{fetchImpl}));
    });
    app.get('/api/agent/issues/search',requireAgentToken,agentLimiter,async(req,res)=>{
      const query=z.object({q:z.string().trim().min(1).max(200),state:z.enum(['open','closed','all']).default('open'),label:z.string().trim().max(100).optional()}).strict().parse(req.query);
      const items=await agentIssueSearch({query:query.q,state:query.state,label:query.label||''});
      res.json({items});
    });
  }
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
    let token;
    try {
      ({data:token}=await requestJson('https://github.com/login/oauth/access_token',{fetchImpl,method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:config.githubClientId,client_secret:config.githubClientSecret,code:req.query.code,redirect_uri:`${config.baseUrl}/auth/github/callback`}),label:'GitHub OAuth'}));
    } catch (error) {
      console.warn(`[${req.requestId}] GitHub OAuth token exchange failed (${error.name || 'Error'}${error.status ? ` ${error.status}` : ''})`);
      throw Object.assign(fail(502,'无法连接 GitHub 完成授权，请检查服务器到 github.com 的网络或代理后重试'),{code:'GITHUB_OAUTH_UNAVAILABLE'});
    }
    if(typeof token.access_token!=='string') throw fail(502,'GitHub 登录换取授权失败');
    let profile;
    try {
      ({data:profile}=await requestJson('https://api.github.com/user',{fetchImpl,headers:{Authorization:`Bearer ${token.access_token}`,Accept:'application/vnd.github+json','User-Agent':'aisbench-triage','X-GitHub-Api-Version':'2022-11-28'},label:'GitHub identity'}));
    } catch (error) {
      console.warn(`[${req.requestId}] GitHub OAuth profile request failed (${error.name || 'Error'}${error.status ? ` ${error.status}` : ''})`);
      throw Object.assign(fail(502,'无法读取 GitHub 账号信息，请检查服务器到 github.com 的网络或代理后重试'),{code:'GITHUB_OAUTH_UNAVAILABLE'});
    }
    const githubId=identityId(profile.id);if(!githubId||typeof profile.login!=='string'||profile.type!=='User') throw fail(502,'无效 GitHub 个人身份');
    const member=db.prepare('SELECT status FROM members WHERE github_user_id=?').get(githubId);
    if(member?.status==='disabled') throw fail(403,'该成员已停用，请联系管理员');
    const stored=signInMember(profile,req,res,{accessToken:token.access_token,scopes:typeof token.scope==='string'?token.scope:''});
    const target=safeReturnTo(context?.returnTo),url=new URL(target,config.baseUrl);
    if(!stored) url.searchParams.set('error','write_storage_unavailable');
    else url.searchParams.set('auth','success');
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
    res.json({stats:{openIssues:open.filter(i=>i.kind==='issue').length,openPRs:open.filter(i=>i.kind==='pr').length,overdue:open.filter(i=>i.overdue).length,myTasks:open.filter(i=>i.workflow!=='done'&&isParticipant(i,req.user)).length,unassigned:open.filter(i=>!i.ownerMemberId).length,ownerIssues:open.filter(i=>i.ownerIssue).length,needsReview:open.filter(i=>i.needsReview).length,unreadMessages:unreadTotal,mentions:mentionTotal,bugIssues:open.filter(i=>i.kind==='issue'&&hasLabel(i,'bug')).length,featureIssues:open.filter(i=>i.kind==='issue'&&hasLabel(i,'feature')).length,rfcIssues:open.filter(i=>i.kind==='issue'&&hasLabel(i,'rfc')).length},items,activity:db.prepare('SELECT id,title,detail,created_at AS createdAt FROM activity ORDER BY created_at DESC LIMIT 20').all(),lastSync:getSetting(db,'lastSync'),syncError:getSetting(db,'syncError')});
  });
  app.get('/api/labels',async(req,res)=>{
    z.object({}).strict().parse(req.query);
    const access=await labelWriteAccess(db,config,req.member.id);
    res.json({labels:listLabels(db),canEdit:access.canEdit,reason:access.reason,permissions:access.permissions});
  });
  app.put('/api/items/:id/labels',rateLimit({windowMs:60000,limit:20,keyGenerator:req=>`item-labels:${req.member.id}`}),async(req,res)=>{
    fresh(req);
    const body=z.object({labels:z.array(z.string().trim().min(1).max(100)).max(20)}).strict().parse(req.body);
    const result=await updateItemLabels(db,config,{member:req.member,itemId:req.params.id,labels:body.labels,requestId:req.requestId});
    res.json({item:allItems().find(item=>item.id===req.params.id),labels:result.labels});
  });
  app.get('/api/items/unread',(req,res)=>{z.object({}).strict().parse(req.query);const summary=unreadSummary(db,req.member.id);res.json({items:summary,total:Object.values(summary).reduce((sum,item)=>sum+item.unread,0),mentions:Object.values(summary).reduce((sum,item)=>sum+item.mentions,0)});});
  app.get('/api/items',(req,res)=>{
    let items=allItems();const {kind,state='open',mine,q,ownerMemberId,unassigned,ownerIssue,needsReview,module,unread,mentions,label,reviewRequested}=req.query;
    if(reviewRequested!==undefined&&reviewRequested!=='me') throw fail(400,'评审邀请筛选仅支持 me');
    if(kind) items=items.filter(i=>i.kind===kind);
    if(reviewRequested==='me') {
      const githubId=String(req.member.github_user_id || '');
      items=items.filter(i=>i.kind==='pr'&&githubId&&(i.reviewerIds||[]).some(id=>String(id)===githubId));
    }
    if(label) items=items.filter(i=>hasLabel(i,label));
    if(state!=='all') items=items.filter(i=>i.state===state);
    if(mine==='true') items=items.filter(i=>isParticipant(i,req.user));
    if(ownerMemberId) items=items.filter(i=>i.ownerMemberId===ownerMemberId);
    if(unassigned==='true') items=items.filter(i=>!i.ownerMemberId);
    if(ownerIssue==='true') items=items.filter(i=>i.ownerIssue);
    if(needsReview==='true') items=items.filter(i=>i.needsReview);
    if(module) items=items.filter(i=>i.module===module);
    if(unread==='true'||mentions==='true') {
      const summary=unreadSummary(db,req.member.id);
      items=items.filter(i=>unread==='true' ? (summary[i.id]?.unread||0)>0 : (summary[i.id]?.mentions||0)>0);
    }
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
      try { const result=await syncItemConversation(db,config,req.params.id,{fetchImpl}); if(result.newMessages?.length) services.notifyConversationMessages(result.item,result.newMessages); }
      catch(error) { if(error.status===404) throw error; syncError=error.code || error.message; }
    }
    res.json({...listConversation(db,config,req.params.id,req.member.id,{before:query.before || '',limit:query.limit}),syncError});
  });
  app.post('/api/items/:id/conversation/sync',rateLimit({windowMs:60000,limit:6,keyGenerator:req=>`conversation-sync:${req.member.id}`}),async(req,res)=>{
    z.object({}).strict().parse(req.body);fresh(req);
    const result=await syncItemConversation(db,config,req.params.id,{force:true,fetchImpl});
    if(result.newMessages?.length) services.notifyConversationMessages(result.item,result.newMessages);
    res.json({...result,conversation:listConversation(db,config,req.params.id,req.member.id)});
  });
  app.post('/api/items/:id/messages',rateLimit({windowMs:60000,limit:10,keyGenerator:req=>`comment:${req.member.id}`}),async(req,res)=>{
    fresh(req);const body=z.object({body:z.string().trim().min(1).max(20000),clientId:z.string().max(64).optional()}).strict().parse(req.body);
    const row=await postPlatformMessage(db,config,{member:req.member,itemId:req.params.id,body:body.body,clientId:body.clientId,fetchImpl});
    res.status(201).json({message:messageDto(db,row,req.member.id)});
  });
  app.post('/api/items/:id/messages/:messageId/reply',rateLimit({windowMs:60000,limit:10,keyGenerator:req=>`comment-reply:${req.member.id}`}),async(req,res)=>{
    fresh(req);const body=z.object({body:z.string().trim().min(1).max(20000),clientId:z.string().max(64).optional()}).strict().parse(req.body);
    const target=getMessage(db,req.params.id,req.params.messageId);
    if(!target) throw fail(404,'原评论不存在');
    const row=await postPlatformMessage(db,config,{member:req.member,itemId:req.params.id,body:body.body,clientId:body.clientId,replyTo:target,fetchImpl});
    res.status(201).json({message:messageDto(db,row,req.member.id)});
  });
  app.post('/api/items/:id/messages/:messageId/retry',rateLimit({windowMs:60000,limit:10,keyGenerator:req=>`comment-retry:${req.member.id}`}),async(req,res)=>{
    fresh(req);z.object({}).strict().parse(req.body);
    const row=await retryPlatformMessage(db,config,{member:req.member,itemId:req.params.id,messageId:req.params.messageId,fetchImpl});
    res.json({message:messageDto(db,row,req.member.id)});
  });
  app.post('/api/items/:id/messages/:messageId/resolve',rateLimit({windowMs:60000,limit:10,keyGenerator:req=>`review-resolve:${req.member.id}`}),async(req,res)=>{
    fresh(req);z.object({}).strict().parse(req.body);
    const result=await resolveItemReviewThread(db,config,{member:req.member,itemId:req.params.id,messageId:req.params.messageId,fetchImpl});
    res.json({...result,conversation:listConversation(db,config,req.params.id,req.member.id)});
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
  function itemForRequest(req) {const item=allItems().find(i=>i.id===req.params.id);if(!item) throw fail(404,'事务不存在');return item;}
  app.post('/api/sync',requireAdmin,async(req,res)=>{fresh(req,true);const result=await services.sync();audit(req,'integration.sync','repository',config.repo);res.json(result);});
  // ---- Agent access: member-side token management, tasks and draft review ----
  if(agentEnabled) {
    app.get('/api/agent/tokens',(req,res)=>{
      fresh(req);z.object({}).strict().parse(req.query);
      res.json({tokens:listAgentTokens(db,req.member.id)});
    });
    app.post('/api/agent/tokens',rateLimit({windowMs:60000,limit:5,keyGenerator:req=>`agent-token:${req.member.id}`}),(req,res)=>{
      fresh(req);const body=z.object({name:z.string().trim().min(1).max(60)}).strict().parse(req.body);
      const created=createAgentToken(db,{memberId:req.member.id,name:body.name});
      audit(req,'agent.token.create','agent_token',created.id,null,{name:body.name});
      res.status(201).json({id:created.id,token:created.token,prefix:created.prefix,name:body.name});
    });
    app.delete('/api/agent/tokens/:id',(req,res)=>{
      fresh(req);
      if(!revokeAgentToken(db,req.member.id,req.params.id)) throw fail(404,'令牌不存在或已撤销');
      audit(req,'agent.token.revoke','agent_token',req.params.id);
      res.json({ok:true});
    });
    app.post('/api/agent/issue-tasks',rateLimit({windowMs:86400000,limit:5,keyGenerator:req=>`agent-issue-task:${req.member.id}`}),(req,res)=>{
      fresh(req);
      const body=z.object({requirement:z.string().trim().min(10).max(2000),templateId:z.string().trim().max(100).optional(),hint:z.string().trim().max(500).optional(),clientRequestId:z.string().uuid().optional()}).strict().parse(req.body||{});
      const hint=[body.requirement,body.hint?`补充：${body.hint}`:'',body.templateId?`期望模板：${body.templateId}`:''].filter(Boolean).join('\n\n');
      const result=createAgentTask(db,{kind:'issue_create',repo:config.repo,memberId:req.member.id,hint,clientRequestId:body.clientRequestId||randomUUID()});
      if(result.created) audit(req,'agent.issue_task.create','agent_task',result.task.id,null,{templateId:body.templateId||''});
      res.status(result.created?201:200).json(result);
    });
    app.get('/api/agent/my-tasks',(req,res)=>{
      fresh(req);z.object({}).strict().parse(req.query);
      res.json({tasks:listTasksForMember(db,req.member.id)});
    });
    app.get('/api/issue-templates',async(req,res)=>{
      fresh(req);z.object({}).strict().parse(req.query);
      res.json(await getIssueTemplates(db,config,{fetchImpl}));
    });
    app.post('/api/items/:id/agent-task',rateLimit({windowMs:60000,limit:10,keyGenerator:req=>`agent-task:${req.member.id}`}),(req,res)=>{
      fresh(req);const body=z.object({hint:z.string().trim().max(500).optional(),messageId:z.string().min(1).max(200).optional(),kind:z.enum(['item_review','pr_create']).default('item_review')}).strict().parse(req.body||{});
      const item=itemForRequest(req);
      if(item.kind!=='issue'&&item.kind!=='pr') throw fail(400,'只有 Issue 或 PR 可以交给 Agent');
      if(item.state!=='open') throw fail(400,'已关闭的 Issue / PR 不能创建 Agent 任务');
      if(body.kind==='pr_create') {
        if(item.kind!=='issue') throw fail(400,'只能针对 Issue 创建提 PR 任务');
        if(body.messageId) throw fail(400,'提 PR 任务不支持评论锚点');
        const result=createAgentTask(db,{kind:'pr_create',itemId:item.id,repo:config.repo,number:item.number,memberId:req.member.id,hint:body.hint||''});
        if(result.created) audit(req,'agent.pr_task.create','item',item.id,null,{taskId:result.task.id});
        return res.status(result.created?201:200).json(result);
      }
      let messageId='',reviewCommentId='';
      if(body.messageId) {
        const target=getMessage(db,item.id,body.messageId);
        const remote=target?String(target.github_comment_id||''):'';
        const reviewId=target&&target.kind==='review_comment'&&remote.startsWith('review_comment:')?remote.slice('review_comment:'.length):'';
        if(!target||target.remote_deleted||!['issue_comment','review_comment','platform'].includes(target.kind)) throw fail(400,'只能回复仍在的评论','INVALID_REPLY_TARGET');
        if(target.kind==='review_comment'&&(item.kind!=='pr'||!/^[1-9]\d*$/.test(reviewId))) throw fail(400,'只能回复 PR 的行内检视意见','INVALID_REPLY_TARGET');
        messageId=target.id;reviewCommentId=reviewId;
      }
      const result=createAgentTask(db,{itemId:item.id,repo:config.repo,number:item.number,memberId:req.member.id,hint:body.hint||'',messageId,reviewCommentId});
      if(result.created) audit(req,'agent.task.create','item',item.id,null,{taskId:result.task.id,replyTo:reviewCommentId||messageId||undefined});
      res.status(result.created?201:200).json(result);
    });
    app.get('/api/items/:id/agent-tasks',(req,res)=>{
      fresh(req);z.object({}).strict().parse(req.query);
      const item=itemForRequest(req);
      res.json({tasks:listTasksForItem(db,req.member.id,item.id)});
    });
    app.get('/api/items/:id/agent-task',(req,res)=>{
      fresh(req);z.object({}).strict().parse(req.query);
      const task=listTasksForMember(db,req.member.id).find(entry=>entry.itemId===req.params.id && ['queued','claimed','submitted'].includes(entry.status)) || null;
      // Return the latest draft even after publish/decline so the issue page can
      // keep showing the result (comment link or rejection reason).
      res.json({task,draft:getLatestDraftForItem(db,req.params.id,req.member.id)});
    });
    app.get('/api/agent/drafts',(req,res)=>{
      fresh(req);z.object({}).strict().parse(req.query);
      res.json({drafts:listDraftsForMember(db,req.member.id)});
    });
    app.post('/api/agent/drafts/:id/publish',async(req,res)=>{
      fresh(req);const body=z.object({actions:z.array(agentActionSchema).max(10).optional(),commentIndexes:z.array(z.number().int().min(0).max(20)).max(20).optional(),confirmedDuplicates:z.array(z.number().int().min(1).max(100000000)).max(20).optional()}).strict().parse(req.body||{});
      const draft=getAgentDraft(db,req.params.id,req.member.id);
      if(!draft) throw fail(404,'草稿不存在');
      if(draft.status!=='pending') throw fail(409,'该草稿已处理，不能重复发布');
      if(draft.kind==='issue_create') return publishIssueDraft(req,res,body,draft);
      if(draft.kind==='pr_result') return publishPrDraft(req,res,draft);
      const actions=body.actions ?? draft.actions;
      const comments=draft.comments||[];
      const selectedComments=(() => {
        if(!comments.length) return [];
        const indexes=body.commentIndexes ?? comments.map((_,index)=>index);
        const seen=new Set();
        return indexes.filter(index=>index>=0&&index<comments.length&&!seen.has(index)&&seen.add(index)).map(index=>comments[index]);
      })();
      if(comments.length&&!selectedComments.length&&!draft.task.messageId) throw fail(400,'请至少选择一条行内检视意见','INLINE_COMMENT_REQUIRED');
      if(config.demo) {
        markPublished(db,draft.id,'');
        audit(req,'agent.publish','agent_draft',draft.id,null,{demo:true,actions:actions.length,comments:selectedComments.length});
        return res.json({demo:true,simulated:true,draft:getAgentDraft(db,draft.id,req.member.id),commentUrl:'',applied:[],errors:[]});
      }
      // A reviewed Agent draft is published as the member's own GitHub identity.
      // The disclosure line is mandatory so readers can tell which Agent wrote it.
      const agentLabel=(draft.agentName||(draft.agentTokenPrefix?`${draft.agentTokenPrefix}…`:draft.model||'未命名 Agent')).replace(/[\r\n]+/g,' ').slice(0,120);
      const modelNote=draft.model&&draft.model!==draft.agentName?`（模型：${draft.model}）`:'';
      const annotation=`\n\n---\n> 本评论由 Agent「${agentLabel}」生成${modelNote}，经 @${req.user.login} 审核后以本人身份发布。`;
      if(actions.length&&!agentAdaptor.configured) throw fail(503,'勾选强副作用动作需要 Agent Adaptor 接入','AGENT_ADAPTOR_DISABLED');
      const replyTarget=draft.task.messageId?getMessage(db,draft.task.itemId,draft.task.messageId):null;
      if(draft.task.messageId&&!replyTarget) throw fail(409,'原检视意见已不可用，请重新创建回复任务','REPLY_TARGET_MISSING');
      let message;
      try {
        if(replyTarget) message=await postPlatformMessage(db,config,{member:req.member,itemId:draft.task.itemId,body:`${draft.commentMd}${annotation}`,bodyLimit:60000,replyTo:replyTarget,fetchImpl});
        else if(selectedComments.length) message=await postPlatformReview(db,config,{member:req.member,itemId:draft.task.itemId,body:`${draft.commentMd}${annotation}`,comments:selectedComments,fetchImpl});
        else message=await postPlatformMessage(db,config,{member:req.member,itemId:draft.task.itemId,body:`${draft.commentMd}${annotation}`,bodyLimit:60000,fetchImpl});
      } catch(error) {
        markPublishError(db,draft.id,error.message);
        throw error;
      }
      let applied=[],errors=[];
      if(actions.length) {
        try {
          const result=await agentAdaptor.publish({repo:draft.task.repo,number:draft.task.number,commentMd:'',actions,requester:`agent:${req.user.login}`,idempotencyKey:`${draft.id}:actions`,postComment:false});
          applied=result?.applied||[];errors=result?.errors||[];
        } catch(error) { errors=[error.message]; }
      }
      const commentUrl=message?.url||'';
      markPublished(db,draft.id,commentUrl);
      audit(req,'agent.publish','agent_draft',draft.id,null,{commentUrl,identity:'member',agentName:agentLabel,actions:actions.length,actionErrors:errors.length,comments:selectedComments.length,replyTo:draft.task.reviewCommentId||undefined});
      res.json({draft:getAgentDraft(db,draft.id,req.member.id),commentUrl,applied,errors});
    });
    app.post('/api/agent/drafts/:id/decline',(req,res)=>{
      fresh(req);z.object({}).strict().parse(req.body||{});
      const draft=getAgentDraft(db,req.params.id,req.member.id);
      if(!draft) throw fail(404,'草稿不存在');
      if(draft.status!=='pending') throw fail(409,'该草稿已处理');
      markDeclined(db,draft.id);
      audit(req,'agent.draft.decline','agent_draft',draft.id);
      res.json({draft:getAgentDraft(db,draft.id,req.member.id)});
    });
    app.post('/api/agent/drafts/:id/refresh',async(req,res)=>{
      fresh(req);z.object({}).strict().parse(req.body||{});
      const draft=getAgentDraft(db,req.params.id,req.member.id);
      if(!draft) throw fail(404,'草稿不存在');
      if(draft.kind!=='pr_result') throw fail(400,'只有 PR 结果草稿支持刷新');
      let payload={...(draft.payload||{})};
      if(!config.demo) {
        const verification=await verifyPrResult({payload,repo:config.repo,memberLogin:req.user.login,token:config.githubToken,fetchImpl});
        payload={...payload,checks:verification.checks,pr:verification.pr,verifyErrors:verification.errors,refreshedAt:new Date().toISOString()};
      }
      updateDraftPayload(db,draft.id,payload);
      res.json({draft:getAgentDraft(db,draft.id,req.member.id)});
    });
  }
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
    const fields='n.id,n.title,COALESCE(m.github_login,n.recipient) AS recipient,n.recipient_member_id AS recipientMemberId,n.status,n.reason,n.created_at AS createdAt,n.error,n.error_code AS errorCode,n.attempts,n.next_at AS nextAt,n.event_type AS eventType';
    const base=`SELECT ${fields} FROM notifications n LEFT JOIN members m ON m.id=n.recipient_member_id`;
    const notifications=req.user.isAdmin?db.prepare(`${base} ORDER BY n.created_at DESC LIMIT 200`).all():db.prepare(`${base} WHERE n.recipient_member_id=? ORDER BY n.created_at DESC LIMIT 200`).all(req.member.id);res.json({notifications});
  });
  app.patch('/api/preferences',(req,res)=>{
    const p=preferenceSchema.parse(req.body);transact(()=>{
      const current=db.prepare('SELECT notification_mode,digest_hour FROM users WHERE member_id=?').get(req.member.id)||{};
      const mode=p.notificationMode ?? current.notification_mode ?? 'realtime';
      const digestHour=p.digestHour ?? current.digest_hour ?? 9;
      db.prepare('UPDATE users SET notifications_enabled=?,quiet_start=?,quiet_end=?,notification_mode=?,digest_hour=? WHERE member_id=?').run(Number(p.notificationsEnabled),p.quietStart,p.quietEnd,mode,digestHour,req.member.id);
      const nextAt=nextNotificationAt(mode,digestHour);
      const pending=db.prepare("SELECT id FROM notifications WHERE recipient_member_id=? AND status='pending'").all(req.member.id);
      for(const notice of pending) db.prepare('UPDATE notifications SET next_at=? WHERE id=?').run(nextAt,notice.id);
      audit(req,'preferences.update','member',req.member.id,null,{...p,notificationMode:mode,digestHour});
    });res.json({user:sessionUser(db,req.member.id,config)});
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
  app.put('/api/feishu/webhook',rateLimit({windowMs:60000,limit:10,keyGenerator:req=>`feishu-webhook:${req.member.id}`}),(req,res)=>{
    if(config.demo) throw fail(400,'演示模式不连接真实飞书');
    const body=z.object({url:z.string().min(1).max(2048)}).strict().parse(req.body);
    const user=transact(()=>{
      fresh(req);
      const version=nextBindingEpoch(req.member.id);
      const {host}=saveWebhook(db,req.member.id,body.url,config,version);
      db.prepare("UPDATE notifications SET status='cancelled',error_code='BINDING_CHANGED' WHERE recipient_member_id=? AND status IN ('pending','sending')").run(req.member.id);
      addAudit(db,{actorId:req.member.id,action:'feishu.webhook_bind',targetType:'member',targetId:req.member.id,after:{host},requestId:req.requestId});
      return sessionUser(db,req.member.id,config);
    });
    res.json({webhook:webhookView(db,req.member.id),user});
  });
  app.delete('/api/feishu/webhook',(req,res)=>{
    const user=transact(()=>{
      fresh(req);
      nextBindingEpoch(req.member.id);
      deleteWebhook(db,req.member.id);
      db.prepare("UPDATE notifications SET status='cancelled',error_code='UNBOUND' WHERE recipient_member_id=? AND status IN ('pending','sending')").run(req.member.id);
      audit(req,'feishu.webhook_unbind','member',req.member.id,null,{bound:false});
      return sessionUser(db,req.member.id,config);
    });
    res.json({ok:true,webhook:webhookView(db,req.member.id),user});
  });
  app.post('/api/feishu/webhook/test',rateLimit({windowMs:60000,limit:3,keyGenerator:req=>`feishu-webhook-test:${req.member.id}`}),async(req,res)=>{
    if(config.demo) return res.json({sent:false,demo:true});
    const webhook=getWebhook(db,req.member.id);
    if(!webhook) throw fail(400,'请先配置个人飞书机器人');
    const webhookUrl=decryptWebhookUrl(webhook,config);
    if(!webhookUrl) throw fail(503,'个人机器人地址无法解密，请重新配置');
    await (integrations.sendWebhook || sendFeishuWebhookMessage)({webhookUrl,title:'AISBench 个人提醒已连接',text:'这是一条由你主动发起的测试消息。',url:config.baseUrl});
    transact(()=>{
      fresh(req);
      const updated=db.prepare("UPDATE feishu_webhooks SET status='active',verified_at=? WHERE member_id=? AND binding_version=?").run(iso(),req.member.id,webhook.binding_version);
      if(!updated.changes) throw fail(409,'绑定已变更，测试结果不能激活旧绑定');
      audit(req,'feishu.webhook_verify','member',req.member.id,null,{verified:true});
    });
    res.json({sent:true,demo:false,channel:'webhook',user:sessionUser(db,req.member.id,config)});
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
    res.json({demo:config.demo,repo:config.repo,lastSync:getSetting(db,'lastSync'),syncError:getSetting(db,'syncError'),nextSyncAllowedAt:getSetting(db,'nextSyncAllowedAt'),githubConfigured:!!config.githubClientId,feishuConfigured:!!(config.feishuAppId&&config.feishuAppSecret),feishuWebhookConfigured:!!config.tokenEncryptionKey&&!config.demo,syncIntervalMinutes:config.syncIntervalMs/60000,webhookIntervalSeconds:15,webhook:{pending:wc.pending||0,done:wc.done||0,oldestPendingAt:db.prepare("SELECT MIN(received_at) AS at FROM webhook_inbox WHERE status='pending'").get().at},notifications:{...Object.fromEntries(['pending','sending','sent','failed','skipped','cancelled'].map(k=>[k,nc[k]||0])),oldestPendingAt:db.prepare("SELECT MIN(created_at) AS at FROM notifications WHERE status='pending'").get().at},membership:{active:mc.active||0,pending:mc.pending_activation||0,disabled:mc.disabled||0},schemaVersion:db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version});
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
    if(status>=500) console.error(`[${_req.requestId}] ${_req.method} ${_req.path} failed: ${error.name || 'Error'}${error.status ? ` status=${error.status}` : ''}${error.code ? ` code=${error.code}` : ''}`);
    const safe=status<500||error.code==='GITHUB_OAUTH_UNAVAILABLE';
    res.status(status).json({error:safe?error.message:'外部服务或平台请求失败，请检查配置与连接',requestId:_req.requestId});
  });
  return {app,db,services};
}
