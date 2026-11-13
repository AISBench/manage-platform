import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { getSetting } from './db.js';

const config=loadConfig();
const {app,db,services}=createApp(config);
const server=app.listen(config.port,config.host,()=>{
  console.log(`AISBench Triage: ${config.baseUrl} (${config.demo?'DEMO — isolated data':'LIVE'})`);
  if(!config.demo&&!getSetting(db,'membershipInitialized',false)) console.warn('Membership is not initialized. Run the local bootstrap or migrate-members CLI; unlisted users cannot log in.');
});
let stopping=false,tickPromise=null,workerPromise=null;
function cleanup() {
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
  db.prepare('DELETE FROM oauth_states WHERE expires_at<?').run(Date.now());
  const events=new Date(Date.now()-config.eventRetentionDays*86400000).toISOString();
  const records=new Date(Date.now()-config.recordRetentionDays*86400000).toISOString();
  db.prepare("DELETE FROM webhook_inbox WHERE status='done' AND COALESCE(processed_at,received_at)<?").run(events);
  db.prepare('DELETE FROM webhook_deliveries WHERE received_at<?').run(events);
  db.prepare("DELETE FROM notifications WHERE status IN ('sent','failed','cancelled','skipped') AND created_at<?").run(records);
  db.prepare('DELETE FROM audit_logs WHERE created_at<?').run(records);
}
function scheduleTick() {
  if(stopping||config.demo||tickPromise) return;
  tickPromise=(async()=>{
    try {await services.sync();} catch {console.error('Background GitHub sync failed or is in backoff; saved data remains available.');}
    try {await services.runReminders();cleanup();} catch {console.error('Reminder/cleanup failed; inspect administrator status.');}
  })().finally(()=>{tickPromise=null;});
}
function worker() {
  if(stopping||config.demo||workerPromise) return workerPromise;
  workerPromise=(async()=>{
    try {
      await services.publicPortal.checkVisibility();if(stopping) return;
      await services.processWebhooks();if(stopping) return;
      await services.runReminders();
    } catch {console.error('Background worker failed; inspect administrator status.');}
  })().finally(()=>{workerPromise=null;});
  return workerPromise;
}
const timer=setInterval(scheduleTick,config.syncIntervalMs);timer.unref();
const workerTimer=setInterval(worker,15000);workerTimer.unref();
if(!config.demo) {scheduleTick();void worker();}
async function stop() {
  if(stopping) return;stopping=true;clearInterval(timer);clearInterval(workerTimer);
  server.close(async()=>{if(tickPromise) await tickPromise;if(workerPromise) await workerPromise;await services.drain();db.close();process.exit(0);});
  setTimeout(()=>process.exit(1),30000).unref();
}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
