import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyHistory,validateHistory,samplesFromTokens,mergeSamples,needsRecording,chartData,MAX_SAMPLES,DAY} from '../dist/test-server/api-usage-model.js';
import {APIUsageStore} from '../dist/test-server/api-usage-store.js';
import {encodeJSON,decodeJSON} from '../dist/edits.js';
const now=Date.parse('2026-11-05T12:00:00Z');
const id='or-00000000-0000-4000-8000-000000000001',other='or-00000000-0000-4000-8000-000000000002';
const point=(at,total=10,daily=2,key_id=id)=>({key_id,at,total,daily});
const token=(at='2026-11-05T11:00:00Z',usage=12,daily=3)=>({id,name:'실험 키',checked_at:at,error:null,usage:{usage,usage_daily:daily}});

test('history accepts an explicit public cost allowlist and never provider credentials',()=>{
  const s=samplesFromTokens([{...token(),key:'secret',label:'secret',usage:{...token().usage,api_key:'secret'}}],now);
  assert.deepEqual(Object.keys(s[0]),['key_id','at','total','daily']);assert.equal(JSON.stringify(s).includes('secret'),false);
  assert.throws(()=>validateHistory({...emptyHistory(),samples:[{...s[0],key:'secret'}]}));
  assert.throws(()=>validateHistory({...emptyHistory(),credentials:'secret'}));
  assert.throws(()=>validateHistory({...emptyHistory(),samples:[{...s[0],daily:-1}]}));
  assert.throws(()=>validateHistory({...emptyHistory(),samples:Array(MAX_SAMPLES+1).fill(s[0])}));
});
test('failed, future, invalid and missing cumulative readings are not invented as zero',()=>{
  assert.deepEqual(samplesFromTokens([{...token(),error:'unauthorized'},token('2026-11-06T11:00:00Z'),token('bad'),token(undefined,null)],now),[]);
  assert.equal(samplesFromTokens([token(undefined,0,null)],now)[0].daily,null);
  assert.equal(samplesFromTokens([token(undefined,0,0)],now)[0].daily,0);
});
test('UTC day boundaries, actual zero and missing dates remain distinct',()=>{
  const document=mergeSamples(emptyHistory(),[point('2026-11-04T23:59:00Z',10,4),point('2026-11-05T00:01:00Z',10,0)],now);
  const data=chartData(document,[token('2026-11-05T00:01:00Z',10,0)],{now});
  assert.equal(data.daily.at(-1).day,'2026-11-05');assert.equal(data.daily.at(-1).total,0);
  assert.equal(data.daily.at(-2).total,4);assert.equal(data.daily.at(-3).total,null);
  assert.equal(data.observedDays,2);assert.equal(data.dailyTotal,4);
});
test('daily amounts use the last observation, not a sum of overlapping hourly totals',()=>{
  const document=mergeSamples(emptyHistory(),[point('2026-11-05T01:00:00Z',12,3),point('2026-11-05T02:00:00Z',15,6),point('2026-11-05T03:00:00Z',14,5)],now);
  const data=chartData(document,[{...token(),error:'rate_limit'}],{now});
  assert.equal(data.daily.at(-1).total,5);assert.equal(data.dailyTotal,5);
  assert.equal(data.series[0].segments.length,2);assert.equal(data.resets,1);
});
test('filtering keys and removing a key cannot resurrect it in the visible dataset',()=>{
  const document=mergeSamples(emptyHistory(),[point('2026-11-05T01:00:00Z',12,3),point('2026-11-05T01:00:00Z',5,2,other)],now);
  const tokens=[{...token(),error:'unavailable'},{...token(),id:other,name:'다른 키',error:'unavailable'}];
  assert.equal(chartData(document,tokens,{now}).dailyTotal,5);
  assert.equal(chartData(document,tokens,{now,key:other}).dailyTotal,2);
  assert.equal(chartData(document,tokens.slice(1),{now}).series.length,1);
});
test('retention compacts to hourly recent points and daily historical points without replay loops',()=>{
  const points=[point('2026-07-01T01:00:00Z'),point('2026-10-01T01:00:00Z'),point('2026-10-01T02:00:00Z',11,3),point('2026-11-05T01:01:00Z'),point('2026-11-05T01:59:00Z',12,4)];
  const merged=mergeSamples(emptyHistory(),points,now);
  assert.equal(merged.samples.length,2);assert.match(merged.samples[0].at,/02:00:00/);
  assert.equal(needsRecording(merged,[token('2026-11-05T01:01:00Z',10,2)],now),false);
  assert.equal(needsRecording(merged,[token('2026-11-05T02:01:00Z',13,5)],now),true);
  assert.equal(mergeSamples(merged,points,now).samples.length,2);
  assert.equal(points.length,5);
});
test('long gaps and counter decreases split cumulative lines rather than implying usage',()=>{
  const document=mergeSamples(emptyHistory(),[point('2026-11-01T01:00:00Z',20,4),point('2026-11-04T01:00:00Z',25,3),point('2026-11-05T01:00:00Z',2,2)],now);
  const data=chartData(document,[{...token(),error:'unavailable'}],{now});
  assert.equal(data.series[0].segments.length,3);assert.equal(data.resets,1);
  assert.equal(data.cumulativeTotal,2);assert.equal(data.dailyTotal,9);
});
test('an empty history can show the current public baseline without making a write',()=>{
  const document=emptyHistory(),data=chartData(document,[token()],{now});
  assert.equal(data.observedDays,1);assert.equal(data.sampleCount,1);assert.equal(document.samples.length,0);
  assert.equal(chartData(document,[],{now}).dailyTotal,null);assert.throws(()=>chartData(document,[],{days:365,now}));
});
test('bounded history does not turn overflowing observed totals into zero',()=>{
  const document=mergeSamples(emptyHistory(),[point('2026-11-05T01:00:00Z',1e308,1e308),point('2026-11-05T01:00:00Z',1e308,1e308,other)],now);
  const data=chartData(document,[{...token(),error:'unavailable'},{...token(),id:other,error:'unavailable'}],{now});
  assert.equal(data.dailyTotal,null);assert.equal(data.cumulativeTotal,null);
});
test('store only writes the isolated staging history, is idempotent, and merges CAS conflicts',async()=>{
  let data=emptyHistory(),puts=0,conflict=true;const requests=[];
  const fetcher=async(url,options={})=>{
    requests.push(String(url));
    assert.equal(String(url).includes('edits.json'),false);assert.equal(String(url).includes('monitoring'),false);
    assert.match(String(url),/dashboard\/openrouter-usage-test\.json/);
    if(String(url).includes('raw.githubusercontent.com'))return new Response(JSON.stringify(data),{status:200});
    if(options.method==='PUT'){
      puts++;const body=JSON.parse(options.body);assert.equal(body.branch,'status');
      if(conflict){conflict=false;data={...emptyHistory(),revision:1,samples:[point('2026-11-04T11:00:00Z',5,2,other)]};return new Response('{}',{status:409});}
      data=decodeJSON(body.content);assert.equal(JSON.stringify(data).includes('fake-admin-token'),false);return new Response('{}',{status:200});
    }
    return new Response(JSON.stringify({type:'file',encoding:'base64',sha:'sha-'+data.revision,content:encodeJSON(data)}),{status:200});
  };
  const store=new APIUsageStore({repository:'shxyzn/gpu-timeline',branch:'status',path:'dashboard/edits.json'},fetcher);store.client.pause=async()=>{};
  await store.append('fake-admin-token',samplesFromTokens([token()],now),now);
  assert.equal(data.samples.length,2);assert.equal(data.revision,2);assert.equal(puts,2);
  await store.append('fake-admin-token',samplesFromTokens([token()],now),now);assert.equal(puts,2);
  assert.equal((await store.readPublic()).samples.length,2);
});
