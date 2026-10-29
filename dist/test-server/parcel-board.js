import {parcelBoardView,openDashboardLogin,saveParcelRecord,refreshDashboard} from '../app.js?v=parcel-board-1';
import {makeParcel,parcelEdit} from '../parcel-records.js?v=parcel-board-1';
import {carriers,trackingQuery,fetchTrack,deliveryTone} from './parcel-model.js?v=parcel-tone-2';

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=at=>!at?'—':new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(at))+' KST';
const key=item=>item.carrier_id+'|'+item.tracking_number;
const cache=new Map(),requests=new Map(),expanded=new Set();
const dialog=$('parcel-order-dialog'),form=$('parcel-order-form');
let filter='active',editing=null,pending=null,batchRunning=false,batchLimited=false;
$('parcel-order-carrier').replaceChildren(new Option('미정 · 나중에 입력',''),...carriers.map(c=>new Option(c.name,c.id)));
const feedback=message=>{$('parcel-board-feedback').textContent=message;};
function state(item,reading) {
  if(item.received_at)return {label:'수령 완료',kind:'received'};
  if(!item.tracking_number)return {label:'운송장 대기',kind:'waiting'};
  if(reading?.loading)return {label:'조회 중…',kind:'loading'};
  if(reading?.track)return {label:reading.track.status+(reading.error?' · 마지막 조회':''),kind:deliveryTone(reading.track.code)};
  return {label:reading?.error?'조회 확인 필요':'배송 조회 전',kind:reading?.error?'warning':'waiting'};
}
function action(item,name,label,disabled=false){return `<button type="button" data-parcel-id="${item.id}" data-parcel-action="${name}"${disabled?' disabled':''}>${label}</button>`;}
function card(item,view) {
  const reading=cache.get(item.id),status=state(item,reading),latest=reading?.track?.events[0];
  const courier=carriers.find(c=>c.id===item.carrier_id);
  const query=item.tracking_number?trackingQuery(item.carrier_id,item.tracking_number):null;
  const history=reading?.track?.events||[];
  return `<article class="parcel-order-card" data-parcel-card="${item.id}" aria-label="${esc(item.name)}" aria-busy="${!!reading?.loading}"><div class="parcel-order-top"><span class="parcel-order-status ${status.kind}">${esc(status.label)}</span><span class="parcel-order-quantity">${item.quantity}개</span></div><h3>${esc(item.name)}</h3>${item.note?`<p class="parcel-order-note">${esc(item.note)}</p>`:''}<p class="parcel-order-waybill">${esc(courier?.name||'택배사 미정')}${item.tracking_number?`<span>${esc(item.tracking_number)}</span>`:'<span>결제 후 등록 · 운송장이 나오면 수정해 주세요.</span>'}</p>${latest?`<p class="parcel-order-location"><strong>${esc(latest.location||'위치 미제공')}</strong><span>마지막 이동 ${esc(date(latest.at))}</span></p>`:''}${reading?.error?`<p class="parcel-order-error">${esc(reading.error)}</p>`:''}<p class="parcel-order-time">${item.received_at?'수령 '+esc(date(item.received_at)):reading?.checkedAt?'조회 '+esc(date(reading.checkedAt)):'등록 '+esc(date(item.created_at))}</p>${history.length?`<details class="parcel-order-history" data-parcel-history="${item.id}"${expanded.has(item.id)?' open':''}><summary>이동 내역 ${history.length}건</summary><ol>${history.map(event=>`<li><span>${esc(date(event.at))}</span><strong class="parcel-event-status ${deliveryTone(event.code)}">${esc(event.status)}</strong>${event.location?`<span>${esc(event.location)}</span>`:''}${event.description?`<p>${esc(event.description)}</p>`:''}</li>`).join('')}</ol></details>`:''}<div class="parcel-order-actions">${query?`${action(item,'query','배송 조회',!!reading?.loading||batchRunning)}${action(item,'copy','번호 복사')}<a href="${esc(query.official)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">공식 조회 ↗</a>`:''}${view.unlocked?`${action(item,'edit','수정',view.busy)}${!item.archived_at?action(item,'received',item.received_at?'수령 취소':'수령 완료',view.busy):''}${action(item,'archive',item.archived_at?'목록으로 복원':'보관',view.busy)}`:''}</div></article>`;
}
function renderBoard() {
  const view=parcelBoardView(),byID=new Map(view.items.map(item=>[item.id,item]));
  for(const [id,request] of requests){const item=byID.get(id);if(!item||item.archived_at||key(item)!==request.key){request.controller.abort();requests.delete(id);cache.delete(id);}}
  for(const [id,reading] of cache){if(!byID.has(id)||key(byID.get(id))!==reading.key)cache.delete(id);}
  const groups={active:view.items.filter(item=>!item.archived_at&&!item.received_at),received:view.items.filter(item=>!item.archived_at&&item.received_at),archived:view.items.filter(item=>item.archived_at)};
  for(const kind of Object.keys(groups)){$('parcel-filter-'+kind).setAttribute('aria-pressed',String(kind===filter));$('parcel-count-'+kind).textContent=groups[kind].length;}
  $('parcel-board-access').textContent=view.unlocked?'관리자 · 등록·수정 가능':'연구실 공용 목록 · 등록·수정은 관리자 로그인';
  $('parcel-board-load-error').textContent=view.loadError;
  $('parcel-order-add').disabled=!view.enabled||view.busy;
  $('parcel-board-sync').disabled=!view.enabled||view.busy;
  $('parcel-board-refresh').disabled=batchRunning||requests.size>0||!groups.active.some(item=>item.tracking_number);
  $('parcel-board-refresh').textContent=batchRunning?'배송 조회 중…':'전체 배송 조회';
  const selected=document.activeElement?.closest('[data-parcel-action]');
  const focus=selected?{id:selected.dataset.parcelId,action:selected.dataset.parcelAction}:null;
  $('parcel-orders').innerHTML=groups[filter].sort((a,b)=>b.created_at.localeCompare(a.created_at)).map(item=>card(item,view)).join('')||`<div class="parcel-board-empty"><strong>${filter==='active'?'등록한 주문이 없어요.':filter==='received'?'수령 완료한 장비가 없어요.':'보관한 주문이 없어요.'}</strong><p>${filter==='active'?'결제한 장비를 추가해 두세요. 운송장 번호는 나중에 입력해도 돼요.':filter==='received'?'장비를 받으면 주문 카드에서 수령 완료를 눌러 주세요.':'지난 주문을 보관하면 이곳에서 다시 확인하고 복원할 수 있어요.'}</p></div>`;
  if(focus)$('parcel-orders').querySelector(`[data-parcel-id="${focus.id}"][data-parcel-action="${focus.action}"]:not(:disabled)`)?.focus({preventScroll:true});
  if(dialog.open&&!view.unlocked)dialog.close();
  for(const field of form.querySelectorAll('input,select,textarea,button'))field.disabled=view.busy;
}
function openOrder(item=null,prefill={}) {
  const view=parcelBoardView();
  if(!view.unlocked){feedback('관리자 로그인 후 추가 버튼을 다시 눌러 주세요.');openDashboardLogin();return;}
  if(view.busy)return;
  editing=item?structuredClone(item):null;pending=null;form.reset();
  $('parcel-order-error').textContent='';$('parcel-order-title').textContent=item?'주문 수정':'장비·택배 추가';
  $('parcel-order-save').textContent=item?'변경 저장':'공용 목록에 추가';
  const values=item||{name:'',quantity:1,carrier_id:prefill.carrier_id||'',tracking_number:prefill.tracking_number||'',note:''};
  for(const field of ['name','quantity','carrier','number','note'])$('parcel-order-'+field).value=values[{carrier:'carrier_id',number:'tracking_number'}[field]||field]??'';
  dialog.showModal();$('parcel-order-name').focus();
}
async function saveOrder(event) {
  event.preventDefault();if(parcelBoardView().busy)return;
  $('parcel-order-error').textContent='';
  try{
    const input={name:$('parcel-order-name').value,quantity:$('parcel-order-quantity').value,carrier_id:$('parcel-order-carrier').value,tracking_number:$('parcel-order-number').value,note:$('parcel-order-note').value};
    const signature=JSON.stringify(input);
    if(pending?.signature!==signature){const at=new Date().toISOString();pending={signature,operation:editing?parcelEdit(editing,input,at):{type:'parcel_add',item:makeParcel(input,at),at}};}
    const operation=pending.operation,id=editing?.id||operation.item.id;
    await saveParcelRecord(operation);dialog.close();pending=null;
    feedback(editing?'주문을 수정했어요.':'연구실 공용 목록에 추가했어요.');
    filter=editing?.archived_at?'archived':editing?.received_at?'received':'active';renderBoard();
    const saved=parcelBoardView().items.find(item=>item.id===id);
    if(saved?.tracking_number&&!saved.received_at&&!saved.archived_at&&(!editing||key(saved)!==key(editing)))void queryItem(id);
  }catch(error){$('parcel-order-error').textContent=error.message;}
}
async function queryItem(id) {
  const item=parcelBoardView().items.find(item=>item.id===id);
  if(!item?.tracking_number||item.archived_at||requests.has(id))return;
  const query=trackingQuery(item.carrier_id,item.tracking_number),controller=new AbortController();
  const request={key:key(item),controller};requests.set(id,request);
  const previous=cache.get(id)?.key===request.key?cache.get(id):undefined;cache.set(id,{...previous,key:request.key,loading:true,error:''});renderBoard();
  try{
    const track=await fetchTrack(query,{signal:controller.signal});
    if(requests.get(id)!==request)return;
    cache.set(id,{key:request.key,track,checkedAt:Date.now(),loading:false,error:''});
  }catch(error){
    if(requests.get(id)!==request)return;
    if(error.code==='rate-limit')batchLimited=true;
    cache.set(id,{...previous,key:request.key,loading:false,error:error.message});
  }finally{if(requests.get(id)===request){requests.delete(id);renderBoard();}}
}
async function refreshAll() {
  if(batchRunning)return;
  const items=parcelBoardView().items.filter(item=>!item.archived_at&&!item.received_at&&item.tracking_number);
  if(!items.length)return;
  batchRunning=true;batchLimited=false;let index=0,finished=0;renderBoard();
  feedback(`${items.length}건의 배송 상태를 조회하고 있어요.`);
  const worker=async()=>{while(index<items.length&&!batchLimited){const item=items[index++];await queryItem(item.id);finished++;feedback(`${finished} / ${items.length}건 배송 조회 완료`);}};
  try{await Promise.all([worker(),worker()]);}
  finally{batchRunning=false;renderBoard();feedback(batchLimited?'조회 서비스의 요청 제한으로 일부 조회를 멈췄어요. 잠시 후 다시 조회해 주세요.':`${finished}건 조회가 끝났어요. 오류가 있는 주문은 카드의 안내를 확인해 주세요.`);}
}
async function recordAction(event) {
  const button=event.target.closest('[data-parcel-action]');if(!button)return;
  const item=parcelBoardView().items.find(item=>item.id===button.dataset.parcelId);if(!item)return;
  const action=button.dataset.parcelAction;
  if(action==='query'){await queryItem(item.id);return;}
  if(action==='edit'){openOrder(item);return;}
  if(action==='copy'){
    try{await navigator.clipboard.writeText(item.tracking_number);feedback('운송장 번호를 복사했어요.');}catch{feedback('복사하지 못했어요. 카드의 운송장 번호를 직접 복사해 주세요.');}return;
  }
  if(!['received','archive'].includes(action)||!parcelBoardView().unlocked||parcelBoardView().busy)return;
  try{
    const at=new Date().toISOString();
    const changes=action==='received'?{received_at:item.received_at?null:at}:{archived_at:item.archived_at?null:at};
    await saveParcelRecord(parcelEdit(item,changes,at));
    feedback(action==='received'?(item.received_at?'진행 중 목록으로 옮겼어요.':'수령 완료로 기록했어요.'):(item.archived_at?'주문을 목록으로 복원했어요.':'보관함으로 옮겼어요. 보관함에서 복원할 수 있어요.'));
  }catch(error){feedback(error.message);}
}
$('parcel-order-add').addEventListener('click',()=>openOrder());
$('parcel-register-current').addEventListener('click',()=>openOrder(null,{carrier_id:$('parcel-carrier').value,tracking_number:$('parcel-number').value}));
$('parcel-board-refresh').addEventListener('click',refreshAll);
$('parcel-board-sync').addEventListener('click',async()=>{try{await refreshDashboard();renderBoard();}catch{feedback('공용 목록을 불러오지 못했어요. 다시 시도해 주세요.');}});
for(const name of ['active','received','archived'])$('parcel-filter-'+name).addEventListener('click',()=>{filter=name;renderBoard();});
$('parcel-orders').addEventListener('click',recordAction);
$('parcel-orders').addEventListener('toggle',event=>{const id=event.target.dataset.parcelHistory;if(id){if(event.target.open)expanded.add(id);else expanded.delete(id);}},true);
form.addEventListener('submit',saveOrder);
for(const button of dialog.querySelectorAll('[data-close-parcel]'))button.addEventListener('click',()=>{if(!parcelBoardView().busy)dialog.close();});
dialog.addEventListener('cancel',event=>{if(parcelBoardView().busy)event.preventDefault();});
document.addEventListener('dashboard:render',renderBoard);
renderBoard();
