import test from 'node:test';
import assert from 'node:assert/strict';
import {availableCurrentView,isUnavailable} from '../dist/test-server/availability-model.js';
const now=Date.parse('2026-11-03T06:00:00Z');
const server=id=>({server_id:id,name:id==='server-a'?'Kimi(191)':'Leclerc(183)',updated_at:new Date(now).toISOString(),collector_ok:true,gpus:[{uuid:id+'-0',index:0,process_count:0,utilization:0}],jobs:[]});

test('repair state overrides healthy, busy, stale and missing collector readings without counting capacity',()=>{
  for(const mode of ['idle','busy','stale','missing']){
    const a=server('server-a'),b=server('server-b');
    if(mode==='busy'){a.gpus[0].process_count=1;a.gpus[0].utilization=100;}
    if(mode==='stale')a.updated_at=new Date(now-3600000).toISOString();
    if(mode==='missing'){a.fetch_error=true;a.gpus=[];}
    const result=availableCurrentView([a,b],[a,b],now);
    assert.equal(result.total,1,mode);assert.equal(result.idle,1,mode);assert.equal(result.busy,0,mode);assert.equal(result.unknown,0,mode);
    assert.equal(result.alerts.length,0,mode);assert.equal(result.gpuRows.length,2,mode);
    assert.equal(result.gpuRows[0].state,'maintenance',mode);assert.equal(result.gpuRows[0].healthy,false,mode);
    assert.equal(result.excluded[0].gpuCount,1,mode);
  }
});
test('original GPU and API experiment records survive while current API totals exclude repair server',()=>{
  const a=server('server-a'),b=server('server-b');
  a.jobs=[{id:'gpu-old',status:'running',gpu_uuids:['server-a-0'],progress:{completed:1,total:2}},{id:'api-old',resource_type:'api',api_slot:0,status:'running',gpu_uuids:[]}];
  b.jobs=[{id:'api-live',resource_type:'api',api_slot:1,status:'running',gpu_uuids:[]}];
  const before=structuredClone([a,b]);const result=availableCurrentView([a,b],[a,b],now);
  assert.equal(result.apiTotal,1);assert.equal(result.apiRunning,1);assert.equal(result.apiUncertain,0);
  assert.equal(result.apiRows.length,2);assert.ok(result.apiRows[0].repair);assert.equal(result.apiRows[0].eta.at,null);
  assert.equal(result.gpuRows[0].jobs[0].id,'gpu-old');assert.deepEqual([a,b],before);
});
test('repair designation follows server ID and removing it restores normal availability',()=>{
  const a=server('server-a');a.name='Renamed server';
  assert.equal(isUnavailable(a.server_id),true);assert.equal(isUnavailable('Kimi(191)'),false);
  const result=availableCurrentView([a],[a],now,1200,{});
  assert.equal(result.idle,1);assert.equal(result.total,1);assert.equal(result.excluded.length,0);assert.equal(result.gpuRows[0].state,'idle');
});
