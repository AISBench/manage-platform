import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { getMemberView } from './members.js';
import { readRegistrationSession } from './registration.js';
export const randomToken = () => randomBytes(32).toString('hex');
export const hashToken = token => createHash('sha256').update(token).digest('hex');
export function cookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    try { result[part.slice(0,index).trim()] = decodeURIComponent(part.slice(index+1)); } catch { /* invalid cookie */ }
  }
  return result;
}
export function setCookie(res,name,value,config,maxAge=7*86400000) {
  res.cookie(name,value,{httpOnly:true,secure:config.secure,sameSite:'lax',path:'/',maxAge});
}
export function sessionUser(db,memberId,config) {
  const member=getMemberView(db,memberId,{appId:config.feishuAppId || '',includeNotes:false});
  const user=db.prepare('SELECT * FROM users WHERE member_id=?').get(memberId);
  if (!member || !user || member.status!=='active') return null;
  return {id:user.id,memberId:member.id,githubId:member.githubId,login:member.login,name:member.displayName || member.name || member.login,avatarUrl:member.avatarUrl || '',isAdmin:member.role==='admin',role:member.role,status:member.status,module:member.module,feishuBound:member.feishuBound,feishuVerified:member.feishuVerified,notificationsEnabled:!!user.notifications_enabled,quietStart:user.quiet_start || '',quietEnd:user.quiet_end || ''};
}
export function createSession(db,res,userId,config) {
  const user=db.prepare('SELECT member_id FROM users WHERE id=?').get(userId);
  const member=user?.member_id && db.prepare('SELECT status FROM members WHERE id=?').get(user.member_id);
  if (!member || member.status!=='active') throw Object.assign(new Error('成员未激活或已停用'),{status:403});
  const token = randomToken(), csrf = randomToken();
  db.prepare('INSERT INTO sessions(token_hash,user_id,member_id,csrf,expires_at) VALUES (?,?,?,?,?)').run(hashToken(token),userId,user.member_id,csrf,Date.now()+7*86400000);
  setCookie(res,'triage_session',token,config);
  return {csrf,user_id:userId,member_id:user.member_id};
}
export function authMiddleware(db,config) {
  return (req,res,next) => {
    const token = cookies(req).triage_session;
    let session = token ? db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(hashToken(token),Date.now()) : null;
    // Anonymous visitors, including demo visitors, never receive a member
    // session automatically. Demo login is an explicit, isolated action.
    const registration=readRegistrationSession(db,cookies(req).triage_registration);
    if(registration) {req.registrationSession=registration.session;req.registrationIdentity=registration.identity;}
    if (session?.member_id) {
      const member=db.prepare('SELECT * FROM members WHERE id=?').get(session.member_id);
      if (member?.status==='active') {
        const user=db.prepare('SELECT * FROM users WHERE id=? AND member_id=?').get(session.user_id,session.member_id);
        if (user) {
          req.session=session;req.member=member;req.userRow=user;req.user=sessionUser(db,member.id,config);
        }
      }
    }
    next();
  };
}
export function requireUser(req,res,next) { if (!req.user) return res.status(401).json({error:'请先使用获准的 GitHub 账号登录，账号可能已被停用'}); next(); }
export function requireAdmin(req,res,next) { if (!req.user?.isAdmin) return res.status(403).json({error:'此操作需要管理员权限'}); next(); }
export function csrfGuard(config) {
  return (req,res,next) => {
    if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
    if (req.headers.origin!==config.baseUrl) return res.status(403).json({error:'请求来源校验失败'});
    const csrf=req.headers['x-csrf-token'],session=req.session || req.registrationSession;
    if (!session || typeof csrf!=='string' || !/^[a-f0-9]{64}$/.test(csrf) || csrf.length!==session.csrf.length || !timingSafeEqual(Buffer.from(csrf),Buffer.from(session.csrf))) return res.status(403).json({error:'会话校验失败，请刷新页面'});
    next();
  };
}
export function newOAuthState(db,res,provider,memberId,config,sessionHash=null) {
  const state=randomToken(), browser=randomToken();
  // user_id is a legacy column; member_id is the authoritative fixed association.
  db.prepare('INSERT INTO oauth_states(state_hash,provider,user_id,member_id,browser_hash,expires_at) VALUES (?,?,?,?,?,?)').run(hashToken(state),provider,sessionHash,memberId || null,hashToken(browser),Date.now()+600000);
  setCookie(res,`triage_oauth_${provider}`,browser,config,600000);
  return state;
}
export function consumeOAuthState(db,req,res,provider,config) {
  const state=req.query.state, browser=cookies(req)[`triage_oauth_${provider}`];
  if (typeof state!=='string' || !browser) throw Object.assign(new Error('授权状态无效，请重新发起绑定或登录'),{status:400});
  const row=db.prepare('SELECT * FROM oauth_states WHERE state_hash=?').get(hashToken(state));
  db.prepare('DELETE FROM oauth_states WHERE state_hash=?').run(hashToken(state));
  res.clearCookie(`triage_oauth_${provider}`,{path:'/',secure:config.secure,sameSite:'lax'});
  if (!row || row.provider!==provider || row.expires_at<Date.now() || row.browser_hash!==hashToken(browser)) throw Object.assign(new Error('授权状态已过期或不匹配'),{status:400});
  return row;
}
