import test from 'node:test';
import assert from 'node:assert/strict';
import {health,gpuState,layoutJobs,HOUR,jobETA,versionLabel} from '../dist/model.js';
const now=Date.parse('2026-09-11T12:00:00Z');
const iso=h=>new Date(now+h*HOUR).toISOString();
const gpu={uuid:'GPU-0',process_count:0,utilization:0,memory_used_mib:10};
const server={updated_at:iso(0),collector_ok:true,gpus:[gpu],jobs:[]};
test('stale or failed telemetry never marks a GPU available',()=>{
  assert.equal(gpuState(server,gpu,now,1200),'idle');
  assert.equal(gpuState({...server,updated_at:iso(-1)},gpu,now,1200),'unknown');
  assert.equal(gpuState({...server,collector_ok:false},gpu,now,1200),'unknown');
  assert.equal(gpuState({...server,fetch_error:true},gpu,now,1200),'unknown');
  assert.equal(health({...server,updated_at:iso(1)},now,1200).ok,false);
});
test('missing process visibility and active low-utilization jobs do not imply free GPU',()=>{
  assert.equal(gpuState(server,{...gpu,process_count:null},now,1200),'unknown');
  assert.equal(gpuState(server,{...gpu,memory_used_mib:4000},now,1200),'busy');
  assert.equal(gpuState({...server,jobs:[{status:'running',gpu_uuids:['GPU-0']}]},gpu,now,1200),'busy');
});
test('unknown and overdue ETA end at now without inventing future duration',()=>{
  const jobs=[{id:'a',status:'running',started_at:iso(-4),expected_end_at:null},{id:'b',status:'running',started_at:iso(-2),expected_end_at:iso(-1)}];
  const bars=layoutJobs(jobs,now-6*HOUR,now+6*HOUR,now);
  assert.equal(bars.length,2);assert.ok(bars.every(b=>b.to===now&&b.uncertain));
  assert.deepEqual(bars.map(b=>b.lane),[0,1]);
});
test('multi-process overlaps stack while adjacent jobs reuse a lane',()=>{
  const jobs=[{id:'a',status:'planned',started_at:iso(0),expected_end_at:iso(2)},{id:'b',status:'planned',started_at:iso(1),expected_end_at:iso(3)},{id:'c',status:'planned',started_at:iso(2),expected_end_at:iso(4)}];
  assert.deepEqual(layoutJobs(jobs,now,now+6*HOUR,now).map(b=>b.lane),[0,1,0]);
});
test('stopped experiments use observed end, completed experiments use actual end',()=>{
  const jobs=[{id:'a',status:'stopped',started_at:iso(-5),expected_end_at:iso(3),ended_at:iso(-2)},{id:'b',status:'completed',started_at:iso(-1),expected_end_at:iso(3),ended_at:iso(0)}];
  const bars=layoutJobs(jobs,now-3*HOUR,now+6*HOUR,now);
  assert.equal(bars[0].from,now-3*HOUR);assert.equal(bars[0].to,now-2*HOUR);
  assert.equal(bars[1].to,now);assert.ok(bars.every(b=>!b.uncertain));
});

test('lost runner tracking stays visible without an invented end or free GPU',()=>{
  const job={status:'unknown',started_at:iso(-2),expected_end_at:iso(5),ended_at:null,gpu_uuids:['GPU-0']};
  assert.equal(gpuState({...server,jobs:[job]},gpu,now,1200),'unknown');
  assert.equal(gpuState({...server,jobs:[job]},{...gpu,process_count:1},now,1200),'busy');
  const [bar]=layoutJobs([job],now-6*HOUR,now+6*HOUR,now);
  assert.equal(bar.to,now);assert.equal(bar.uncertain,true);
});

test('progress ETA uses the observation time and does not drift with the screen clock',()=>{
  const job={status:'running',started_at:iso(-4),progress:{completed:25,total:100,updated_at:iso(-2)}};
  const eta=jobETA(job,iso(0));
  assert.equal(eta.at,now+4*HOUR);assert.equal(eta.source,'progress');assert.equal(eta.approximate,false);
  assert.equal(jobETA(job,iso(1)).at,eta.at);
  const [bar]=layoutJobs([job],now-6*HOUR,now+6*HOUR,now,iso(0));
  assert.equal(bar.to,eta.at);assert.equal(bar.uncertain,false);
});
test('manual ETA wins and incomplete legacy telemetry is explicitly approximate',()=>{
  const job={status:'running',started_at:iso(-2),progress:{completed:50,total:100}};
  assert.equal(jobETA(job,iso(0)).at,now+2*HOUR);
  assert.equal(jobETA(job,iso(0)).approximate,true);
  assert.deepEqual(jobETA({...job,expected_end_at:iso(1)},iso(0)),{at:now+HOUR,source:'manual',approximate:false});
  assert.equal(jobETA({...job,expected_end_at:iso(1),eta_source:'progress'},iso(0)).at,now+2*HOUR);
});
test('zero, complete, invalid and untracked progress never invents a completion',()=>{
  const job={status:'running',started_at:iso(-2)};
  for(const p of [{completed:0,total:100},{completed:100,total:100},{completed:101,total:100},
                 {completed:1,total:0},{completed:NaN,total:100},{completed:'50',total:100}]){
    assert.equal(jobETA({...job,progress:p},iso(0)).at,null);
  }
  assert.equal(jobETA({...job,progress:{completed:50,total:100,updated_at:iso(-3)}},iso(0)).at,null);
  for(const status of ['completed','failed','cancelled','unknown']){
    assert.equal(jobETA({...job,status,progress:{completed:50,total:100}},iso(0)).at,null);
  }
  assert.equal(jobETA({...job,progress:{completed:50,total:100}},null).at,null);
});
test('deployed versions display full release and commit without guessing old collectors',()=>{
  assert.equal(versionLabel(null),null);
  assert.equal(versionLabel({version:'1.1.0',revision:'a'.repeat(40),dirty:false}),'v1.1.0+aaaaaaa');
  assert.equal(versionLabel({version:'1.1.0',revision:null}),'v1.1.0+unknown');
  assert.equal(versionLabel({version:'1.1.0',revision:'a'.repeat(40),dirty:true}),'v1.1.0+aaaaaaa.dirty');
});
