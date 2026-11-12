import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/browser',
  fullyParallel:false,
  workers:1,
  use:{baseURL:'http://127.0.0.1:3211',channel:'chrome',headless:true,timezoneId:'Asia/Shanghai',trace:'retain-on-failure'},
  webServer:{command:'node server/index.js',url:'http://127.0.0.1:3211/api/health',reuseExistingServer:false,env:{DEMO_MODE:'true',PORT:'3211',BASE_URL:'http://127.0.0.1:3211',HOST:'127.0.0.1',DATA_DIR:`data/e2e/run-${Date.now()}-${process.pid}`}},
});
