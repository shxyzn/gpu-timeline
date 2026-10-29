import {carriers,stages,trackingQuery,fetchTrack,deliveryTone} from './parcel-model.js?v=parcel-tone-2';

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=at=>at===null?'시간 미제공':new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(at)+' KST';
const form=$('parcel-form'),carrier=$('parcel-carrier'),number=$('parcel-number');
let request=null,sequence=0;
carrier.replaceChildren(new Option('택배사 선택',''),...carriers.map(item=>new Option(item.name,item.id)));

function busy(value) {
  $('parcel-result').setAttribute('aria-busy',String(value));
  $('parcel-submit').textContent=value?'조회 중…':'배송 조회';
}
function reset() {
  sequence++;request?.abort();request=null;busy(false);
  form.reset();carrier.removeAttribute('aria-invalid');number.removeAttribute('aria-invalid');
  $('parcel-feedback').textContent='';$('parcel-result').hidden=true;
  $('parcel-result-body').replaceChildren();$('parcel-query').textContent='';
  $('parcel-official').removeAttribute('href');$('parcel-empty').hidden=false;
  number.focus();
}
function render(track) {
  $('parcel-result-body').dataset.deliveryTone=deliveryTone(track.code);
  const latest=track.events[0];
  const steps=track.stage<0?'':`<ol class="parcel-stages" aria-label="배송 단계">${stages.map((stage,index)=>`<li class="${index<track.stage?'done':index===track.stage?'active':''}"${index===track.stage?' aria-current="step"':''}><span aria-hidden="true">${index<track.stage?'✓':index+1}</span>${esc(stage[1])}</li>`).join('')}</ol>`;
  $('parcel-result-body').innerHTML=`<div class="parcel-summary"><div><span class="parcel-eyebrow">현재 배송 상태</span><h3>${esc(track.status)}</h3>${latest?`<p>${esc(latest.location||'위치 미제공')}<small>마지막 이동 · ${esc(date(latest.at))}</small></p>`:'<p>상세 이동 내역은 아직 제공되지 않았어요.</p>'}</div><p class="parcel-checked">조회 ${esc(date(Date.now()))}<small>다시 조회하면 상태를 갱신해요.</small></p></div>${steps}<div class="parcel-history-heading"><h3>이동 내역</h3><span>최근 순 · ${track.events.length}건</span></div>${track.events.length?`<ol class="parcel-history">${track.events.map(event=>`<li><time${event.at===null?'':` datetime="${new Date(event.at).toISOString()}"`}>${esc(date(event.at))}</time><div><strong class="parcel-event-status ${deliveryTone(event.code)}">${esc(event.status)}</strong>${event.location?`<span class="parcel-location">${esc(event.location)}</span>`:''}${event.description?`<p>${esc(event.description)}</p>`:''}</div></li>`).join('')}</ol>`:'<p class="parcel-no-events">등록된 이동 내역이 없어요. 잠시 후 다시 확인해 주세요.</p>'}`;
}
async function lookup(event) {
  event.preventDefault();
  // Even an invalid new submission invalidates the previous in-flight request.
  const own=++sequence;request?.abort();request=null;busy(false);
  carrier.removeAttribute('aria-invalid');number.removeAttribute('aria-invalid');
  $('parcel-result').hidden=true;$('parcel-result-body').replaceChildren();$('parcel-empty').hidden=true;
  let query;
  try {query=trackingQuery(carrier.value,number.value);}catch(error){
    const field=carrier.value?number:carrier;
    field.setAttribute('aria-invalid','true');field.focus();
    $('parcel-feedback').textContent=error.message;return;
  }
  number.value=query.number;
  $('parcel-query').textContent=query.carrier.name+' · '+query.number;
  $('parcel-official').href=query.official;
  $('parcel-official-note').textContent=query.carrier.parameter?'택배사 공식 사이트에서 열려요.':'공식 조회 화면에서 운송장 번호를 다시 입력해 주세요.';
  $('parcel-result').hidden=false;$('parcel-feedback').textContent='배송 정보를 조회하고 있어요.';
  request=new AbortController();busy(true);
  try {
    const track=await fetchTrack(query,{signal:request.signal});
    if(own!==sequence)return;
    render(track);$('parcel-feedback').textContent=query.carrier.name+' · '+track.status;
  } catch(error) {
    if(own!==sequence)return;
    $('parcel-feedback').textContent=error.message;
    $('parcel-result-body').innerHTML='<div class="parcel-unavailable"><h3>배송 정보를 가져오지 못했어요</h3><p>번호를 확인하고 다시 조회하거나 아래의 공식 조회를 이용해 주세요.</p></div>';
  } finally {if(own===sequence){request=null;busy(false);}}
}
form.addEventListener('submit',lookup);
$('parcel-clear').addEventListener('click',reset);
$('parcel-copy').addEventListener('click',async()=>{
  const value=$('parcel-query').textContent.split(' · ')[1];
  if(!value)return;
  try {await navigator.clipboard.writeText(value);$('parcel-feedback').textContent='운송장 번호를 복사했어요.';}
  catch {$('parcel-feedback').textContent='복사하지 못했어요. 운송장 입력칸에서 번호를 직접 복사해 주세요.';number.focus();number.select();}
});
