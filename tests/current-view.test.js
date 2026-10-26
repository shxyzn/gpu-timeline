import test from 'node:test';
import assert from 'node:assert/strict';
import {currentView,progressValue,experimentPresentation,humanDuration,gpuReadings} from '../dist/test-server/current-model.js';
const now=Date.parse('2026-10-26T05:20:00Z');
const iso=minutes=>new Date(now+minutes*60000).toISOString();
const gpu={uuid:'gpu-0',index:0,process_count:0,utilization:0,memory_used_mib:0,memory_total_mib:24576};
const server=()=>({server_id:'server-a',name:'Server A',updated_at:iso(0),collector_ok:true,gpus:[{...gpu}],jobs:[]});

test('current view separates free, busy, stale and API resources',()=>{
  const a=server(),b={...server(),server_id:'server-b',updated_at:iso(-24)};
  a.jobs=[{id:'api',resource_type:'api',api_slot:0,status:'running',gpu_uuids:[]}];
  const result=currentView([a,b],[a,b],now);
  assert.equal(result.total,2);assert.equal(result.idle,1);assert.equal(result.unknown,1);
  assert.equal(result.apiRunning,1);assert.equal(result.alerts.length,1);
  assert.equal(result.gpuRows[0].jobs.length,0);
});
test('a hidden collector experiment never makes its physical GPU appear free',()=>{
  const raw=server();raw.jobs=[{id:'run',status:'running',gpu_uuids:['gpu-0']}];
  const display={...raw,jobs:[]};
  const result=currentView([display],[raw],now);
  assert.equal(result.busy,1);assert.equal(result.idle,0);
  assert.deepEqual(result.gpuRows[0].jobs,[]);
});
test('concurrent GPU experiments remain separate and the earliest plan is retained',()=>{
  const s=server();
  s.jobs=[{id:'a',status:'running',gpu_uuids:['gpu-0']},{id:'b',status:'running',gpu_uuids:['gpu-0']},
    {id:'later',status:'planned',gpu_uuids:['gpu-0'],started_at:iso(120)},
    {id:'first',status:'planned',gpu_uuids:['gpu-0'],started_at:iso(60)}];
  const result=currentView([s],[s],now);
  assert.equal(result.busy,1);assert.equal(result.gpuRows[0].jobs.length,2);
  assert.equal(result.gpuRows[0].next.id,'first');
});
test('stale API jobs remain visible as unconfirmed without increasing running count',()=>{
  const s={...server(),fetch_error:true,jobs:[{id:'api',resource_type:'api',api_slot:3,status:'running',gpu_uuids:[]}]};
  const result=currentView([s],[s],now);
  assert.equal(result.apiRows.length,1);assert.equal(result.apiRunning,0);assert.equal(result.apiUncertain,1);
  assert.equal(result.idle,0);assert.equal(result.unknown,1);
});
test('missing telemetry and unknown execution state never imply availability',()=>{
  const s=server();s.gpus[0].process_count=null;
  assert.equal(currentView([s],[s],now).unknown,1);
  s.gpus[0].process_count=0;s.jobs=[{id:'lost',status:'unknown',gpu_uuids:['gpu-0']}];
  assert.equal(currentView([s],[s],now).unknown,1);
  assert.equal(currentView([{...s,updated_at:iso(6)}],[],now).unknown,1);
});
test('progress preserves missing values and clamps displayed percentages',()=>{
  assert.equal(progressValue({}),null);
  for(const progress of [{completed:0,total:0},{completed:-1,total:10},{completed:1,total:Infinity}])assert.equal(progressValue({progress}),null);
  assert.equal(progressValue({progress:{completed:0,total:10}}),0);
  assert.equal(progressValue({progress:{completed:152,total:280}}),152/280*100);
  assert.equal(progressValue({progress:{completed:101,total:100}}),100);
});
test('compact experiment names retain explicit task, model, method, seed and owner without inventing a model family',()=>{
  const original='exp46 · AIME · 8B GEPA · 정답 2회 연속 시 진짜 AIME 문제로 교체 · 8B 검증 · seed0';
  const result=experimentPresentation({name:original,owner:'상현'});
  assert.equal(result.title,'exp46 · AIME / 8B');
  assert.deepEqual(result.meta,['GEPA','seed 0','상현']);
  assert.equal(result.original,original);
  assert.equal(result.title.includes('Qwen'),false);
  const named=experimentPresentation({name:'exp_kmj_39 · GEPA · AIME · Qwen3-4B task+reflection · paper protocol · seed2',owner:'kmj'});
  assert.equal(named.title,'exp_kmj_39 · AIME / Qwen3-4B');
  assert.deepEqual(named.meta,['GEPA','seed 2','kmj']);
});
test('unstructured names preserve their original text and explicit model names survive compact display',()=>{
  assert.equal(experimentPresentation({name:'API current <script> test'}).title,'API current <script> test');
  assert.equal(experimentPresentation({name:'exp68 Qwen3-4B problem generation, outcome-change rule, seed 2'}).title,'exp68 · Qwen3-4B 문제 생성');
  assert.match(experimentPresentation({name:'exp49 · AIME · GPT-4.1-mini (OpenRouter) GEPA · seed 0'}).title,/GPT-4\.1-mini/);
  const long='한'.repeat(120);const result=experimentPresentation({name:long});
  assert.ok(result.title.length<=80);assert.equal(result.original,long);
});
test('long ETA durations use days while short durations retain useful precision',()=>{
  assert.equal(humanDuration(49*3600000+59*60000),'약 2일 2시간');
  assert.equal(humanDuration(48*3600000),'약 2일');
  assert.equal(humanDuration(2*3600000+10*60000),'2시간 10분');
  assert.equal(humanDuration(20*60000),'20분');
});
test('GPU readings distinguish measured zero from missing, invalid and unsupported telemetry',()=>{
  assert.deepEqual(gpuReadings({utilization:0,memory_used_mib:0,memory_total_mib:24576}),{utilization:0,used:0,total:24});
  assert.deepEqual(gpuReadings({utilization:98,memory_used_mib:23859.2,memory_total_mib:24576}),{utilization:98,used:23.3,total:24});
  assert.deepEqual(gpuReadings({utilization:null,memory_used_mib:null,memory_total_mib:null}),{utilization:null,used:null,total:null});
  assert.equal(gpuReadings({utilization:101}).utilization,null);
  assert.equal(gpuReadings({utilization:'98'}).utilization,null);
});
