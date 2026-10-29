import test from 'node:test';
import assert from 'node:assert/strict';
import {carriers,trackingQuery,normalizeTrack,fetchTrack} from '../dist/test-server/parcel-model.js';

const query=trackingQuery('kr.cjlogistics','1234-5678 9012');
const data={carrier:{id:query.carrier.id},state:{id:'out_for_delivery',text:'배송출발'},progresses:[
  {time:'2026-10-29T06:00:00+09:00',status:{id:'in_transit',text:'간선 하차'},location:{name:'대전 HUB'},description:'배송 지역으로 이동'},
  {time:'2026-10-29T09:12:00+09:00',status:{id:'out_for_delivery',text:'배송출발'},location:{name:'성북 배송점'},description:'오늘 배달 예정'},
]};

test('tracking requires an explicit supported carrier and normalizes only number formatting',()=>{
  assert.equal(query.number,'123456789012');
  assert.equal(trackingQuery('kr.epost','１２３４ ５６７８ ９０１２３').number,'1234567890123');
  assert.throws(()=>trackingQuery('',query.number),/택배사/);
  assert.throws(()=>trackingQuery('kr.fake',query.number),/택배사/);
  for(const value of ['', '123','000000000000','12345678<script>','https://example.com/123456789012','12/3456789012'])assert.throws(()=>trackingQuery(query.carrier.id,value),/운송장/);
  for(const carrier of carriers){
    const item=trackingQuery(carrier.id,query.number),official=new URL(item.official);
    assert.equal(official.protocol,'https:');
    assert.equal(new URL(item.endpoint).hostname,'apis.tracker.delivery');
    if(carrier.parameter)assert.equal(official.searchParams.get(carrier.parameter),query.number);
  }
});

test('tracking preserves the reported state and orders history without inventing timestamps or stages',()=>{
  const result=normalizeTrack(data,query);
  assert.equal(result.stage,3);
  assert.equal(result.status,'배송출발');
  assert.equal(result.events[0].location,'성북 배송점');
  assert.ok(result.events[0].at>result.events[1].at);
  const unknown=normalizeTrack({state:{id:'exception',text:'배송 확인 필요'},progresses:[null,{time:'',status:{id:'in_transit'},description:'일시 중지'}]},query);
  assert.equal(unknown.stage,-1);
  assert.equal(unknown.events[0].at,null);
  assert.equal(unknown.status,'배송 확인 필요');
  const noEvents=normalizeTrack({state:{id:'information_received'}},query);
  assert.equal(noEvents.events.length,0);
  assert.equal(noEvents.status,'상품 준비');
  assert.throws(()=>normalizeTrack({message:'no tracking'},query),e=>e.code==='not-found');
  assert.throws(()=>normalizeTrack({...data,carrier:{id:'kr.epost'}},query),e=>e.code==='response');
});

test('tracking uses credential-free on-demand requests and distinguishes provider failures',async()=>{
  let calls=0;
  const result=await fetchTrack(query,{fetcher:async(url,options)=>{
    calls++;assert.equal(url,query.endpoint);assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.headers,undefined);
    return new Response(JSON.stringify(data),{status:200});
  }});
  assert.equal(result.code,'out_for_delivery');assert.equal(calls,1);
  for(const [status,code] of [[404,'not-found'],[429,'rate-limit'],[401,'unavailable'],[403,'unavailable'],[410,'unavailable'],[503,'unavailable']]){
    await assert.rejects(fetchTrack(query,{fetcher:async()=>new Response('private provider error',{status})}),error=>error.code===code&&!error.message.includes('private provider error'));
  }
  await assert.rejects(fetchTrack(query,{fetcher:async()=>new Response('<html>wrong response</html>')}),error=>error.code==='response');
  await assert.rejects(fetchTrack(query,{fetcher:async()=>{throw new TypeError('Failed to fetch');}}),error=>error.code==='network');
});

test('tracking times out and user cancellation remains distinguishable from a provider error',async()=>{
  const wait=async(url,{signal})=>new Promise((resolve,reject)=>{
    const abort=()=>reject(new DOMException('Aborted','AbortError'));
    if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
  });
  await assert.rejects(fetchTrack(query,{fetcher:wait,timeout:5}),error=>error.code==='timeout');
  const controller=new AbortController();
  const pending=fetchTrack(query,{fetcher:wait,signal:controller.signal});controller.abort();
  await assert.rejects(pending,error=>error.name==='AbortError');
});
