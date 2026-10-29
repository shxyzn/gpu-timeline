import {dashboardView,openExperiment,refreshDashboard} from '../app.js?v=parcel-board-1';
import {currentView,progressValue,experimentPresentation,humanDuration,gpuReadings} from './current-model.js?v=test-server-2';
import {health,jobETA,timestamp,apiSlot} from '../model.js';
import {budgetUsage,dollars,usageStatus} from '../openrouter-model.js?v=1.1.8';
import './parcel.js?v=parcel-tone-2';
import './parcel-board.js?v=parcel-tone-2';

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock=value=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(value);
const day=value=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(value);
const date=(value,now=Date.now())=>day(value)===day(now)?'오늘 '+clock(value):new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',weekday:'short'}).format(value)+' '+clock(value);
const age=value=>{const at=timestamp(value);if(at===null)return '수신 없음';const minutes=Math.max(0,Math.floor((Date.now()-at)/60000));return minutes<1?'방금':minutes<60?minutes+'분 전':Math.floor(minutes/60)+'시간 '+minutes%60+'분 전';};
const duration=humanDuration;
const badge=(label,state)=>`<span class="current-state ${state}">${esc(label)}</span>`;
let currentResource='gpu';
function jobButton(server,job,prefix='') {
  const display=experimentPresentation(job);
  return `<div class="current-job-copy"><button type="button" class="current-job" title="${esc(display.original)}" aria-label="${esc(display.original)} 상세 보기" data-server="${esc(server.server_id)}" data-job="${esc(job.id)}">${esc(prefix+display.title)}</button>${display.meta.length?`<small class="current-job-meta">${esc(display.meta.join(' · '))}</small>`:''}</div>`;
}
function progress(job,healthy) {
  const pct=progressValue(job);
  if(pct===null)return '<span class="current-muted">미등록</span>';
  const label=(healthy?'':'마지막 ')+pct.toLocaleString('ko-KR',{maximumFractionDigits:1})+'%';
  return `<div class="current-progress"><strong>${esc(label)}</strong>${healthy?`<div class="current-meter" role="progressbar" aria-label="${esc(job.name)} 진행률" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`:''}</div>`;
}
function eta(job,server,healthy,now) {
  if(!healthy||job.status==='unknown')return '<span class="current-muted">실행 확인 필요</span>';
  const result=jobETA(job,server.updated_at);
  if(result.at===null)return '<span class="current-muted">종료 미정</span>';
  const overdue=result.at<now;
  return `<strong>${esc(date(result.at,now))}</strong><small class="${overdue?'current-warning':''}">${overdue?'예정 '+duration(now-result.at)+' 초과':duration(result.at-now)+' 후'+(result.source==='progress'?' · 추정':'')}</small>`;
}
function gpuUsage(gpu,healthy) {
  const {utilization,used,total}=gpuReadings(gpu);
  return `${!healthy?'<small class="current-last-reading">마지막 수신</small>':''}<div class="current-usage-line"><span>GPU</span><strong class="current-gpu-percent">${utilization===null?'—':utilization+'%'}</strong></div>${healthy&&utilization!==null?`<div class="current-meter current-utilization" role="progressbar" aria-label="GPU ${gpu.index} 사용률" aria-valuenow="${utilization}" aria-valuemin="0" aria-valuemax="100"><span style="width:${utilization}%"></span></div>`:''}<div class="current-usage-line current-vram"><span>VRAM</span><strong>${used===null?'—':used.toFixed(1)} / ${total===null?'—':total.toFixed(1)} <small>GiB</small></strong></div>`;
}
function gpuTable(rows,now) {
  if(!rows.length)return '<div class="current-empty">GPU 목록 수신 대기 · 서버 탭에서 연결 상태를 확인하세요.</div>';
  const groups=new Map();for(const row of rows){const id=row.server.server_id;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(row);}
  return `<table class="current-gpu-table"><thead><tr><th scope="col">서버</th><th scope="col">GPU</th><th scope="col">상태</th><th scope="col">실험 / 담당자</th><th scope="col">진행률</th><th scope="col">GPU 사용률 · VRAM</th><th scope="col">종료 예정</th></tr></thead>${[...groups.values()].map(group=>{
    const server=group[0].server;
    const modelNames=[...new Set(group.map(row=>row.gpu.name||'기종 미등록'))];
    const models=modelNames.join(' / '),sameModel=modelNames.length===1;
    const shortModels=models.replace(/NVIDIA\s+(?:GeForce\s+)?/gi,'');
    const groupModel=sameModel?shortModels:`${group.length} GPU · ${modelNames.length}기종`;
    return `<tbody aria-label="${esc(server.name)}" data-server-label="${esc(server.name+' · '+groupModel)}">${group.map((row,index)=>{
    const {server,gpu,state,healthy,jobs,next}=row;
    const labels={idle:['여유','idle'],busy:['점유 중','busy'],unknown:['확인 필요','warning']};
    const label=labels[state];
    const entries=jobs.length?jobs.map(job=>`<div class="current-job-entry">${jobButton(server,job)}${job.status==='unknown'||!healthy?`<small class="current-observation">${job.status==='unknown'?'실행 상태 확인 필요':'마지막 관측: 실행 중'}</small>`:''}</div>`).join(''):
      state==='busy'?'<span>GPU 점유 감지</span><small>등록된 실행 실험 없음</small>':next?jobButton(server,next,'예정 · ')+`<small>시작 ${timestamp(next.started_at)!==null?esc(date(timestamp(next.started_at),now)):'미등록'}</small>`:
      `<span class="current-muted">${state==='unknown'?'새 상태 확인 필요':'등록된 실행 실험 없음'}</span>`;
    return `<tr data-current-server="${esc(server.server_id)}" data-gpu-state="${state}">${index===0?`<th scope="rowgroup" rowspan="${group.length}" class="current-server-label"><strong>${esc(server.name)}</strong><small title="${esc(models)}">${esc(groupModel)}</small></th>`:''}<td class="current-resource"><strong>GPU ${gpu.index}</strong>${sameModel?'':`<small>${esc((gpu.name||'기종 미등록').replace(/NVIDIA\s+(?:GeForce\s+)?/gi,''))}</small>`}</td><td class="current-status">${badge(...label)}</td><td class="current-experiments">${entries}</td><td class="current-progress-cell" data-label="진행">${jobs.length?jobs.map(j=>progress(j,healthy&&j.status==='running')).join(''):'<span class="current-muted">—</span>'}</td><td class="current-memory" data-label="GPU · VRAM">${gpuUsage(gpu,healthy)}</td><td class="current-eta" data-label="종료 예정">${jobs.length?jobs.map(j=>`<div>${eta(j,server,healthy,now)}</div>`).join(''):'<span class="current-muted">—</span>'}</td></tr>`;
    }).join('')}</tbody>`;
  }).join('')}</table>`;
}
function apiList(rows,now) {
  return rows.map(({server,job,healthy})=>`<article class="current-api-row"><div>${jobButton(server,job)}</div><div>${badge(!healthy||job.status==='unknown'?'확인 필요':'실행 중',!healthy||job.status==='unknown'?'warning':'busy')}<small>${esc(server.name)} · API ${apiSlot(job)}</small></div><div>${progress(job,healthy&&job.status==='running')}${job.progress?`<small>${esc(job.progress.completed)} / ${esc(job.progress.total)}</small>`:''}</div><div class="current-eta"><span class="current-api-eta-label">종료 예정</span>${eta(job,server,healthy,now)}</div></article>`).join('')||'<div class="current-empty">현재 등록된 API 실험이 없습니다.</div>';
}
function renderCurrent() {
  const view=dashboardView();document.title='test-server · '+(view.config?.title||'CVML GPU Timeline');
  if(!view.config||!['demo','live'].includes(view.config.mode)||(view.config.mode==='live'&&!Array.isArray(view.config.servers))){$('priority-alerts').textContent=$('notice').textContent||'설정과 서버 연결을 확인해 주세요.';return;}
  const now=Date.now(),stale=view.config.stale_after_seconds||1200;
  const current=currentView(view.servers,view.telemetryServers,now,stale);
  const alerts=current.alerts.map(({server,label})=>`<div class="priority-alert"><div><strong>${esc(server.name)} · ${esc(label)}</strong><span>마지막 수신 ${esc(age(server.updated_at))} · 현재 GPU 상태 확인 필요</span></div><button type="button" data-server-details="${esc(server.server_id)}">상태 보기</button></div>`);
  const overdue=view.servers.flatMap(s=>health(s,now,stale).ok?s.jobs.filter(j=>j.status==='running'&&jobETA(j,s.updated_at).at!==null&&jobETA(j,s.updated_at).at<now):[]).length;
  if(overdue)alerts.push(`<div class="priority-alert"><span><strong>종료 확인 필요 · ${overdue}개 실험</strong> 종료 예정이 지났습니다. 상세에서 실제 상태를 확인하세요.</span></div>`);
  if(view.config.mode==='demo')alerts.unshift('<div class="priority-alert neutral">예시 데이터 모드입니다.</div>');
  $('priority-alerts').innerHTML=alerts.join('');$('priority-alerts').hidden=!alerts.length;
  $('priority-overview').innerHTML=[['현재 여유',current.idle,`/ ${current.total} GPU`,'gpu'],['점유',current.busy,'GPU','gpu'],['확인 필요',current.unknown,'GPU','gpu'],['API 실행',current.apiRunning,`실험${current.apiUncertain?' · 확인 필요 '+current.apiUncertain:''}`,'api']].map(([label,count,unit,resource])=>`<button type="button" data-resource-view="${resource}" aria-label="${label} ${count} · ${resource==='api'?'API':'GPU'} 목록 보기"><span>${label}</span><strong>${count} <small>${unit}</small></strong></button>`).join('');
  $('current-updated').textContent='화면 조회 '+(view.lastFetch?clock(view.lastFetch):'—')+' KST';
  $('current-gpus').innerHTML=gpuTable(current.gpuRows,now);
  $('current-api').innerHTML=apiList(current.apiRows,now);
  $('current-gpu-count').textContent=current.total;
  $('current-api-total').textContent=current.apiRows.length;
  $('current-api-count').textContent=`실행 ${current.apiRunning}개${current.apiUncertain?' · 확인 필요 '+current.apiUncertain+'개':''}`;
  $('current-budgets').innerHTML=view.tokens.map(token=>{
    const budget=budgetUsage(token.usage),old=usageStatus(token)!=='조회 완료';
    const amount=['limited','zero'].includes(budget.state)?`남은 한도 ${dollars(budget.remaining)} · ${budget.remainingPercent.toLocaleString('ko-KR',{maximumFractionDigits:1})}%`:budget.state==='unlimited'?'한도 미설정':'남은 한도 확인 불가';
    return `<button type="button" class="current-budget" data-go-panel="resources">${esc(token.name)} <strong>${esc(amount)}</strong><small>${old?'마지막 조회값 · ':''}조회 ${esc(age(token.checked_at))}</small></button>`;
  }).join('');
  setResourceView(currentResource);
}
function setResourceView(resource) {
  if(!['gpu','api'].includes(resource))return;
  currentResource=resource;
  for(const kind of ['gpu','api']){
    $('current-'+kind+'-tab').setAttribute('aria-selected',String(kind===resource));
    $('current-'+kind+'-panel').hidden=kind!==resource;
  }
  $('current-list-title').textContent=resource==='gpu'?'GPU 현황':'API 실험';
}
function setPanel(name) {
  const tab=document.querySelector(`[data-panel="${name}"]`);if(!tab)return;
  document.querySelectorAll('[data-panel]').forEach(button=>{const on=button===tab;button.setAttribute('aria-selected',String(on));$(button.getAttribute('aria-controls')).hidden=!on;});
  if(name!=='more')document.querySelector('#release-video video')?.pause();
  if(location.hash!==`#${name}`)history.replaceState(null,'',`#${name}`);
}
document.querySelectorAll('[data-panel]').forEach(button=>button.addEventListener('click',()=>setPanel(button.dataset.panel)));
document.addEventListener('click',event=>{
  const resource=event.target.closest('[data-resource-view]');if(resource){setResourceView(resource.dataset.resourceView);return;}
  const job=event.target.closest('#panel-now [data-job]');if(job){openExperiment(job.dataset.server,job.dataset.job);return;}
  const link=event.target.closest('[data-go-panel]');if(link){setPanel(link.dataset.goPanel);return;}
  const server=event.target.closest('[data-server-details]');if(server){setPanel('servers');const index=dashboardView().servers.findIndex(s=>s.server_id===server.dataset.serverDetails);document.querySelectorAll('#servers .server-card')[index]?.scrollIntoView({block:'start'});}
});
$('current-refresh').onclick=async()=>{if($('refresh').disabled)return;$('current-refresh').disabled=true;try{await refreshDashboard();}finally{$('current-refresh').disabled=false;}};
document.addEventListener('dashboard:render',renderCurrent);
window.addEventListener('hashchange',()=>setPanel(location.hash==='#release-video'?'more':location.hash.slice(1)));
document.querySelectorAll('a[href="#release-video"]').forEach(link=>link.addEventListener('click',()=>setPanel('more')));
setPanel(location.hash==='#release-video'?'more':location.hash.slice(1)||'now');
renderCurrent();
