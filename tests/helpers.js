import { openDatabase, seedDemo, setSetting } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createSession } from '../server/auth.js';
import { loadConfig } from '../server/config.js';
import { createMember } from '../server/members.js';

export const configForTests=overrides=>({...loadConfig({DEMO_MODE:'true'}),demo:false,githubClientId:'test-id',githubClientSecret:'test-secret',feishuAppId:'cli_test',feishuAppSecret:'test-secret',...overrides});
export function addTestMember(db,{githubId='501',login='alice',role='member',status='active',memberId}={}) {
  const created=createMember(db,{profile:{githubId,login,type:'User'},role});
  if(memberId) throw new Error('Use returned generated member id');
  db.prepare('UPDATE members SET status=?,first_login_at=?,last_login_at=? WHERE id=?').run(status,status==='active'?new Date().toISOString():null,status==='active'?new Date().toISOString():null,created.id);
  if(status==='active') db.prepare('INSERT INTO users(id,member_id,login,name) VALUES (?,?,?,?)').run(githubId,created.id,login,login);
  return db.prepare('SELECT * FROM members WHERE id=?').get(created.id);
}
export function bindTestMember(db,memberId,appId='cli_test',openId=`ou_${memberId}`) {
  db.prepare("INSERT INTO feishu_bindings(member_id,app_id,open_id,status,bound_at,verified_at) VALUES (?,?,?,'active',?,?) ON CONFLICT(member_id) DO UPDATE SET app_id=excluded.app_id,open_id=excluded.open_id,status='active',verified_at=excluded.verified_at").run(memberId,appId,openId,new Date().toISOString(),new Date().toISOString());
}
export function serviceDb() {
  const db=openDatabase(':memory:');seedDemo(db,'AISBench/benchmark');
  setSetting(db,'rules',{enabled:true,staleHours:48,reminderCooldownHours:24});
  return db;
}
export async function httpFixture(t,{config={},integrations={},fetchImpl,seed=true}={}) {
  const db=openDatabase(':memory:');if(seed) seedDemo(db,'AISBench/benchmark');
  const options=configForTests(config);
  const {app,services}=createApp(options,{db,integrations,fetchImpl:fetchImpl || (async()=>{throw new Error('Unexpected external HTTP');})});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await services.drain();await new Promise(resolve=>server.close(resolve));db.close();});
  function client(memberId=null) {
    let cookie='',csrf='';
    if(memberId) {
      const user=db.prepare('SELECT id FROM users WHERE member_id=?').get(memberId);
      const session=createSession(db,{cookie:(name,value)=>{cookie=`${name}=${value}`;}},user.id,options);csrf=session.csrf;
    }
    return {
      async request(route,method='GET',body,headers={}) {
        const response=await fetch(base+route,{method,headers:{Cookie:cookie,...(method!=='GET'?{Origin:options.baseUrl,'X-CSRF-Token':csrf,'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
        const received=response.headers.getSetCookie();
        // Merge cookies so OAuth state and logged-in session coexist as in a real browser.
        if(received.length) {
          const jar=Object.fromEntries(cookie.split('; ').filter(Boolean).map(part=>{const i=part.indexOf('=');return [part.slice(0,i),part.slice(i+1)];}));
          for(const value of received) {const part=value.split(';')[0],i=part.indexOf('=');jar[part.slice(0,i)]=part.slice(i+1);}
          cookie=Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; ');
        }
        let data=null;try {data=await response.json();} catch {}
        if(route==='/api/session'&&data?.csrfToken) csrf=data.csrfToken;
        return {status:response.status,data,response};
      },
      get cookie(){return cookie;},get csrf(){return csrf;},
    };
  }
  return {db,config:options,services,base,client};
}
export function testItem(extra={}) {
  return {id:'github:101',number:101,kind:'issue',state:'open',title:'Regression task',body:'',url:'https://github.com/AISBench/benchmark/issues/101',author:'alice',authorId:'501',assignees:[],assigneeIds:[],reviewers:[],reviewerIds:[],labels:[],createdAt:new Date(Date.now()-100*3600000).toISOString(),updatedAt:new Date(Date.now()-100*3600000).toISOString(),...extra};
}
export function insertItem(db,item=testItem()) {db.prepare('INSERT INTO items(id,number,data) VALUES (?,?,?)').run(item.id,item.number,JSON.stringify(item));return item;}
