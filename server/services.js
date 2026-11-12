import { randomUUID } from 'node:crypto';
import { listItems, getSetting, setSetting, addActivity, addAudit } from './db.js';
import { fetchRepositoryItems, identityId } from './integrations/github.js';
import { sendFeishuMessage } from './integrations/feishu.js';
import { createPublicService } from './public-service.js';

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
export function isParticipant(item,identity) {
  if (!identity || typeof identity!=='object') return false; // Never authorize a mutable login string.
  const memberId=identity.memberId || identity.id, githubId=identity.githubId || identity.github_user_id;
  return (!!item.ownerMemberId&&item.ownerMemberId===memberId) || (!!githubId&&[item.authorId,...(item.assigneeIds||[]),...(item.reviewerIds||[])].includes(String(githubId)));
}
const nowISO=()=>new Date().toISOString();
export function createServices(db,config,integrations={}) {
  const fetchItems=integrations.fetchItems || fetchRepositoryItems, sendMessage=integrations.sendMessage || sendFeishuMessage;
  const publicPortal=createPublicService(db,config,integrations);
  let syncPromise=null,reminderPromise=null,webhookPromise=null;
  const items=()=>listItems(db,Date.now(),config.feishuAppId || '');
  const members=()=>db.prepare('SELECT * FROM members').all();
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
    const binding=db.prepare('SELECT * FROM feishu_bindings WHERE member_id=?').get(member.id);
    let errorCode=null;
    if (member.status==='disabled') errorCode='MEMBER_DISABLED';
    else if (member.status!=='active') errorCode='MEMBER_PENDING';
    else if (!binding) errorCode='UNBOUND';
    else if (binding.app_id!==config.feishuAppId) errorCode='APP_MISMATCH';
    else if (binding.status!=='active'||!binding.verified_at) errorCode='BINDING_CONFIRMATION';
    else if (!user?.notifications_enabled) errorCode='NOTIFICATIONS_DISABLED';
    return {user,binding,errorCode};
  }
  function enqueue(item,member,reason,key) {
    if (member?.status==='disabled') return 0;
    const context=member?deliveryContext(member):{errorCode:'NO_ACTIVE_ADMIN'};
    const unreachable={MEMBER_PENDING:'成员尚未首次登录',UNBOUND:'成员尚未绑定飞书',APP_MISMATCH:'飞书应用已更换，请重新绑定',BINDING_CONFIRMATION:'飞书绑定待本人确认并测试',NOTIFICATIONS_DISABLED:'成员已关闭通知',NO_ACTIVE_ADMIN:'没有可用的管理员接收提醒'};
    return Number(db.prepare('INSERT OR IGNORE INTO notifications(id,dedupe_key,item_id,recipient,recipient_member_id,binding_version,title,reason,status,created_at,error_code,error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),key,item.id,member?.github_login || '(unrouted)',member?.id || null,context.binding?.binding_version || null,`${item.kind==='pr'?'PR':'Issue'} #${item.number} · ${item.title}`.slice(0,300),reason,context.errorCode?'skipped':'pending',nowISO(),context.errorCode,context.errorCode?unreachable[context.errorCode] || '接收人不可达':null).changes);
  }
  async function syncInner() {
    if (config.demo) {publicPortal.demoProjection();return {count:items().length,lastSync:getSetting(db,'lastSync')};}
    const next=Date.parse(getSetting(db,'nextSyncAllowedAt','') || '');
    if (Number.isFinite(next)&&next>Date.now()) throw Object.assign(new Error('GitHub 接口正在退避，请稍后重试'),{status:429});
    try {
      const publication=await publicPortal.beginProjection();
      const snapshot=await fetchItems({repo:config.repo,token:config.githubToken});
      const publicSnapshot=await publicPortal.finishProjection(publication,snapshot);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const item of snapshot) {
          const old=db.prepare('SELECT * FROM items WHERE id=?').get(item.id);
          if (!old) db.prepare('INSERT INTO items(id,number,data,repository_id) VALUES (?,?,?,?)').run(item.id,item.number,JSON.stringify(item),config.repo);
          else {
            const reopened=JSON.parse(old.data).state==='closed'&&item.state==='open'&&old.workflow==='done';
            db.prepare('UPDATE items SET data=?,repository_id=?,needs_review=CASE WHEN ? THEN 1 ELSE needs_review END,version=version+CASE WHEN data<>? THEN 1 ELSE 0 END WHERE id=?').run(JSON.stringify(item),config.repo,Number(reopened),JSON.stringify(item),item.id);
          }
        }
        publicPortal.commitProjection(publicSnapshot);
        const lastSync=nowISO();setSetting(db,'lastSync',lastSync);setSetting(db,'syncError',null);setSetting(db,'nextSyncAllowedAt',null);
        addActivity(db,'GitHub 同步完成',`同步 ${snapshot.length} 条 PR / Issue，保留平台处理字段。`);db.exec('COMMIT');
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
      if (!targets.length) {enqueue(item,null,'超期或长时间未更新',`unrouted:${item.id}:${Math.floor(now/86400000)}`);result.skipped++;}
      for (const member of targets) {
        if (member.status==='disabled') continue;
        if (db.prepare("SELECT id FROM notifications WHERE item_id=? AND recipient_member_id=? AND reason='超期或长时间未更新' AND status IN ('pending','sending') LIMIT 1").get(item.id,member.id)) continue;
        const recent=db.prepare("SELECT sent_at FROM notifications WHERE item_id=? AND recipient_member_id=? AND reason='超期或长时间未更新' AND status='sent' ORDER BY sent_at DESC LIMIT 1").get(item.id,member.id);
        if (recent&&now-Date.parse(recent.sent_at)<rules.reminderCooldownHours*3600000) continue;
        const changed=enqueue(item,member,'超期或长时间未更新',`stale:${config.repo}:${item.id}:${member.id}:${Math.floor(now/(rules.reminderCooldownHours*3600000))}`);
        if(deliveryContext(member).errorCode) result.skipped+=changed;else result.queued+=changed;
      }
    }
    // Fairness: quiet tasks are moved to their end time, never occupy the due batch forever.
    const pending=db.prepare("SELECT * FROM notifications WHERE status='pending' AND next_at<=? ORDER BY next_at,created_at LIMIT 200").all(now);
    for (const notice of pending) {
      if(!getSetting(db,'rules').enabled) break;
      // Previous external sends yield to admin requests: never reuse an old
      // item/owner/rules snapshot for the next recipient.
      const item=items().find(i=>i.id===notice.item_id),member=notice.recipient_member_id&&db.prepare('SELECT * FROM members WHERE id=?').get(notice.recipient_member_id);
      const context=member?deliveryContext(member):{errorCode:'MEMBER_MISSING'};
      if(!item||item.state!=='open'||item.workflow==='done'||!member||context.errorCode||!recipients(item).some(m=>m.id===member.id)||context.binding?.binding_version!==notice.binding_version||(notice.reason==='超期或长时间未更新'&&!item.overdue)) {
        db.prepare("UPDATE notifications SET status='cancelled',error_code=? WHERE id=?").run(context.errorCode || 'NO_LONGER_RELEVANT',notice.id);result.skipped++;continue;
      }
      if(isQuietTime(context.user.quiet_start,context.user.quiet_end)) {db.prepare('UPDATE notifications SET next_at=? WHERE id=?').run(quietEndAt(context.user.quiet_end),notice.id);result.skipped++;continue;}
      if(!db.prepare("UPDATE notifications SET status='sending',attempts=attempts+1 WHERE id=? AND status='pending'").run(notice.id).changes) continue;
      try {
        const platformUrl=`${config.baseUrl}/workspace?item=${encodeURIComponent(item.id)}`;
        await sendMessage({appId:config.feishuAppId,appSecret:config.feishuAppSecret,openId:context.binding.open_id,title:notice.title,text:`${notice.reason}\n仓库：${config.repo}\n负责人：${item.owner || '待分派'}${item.dueAt?'\n截止时间：'+item.dueAt:''}\n平台处理：${platformUrl}\nGitHub：${item.url}\n平台工作流不会修改 GitHub 状态。`,url:item.url,uuid:notice.id});
        const completed=db.prepare("UPDATE notifications SET status='sent',sent_at=?,error=NULL,error_code=NULL WHERE id=? AND status='sending'").run(nowISO(),notice.id);
        if(!completed.changes) {
          db.prepare("UPDATE notifications SET sent_at=?,error_code='DELIVERED_AFTER_REVOCATION',error='飞书已接受发送，但发送期间权限或绑定被撤销；详见审计' WHERE id=?").run(nowISO(),notice.id);
          addAudit(db,{action:'notification.delivered_after_revocation',targetType:'notification',targetId:notice.id,after:{recipientMemberId:member.id,externallyAccepted:true}});
        }
        result.delivered++;
      } catch(error) {
        const permanent=!!error.permanent,attempt=notice.attempts+1;
        db.prepare("UPDATE notifications SET status=?,next_at=?,error_code=?,error=? WHERE id=? AND status='sending'").run(permanent||attempt>=3?'failed':'pending',Number(error.retryAt)||Date.now()+60000*2**(attempt-1),typeof error.code==='string'?error.code:'DELIVERY_FAILED','飞书发送失败，请检查应用权限、绑定或网络；系统按策略重试',notice.id);result.failed++;
      }
    }
    return result;
  }
  function runReminders() {if(!reminderPromise) reminderPromise=runInner().finally(()=>{reminderPromise=null;});return reminderPromise;}
  function queueAssignment(item,actorId,requestId) {
    if(config.demo||!getSetting(db,'rules').enabled||!item.ownerMemberId) return;
    const member=db.prepare('SELECT * FROM members WHERE id=?').get(item.ownerMemberId);
    if(member&&member.id!==actorId) enqueue(item,member,'平台负责人分派 / 改派',`assignment:${config.repo}:${item.id}:${item.version}:${member.id}`);
    addAudit(db,{actorId,action:'notification.assignment',targetType:'item',targetId:item.id,after:{recipientMemberId:member?.id || null},requestId});
  }
  async function onWebhook(payload,delivery,event,{alreadySynced=false}={}) {
    if(payload.repository?.full_name?.toLowerCase()!==config.repo.toLowerCase()) return;
    if(db.prepare('SELECT id FROM webhook_deliveries WHERE id=?').get(delivery)) return;
    if(!alreadySynced) {if(syncPromise) await syncPromise;await sync();}
    const item=items().find(i=>i.number===(payload.issue?.number||payload.pull_request?.number));
    const events=new Set(['issues','issue_comment','pull_request','pull_request_review','pull_request_review_comment']);
    const actions=['opened','assigned','review_requested','submitted','created','reopened','ready_for_review','synchronize'];
    db.exec('BEGIN IMMEDIATE');
    try {
      if(db.prepare('SELECT id FROM webhook_deliveries WHERE id=?').get(delivery)) {db.exec('COMMIT');return;}
      db.prepare('INSERT INTO webhook_deliveries VALUES (?,?)').run(delivery,nowISO());
      if(item?.state==='open'&&events.has(event)&&actions.includes(payload.action)&&getSetting(db,'rules').enabled) {
        const targets=recipients(item);
        if(!targets.length) enqueue(item,null,`GitHub ${event} / ${payload.action}`,`event:${config.repo}:${delivery}:unrouted`);
        for(const member of targets) {
          if(member.github_user_id===identityId(payload.sender?.id)||member.status==='disabled') continue;
          enqueue(item,member,`GitHub ${event} / ${payload.action}`,`event:${config.repo}:${delivery}:${member.id}`);
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
      let syncError=null;
      try {if(syncPromise) await syncPromise;await sync();} catch(error) {syncError=error;}
      for(const job of jobs) {
        try {
          if(syncError) throw syncError;
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
  async function drain() {await Promise.allSettled([syncPromise,reminderPromise,webhookPromise,publicPortal.drain()].filter(Boolean));}
  return {sync,runReminders,onWebhook,acceptWebhook,processWebhooks,queueAssignment,publicPortal,drain};
}
