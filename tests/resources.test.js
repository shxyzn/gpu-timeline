import test from 'node:test';
import assert from 'node:assert/strict';
import {resourceSummary,resourceState,resourceEvents,pressureAssessment} from '../dist/resources-model.js';
const now=1800000000000;
const base=()=>({schema_version:1,enabled:true,current:{at:now/1000,psi_supported:{cpu:true,memory:true,io:false}},
  columns:['cpu_pct','gpu_pct','allocated_gpus','ram_peak_pct'],reducers:['mean','mean','mean','max'],fine:[],hourly:[],events:[]});
test('legacy, disabled, missing, stale and unavailable telemetry remain explicit',()=>{
  assert.equal(resourceState({}).kind,'upgrade');
  assert.equal(resourceState({resources:{...base(),enabled:false}}).kind,'disabled');
  assert.equal(resourceState({resources:{...base(),current:null}}).kind,'waiting');
  assert.equal(resourceState({resources:base()},now).kind,'ready');
  assert.equal(resourceState({resources:base(),fetch_error:true},now).kind,'stale');
  assert.equal(resourceState({resources:base()},now+1500000).kind,'stale');
});
test('weighted averages, per-metric gaps, maximum, GPU hours and coverage',()=>{
  const r=base(), t=now/1000;
  r.fine=[[t-600,300,[20,null,1,90],[300,0,300,300]],[t-300,150,[80,50,2,98],[150,150,150,150]]];
  const s=resourceSummary(r,24,now);
  assert.equal(s.metrics.cpu_pct,40);assert.equal(s.metrics.gpu_pct,50);
  assert.equal(s.metrics.ram_peak_pct,98);assert.equal(s.allocation,1/6);
  assert.equal(s.seconds,450);assert.equal(s.weights.gpu_pct,150);
  assert.ok(s.coverage<1);
});
test('empty histories have null metrics; current partial bucket is not undercounted',()=>{
  const r=base();assert.equal(resourceSummary(r,24,now).metrics.cpu_pct,null);
  const t=now/1000;r.current.at=t-100;r.fine=[[t-300,200,[50,null,1,90],[200,0,200,200]]];
  assert.equal(resourceSummary(r,24,now).seconds,200);
  assert.equal(resourceSummary(r,24,now).weights.cpu_pct,200);
});
test('7 and 30 days use hourly history; malformed, future and duplicate rows ignored',()=>{
  const r=base(),t=now/1000;
  const row=[t-3600,3600,[40,null,1,90],[3600,0,3600,3600]];
  r.hourly=[row,row,[t+3600,3600,[99],[3600]],[t-7200,9999,[99],[9999]]];
  const s=resourceSummary(r,168,now);assert.equal(s.rows.length,1);assert.equal(s.seconds,3600);
});
test('pressure reports require sustained, recent events and preserve unsupported state',()=>{
  const r=base(),t=now/1000;
  r.events=[{kind:'memory',start:t-300,end:t-100,evidence:{ram_pct:97}},
    {kind:'cpu',start:t-60,end:t,evidence:{}},{kind:'io',start:t-90000,end:t-89000,evidence:{}}];
  assert.equal(resourceEvents(r,now).length,1);
  assert.equal(pressureAssessment(r,now).find(a=>a.kind==='io').supported,false);
});
