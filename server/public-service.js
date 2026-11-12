import { randomUUID } from 'node:crypto';
import { getSetting,setSetting } from './db.js';
import { requestJson } from './integrations/http.js';
import { identityId } from './integrations/github.js';

const TTL=60000;
const fallbackPolicy={registrationEnabled:true,publicOverviewEnabled:false,reapplyCooldownHours:24,maxPendingRequests:1000,version:1};
const stamp=()=>new Date().toISOString();
export function publicItem(raw,repo) {
  if(!raw||!Number.isSafeInteger(raw.number)||raw.number<1||!['pr','issue'].includes(raw.kind)||!['open','closed'].includes(raw.state)) throw new Error('Invalid public item');
  const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
  return {number:raw.number,kind:raw.kind,title:typeof raw.title==='string'?raw.title.slice(0,500):'',state:raw.state,author:typeof raw.author==='string'?raw.author.slice(0,39):'',labels:Array.isArray(raw.labels)?raw.labels.filter(v=>typeof v==='string').slice(0,50).map(v=>v.slice(0,100)):[],createdAt:date(raw.createdAt),updatedAt:date(raw.updatedAt),url:`https://github.com/${repo}/${raw.kind==='pr'?'pull':'issues'}/${raw.number}`,...(raw.kind==='pr'&&raw.state==='closed'&&raw.merged===true?{merged:true}:{})};
}
export function createPublicService(db,config,{fetchMetadata,fetchImpl=fetch}={}) {
  let checking=null;
  const policy=()=>getSetting(db,'accessPolicy',fallbackPolicy);
  const epoch=()=>getSetting(db,'publicPublicationEpoch',0);
  const demoMetadata=()=>({repositoryId:`demo:${config.repo.toLowerCase()}`,repo:config.repo,public:true,checkedAt:stamp(),demo:true});
  async function metadata() {
    if(config.demo) return demoMetadata();
    let data;
    if(fetchMetadata) data=await fetchMetadata({repo:config.repo,token:config.githubToken});
    else ({data}=await requestJson(`https://api.github.com/repos/${config.repo}`,{fetchImpl,label:'GitHub repository visibility',headers:{Accept:'application/vnd.github+json','User-Agent':'aisbench-triage','X-GitHub-Api-Version':'2022-11-28',...(config.githubToken?{Authorization:`Bearer ${config.githubToken}`}:{})}}));
    const repositoryId=identityId(data?.id);
    if(!repositoryId||typeof data.full_name!=='string'||data.full_name.toLowerCase()!==config.repo.toLowerCase()||typeof data.private!=='boolean') throw new Error('Repository visibility is not verified');
    return {repositoryId,repo:config.repo,public:data.private===false&&data.visibility==='public',checkedAt:stamp(),demo:false};
  }
  function revoke(reason='unverified') {
    const ownsTransaction=!db.isTransaction;
    if(ownsTransaction) db.exec('BEGIN IMMEDIATE');
    try {
      setSetting(db,'publicPublicationEpoch',epoch()+1);
      db.exec('DELETE FROM public_items; DELETE FROM public_snapshots;');
      const previous=getSetting(db,'publicVisibility',{});
      setSetting(db,'publicVisibility',{...previous,public:false,reason,checkedAt:stamp()});
      if(ownsTransaction) db.exec('COMMIT');
    } catch(error) {if(ownsTransaction) db.exec('ROLLBACK');throw error;}
  }
  async function checkVisibility({force=false}={}) {
    if(!policy().publicOverviewEnabled&&!force) return null;
    const cached=getSetting(db,'publicVisibility');
    if(!force&&cached&&Date.now()-Date.parse(cached.checkedAt)<TTL) return cached;
    // A post-fetch verification must not reuse a request started before the
    // item snapshot finished. Wait for that flight, then begin a fresh check.
    if(force&&checking) await checking;
    if(!checking) checking=(async()=>{
      try {
        const fresh=await metadata(),old=getSetting(db,'publicVisibility');
        if(!fresh.public) {revoke('private');setSetting(db,'publicVisibility',{...fresh,reason:'private'});return fresh;}
        if(old?.repositoryId&&old.repositoryId!==fresh.repositoryId) revoke('unverified');
        setSetting(db,'publicVisibility',{...fresh,reason:'ready'});return fresh;
      } catch {
        revoke('unverified');return null;
      }
    })().finally(()=>{checking=null;});
    return checking;
  }
  function inspect() {
    if(!policy().publicOverviewEnabled) return {available:false,reason:'disabled',checkedAt:null};
    const visibility=getSetting(db,'publicVisibility');
    if(!visibility) return {available:false,reason:'unverified',checkedAt:null};
    if(!visibility.public) return {available:false,reason:visibility.reason==='private'?'private':'unverified',checkedAt:visibility.checkedAt || null};
    if(!config.demo&&(!Number.isFinite(Date.parse(visibility.checkedAt))||Date.now()-Date.parse(visibility.checkedAt)>=TTL)) return {available:false,reason:'expired',checkedAt:visibility.checkedAt};
    const snapshot=db.prepare('SELECT * FROM public_snapshots WHERE id=1').get();
    if(!snapshot||snapshot.repository_id!==visibility.repositoryId||snapshot.repo.toLowerCase()!==config.repo.toLowerCase()) return {available:false,reason:'no_snapshot',checkedAt:visibility.checkedAt};
    return {available:true,reason:'ready',checkedAt:visibility.checkedAt,snapshot};
  }
  async function beginProjection() {
    if(!policy().publicOverviewEnabled) return null;
    const fresh=await checkVisibility({force:true});
    if(!fresh?.public||!policy().publicOverviewEnabled) return null;
    return {repositoryId:fresh.repositoryId,epoch:epoch()};
  }
  async function finishProjection(ticket,rawItems) {
    if(!ticket||!policy().publicOverviewEnabled||ticket.epoch!==epoch()) return null;
    const fresh=await checkVisibility({force:true});
    if(!fresh?.public||ticket.repositoryId!==fresh.repositoryId||ticket.epoch!==epoch()||!policy().publicOverviewEnabled) return null;
    const projected=[...new Map(rawItems.map(raw=>{const item=publicItem(raw,config.repo);return [item.number,item];})).values()];
    return {repositoryId:fresh.repositoryId,epoch:ticket.epoch,generation:randomUUID(),generatedAt:stamp(),visibilityCheckedAt:fresh.checkedAt,items:projected};
  }
  function commitProjection(prepared) {
    if(!prepared||!policy().publicOverviewEnabled||prepared.epoch!==epoch()) return false;
    const visibility=getSetting(db,'publicVisibility');
    if(!visibility?.public||visibility.repositoryId!==prepared.repositoryId) return false;
    db.exec('DELETE FROM public_items; DELETE FROM public_snapshots;');
    db.prepare('INSERT INTO public_snapshots(id,repository_id,repo,generation,generated_at,visibility_checked_at) VALUES (1,?,?,?,?,?)').run(prepared.repositoryId,config.repo,prepared.generation,prepared.generatedAt,prepared.visibilityCheckedAt);
    const insert=db.prepare('INSERT INTO public_items(number,data,generation) VALUES (?,?,?)');
    for(const item of prepared.items) insert.run(item.number,JSON.stringify(item),prepared.generation);
    return true;
  }
  function overview() {
    const status=inspect();
    const base={available:status.available,reason:status.reason,demo:!!config.demo,repo:config.repo,repoUrl:`https://github.com/${config.repo}`,dataUpdatedAt:status.snapshot?.generated_at || null,visibilityCheckedAt:status.checkedAt,stats:null};
    if(!status.available) return base;
    const items=db.prepare('SELECT data FROM public_items WHERE generation=?').all(status.snapshot.generation).map(row=>JSON.parse(row.data));
    return {...base,stats:{openPRs:items.filter(i=>i.kind==='pr'&&i.state==='open').length,closedPRs:items.filter(i=>i.kind==='pr'&&i.state==='closed').length,openIssues:items.filter(i=>i.kind==='issue'&&i.state==='open').length,closedIssues:items.filter(i=>i.kind==='issue'&&i.state==='closed').length}};
  }
  function list({kind,state='all',q='',page=1,pageSize=20}={}) {
    const status=inspect();
    if(!status.available) return {available:false,reason:status.reason,items:[],total:0,page,pageSize,dataUpdatedAt:null};
    let items=db.prepare('SELECT data FROM public_items WHERE generation=? ORDER BY number DESC').all(status.snapshot.generation).map(row=>JSON.parse(row.data));
    // DTO reconstruction at the response boundary prevents even corrupted JSON
    // or future schema additions from exposing a member-only field.
    items=items.map(raw=>publicItem(raw,config.repo));
    if(kind) items=items.filter(i=>i.kind===kind);if(state!=='all') items=items.filter(i=>i.state===state);
    if(q) {const query=q.toLowerCase();items=items.filter(i=>`${i.title} ${i.number}`.toLowerCase().includes(query));}
    return {available:true,reason:'ready',items:items.slice((page-1)*pageSize,page*pageSize),total:items.length,page,pageSize,dataUpdatedAt:status.snapshot.generated_at};
  }
  function demoProjection() {
    if(!config.demo||!policy().publicOverviewEnabled) return;
    const visible=demoMetadata();setSetting(db,'publicVisibility',{...visible,reason:'ready'});
    const prepared={repositoryId:visible.repositoryId,epoch:epoch(),generation:randomUUID(),generatedAt:stamp(),visibilityCheckedAt:visible.checkedAt,items:db.prepare('SELECT data FROM items ORDER BY number').all().map(row=>publicItem(JSON.parse(row.data),config.repo))};
    db.exec('BEGIN IMMEDIATE');try {commitProjection(prepared);db.exec('COMMIT');} catch(error) {db.exec('ROLLBACK');throw error;}
  }
  if(config.demo&&!getSetting(db,'demoPublicSeedVersion')) {
    const current=policy();
    if(current.version===1&&!current.publicOverviewEnabled) setSetting(db,'accessPolicy',{...current,publicOverviewEnabled:true,version:2});
    demoProjection();setSetting(db,'demoPublicSeedVersion',1);
  }
  return {inspect,overview,list,revoke,checkVisibility,beginProjection,finishProjection,commitProjection,demoProjection,drain:()=>checking || Promise.resolve()};
}
