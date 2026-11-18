import { randomUUID } from 'node:crypto';
import { listItems, getSetting, setSetting, addActivity, addAudit } from './db.js';
import { fetchRepositoryItems, fetchRepositoryLabels, identityId } from './integrations/github.js';
import { sendFeishuMessage, sendFeishuWebhookMessage } from './integrations/feishu.js';
import { decryptWebhookUrl } from './feishu-webhooks.js';
import { createPublicService } from './public-service.js';
import { mentionLogins, syncConversationBatch, upsertFromWebhook } from './conversation.js';
import { syncRepositoryLabels } from './labels.js';

export function isQuietTime(start,end,now=new Date()) {
  if (!start || !end || start===end) return false;
  const time=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(now);
  return start<end ? time>=start&&time<end : time>=start||time<end;
}
function quietEndAt(end,now=Date.now()) {
  const [h,m]=end.split(':').map(Number), local=new Date(now+8*3600000);
  const target=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate(),h,m)-8*3600000;
  return target<=now?target+86400000:target;
}
// Realtime is immediate; hourly posts at the next top of the hour; daily posts
// at the member's chosen Asia/Shanghai hour. Boundaries are computed in UTC.
export function nextNotificationAt(mode='realtime',digestHour=9,now=Date.now()) {
  if (mode==='realtime') return 0;
  const local=new Date(now+8*3600000),y=local.getUTCFullYear(),m=local.getUTCMonth(),d=local.getUTCDate();
  if (mode==='hourly') return Date.UTC(y,m,d,local.getUTCHours()+1,0,0)-8*3600000;
  const hour=Number.isInteger(digestHour)&&digestHour>=0&&digestHour<=23?digestHour:9;
  const at=Date.UTC(y,m,d,hour,0,0)-8*3600000;
  return at<=now?at+86400000:at;
}
export function isParticipant(item,identity) {
  if (!identity || typeof identity!=='object') return false; // Never authorize a mutable login string.
  const memberId=identity.memberId || identity.id, githubId=identity.githubId || identity.github_user_id;
  return (!!item.ownerMemberId&&item.ownerMemberId===memberId) || (!!githubId&&[item.authorId,...(item.assigneeIds||[]),...(item.reviewerIds||[])].includes(String(githubId)));
}
const nowISO=()=>new Date().toISOString();
const KIND=item=>item.kind==='pr'?'PR':'Issue';
const EVENT_LABELS={
  new_issue:'新 Issue',new_pr:'新 PR',assigned:'指派给你',review_requested:'请求你评审',
  comment:'新评论',review:'新评审',review_comment:'新行内评论',mention:'有人 @你',reply:'回复了你的评论',
  ci:'CI 状态',status:'状态更新',stale:'超期催办',assignment:'平台分派',legacy:'提醒',
};
const isBotActor=user=>user?.type==='Bot'||/\[bot\]$/i.test(String(user?.login||''));
const REVIEW_STATES={approved:'通过',changes_requested:'要求修改',commented:'评论'};
const CI_STATES={success:'通过',failure:'失败',cancelled:'已取消',timed_out:'超时',action_required:'需要处理',neutral:'无结论',skipped:'跳过'};
const excerpt=(value,limit=160)=>{const text=String(value||'').replace(/\s+/g,' ').trim();return text.length>limit?`${text.slice(0,limit)}…`:text;};
const titleFor=(type,item)=>`[${EVENT_LABELS[type]||EVENT_LABELS.legacy}] ${KIND(item)} #${item.number} · ${item.title}`.slice(0,300);

export function createServices(db,config,integrations={}) {
  const fetchItems=integrations.fetchItems || fetchRepositoryItems, sendMessage=integrations.sendMessage || sendFeishuMessage;
  const sendWebhook=integrations.sendWebhook || sendFeishuWebhookMessage;
  const publicPortal=createPublicService(db,config,integrations);
  let syncPromise=null,reminderPromise=null,webhookPromise=null;
  const items=()=>listItems(db,Date.now(),config.feishuAppId || '');
  const members=()=>db.prepare('SELECT * FROM members').all();
  const memberByGithubId=id=>id?db.prepare('SELECT * FROM members WHERE github_user_id=?').get(String(id))||null:null;
  const memberByLogin=login=>login?db.prepare('SELECT * FROM members WHERE github_login=? COLLATE NOCASE').get(login)||null:null;
  const memberById=id=>id?db.prepare('SELECT * FROM members WHERE id=?').get(id)||null:null;
  function recipients(item) {
    const all=members();
    const related=all.filter(member=>isParticipant(item,{id:member.id,githubId:member.github_user_id}));
    // An explicit unavailable owner stays visible for reassignment; a disabled
    // external participant alone must not suppress administrator fallback.
    const candidates=item.ownerMemberId?related:related.filter(member=>member.status!=='disabled');
    return candidates.length?candidates:all.filter(member=>member.role==='admin'&&member.status==='active');
  }
  function deliveryContext(member) {
    const user=db.prepare('SELECT * FROM users WHERE member_id=?').get(member.id);
    const webhook=db.prepare('SELECT * FROM feishu_webhooks WHERE member_id=?').get(member.id);
    const binding=db.prepare('SELECT * FROM feishu_bindings WHERE member_id=?').get(member.id);
    let errorCode=null,channel=null,bindingVersion=null;
    if (member.status==='disabled') errorCode='MEMBER_DISABLED';
    else if (member.status!=='active') errorCode='MEMBER_PENDING';
    // A verified personal webhook is tenant-independent and takes precedence.
    else if (webhook?.status==='active'&&webhook.verified_at) {channel='webhook';bindingVersion=webhook.binding_version;}
    else if (binding?.app_id===config.feishuAppId&&binding.status==='active'&&binding.verified_at) {channel='oauth';bindingVersion=binding.binding_version;}
    else if (!webhook&&!binding) errorCode='UNBOUND';
    else if (webhook&&(webhook.status!=='active'||!webhook.verified_at)) errorCode='WEBHOOK_CONFIRMATION';
    else if (binding&&binding.app_id!==config.feishuAppId) errorCode='APP_MISMATCH';
    else errorCode='BINDING_CONFIRMATION';
    if (!errorCode&&!user?.notifications_enabled) errorCode='NOTIFICATIONS_DISABLED';
    return {user,webhook,binding,channel,bindingVersion,errorCode};
  }
  const unreachable={MEMBER_PENDING:'成员尚未首次登录',UNBOUND:'成员尚未绑定飞书',APP_MISMATCH:'飞书应用已更换，请重新绑定',BINDING_CONFIRMATION:'飞书绑定待本人确认并测试',WEBHOOK_CONFIRMATION:'飞书个人机器人待发送测试确认',NOTIFICATIONS_DISABLED:'成员已关闭通知',NO_ACTIVE_ADMIN:'没有可用的管理员接收提醒'};
  function enqueue(item,member,{type='legacy',reason='',key,detail={},schedule=true}={}) {
    if (member?.status==='disabled') return 0;
    const context=member?deliveryContext(member):{errorCode:'NO_ACTIVE_ADMIN'};
    const nextAt=context.errorCode||!schedule?0:nextNotificationAt(context.user?.notification_mode,context.user?.digest_hour);
    return Number(db.prepare('INSERT OR IGNORE INTO notifications(id,dedupe_key,item_id,recipient,recipient_member_id,binding_version,title,reason,status,created_at,error_code,error,next_at,event_type,event_detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),key,item.id,member?.github_login || '(unrouted)',member?.id || null,context.bindingVersion || null,titleFor(type,item),String(reason||'').slice(0,1000),context.errorCode?'skipped':'pending',nowISO(),context.errorCode,context.errorCode?unreachable[context.errorCode] || '接收人不可达':null,nextAt,type,JSON.stringify(detail||{})).changes);
  }
  function watcherMembers(item) {
    const result=new Map(),add=id=>{const member=memberByGithubId(id);if(member) result.set(member.id,member);};
    add(item.authorId);
    for(const id of item.assigneeIds||[]) add(id);
    if(item.ownerMemberId) {const member=memberById(item.ownerMemberId);if(member) result.set(member.id,member);}
    return result;
  }
  // Build one precise notification per member per delivery. A comment can be
  // both a watcher update and an @mention; the stronger reason wins.
  function eventNotifications(item,payload,event,previousCI) {
    const sender=payload.sender||payload.comment?.user||payload.review?.user||{},actorId=identityId(sender.id);
    const actor=typeof sender.login==='string'&&sender.login?`@${sender.login}`:'GitHub 用户';
    const commentAuthor=payload.comment?.user||payload.review?.user||sender;
    const isCommentEvent=['issue_comment','pull_request_review','pull_request_review_comment'].includes(event);
    if(isCommentEvent&&isBotActor(commentAuthor)) return [];
    const result=new Map();
    // Comment-like events share a message-based key with polling sync so the
    // same GitHub comment cannot be delivered twice through both paths.
    const remoteKey=event==='issue_comment'&&payload.comment?.id?`comment:${payload.comment.id}`
      :event==='pull_request_review'&&payload.review?.id?`review:${payload.review.id}`
        :event==='pull_request_review_comment'&&payload.comment?.id?`review_comment:${payload.comment.id}`:null;
    const put=(member,type,reason,detail={},rank=1,allowSelf=false)=>{
      if(!member||member.status==='disabled'||(!allowSelf&&String(member.github_user_id)===String(actorId))) return;
      const current=result.get(member.id);
      const key=remoteKey?`msg:${item.id}:${remoteKey}:${member.id}`
        :(type==='new_issue'||type==='new_pr')?`item-new:${item.id}:${member.id}`:null;
      if(!current||rank>current.rank) result.set(member.id,{member,type,reason,detail,rank,key});
    };
    const mentions=(body,rank=5)=>{
      for(const login of mentionLogins(body)) {
        const member=memberByLogin(login);
        if(member) put(member,'mention',`${actor} 在评论中 @你：${excerpt(body)}`,{url:payload.comment?.html_url||payload.review?.html_url||item.url,actor:sender.login||''},rank);
      }
    };
    const action=payload.action;
    if((event==='issues'||event==='pull_request')&&action==='opened') {
      // Administrators watch every new issue/PR; authors and current assignees
      // also get one confirmation so a newly opened item is never silent.
      const type=event==='pull_request'?'new_pr':'new_issue',targets=new Map();
      for(const admin of db.prepare("SELECT * FROM members WHERE role='admin' AND status='active'").all()) targets.set(admin.id,admin);
      for(const member of watcherMembers(item).values()) targets.set(member.id,member);
      for(const member of targets.values()) {
        const admin=member.role==='admin';
        put(member,type,`${actor} 创建了 ${KIND(item)} #${item.number}`,{url:item.url,actor:sender.login||''},1,admin);
      }
    } else if((event==='issues'||event==='pull_request')&&action==='assigned'&&payload.assignee) {
      const member=memberByGithubId(payload.assignee.id)||memberByLogin(payload.assignee.login);
      put(member,'assigned',`${actor} 将 ${KIND(item)} #${item.number} 指派给你`,{url:item.url,assignee:payload.assignee.login||''},4);
    } else if((event==='issues'||event==='pull_request')&&action==='review_requested'&&payload.requested_reviewer) {
      const member=memberByGithubId(payload.requested_reviewer.id)||memberByLogin(payload.requested_reviewer.login);
      put(member,'review_requested',`${actor} 请求你评审 ${KIND(item)} #${item.number}`,{url:item.url,reviewer:payload.requested_reviewer.login||''},4);
    } else if((event==='issues'||event==='pull_request')&&['closed','reopened','ready_for_review','converted_to_draft'].includes(action)) {
      const kind=KIND(item);
      const reason=action==='closed'
        ?(event==='pull_request'&&payload.pull_request?.merged?`${actor} 合并了 ${kind} #${item.number}`:`${actor} 关闭了 ${kind} #${item.number}`)
        :action==='reopened'?`${actor} 重新打开了 ${kind} #${item.number}`
          :action==='ready_for_review'?`${actor} 将 ${kind} #${item.number} 标记为可评审`
            :`${actor} 将 ${kind} #${item.number} 转为草稿`;
      for(const member of watcherMembers(item).values()) put(member,'status',reason,{url:item.url,status:action},2);
    } else if(event==='issue_comment'&&action==='created'&&payload.comment) {
      const body=payload.comment.body||'';
      for(const member of watcherMembers(item).values()) put(member,'comment',`${actor} 评论：${excerpt(body)}`,{url:payload.comment.html_url||item.url,commentId:payload.comment.id},2);
      mentions(body);
    } else if(event==='pull_request_review'&&action==='submitted'&&payload.review) {
      const review=payload.review,body=review.body||'',state=review.state?`（${REVIEW_STATES[review.state]||review.state}）`:'';
      for(const member of watcherMembers(item).values()) put(member,'review',`${actor} 提交了评审${state}${body?`：${excerpt(body)}`:''}`,{url:review.html_url||item.url,reviewId:review.id,state:review.state||null},2);
      mentions(body);
    } else if(event==='pull_request_review_comment'&&action==='created'&&payload.comment) {
      const comment=payload.comment,body=comment.body||'';
      const location=comment.path?`${comment.path}${Number.isInteger(comment.line)?`:${comment.line}`:''} `:'';
      for(const member of watcherMembers(item).values()) put(member,'review_comment',`${actor} 在 ${location}评论：${excerpt(body)}`,{url:comment.html_url||item.url,commentId:comment.id,path:comment.path||null,line:comment.line??null},2);
      mentions(body);
      if(comment.in_reply_to_id) {
        const parent=db.prepare('SELECT author_member_id FROM item_messages WHERE github_comment_id=?').get(`review_comment:${comment.in_reply_to_id}`);
        const member=parent?.author_member_id&&memberById(parent.author_member_id);
        put(member,'reply',`${actor} 回复了你的评论${location?`（${location.trim()}）`:''}：${excerpt(body)}`,{url:comment.html_url||item.url,commentId:comment.id},4);
      }
    } else if(event==='check_run'&&action==='completed'&&payload.check_run) {
      const run=payload.check_run,conclusion=run.conclusion,name=run.name||'check';
      const failed=['failure','timed_out','cancelled','action_required'].includes(conclusion);
      const recovered=conclusion==='success'&&['failure','timed_out','cancelled','action_required'].includes(previousCI);
      if(failed||recovered) {
        const label=CI_STATES[conclusion]||conclusion;
        for(const member of watcherMembers(item).values()) put(member,'ci',`${name} · ${label}${recovered?'（已恢复）':''}`,{url:run.html_url||run.details_url||item.url,name,conclusion},2);
      }
    }
    return [...result.values()];
  }
  // Polling fallback: when the repository has no signed webhook, conversation
  // sync still discovers new comments. Only messages inserted after the first
  // sync are queued, so opening an old item never floods history.
  function conversationNotifications(item,messages) {
    if(!getSetting(db,'rules').enabled) return;
    const watchers=watcherMembers(item);
    for(const message of messages) {
      const author={login:message.authorLogin||'',id:message.authorGithubId};
      if(isBotActor(author)) continue;
      const actorId=identityId(message.authorGithubId);
      const actor=message.authorLogin?`@${message.authorLogin}`:'GitHub 用户';
      const baseKey=`msg:${item.id}:${message.remoteKey||`message:${message.id}`}`;
      const byMember=new Map();
      const put=(member,type,reason,rank)=>{
        if(!member||member.status==='disabled'||(actorId&&String(member.github_user_id)===String(actorId))) return;
        const current=byMember.get(member.id);
        if(!current||rank>current.rank) byMember.set(member.id,{member,type,reason,rank});
      };
      const kind=message.kind==='review'?'review':message.kind==='review_comment'?'review_comment':'comment';
      const body=message.body||'';
      const location=message.path?`${message.path}${Number.isInteger(message.line)?`:${message.line}`:''}`:'';
      let reason;
      if(kind==='review') reason=`${actor} 提交了评审${message.state?`（${REVIEW_STATES[message.state]||message.state}）`:''}${body?`：${excerpt(body)}`:''}`;
      else if(kind==='review_comment') reason=`${actor} 在 ${location?`${location} `:''}评论：${excerpt(body)||'（无正文）'}`;
      else reason=`${actor} 评论：${excerpt(body)||'（无正文）'}`;
      for(const member of watchers.values()) put(member,kind,reason,2);
      for(const mention of db.prepare('SELECT member_id AS memberId FROM item_message_mentions WHERE message_id=?').all(message.id)) {
        put(memberById(mention.memberId),'mention',`${actor} 在评论中 @你：${excerpt(body)||'（无正文）'}`,5);
      }
      if(message.inReplyTo) {
        const parent=db.prepare('SELECT author_member_id FROM item_messages WHERE github_comment_id=?').get(`review_comment:${message.inReplyTo}`);
        put(parent?.author_member_id&&memberById(parent.author_member_id),'reply',`${actor} 回复了你的评论${location?`（${location}）`:''}：${excerpt(body)||'（无正文）'}`,4);
      }
      for(const notice of byMember.values()) enqueue(item,notice.member,{type:notice.type,reason:notice.reason,key:`${baseKey}:${notice.member.id}`,detail:{url:message.url||item.url}});
    }
  }
  function outgoingMessage(claimed) {
    if(claimed.length===1) {
      const {notice,item}=claimed[0];
      let detail={};try {detail=JSON.parse(notice.event_detail||'{}');} catch { /* ignore */ }
      const extra=[];
      if(notice.event_type==='stale') {extra.push(`负责人：${item.owner||'待分派'}`);if(item.dueAt) extra.push(`截止时间：${item.dueAt}`);}
      const link=detail.url||item.url;
      const text=[notice.reason,...extra,`平台处理：${config.baseUrl}/workspace?item=${encodeURIComponent(item.id)}`,`GitHub：${link}`].filter(Boolean).join('\n');
      return {title:notice.title,text,url:link};
    }
    let text='',included=0;
    for(const {notice} of claimed) {
      const line=`${included+1}. ${notice.title}\n   ${notice.reason}`;
      if(text.length+line.length>5200) break;
      text+=`${text?'\n':''}${line}`;included++;
    }
    if(included<claimed.length) text+=`\n…另有 ${claimed.length-included} 条，请在平台查看。`;
    return {title:`AISBench 提醒 · ${claimed.length} 条更新`,text:`${text}\n\n平台处理：${config.baseUrl}/workspace`,url:`${config.baseUrl}/workspace`};
  }
  async function syncInner() {
    if (config.demo) {publicPortal.demoProjection();return {count:items().length,lastSync:getSetting(db,'lastSync')};}
    const next=Date.parse(getSetting(db,'nextSyncAllowedAt','') || '');
    if (Number.isFinite(next)&&next>Date.now()) throw Object.assign(new Error('GitHub 接口正在退避，请稍后重试'),{status:429});
    const hadBaseline=!!getSetting(db,'lastSync'),newItems=[];
    try {
      const publication=await publicPortal.beginProjection();
      const snapshot=await fetchItems({repo:config.repo,token:config.githubToken});
      // Injected item fetchers mean a test/offline sync; never add network calls then.
      const labelSnapshot=integrations.fetchLabels
        ? await integrations.fetchLabels({repo:config.repo,token:config.githubToken}).catch(()=>null)
        : integrations.fetchItems ? null : await fetchRepositoryLabels({repo:config.repo,token:config.githubToken}).catch(()=>null);
      const publicSnapshot=await publicPortal.finishProjection(publication,snapshot);
      db.exec('BEGIN IMMEDIATE');
      try {
        if(labelSnapshot) syncRepositoryLabels(db,labelSnapshot);
        for (const item of snapshot) {
          const old=db.prepare('SELECT * FROM items WHERE id=?').get(item.id);
          if (!old) {newItems.push(item);db.prepare('INSERT INTO items(id,number,data,repository_id) VALUES (?,?,?,?)').run(item.id,item.number,JSON.stringify(item),config.repo);}
          else {
            const reopened=JSON.parse(old.data).state==='closed'&&item.state==='open'&&old.workflow==='done';
            db.prepare('UPDATE items SET data=?,repository_id=?,needs_review=CASE WHEN ? THEN 1 ELSE needs_review END,version=version+CASE WHEN data<>? THEN 1 ELSE 0 END WHERE id=?').run(JSON.stringify(item),config.repo,Number(reopened),JSON.stringify(item),item.id);
          }
        }
        publicPortal.commitProjection(publicSnapshot);
        const lastSync=nowISO();setSetting(db,'lastSync',lastSync);setSetting(db,'syncError',null);setSetting(db,'nextSyncAllowedAt',null);
        addActivity(db,'GitHub 同步完成',`同步 ${snapshot.length} 条 PR / Issue，保留平台处理字段。`);db.exec('COMMIT');
        if(hadBaseline&&newItems.length&&getSetting(db,'rules').enabled) {
          try {
            for(const item of newItems) {
              const payload={action:'opened',sender:{id:item.authorId,login:item.author},[item.kind==='pr'?'pull_request':'issue']:{number:item.number}};
              for(const notice of eventNotifications(item,payload,item.kind==='pr'?'pull_request':'issues',null)) {
                enqueue(item,notice.member,{type:notice.type,reason:notice.reason,key:notice.key||`item-new:${item.id}:${notice.member.id}`,detail:notice.detail});
              }
            }
            await runReminders();
          } catch { /* notification delivery must not mark the data sync as failed */ }
        }
        return {count:snapshot.length,lastSync};
      } catch(error) {db.exec('ROLLBACK');throw error;}
    } catch(error) {
      setSetting(db,'syncError','GitHub 同步失败，已保留原数据；请检查网络、权限与 API 配额');
      if (error.retryAt) setSetting(db,'nextSyncAllowedAt',new Date(error.retryAt).toISOString());
      throw error;
    }
  }
  function sync() {if(!syncPromise) syncPromise=syncInner().finally(()=>{syncPromise=null;});return syncPromise;}
  async function runInner() {
    const result={queued:0,delivered:0,failed:0,skipped:0};
    if (config.demo||!getSetting(db,'rules').enabled) return result;
    const rules=getSetting(db,'rules'), snapshot=items(),now=Date.now();
    for (const item of snapshot.filter(i=>i.overdue)) {
      const targets=recipients(item);
      if (!targets.length) {enqueue(item,null,{type:'stale',reason:'超期或长时间未更新',key:`unrouted:${item.id}:${Math.floor(now/86400000)}`});result.skipped++;}
      for (const member of targets) {
        if (member.status==='disabled') continue;
        if (db.prepare("SELECT id FROM notifications WHERE item_id=? AND recipient_member_id=? AND reason='超期或长时间未更新' AND status IN ('pending','sending') LIMIT 1").get(item.id,member.id)) continue;
        const recent=db.prepare("SELECT sent_at FROM notifications WHERE item_id=? AND recipient_member_id=? AND reason='超期或长时间未更新' AND status='sent' ORDER BY sent_at DESC LIMIT 1").get(item.id,member.id);
        if (recent&&now-Date.parse(recent.sent_at)<rules.reminderCooldownHours*3600000) continue;
        const changed=enqueue(item,member,{type:'stale',reason:'超期或长时间未更新',key:`stale:${config.repo}:${item.id}:${member.id}:${Math.floor(now/(rules.reminderCooldownHours*3600000))}`});
        if(deliveryContext(member).errorCode) result.skipped+=changed;else result.queued+=changed;
      }
    }
    const pending=db.prepare("SELECT * FROM notifications WHERE status='pending' AND next_at<=? ORDER BY next_at,created_at LIMIT 200").all(now);
    const groups=new Map(),modeCache=new Map();
    const modeFor=memberId=>{
      if(!modeCache.has(memberId)) {
        const user=db.prepare('SELECT notification_mode FROM users WHERE member_id=?').get(memberId);
        modeCache.set(memberId,user?.notification_mode||'realtime');
      }
      return modeCache.get(memberId);
    };
    for(const notice of pending) {
      if(!getSetting(db,'rules').enabled) break;
      if(!notice.recipient_member_id) {
        db.prepare("UPDATE notifications SET status='cancelled',error_code='MEMBER_MISSING' WHERE id=?").run(notice.id);result.skipped++;continue;
      }
      // Realtime keeps one external message per event and revalidates between
      // sends; digest modes batch all due rows for the same member.
      const key=modeFor(notice.recipient_member_id)==='realtime'?`one:${notice.id}`:`batch:${notice.recipient_member_id}`;
      if(!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(notice);
    }
    const groupsList=[...groups.values()];
    for(const notices of groupsList) {
      if(!getSetting(db,'rules').enabled) break;
      const member=memberById(notices[0].recipient_member_id),context=member?deliveryContext(member):{errorCode:'MEMBER_MISSING'};
      if(!member||context.errorCode) {
        for(const notice of notices) db.prepare("UPDATE notifications SET status='cancelled',error_code=? WHERE id=?").run(context.errorCode||'MEMBER_MISSING',notice.id);
        result.skipped+=notices.length;continue;
      }
      if(isQuietTime(context.user.quiet_start,context.user.quiet_end)) {
        const at=quietEndAt(context.user.quiet_end);
        for(const notice of notices) db.prepare('UPDATE notifications SET next_at=? WHERE id=?').run(at,notice.id);
        result.skipped+=notices.length;continue;
      }
      const sendable=[];
      for(const notice of notices) {
        // Reload relations for each notice: an earlier external send may have
        // changed ownership or closed the item while this batch was yielding.
        const item=items().find(i=>i.id===notice.item_id);
        // Legacy/stale envelopes keep the old "still open and relevant" guard.
        // New event notifications must still deliver after a close/merge.
        const strict=notice.event_type==='legacy'||notice.event_type==='stale';
        const invalid=!item||(strict&&(item.state!=='open'||item.workflow==='done'))
          ||context.bindingVersion!==notice.binding_version
          ||(strict&&!recipients(item).some(m=>m.id===member.id))
          ||(notice.reason==='超期或长时间未更新'&&!item.overdue);
        if(invalid) {
          db.prepare("UPDATE notifications SET status='cancelled',error_code=? WHERE id=?").run(!item?'ITEM_MISSING':context.bindingVersion!==notice.binding_version?'BINDING_CHANGED':'NO_LONGER_RELEVANT',notice.id);
          result.skipped++;continue;
        }
        sendable.push({notice,item});
      }
      if(!sendable.length) continue;
      const claimed=[];
      for(const entry of sendable) {
        if(db.prepare("UPDATE notifications SET status='sending',attempts=attempts+1 WHERE id=? AND status='pending'").run(entry.notice.id).changes) claimed.push(entry);
      }
      if(!claimed.length) continue;
      try {
        const message=outgoingMessage(claimed);
        if(context.channel==='webhook') {
          const webhookUrl=decryptWebhookUrl(context.webhook,config);
          if(!webhookUrl) throw Object.assign(new Error('飞书个人机器人地址不可解密，请重新绑定'),{permanent:true,code:'WEBHOOK_UNREADABLE'});
          await sendWebhook({webhookUrl,...message});
        } else {
          await sendMessage({appId:config.feishuAppId,appSecret:config.feishuAppSecret,openId:context.binding.open_id,...message,uuid:claimed[0].notice.id});
        }
        const sentAt=nowISO();
        for(const {notice} of claimed) {
          const completed=db.prepare("UPDATE notifications SET status='sent',sent_at=?,error=NULL,error_code=NULL WHERE id=? AND status='sending'").run(sentAt,notice.id);
          if(!completed.changes) {
            db.prepare("UPDATE notifications SET sent_at=?,error_code='DELIVERED_AFTER_REVOCATION',error='飞书已接受发送，但发送期间权限或绑定被撤销；详见审计' WHERE id=?").run(sentAt,notice.id);
            addAudit(db,{action:'notification.delivered_after_revocation',targetType:'notification',targetId:notice.id,after:{recipientMemberId:member.id,externallyAccepted:true}});
          }
        }
        result.delivered++;
      } catch(error) {
        const permanent=!!error.permanent;
        for(const {notice} of claimed) {
          const attempt=notice.attempts+1;
          db.prepare("UPDATE notifications SET status=?,next_at=?,error_code=?,error=? WHERE id=? AND status='sending'").run(permanent||attempt>=3?'failed':'pending',Number(error.retryAt)||Date.now()+60000*2**(attempt-1),typeof error.code==='string'?error.code:'DELIVERY_FAILED','飞书发送失败，请检查应用权限、绑定或网络；系统按策略重试',notice.id);
        }
        result.failed+=claimed.length;
      }
    }
    return result;
  }
  function runReminders() {if(!reminderPromise) reminderPromise=runInner().finally(()=>{reminderPromise=null;});return reminderPromise;}
  function queueAssignment(item,actorId,requestId) {
    if(config.demo||!getSetting(db,'rules').enabled||!item.ownerMemberId) return;
    const member=memberById(item.ownerMemberId),actor=memberById(actorId);
    if(member&&member.id!==actorId) enqueue(item,member,{type:'assignment',reason:`${actor?`@${actor.github_login}`:'管理员'} 在平台将任务分派给你`,key:`assignment:${config.repo}:${item.id}:${item.version}:${member.id}`,detail:{url:item.url,actor:actor?.github_login||''}});
    addAudit(db,{actorId,action:'notification.assignment',targetType:'item',targetId:item.id,after:{recipientMemberId:member?.id || null},requestId});
  }
  async function onWebhook(payload,delivery,event,{alreadySynced=false}={}) {
    if(payload.repository?.full_name?.toLowerCase()!==config.repo.toLowerCase()) return;
    if(db.prepare('SELECT id FROM webhook_deliveries WHERE id=?').get(delivery)) return;
    const number=payload.issue?.number||payload.pull_request?.number||payload.check_run?.pull_requests?.[0]?.number;
    // Conversation writes are the real-time path; only fall back to a full
    // repository sync when the item is not present locally yet.
    if(number&&!db.prepare('SELECT id FROM items WHERE number=?').get(number)) {
      if(syncPromise) await syncPromise;
      await sync();
    }
    const item=items().find(i=>i.number===(payload.issue?.number||payload.pull_request?.number||payload.check_run?.pull_requests?.[0]?.number));
    let previousCI=null;
    if(item&&event==='check_run'&&payload.check_run?.name) {
      const row=db.prepare("SELECT json_extract(detail,'$.conclusion') AS conclusion FROM item_events WHERE item_id=? AND category='ci' AND lower(json_extract(detail,'$.name'))=lower(?) ORDER BY occurred_at DESC LIMIT 1").get(item.id,payload.check_run.name);
      previousCI=row?.conclusion||null;
    }
    if(item) upsertFromWebhook(db,payload,event,delivery);
    db.exec('BEGIN IMMEDIATE');
    try {
      if(db.prepare('SELECT id FROM webhook_deliveries WHERE id=?').get(delivery)) {db.exec('COMMIT');return;}
      db.prepare('INSERT INTO webhook_deliveries VALUES (?,?)').run(delivery,nowISO());
      if(item&&getSetting(db,'rules').enabled) {
        for(const notice of eventNotifications(item,payload,event,previousCI)) {
          enqueue(item,notice.member,{type:notice.type,reason:notice.reason,key:notice.key||`evt:${config.repo}:${delivery}:${notice.member.id}`,detail:notice.detail});
        }
      }
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
    await runReminders();
  }
  function acceptWebhook(payload,delivery,event) {db.prepare('INSERT OR IGNORE INTO webhook_inbox(id,event,payload,received_at) VALUES (?,?,?,?)').run(delivery,event,JSON.stringify(payload),nowISO());}
  function processWebhooks() {
    if(!webhookPromise) webhookPromise=(async()=>{
      const jobs=db.prepare("SELECT * FROM webhook_inbox WHERE status='pending' AND next_at<=? ORDER BY received_at LIMIT 50").all(Date.now());
      if(!jobs.length) return;
      for(const job of jobs) {
        try {
          await onWebhook(JSON.parse(job.payload),job.id,job.event,{alreadySynced:true});
          db.prepare("UPDATE webhook_inbox SET status='done',processed_at=? WHERE id=?").run(nowISO(),job.id);
        } catch {
          const backoff=Math.max(Date.now()+Math.min(3600000,60000*2**Math.min(job.attempts,6)),Date.parse(getSetting(db,'nextSyncAllowedAt','')||'')||0);
          db.prepare('UPDATE webhook_inbox SET attempts=attempts+1,next_at=? WHERE id=?').run(backoff,job.id);
          addActivity(db,'GitHub 事件处理失败，已保留待重试',job.id);
        }
      }
    })().finally(()=>{webhookPromise=null;});
    return webhookPromise;
  }
  async function syncConversations(options={}) {
    return syncConversationBatch(db,config,{...options,fetchImpl:options.fetchImpl || integrations.fetchImpl || fetch,onNewMessages:options.onNewMessages || conversationNotifications});
  }
  async function drain() {await Promise.allSettled([syncPromise,reminderPromise,webhookPromise,publicPortal.drain()].filter(Boolean));}
  return {sync,runReminders,onWebhook,acceptWebhook,processWebhooks,queueAssignment,syncConversations,notifyConversationMessages:conversationNotifications,publicPortal,drain};
}
