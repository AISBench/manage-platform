import test from 'node:test';
import assert from 'node:assert/strict';
import { identityId,normalizeIssue,fetchRepositoryItems } from '../server/integrations/github.js';
import { requestJson } from '../server/integrations/http.js';
import { createApp } from '../server/app.js';
import { openDatabase,getSetting } from '../server/db.js';
import { configForTests } from './helpers.js';

test('GitHub identity normalization never derives IDs from mutable names',()=>{
  const item=normalizeIssue({number:1,state:'open',user:{id:501,login:'alice'},assignees:[{id:'502',login:'bob'},{login:'alice'}],requested_reviewers:[{id:503,login:'carol'}]});
  assert.equal(item.authorId,'501');assert.deepEqual(item.assigneeIds,['502']);assert.deepEqual(item.reviewerIds,['503']);
  assert.equal(identityId(Number.MAX_SAFE_INTEGER+1),null);assert.equal(identityId('0001'),null);assert.equal(identityId('alice'),null);assert.equal(identityId('12345678901234567890'),'12345678901234567890');
});

test('HTTP rate-limit metadata is sanitized and honors retry headers',async()=>{
  const before=Date.now();
  await assert.rejects(requestJson('https://api.github.com/example',{label:'GitHub',fetchImpl:async()=>new Response('secret body',{status:429,headers:{'Retry-After':'120'}})}),error=>error.status===429&&error.retryAt>=before+120000&&!error.message.includes('secret'));
  await assert.rejects(requestJson('https://api.github.com/example',{label:'GitHub',fetchImpl:async()=>new Response('secret',{status:403,headers:{'X-RateLimit-Remaining':'0','X-RateLimit-Reset':String(Math.ceil(Date.now()/1000)+300)}})}),error=>error.status===403&&error.retryAt>Date.now()&&!error.permanent);
});

test('CI permission denial remains unknown but rate-limit denial aborts entire snapshot',async()=>{
  const sha='a'.repeat(40);
  const mock=async url=>{
    if(url.includes('/issues?')) return new Response(JSON.stringify([{number:1,state:'open',pull_request:{},user:{id:501,login:'alice'}}]));
    if(url.endsWith('/pulls/1')) return new Response(JSON.stringify({number:1,requested_reviewers:[],head:{sha}}));
    return new Response('not a credential-safe body',{status:403,headers:{'X-RateLimit-Remaining':'0','Retry-After':'60'}});
  };
  await assert.rejects(fetchRepositoryItems({repo:'AISBench/benchmark',fetchImpl:mock}),error=>error.status===403&&error.retryAt>Date.now());
});

test('a single-repository database refuses config changes that could mix GitHub item numbers',()=>{
  const db=openDatabase(':memory:');
  try {
    createApp(configForTests(),{db});
    assert.throws(()=>createApp(configForTests({repo:'other/project'}),{db}),/another GitHub repository/);
    assert.equal(getSetting(db,'repositoryIdentity'),'AISBench/benchmark');
  } finally {db.close();}
});
