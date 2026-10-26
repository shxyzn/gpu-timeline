import test from 'node:test';
import assert from 'node:assert/strict';
import {currentView,progressValue} from '../dist/test-server/current-model.js';
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
