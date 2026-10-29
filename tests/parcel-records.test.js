import test from 'node:test';
import assert from 'node:assert/strict';
import {makeParcel,parcelEdit,validateParcels} from '../dist/parcel-records.js';
import {emptyEdits,applyOperation,validateEdits,encodeJSON,decodeJSON,GitHubEditsStore} from '../dist/edits.js';

const at='2026-10-29T03:00:00.000Z';
const id='parcel-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const input={name:'측정용 마이크 🎙️',quantity:4,carrier_id:'',tracking_number:'',note:'차량 데이터 수집용'};
const item=()=>makeParcel(input,at,id);
const add=()=>({type:'parcel_add',item:item(),at});
const config={repository:'shxyzn/gpu-timeline',branch:'status',path:'dashboard/edits.json'};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const file=data=>({type:'file',encoding:'base64',sha:'sha-'+data.revision,content:encodeJSON(data)});

test('orders can be registered before dispatch; quantities and waybills are validated before sharing',()=>{
  assert.equal(item().tracking_number,null);
  assert.equal(item().carrier_id,null);
  assert.equal(makeParcel({...input,carrier_id:'kr.cjlogistics',tracking_number:'1234-5678 9012'},at,id).tracking_number,'123456789012');
  for(const quantity of [0,1.5,-1,1000,'abc'])assert.throws(()=>makeParcel({...input,quantity},at,id),/수량/);
  assert.throws(()=>makeParcel({...input,name:' '},at,id),/장비명/);
  assert.throws(()=>makeParcel({...input,tracking_number:'123456789012'},at,id),/택배사/);
  assert.throws(()=>makeParcel({...input,carrier_id:'kr.fake'},at,id),/택배사/);
  assert.throws(()=>validateParcels([{...item(),address:'private address'}]));
  assert.throws(()=>validateEdits({...emptyEdits(),parcels:[item(),item()]}));
});

test('shared parcel operations preserve existing experiment and token data and retry without duplicates',()=>{
  const original={...emptyEdits(),hidden_jobs:[{reference:'server-a/job-1',name:'기존 실험',hidden_at:at}],openrouter_tokens:[]};
  const data=applyOperation(original,add());
  assert.equal(original.parcels,undefined);
  assert.equal(data.parcels.length,1);
  assert.deepEqual(data.hidden_jobs,original.hidden_jobs);
  assert.deepEqual(data.openrouter_tokens,original.openrouter_tokens);
  assert.deepEqual(applyOperation(data,add()),data);
  assert.deepEqual(decodeJSON(encodeJSON(data)),data);
  const after=applyOperation(data,{type:'hide',reference:'server-b/job-2',name:'다른 실험',at});
  assert.deepEqual(after.parcels,data.parcels);
  assert.equal(after.hidden_jobs.length,2);
});

test('independent order edits merge, same-field changes conflict, and carrier and waybill edits remain paired',()=>{
  const data=applyOperation(emptyEdits(),add());
  const name=parcelEdit(item(),{name:'새 마이크'},at),quantity=parcelEdit(item(),{quantity:6},at);
  let next=applyOperation(applyOperation(data,name),quantity);
  assert.equal(next.parcels[0].name,'새 마이크');assert.equal(next.parcels[0].quantity,6);
  assert.deepEqual(applyOperation(next,quantity),next);
  assert.throws(()=>applyOperation(next,parcelEdit(item(),{name:'다른 이름'},at)),/다른 관리자/);
  next=applyOperation(next,parcelEdit(next.parcels[0],{carrier_id:'kr.cjlogistics',tracking_number:'123456789012'},at));
  const opened=structuredClone(next.parcels[0]);
  const number=parcelEdit(opened,{tracking_number:'123456789013'},at);
  next=applyOperation(next,parcelEdit(opened,{carrier_id:'kr.hanjin'},at));
  assert.throws(()=>applyOperation(next,number),/다른 창|다른 관리자/);
  assert.throws(()=>parcelEdit(opened,{created_at:'2020-01-01T00:00:00Z'},at),/수정/);
});

test('receipt and archive actions are reversible and idempotent without destroying tracking data',()=>{
  let data=applyOperation(emptyEdits(),add());
  const received=parcelEdit(data.parcels[0],{received_at:at},at);
  data=applyOperation(data,received);assert.equal(data.parcels[0].received_at,at);
  assert.deepEqual(applyOperation(data,received),data);
  data=applyOperation(data,parcelEdit(data.parcels[0],{archived_at:at},at));
  assert.equal(data.parcels[0].archived_at,at);
  data=applyOperation(data,parcelEdit(data.parcels[0],{archived_at:null,received_at:null},at));
  assert.equal(data.parcels[0].archived_at,null);assert.equal(data.parcels[0].received_at,null);
  assert.equal(data.parcels[0].name,input.name);assert.equal(data.parcels[0].quantity,4);
});

test('GitHub conflict retries retain another administrator’s order and unrelated dashboard records',async()=>{
  let data=emptyEdits(),writes=0;
  const other=makeParcel({...input,name:'오디오 인터페이스',quantity:1},at,'parcel-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const store=new GitHubEditsStore(config,async(url,options)=>{
    if(options.method!=='PUT')return json(file(data));
    if(writes++===0){data=applyOperation(data,{type:'parcel_add',item:other,at});return json({},409);}
    const body=JSON.parse(options.body);assert.equal(body.sha,'sha-'+data.revision);data=decodeJSON(body.content);return json({});
  },async()=>{});
  const saved=await store.save('test-only-token',add());
  assert.equal(saved.parcels.length,2);assert.equal(writes,2);
  assert.equal(saved.parcels.find(p=>p.id===other.id).name,'오디오 인터페이스');
});

test('uncertain and rejected shared saves never create duplicate orders or report a successful local-only record',async()=>{
  let data=emptyEdits(),writes=0;
  const store=new GitHubEditsStore(config,async(url,options)=>{
    if(options.method!=='PUT')return json(file(data));
    writes++;data=decodeJSON(JSON.parse(options.body).content);throw new TypeError('lost response');
  });
  await assert.rejects(store.save('test-only-token',add()),/연결/);
  assert.equal((await store.save('test-only-token',add())).parcels.length,1);assert.equal(writes,1);
  const denied=new GitHubEditsStore(config,async(url,options)=>options.method==='PUT'?json({},403):json(file(emptyEdits())));
  await assert.rejects(denied.save('test-only-token',add()),/권한/);
  assert.equal(denied.saving,false);
});
