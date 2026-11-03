import test from 'node:test';
import assert from 'node:assert/strict';
import {CHECKS,monitoringID,makeSchedule,defaultConfig,validateConfig,validateSchedule,inWindow,nextRun,emptyMonitoring} from '../dist/test-server/monitoring-model.js';
import {MonitoringStore} from '../dist/test-server/monitoring-store.js';
import {encodeJSON,decodeJSON} from '../dist/edits.js';

const server={server_id:'server-a',gpus:[{}]};
const schedule=()=>makeSchedule();
const config=()=>({...defaultConfig(server),schedules:[schedule()]});
const saved=id=>({...config(),server_id:id,revision:1,updated_at:'2026-11-03T01:00:00Z'});
test('monitoring rejects empty checks, duplicate daily times and executable check names',()=>{
  const s=schedule();s.checks=[];assert.throws(()=>validateSchedule(s),/점검 항목/);
  s.checks=['reboot'];assert.throws(()=>validateSchedule(s),/점검 항목/);
  const d=makeSchedule('daily');d.times=['09:00','09:00'];assert.throws(()=>validateSchedule(d),/점검 시각/);
  d.times=['09:00','21:00'];assert.equal(validateSchedule(d),d);assert.equal(CHECKS.length,12);
});
test('an overnight Monday schedule includes early Tuesday, but not early Monday or its exclusive end',()=>{
  const s={...schedule(),days:[0],all_day:false,start_time:'23:00',end_time:'02:00'};
  assert.equal(inWindow(s,Date.parse('2026-11-02T23:15:00+09:00')),true);
  assert.equal(inWindow(s,Date.parse('2026-11-03T01:00:00+09:00')),true);
  assert.equal(inWindow(s,Date.parse('2026-11-02T01:00:00+09:00')),false);
  assert.equal(inWindow(s,Date.parse('2026-11-03T02:00:00+09:00')),false);
});
test('next run uses KST and advances past the active window and weekends',()=>{
  const s={...schedule(),days:[0,1,2,3,4],all_day:false,start_time:'09:00',end_time:'18:00'};
  assert.equal(new Date(nextRun(s,Date.parse('2026-11-06T17:55:00+09:00'),'2026-11-06T17:50:00+09:00')).toISOString(),'2026-11-09T00:00:00.000Z');
  const d={...makeSchedule('daily'),times:['09:00','21:00']};
  assert.equal(new Date(nextRun(d,Date.parse('2026-11-03T10:00:00+09:00'))).toISOString(),'2026-11-03T12:00:00.000Z');
  d.enabled=false;assert.equal(nextRun(d),null);
});
test('only a disabled monitor may have zero schedules and thresholds are bounded',()=>{
  assert.throws(()=>validateConfig(defaultConfig(server)),/일정/);
  const c=defaultConfig(server);c.enabled=false;assert.equal(validateConfig(c),c);
  c.timeout_seconds=100;assert.throws(()=>validateConfig(c),/응답 제한/);
});
function fakeStore(initial=emptyMonitoring()){
  let data=structuredClone(initial),puts=0;
  const fetcher=async(url,options={})=>{
    if(String(url).includes('raw.githubusercontent.com'))return new Response(JSON.stringify(data),{status:200});
    if(options.method==='PUT'){const body=JSON.parse(options.body);assert.equal(body.branch,'status');assert.ok(String(url).endsWith('/dashboard/monitoring-test.json'));data=decodeJSON(body.content);puts++;return new Response('{}',{status:200});}
    return new Response(JSON.stringify({type:'file',encoding:'base64',sha:'config-sha',content:encodeJSON(data)}),{status:200});
  };
  return {store:new MonitoringStore({repository:'shxyzn/gpu-timeline',branch:'status',path:'dashboard/edits.json'},fetcher),get:()=>data,puts:()=>puts,set:v=>{data=v;}};
}
test('saving a server preserves other server settings and a retried request is idempotent',async()=>{
  const b=saved('server-b'),fake=fakeStore({...emptyMonitoring(),revision:1,servers:[b]});
  const id=crypto.randomUUID(),draft=config();
  const first=await fake.store.saveServer('fake-token',draft,0,id);
  assert.deepEqual(first.servers.find(s=>s.server_id==='server-b'),b);
  assert.equal(first.servers.find(s=>s.server_id==='server-a').revision,1);
  await fake.store.saveServer('fake-token',draft,0,id);assert.equal(fake.puts(),1);
});
test('a same-server revision conflict cannot overwrite another administrator',async()=>{
  const fake=fakeStore({...emptyMonitoring(),revision:2,servers:[{...saved('server-a'),revision:2}]});
  await assert.rejects(fake.store.saveServer('fake-token',config(),1,crypto.randomUUID()),/다른 관리자/);assert.equal(fake.puts(),0);
});
test('missing public configuration is empty; invalid shared configuration is not overwritten',async()=>{
  const cfg={repository:'shxyzn/gpu-timeline',branch:'status',path:'dashboard/edits.json'};
  const missing=new MonitoringStore(cfg,async()=>new Response('{}',{status:404}));assert.deepEqual(await missing.readPublic(),emptyMonitoring());
  const invalid=new MonitoringStore(cfg,async()=>new Response(JSON.stringify({type:'file',encoding:'base64',sha:'x',content:encodeJSON({unexpected:true})}),{status:200}));
  await assert.rejects(invalid.saveServer('fake-token',config(),0,crypto.randomUUID()),/모니터링 설정/);
});

test('schedule IDs work on a non-secure preview origin without randomUUID',()=>{
  const id=monitoringID({getRandomValues:bytes=>{bytes.fill(3);return bytes;}});
  assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
