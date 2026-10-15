import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUsage, validatePublicToken, queryUsage, dueForRefresh, usageStatus, REFRESH_MS} from '../dist/openrouter-model.js';
import {applyOperation,emptyEdits,validateEdits} from '../dist/edits.js';
const at='2026-10-15T02:00:00Z';
const id='or-00000000-0000-4000-8000-000000000001';
const fixture=()=>({id,name:'공용',usage:normalizeUsage({usage:12,usage_daily:0,usage_monthly:12,limit:null,limit_remaining:null}),checked_at:at,attempted_at:at,error:null});
test('only numeric usage and documented reset values enter public data; credential/identity fields rejected',()=>{
  const raw={usage:12,usage_daily:0,usage_monthly:12,limit:null,limit_remaining:null,key:'secret',label:'secret',creator_user_id:'private',limit_reset:'never'};
  assert.equal(JSON.stringify(normalizeUsage(raw)).includes('secret'),false);
  assert.equal(normalizeUsage(raw).usage_daily,0);
  assert.equal(normalizeUsage(raw).limit,null);
  assert.throws(()=>normalizeUsage({usage:'12'}));
  assert.throws(()=>validatePublicToken({...fixture(),key:'secret'}));
  assert.throws(()=>validatePublicToken({...fixture(),usage:{...fixture().usage,key:'secret'}}));
  assert.throws(()=>validateEdits({...emptyEdits(),openrouter_tokens:[fixture(),fixture()]}));
});
test('refresh keeps failed last value/time, ignores older responses and cannot recreate a deleted token',()=>{
  let data=applyOperation(emptyEdits(),{type:'token_add',entry:fixture(),at});
  const failed={type:'token_refresh',entries:[{id,attempted_at:'2026-10-15T03:00:00Z',error:'unauthorized',key:'never copied'}],at};
  data=applyOperation(data,failed);
  assert.equal(data.openrouter_tokens[0].usage.usage,12);
  assert.equal(data.openrouter_tokens[0].checked_at,at);
  assert.equal(usageStatus(data.openrouter_tokens[0]),'마지막 조회값');
  assert.equal(JSON.stringify(data).includes('never copied'),false);
  data=applyOperation(data,{type:'token_refresh',entries:[{...fixture(),usage:normalizeUsage({usage:1})}],at});
  assert.equal(data.openrouter_tokens[0].error,'unauthorized');
  data=applyOperation(data,{type:'token_remove',id,at});
  data=applyOperation(data,failed);
  assert.deepEqual(data.openrouter_tokens,[]);
});
test('hourly refresh is measured from attempt; display freshness from successful read',()=>{
  assert.equal(dueForRefresh(fixture(),Date.parse(at)+REFRESH_MS-1),false);
  assert.equal(dueForRefresh(fixture(),Date.parse(at)+REFRESH_MS),true);
  assert.equal(usageStatus(fixture(),Date.parse(at)+2*REFRESH_MS),'마지막 조회값');
});
test('key goes only to OpenRouter GET authorization; redirects and provider error text never propagate',async()=>{
  const key='test-not-a-real-key';
  const output=await queryUsage(key,async(url,options)=>{
    assert.equal(url,'https://openrouter.ai/api/v1/key');assert.equal(options.method,'GET');
    assert.equal(options.headers.Authorization,`Bearer ${key}`);assert.equal(options.redirect,'error');
    assert.equal(options.credentials,'omit');assert.equal(options.body,undefined);
    return {ok:true,json:async()=>({data:{usage:0,label:key,creator_user_id:'private'}})};
  });
  assert.equal(JSON.stringify(output).includes(key),false);
  await assert.rejects(()=>queryUsage(key,async()=>({ok:false,status:401,json:async()=>{throw new Error(key);}})),e=>e.code==='unauthorized'&&!e.message.includes(key));
});
