import {carriers,trackingQuery} from './dashboard/parcel-model.js?v=1.2.0';

const fields=['name','quantity','carrier_id','tracking_number','note','received_at','archived_at'];
const keys=['id',...fields,'created_at','updated_at'];
const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=message=>{throw new Error(message||'주문·배송 기록 형식을 확인해 주세요.');};
export function validateParcels(items) {
  if(!Array.isArray(items)||items.length>200)fail('보관함을 포함해 주문·배송 기록은 최대 200개까지 등록할 수 있어요.');
  const ids=new Set();
  for(const item of items){
    if(!item||Object.keys(item).some(key=>!keys.includes(key))||!/^parcel-[a-f0-9-]{36}$/.test(item.id||'')||ids.has(item.id)||
      typeof item.name!=='string'||!item.name.trim()||item.name.length>120||
      !Number.isSafeInteger(item.quantity)||item.quantity<1||item.quantity>999||
      typeof item.note!=='string'||item.note.length>300||
      !(item.carrier_id===null||carriers.some(c=>c.id===item.carrier_id))||
      !(item.tracking_number===null||typeof item.tracking_number==='string')||
      !time(item.created_at)||!time(item.updated_at)||
      !(item.received_at===null||time(item.received_at))||!(item.archived_at===null||time(item.archived_at)))fail();
    if(item.tracking_number!==null){
      const query=trackingQuery(item.carrier_id,item.tracking_number);
      if(query.number!==item.tracking_number)fail();
    }
    ids.add(item.id);
  }
  return items;
}
function normalized(input) {
  const name=String(input.name??'').trim(),note=String(input.note??'').trim();
  if(!name||name.length>120)fail('장비명을 120자 이내로 입력해 주세요.');
  const quantity=Number(input.quantity);
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>999)fail('수량은 1~999 사이의 정수로 입력해 주세요.');
  if(note.length>300)fail('메모는 300자 이내로 입력해 주세요.');
  const carrier_id=input.carrier_id||null,raw=String(input.tracking_number??'').trim();
  if(carrier_id!==null&&!carriers.some(c=>c.id===carrier_id))fail('지원하는 택배사를 선택해 주세요.');
  const tracking_number=raw?trackingQuery(carrier_id,raw).number:null;
  return {name,quantity,carrier_id,tracking_number,note};
}
export function makeParcel(input,at=new Date().toISOString(),id='parcel-'+crypto.randomUUID()) {
  const item={id,...normalized(input),received_at:null,archived_at:null,created_at:at,updated_at:at};
  validateParcels([item]);return item;
}
export function parcelEdit(item,input,at=new Date().toISOString()) {
  const candidate={...item,...input};
  Object.assign(candidate,normalized(candidate));
  validateParcels([candidate]);
  if(Object.keys(input).some(key=>!fields.includes(key)))fail('수정할 수 없는 주문 항목이에요.');
  const changes={},before={};
  for(const key of Object.keys(input))if(!same(item[key],candidate[key])){changes[key]=candidate[key];before[key]=item[key];}
  if('carrier_id' in changes||'tracking_number' in changes)for(const key of ['carrier_id','tracking_number'])before[key]=item[key];
  return {type:'parcel_edit',id:item.id,changes,before,at};
}
export function applyParcelOperation(original,operation) {
  validateParcels(original);
  if(!time(operation.at))fail();
  if(operation.type==='parcel_add'){
    validateParcels([operation.item]);
    const previous=original.find(item=>item.id===operation.item.id);
    if(previous){if(!same(previous,operation.item))fail('같은 ID의 다른 주문이 있어요. 목록을 새로고침해 주세요.');return original;}
    const next=[...original,structuredClone(operation.item)];validateParcels(next);return next;
  }
  if(operation.type!=='parcel_edit'||!operation.changes||Array.isArray(operation.changes)||!operation.before||Array.isArray(operation.before))fail();
  const keys=Object.keys(operation.changes);
  if(keys.some(key=>!fields.includes(key)))fail('수정할 수 없는 주문 항목이에요.');
  const existing=original.find(item=>item.id===operation.id);
  if(!existing)fail('주문 원본이 없어요. 목록을 새로고침해 주세요.');
  if(keys.some(key=>['carrier_id','tracking_number'].includes(key)))for(const key of ['carrier_id','tracking_number']){
    if(!Object.prototype.hasOwnProperty.call(operation.before,key)||(!keys.includes(key)&&!same(existing[key],operation.before[key])))fail('택배사 또는 운송장이 다른 창에서 변경됐어요. 주문을 다시 열어 주세요.');
  }
  let changed=false;
  for(const key of keys){
    if(same(existing[key],operation.changes[key]))continue;
    if(!Object.prototype.hasOwnProperty.call(operation.before,key)||!same(existing[key],operation.before[key]))fail('다른 관리자가 같은 주문 항목을 수정했어요. 창을 닫고 다시 열어 주세요.');
    changed=true;
  }
  if(!changed)return original;
  const next=original.map(item=>item.id===operation.id?{...item,...operation.changes,updated_at:operation.at}:item);
  validateParcels(next);return next;
}
