import {dashboardView} from '../app.js?patch=snapshot3-1';
import {isUnavailable,repairState} from './availability-model.js?v=2.1-as';
import {repairPanel,escapeAvailability as esc} from './availability-ui.js?v=2.1-as';

const $=id=>document.getElementById(id);
const setText=(element,value)=>{if(element&&element.textContent!==value)element.textContent=value;};
const stamp=value=>value&&Number.isFinite(new Date(value).getTime())?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'medium',timeStyle:'short',hourCycle:'h23'}).format(new Date(value))+' KST':'미등록';
const historyDialog=document.createElement('dialog');
historyDialog.id='as-history-dialog';historyDialog.className='as-history-dialog';historyDialog.setAttribute('aria-labelledby','as-history-title');
document.body.append(historyDialog);
function openHistory(id){
  const server=dashboardView().servers.find(s=>s.server_id===id);if(!server||!isUnavailable(id))return;
  const labels={running:'수집 당시 실행 중',unknown:'수집 당시 상태 미확인',planned:'등록된 예정',completed:'완료 기록',failed:'실패 기록',cancelled:'취소 기록'};
  historyDialog.innerHTML=`<div class="dialog-heading"><span class="as-eyebrow">A/S 중 · 보관된 기록</span><button type="button" data-as-close aria-label="이전 실험 닫기">×</button></div><h2 id="as-history-title">${esc(server.name)} · 이전 실험</h2><p class="as-history-intro">장비 수리로 현재 실행 상태와 종료 예정은 확인할 수 없어요. 마지막으로 수집한 기록을 보관하고 있습니다.</p><p class="as-history-stamp">마지막 수신 ${esc(stamp(server.updated_at))}</p><div class="as-history-list">${server.jobs.map(job=>`<article><span class="as-history-status">${esc(labels[job.status]||'보관된 기록')}</span><h3>${esc(job.name||job.id)}</h3><code>${esc(server.server_id+'/'+job.id)}</code>${job.owner?`<p>담당 ${esc(job.owner)}</p>`:''}${job.description?`<p>${esc(job.description)}</p>`:''}<dl><dt>등록된 시작</dt><dd>${esc(stamp(job.started_at))}</dd><dt>실제 종료 기록</dt><dd>${esc(stamp(job.ended_at))}</dd></dl></article>`).join('')||'<p>보관된 실험 기록이 없습니다.</p>'}</div>`;
  historyDialog.showModal();
}
function decorateServers(view){
  document.querySelectorAll('#servers .server-card').forEach((card,index)=>{
    const server=view.servers[index];if(!server||!isUnavailable(server.server_id))return;
    card.dataset.asServer=server.server_id;card.classList.add('as-server-card');
    const state=card.querySelector('.server-heading .state');
    if(state){state.className='state as-state';setText(state,'A/S 중');}
    const meta=card.querySelector('.server-meta');
    setText(meta,([...new Set(server.gpus.map(g=>g.name))].join(' / ')||'GPU 정보 보관 중')+' · '+(server.gpus.length||repairState(server.server_id).gpuCount)+' GPU');
    if(!card.querySelector('.as-server-body')){
      const body=document.createElement('div');body.className='as-server-body';
      const underlay=document.createElement('div');underlay.className='as-server-underlay';underlay.inert=true;underlay.setAttribute('aria-hidden','true');
      for(const child of [...card.children])if(!child.matches('.server-heading,.server-meta'))underlay.append(child);
      // No stale percentages, progress, or ETA remain legible under the mask.
      underlay.querySelectorAll('.meter-line span:last-child,.gpu-experiment span:last-child').forEach(e=>e.textContent='—');
      underlay.querySelectorAll('.meter-fill').forEach(e=>e.style.width='0');
      body.append(underlay);body.insertAdjacentHTML('beforeend',repairPanel(server.server_id));card.append(body);
    }
  });
}
function decorateTimeline(view){
  document.querySelectorAll('#timeline .lane').forEach(lane=>{
    const name=lane.querySelector('.gpu-label strong')?.textContent;
    const server=view.servers.find(s=>s.name===name);if(!server||!isUnavailable(server.server_id)||lane.classList.contains('as-lane'))return;
    lane.classList.add('as-lane');
    lane.querySelector('.gpu-label')?.insertAdjacentHTML('beforeend','<span class="as-tag">A/S 중</span>');
    const track=lane.querySelector('.track');if(!track)return;
    const preserved=document.createElement('div');preserved.className='as-track-underlay';preserved.inert=true;preserved.setAttribute('aria-hidden','true');
    while(track.firstChild)preserved.append(track.firstChild);
    track.append(preserved);track.insertAdjacentHTML('beforeend',repairPanel(server.server_id,{compact:true}));
  });
}
let preferredServerChosen=false;
function decorateStats(view){
  const select=$('resource-server');if(!select)return;
  for(const option of select.options){const server=view.servers.find(s=>s.server_id===option.value);if(server&&isUnavailable(server.server_id))setText(option,server.name+' · A/S 중');}
  if(!preferredServerChosen&&select.options.length){
    preferredServerChosen=true;
    if(isUnavailable(select.value)){
      const next=[...select.options].find(o=>!isUnavailable(o.value));
      if(next){select.value=next.value;select.dispatchEvent(new Event('change',{bubbles:true}));}
    }
  }
  const resourceAS=isUnavailable(select.value);
  if(resourceAS){$('resource-state').className='resource-badge as-state';setText($('resource-state'),'A/S 중 · 과거 기록');}
  setStatsMask('resource',resourceAS,select.value,'수리 전 통계 보기');
  document.querySelectorAll('#bottleneck-servers [data-resource-server]').forEach(button=>{
    if(!isUnavailable(button.dataset.resourceServer))return;
    button.classList.add('as-server-choice');setText(button.querySelector('strong'),'A/S 중');setText(button.querySelector('small'),'현재 분석 보류 · 기존 기록 유지');
  });
  const selected=document.querySelector('#bottleneck-servers [aria-pressed=true]')?.dataset.resourceServer;
  setStatsMask('analysis',isUnavailable(selected),selected,'수리 전 분석 보기');
}
function setStatsMask(kind,unavailable,id,label){
  const body=$('as-'+kind+'-body'),content=$('as-'+kind+'-content');if(!body||!content)return;
  if(body.dataset.server!==id){body.classList.remove('as-history-revealed');body.dataset.server=id||'';}
  body.classList.toggle('as-stats-masked',unavailable);
  content.inert=unavailable&&!body.classList.contains('as-history-revealed');
  if(content.inert)content.setAttribute('aria-hidden','true');else content.removeAttribute('aria-hidden');
  let cover=body.querySelector(':scope > .as-cover');
  if(!unavailable){cover?.remove();body.querySelector(':scope > .as-past-note')?.remove();return;}
  if(!cover){body.insertAdjacentHTML('beforeend',repairPanel(id,{history:false}));cover=body.querySelector(':scope > .as-cover');cover.querySelector('.as-panel').insertAdjacentHTML('beforeend',`<button type="button" class="as-history-button" data-as-stats="${kind}">${label}</button>`);}
  if(!body.querySelector(':scope > .as-past-note'))body.insertAdjacentHTML('afterbegin','<p class="as-past-note">A/S 중 · 아래는 수리 전 수집 기록입니다. 현재 자원 상태와 병목을 나타내지 않습니다.</p>');
}
function decorateHistory(){
  const detail=$('job-detail'),ref=$('experiment-reference-value')?.textContent;
  if(detail&&isUnavailable(ref?.split('/')[0])&&!detail.querySelector('.as-detail-note')){
    detail.insertAdjacentHTML('afterbegin','<p class="as-detail-note">A/S 중 · 보관된 실험 기록입니다. 현재 실행 상태와 종료 예정은 확인할 수 없어요.</p>');
    for(const term of detail.querySelectorAll('dt')){
      if(term.textContent==='상태')term.textContent='수집 당시 상태';
      if(['사용 시간','완료 예정','예정 산정'].includes(term.textContent))term.nextElementSibling.textContent='A/S 중 · 현재 확인 불가';
    }
  }
  for(const row of document.querySelectorAll('#record-items .record-item')){
    const id=row.querySelector('[data-reference]')?.dataset.reference?.split('/')[0];
    if(isUnavailable(id)&&!row.querySelector('.as-tag')){row.classList.add('as-record');row.querySelector('div')?.insertAdjacentHTML('afterbegin','<span class="as-tag">A/S 중 · 기존 기록</span>');}
  }
}
function decorateManual(){
  if(!$('manual-dialog')?.open)return;
  const select=$('manual-server'),editing=$('manual-title').textContent==='실험 수정';
  for(const option of select.options){
    if(!isUnavailable(option.value))continue;
    const server=dashboardView().servers.find(s=>s.server_id===option.value);
    setText(option,(server?.name||option.value)+' · A/S 중');option.disabled=!editing;
  }
  if(!editing&&isUnavailable(select.value)){
    const next=[...select.options].find(o=>!o.disabled);
    if(next){select.value=next.value;select.dispatchEvent(new Event('change',{bubbles:true}));}
  }
}
function decorate(){const view=dashboardView();decorateServers(view);decorateTimeline(view);decorateStats(view);decorateHistory();decorateManual();}
let queued=false;
function queue(){if(!queued){queued=true;requestAnimationFrame(()=>{queued=false;decorate();});}}
const observer=new MutationObserver(queue);
for(const id of ['servers','timeline','resource-server','resource-state','resource-meta','resource-grid','resource-storage','resource-cores','bottleneck-servers','bottleneck-detail','job-detail','record-items','manual-dialog']){
  const element=$(id);if(element)observer.observe(element,{childList:true,subtree:true,attributes:id==='manual-dialog',attributeFilter:id==='manual-dialog'?['open']:undefined});
}
document.addEventListener('dashboard:render',queue);
document.addEventListener('change',event=>{if(['resource-server','manual-server','resource-period'].includes(event.target.id))queue();});
document.addEventListener('click',event=>{
  const history=event.target.closest('[data-as-history]');if(history)openHistory(history.dataset.asHistory);
  if(event.target.closest('[data-as-close]'))historyDialog.close();
  const stats=event.target.closest('[data-as-stats]');if(stats){$('as-'+stats.dataset.asStats+'-body').classList.add('as-history-revealed');queue();}
  if(event.target.closest('[data-resource-server],#manual-add,[data-edit-experiment]'))queue();
});
$('manual-form')?.addEventListener('submit',event=>{
  if($('manual-title').textContent!=='실험 수정'&&isUnavailable($('manual-server').value)){
    event.preventDefault();event.stopImmediatePropagation();$('manual-error').textContent='A/S 중인 서버에는 새 실험을 등록할 수 없어요.';
  }
},true);
queue();
