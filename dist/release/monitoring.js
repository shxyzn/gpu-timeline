import {dashboardView,monitoringAccess,openDashboardLogin,saveMonitoringConfig} from '../app.js?patch=zero-balance-v211';
import {CHECKS,DAYS,monitoringID,defaultConfig,emptyMonitoring,makeSchedule,validateConfig,validateSchedule,scheduleLabel,nextRun} from './monitoring-model.js?v=2.1';
import {MonitoringStore} from './monitoring-store.js?v=2.1';
import {isUnavailable} from './availability-model.js?v=2.1-as';
import {health} from '../model.js';

const $=id=>document.getElementById(id);
const reportFor=s=>s?.monitoring?.profile==='production'?s.monitoring:null;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=t=>t&&Number.isFinite(new Date(t).getTime())?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(t))+' KST':'아직 없음';
const checkName=id=>CHECKS.find(c=>c.id===id)?.name||id;
let data=emptyMonitoring(),store=null,loading=false,loadError='',loaded=false,serverID=null,draft=null,baseRevision=0,editingSchedule=null,saving=false,pending=null;
const dialog=document.createElement('dialog');dialog.id='monitor-dialog';dialog.className='monitor-dialog';dialog.setAttribute('aria-labelledby','monitor-title');
dialog.innerHTML=`<div class="monitor-dialog-header"><div><span class="monitor-eyebrow">SERVER MONITORING · v2.1</span><h2 id="monitor-title">모니터링 설정</h2><p id="monitor-server-meta"></p></div><button type="button" id="monitor-close" aria-label="모니터링 설정 닫기">×</button></div>
<form id="monitor-config-form"><div class="monitor-dialog-content">
  <div id="monitor-connection" class="monitor-connection" role="status"></div>
  <div id="monitor-auth" class="monitor-auth"></div>
  <div class="monitor-section-heading"><h3>서버 모니터링</h3><label class="monitor-enable"><input id="monitor-enabled" type="checkbox"> 사용</label></div>
  <p class="monitor-help">서버별로 점검 일정을 만들고 항목을 골라 주세요. 모든 일정은 한국시간(KST) 기준입니다.</p>
  <div class="monitor-setting-grid"><label class="monitor-field">정상 GPU 개수<input id="monitor-gpu-count" type="number" min="1" max="32" required></label><label class="monitor-field">응답 제한 · 초<input id="monitor-timeout" type="number" min="5" max="60" required></label><label class="monitor-field">GPU 경고 온도 · °C<input id="monitor-temperature" type="number" min="50" max="110" required></label></div>
  <section class="monitor-schedules" aria-labelledby="monitor-schedules-title"><div class="monitor-section-heading"><div><h3 id="monitor-schedules-title">점검 일정 <span id="monitor-schedule-count">0</span></h3><p>일정마다 검사 항목과 시간을 다르게 지정할 수 있어요.</p></div><button type="button" id="monitor-add" class="monitor-secondary">＋ 일정 추가</button></div><div id="monitor-schedule-list"></div></section>
  <fieldset id="monitor-editor" class="monitor-editor" hidden><legend id="monitor-editor-title">점검 일정 추가</legend>
    <div class="monitor-editor-grid"><label class="monitor-field">일정 이름<input id="monitor-schedule-name" maxlength="60" required placeholder="예: GPU 인식 확인"></label><label class="monitor-field">점검 방식<select id="monitor-kind"><option value="interval">일반 점검 · 간격 반복</option><option value="daily">정밀 점검 · 하루 지정 시각</option></select></label></div>
    <div id="monitor-interval-fields"><div class="monitor-editor-grid"><label class="monitor-field">점검 간격 · 분<input id="monitor-interval" type="number" min="5" max="1440" step="1" value="30"></label><label class="monitor-enable monitor-all-day"><input id="monitor-all-day" type="checkbox" checked> 24시간 점검</label></div><div id="monitor-window-fields" class="monitor-editor-grid"><label class="monitor-field">운영 시작<input id="monitor-window-start" type="time" value="09:00"></label><label class="monitor-field">운영 종료<input id="monitor-window-end" type="time" value="18:00"></label></div><p class="monitor-help">종료가 시작보다 이르면 다음 날까지 점검해요. 선택한 요일은 운영 시작일 기준입니다.</p></div>
    <div id="monitor-daily-fields" hidden><div class="monitor-editor-grid"><label class="monitor-field">하루 점검 횟수<select id="monitor-daily-count"><option value="1">하루 1회</option><option value="2">하루 2회</option></select></label><div class="monitor-help">상태와 로그를 조회하는 읽기 전용 점검입니다.</div></div><div class="monitor-editor-grid"><label class="monitor-field">첫 번째 시각<input id="monitor-time-one" type="time" value="09:00"></label><label id="monitor-time-two-label" class="monitor-field">두 번째 시각<input id="monitor-time-two" type="time" value="21:00"></label></div></div>
    <div class="monitor-field"><span>점검 요일</span><div class="monitor-days">${DAYS.map((day,i)=>`<label><input type="checkbox" name="monitor-day" value="${i}" checked><span>${day}</span></label>`).join('')}</div></div>
    <div class="monitor-section-heading monitor-check-heading"><div><h4>점검 항목 선택</h4><p id="monitor-check-count">0개 선택</p></div><div><button type="button" id="monitor-check-all" class="monitor-text-button">전체 선택</button><button type="button" id="monitor-check-none" class="monitor-text-button">모두 해제</button></div></div>
    <div id="monitor-checks"></div><p id="monitor-schedule-error" class="monitor-error" role="alert"></p>
    <div class="monitor-editor-actions"><button type="button" id="monitor-editor-cancel" class="monitor-secondary">취소</button><button type="button" id="monitor-editor-add" class="monitor-primary">일정에 추가</button></div>
  </fieldset>
  <section class="monitor-results" aria-labelledby="monitor-results-title"><h3 id="monitor-results-title">최근 점검 결과</h3><div id="monitor-results"></div></section>
  <details class="monitor-connect-help"><summary>서버 연결 안내</summary><p>서버 관리자가 모니터링 수집기를 연결하면 저장한 일정이 적용돼요. 아직 연결하지 않은 서버는 적용 대기로 표시됩니다.</p><a href="https://github.com/shxyzn/gpu-timeline/blob/main/MONITORING.md" target="_blank" rel="noopener noreferrer">설치·연결 안내 ↗</a></details>
  <p id="monitor-config-error" class="monitor-error" role="alert"></p><p id="monitor-feedback" class="monitor-feedback" role="status"></p>
</div><div class="monitor-dialog-footer"><button type="button" id="monitor-reload" class="monitor-secondary">설정 다시 불러오기</button><button type="submit" id="monitor-save" class="monitor-primary">서버 설정 저장</button></div></form>`;
document.body.append(dialog);
$('monitor-checks').innerHTML=[...new Set(CHECKS.map(c=>c.group))].map(group=>`<fieldset class="monitor-check-group"><legend>${group}</legend><div class="monitor-check-grid">${CHECKS.filter(c=>c.group===group).map(c=>`<label class="monitor-check"><input type="checkbox" name="monitor-check" value="${c.id}"><span><strong>${c.name}${c.deep?'<small>정밀</small>':''}</strong><span>${c.detail}</span></span></label>`).join('')}</div></fieldset>`).join('');

function server(){return dashboardView().telemetryServers.find(s=>s.server_id===serverID)||dashboardView().servers.find(s=>s.server_id===serverID);}
function savedConfig(id){return data.servers.find(c=>c.server_id===id);}
function state(s,c){
  const m=reportFor(s),ok=s&&health(s,Date.now(),dashboardView().config?.stale_after_seconds||1200).ok;
  if(!loaded)return {label:loading?'설정 불러오는 중':'설정 확인 필요',tone:'muted'};
  if(!c)return {label:'일정 미설정',tone:'muted'};
  if(!ok)return {label:'서버 수신 지연 · 적용 확인 필요',tone:'warning'};
  if(!m||m.profile!=='production')return {label:'적용 대기 · 수집기 연결 필요',tone:'warning'};
  if(m.config_error)return {label:'서버 설정 확인 필요',tone:'warning'};
  if(m.applied_revision!==c.revision)return {label:'서버 적용 대기',tone:'warning'};
  if(!c.enabled)return {label:'모니터링 중지됨',tone:'muted'};
  return {label:'서버 적용 완료',tone:'success'};
}
function renderCards(){
  const view=dashboardView();if(!view.config)return;
  if(!store&&view.config.dashboard){store=new MonitoringStore(view.config.dashboard);void refreshPublic();}
  const note=document.querySelector('.priority-header p');if(note)note.textContent='v2.1.2 · 연구실의 모든 흐름을, 한눈에.';
  if(view.build&&$('dashboard-version'))$('dashboard-version').textContent='대시보드 v2.1.2'+(/^[a-f0-9]{40}$/.test(view.build.revision||'')?'+'+view.build.revision.slice(0,7):'');
  if(!$('monitor-release')){
    const intro=document.createElement('div');intro.id='monitor-release';intro.className='monitor-release';
    intro.innerHTML='<div class="monitor-release-copy"><span>새로운 기능 · v2.1</span><h2>서버 상태 모니터링 업데이트</h2><p>서버마다 다르게. 필요한 항목만. 원하는 시각에.<br>일반 점검과 하루 1~2회의 정밀 점검을 직접 구성하세요.</p></div><div class="monitor-release-number" aria-hidden="true">2.1</div>';
    $('panel-servers').prepend(intro);
  }
  document.querySelectorAll('#servers .server-card').forEach((card,index)=>{
    const s=view.servers[index];if(!s)return;const c=savedConfig(s.server_id),st=state(s,c);
    card.querySelector('.monitor-card')?.remove();
    if(isUnavailable(s.server_id))return;
    const box=document.createElement('div');box.className='monitor-card';
    const run=reportFor(s)?.last_run;
    box.innerHTML=`<div class="monitor-card-top"><strong>상태 모니터링</strong><span class="monitor-badge ${st.tone}">${esc(st.label)}</span></div><p>${c?`${c.schedules.filter(x=>x.enabled).length}개 활성 일정 · 설정 v${c.revision}`:'일반·정밀 점검 일정을 추가해 주세요.'}</p>${run?`<p>마지막 점검 ${esc(stamp(run.finished_at))} · ${esc(resultLabel(run.status))}</p>`:''}<button type="button" class="monitor-settings-button" data-monitor-server="${esc(s.server_id)}">모니터링 설정</button>`;
    card.append(box);
  });
  if(dialog.open){updateConnection();updateAuth();}
}
async function refreshPublic(){
  if(!store||loading)return;loading=true;renderCards();
  try{const next=await store.readPublic();if(next.revision>=data.revision)data=next;loaded=true;loadError='';}
  catch(error){loadError=error.message;}
  finally{loading=false;renderCards();}
}
function resultLabel(status){return ({ok:'정상',warning:'확인 필요',error:'점검 실패',unsupported:'지원·권한 확인',running:'점검 중'})[status]||'상태 확인 필요';}
function updateConnection(){
  const s=server(),c=savedConfig(serverID),st=state(s,c),m=reportFor(s);
  $('monitor-connection').className='monitor-connection '+st.tone;
  $('monitor-connection').innerHTML=`<strong>${esc(st.label)}</strong><p>${c?`공용 설정 v${c.revision} · 저장 ${esc(stamp(c.updated_at))}`:'아직 저장된 일정이 없습니다.'}${m?.applied_at?`<br>서버 적용 ${esc(stamp(m.applied_at))}`:''}${m?.config_error?'<br>서버가 최신 설정을 확인하지 못했어요. 마지막 적용 설정으로 동작할 수 있습니다.':''}</p>`;
  const runs=Array.isArray(m?.history)?m.history.filter(r=>r&&typeof r==='object').slice(-5).reverse():[];
  $('monitor-results').innerHTML=runs.length?runs.map(run=>`<details class="monitor-result"><summary><span>${esc(run.name||run.schedule_id)}</span><strong>${esc(resultLabel(run.status))}</strong><small>${esc(stamp(run.finished_at))}</small></summary><ul>${(Array.isArray(run.checks)?run.checks:[]).map(item=>`<li><span>${esc(checkName(item.id))}</span><strong>${esc(resultLabel(item.status))}</strong><p>${esc(item.summary)}</p></li>`).join('')}</ul></details>`).join(''):'<p class="monitor-empty">수집기에서 전송한 점검 결과가 아직 없어요. 설정 저장과 서버 적용 상태를 구분해서 표시합니다.</p>';
}
function updateAuth(){
  const access=monitoringAccess(),busy=saving||access.busy;
  $('monitor-auth').innerHTML=access.unlocked?'<span>관리자 로그인 중 · 저장한 설정은 연구실에 공유됩니다.</span>':'<span>일정은 미리 구성할 수 있어요. 공용 저장은 관리자 로그인이 필요합니다.</span><button type="button" data-monitor-login>관리자 로그인</button>';
  $('monitor-save').textContent=saving?'저장 중…':access.unlocked?'서버 설정 저장':'관리자 로그인 후 저장';
  $('monitor-save').disabled=busy||loading||!!loadError;
  $('monitor-reload').disabled=busy||loading;
  $('monitor-close').disabled=busy;
  if(loadError)$('monitor-config-error').textContent=loadError;
}
function fillDraft(){
  const s=server();draft=structuredClone(savedConfig(serverID)||defaultConfig(s));baseRevision=draft.revision;pending=null;
  $('monitor-title').textContent=(s?.name||serverID)+' 모니터링 설정';$('monitor-server-meta').textContent='서버별 일정 · 한국시간(KST) · 읽기 전용 점검';
  $('monitor-enabled').checked=draft.enabled;$('monitor-gpu-count').value=draft.expected_gpu_count;$('monitor-timeout').value=draft.timeout_seconds;$('monitor-temperature').value=draft.temperature_warn_c;
  $('monitor-config-error').textContent=loadError;$('monitor-feedback').textContent='';hideEditor();renderSchedules();updateConnection();updateAuth();
}
async function openSettings(id){
  if(saving||isUnavailable(id))return;serverID=id;if(!server())return;fillDraft();dialog.showModal();
  if(!loaded){await refreshPublic();if(dialog.open&&serverID===id)fillDraft();}
}
function renderSchedules(){
  $('monitor-schedule-count').textContent=draft.schedules.length+' / 12';
  $('monitor-schedule-list').innerHTML=draft.schedules.length?draft.schedules.map(s=>{
    const report=reportFor(server())?.schedules?.find(x=>x.id===s.id),at=draft.enabled?(report?.next_run_at||nextRun(s)):null;
    return `<article class="monitor-schedule-row"><div><div class="monitor-schedule-title"><strong>${esc(s.name)}</strong><span class="monitor-badge ${s.enabled?'':'muted'}">${s.kind==='daily'?'정밀 점검':'일반 점검'}</span>${s.enabled?'':'<small>일시 중지</small>'}</div><p>${esc(scheduleLabel(s))}</p><div class="monitor-check-chips">${s.checks.map(id=>`<span>${esc(checkName(id))}</span>`).join('')}</div><small>다음 예정 ${!draft.enabled?'모니터링 중지':s.enabled?esc(stamp(at)):'일시 중지'}${report?.next_run_at?'':' · 서버 적용 후 실행'}</small></div><div class="monitor-row-actions"><button type="button" data-monitor-edit="${s.id}">수정</button><button type="button" data-monitor-toggle="${s.id}">${s.enabled?'일시 중지':'활성화'}</button><button type="button" data-monitor-delete="${s.id}">삭제</button></div></article>`;
  }).join(''):'<div class="monitor-empty-box"><strong>첫 점검 일정을 만들어 보세요.</strong><p>예: GPU 인식 확인은 30분마다, 전체 정밀 점검은 매일 09:00와 21:00에.</p></div>';
  $('monitor-add').disabled=draft.schedules.length>=12;
}
function hideEditor(){
  $('monitor-editor').hidden=true;for(const e of $('monitor-editor').querySelectorAll('input,select,button'))e.disabled=true;editingSchedule=null;
}
function showEditor(schedule=null){
  editingSchedule=schedule?.id||null;const s=schedule||makeSchedule();$('monitor-editor').hidden=false;
  for(const e of $('monitor-editor').querySelectorAll('input,select,button'))e.disabled=false;
  $('monitor-editor-title').textContent=schedule?'점검 일정 수정':'점검 일정 추가';$('monitor-editor-add').textContent=schedule?'일정 수정 완료':'일정에 추가';
  $('monitor-schedule-name').value=s.name;$('monitor-kind').value=s.kind;$('monitor-interval').value=s.interval_minutes;$('monitor-all-day').checked=s.all_day;$('monitor-window-start').value=s.start_time;$('monitor-window-end').value=s.end_time;
  $('monitor-daily-count').value=String(s.times.length||1);$('monitor-time-one').value=s.times[0]||'09:00';$('monitor-time-two').value=s.times[1]||'21:00';
  for(const e of dialog.querySelectorAll('[name=monitor-day]'))e.checked=s.days.includes(Number(e.value));
  for(const e of dialog.querySelectorAll('[name=monitor-check]'))e.checked=s.checks.includes(e.value);
  $('monitor-schedule-error').textContent='';syncEditor();$('monitor-editor').scrollIntoView({block:'start'});$('monitor-schedule-name').focus({preventScroll:true});
}
function syncEditor(){
  const daily=$('monitor-kind').value==='daily',all=$('monitor-all-day').checked,two=$('monitor-daily-count').value==='2';
  $('monitor-interval-fields').hidden=daily;$('monitor-daily-fields').hidden=!daily;$('monitor-window-fields').hidden=all;
  $('monitor-interval').disabled=daily;$('monitor-window-start').disabled=daily||all;$('monitor-window-end').disabled=daily||all;
  $('monitor-time-two-label').hidden=!two;$('monitor-time-one').disabled=!daily;$('monitor-time-two').disabled=!daily||!two;
  $('monitor-check-count').textContent=dialog.querySelectorAll('[name=monitor-check]:checked').length+'개 선택';
}
function addSchedule(){
  try{
    const previous=draft.schedules.find(s=>s.id===editingSchedule),kind=$('monitor-kind').value;
    const s={...(previous||makeSchedule(kind)),name:$('monitor-schedule-name').value.trim(),kind,interval_minutes:Number($('monitor-interval').value),all_day:$('monitor-all-day').checked,start_time:$('monitor-window-start').value,end_time:$('monitor-window-end').value,
      days:[...dialog.querySelectorAll('[name=monitor-day]:checked')].map(e=>Number(e.value)),checks:[...dialog.querySelectorAll('[name=monitor-check]:checked')].map(e=>e.value),times:kind==='daily'?[$('monitor-time-one').value,...($('monitor-daily-count').value==='2'?[$('monitor-time-two').value]:[])]:[]};
    validateSchedule(s);if(previous)draft.schedules=draft.schedules.map(x=>x.id===s.id?s:x);else if(draft.schedules.length<12)draft.schedules.push(s);else throw new Error('점검 일정은 최대 12개까지 추가할 수 있어요.');
    hideEditor();renderSchedules();$('monitor-feedback').textContent='일정 초안에 반영했어요. 아래의 서버 설정 저장을 눌러 주세요.';$('monitor-schedules-title').scrollIntoView({block:'start'});
  }catch(error){$('monitor-schedule-error').textContent=error.message;}
}
async function save(event){
  event.preventDefault();if(saving||isUnavailable(serverID))return;$('monitor-config-error').textContent='';
  if(!monitoringAccess().unlocked){openDashboardLogin();return;}
  if(!$('monitor-editor').hidden){$('monitor-config-error').textContent='작성 중인 일정을 추가하거나 취소한 후 서버 설정을 저장해 주세요.';return;}
  try{
    const candidate={...draft,enabled:$('monitor-enabled').checked,expected_gpu_count:Number($('monitor-gpu-count').value),timeout_seconds:Number($('monitor-timeout').value),temperature_warn_c:Number($('monitor-temperature').value)};validateConfig(candidate);
    const signature=JSON.stringify(candidate);if(pending?.signature!==signature)pending={signature,id:monitoringID()};
    saving=true;updateAuth();const saved=await saveMonitoringConfig(candidate,baseRevision,pending.id);data=saved;loaded=true;loadError='';draft=structuredClone(savedConfig(serverID));baseRevision=draft.revision;pending=null;
    renderCards();renderSchedules();$('monitor-feedback').textContent='공용 설정을 저장했어요. 서버의 적용 응답을 기다립니다.';
  }catch(error){$('monitor-config-error').textContent=error.message;}
  finally{saving=false;updateAuth();}
}
$('monitor-config-form').addEventListener('submit',save);
$('monitor-close').onclick=()=>{if(!saving)dialog.close();};dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
$('monitor-enabled').onchange=()=>{draft.enabled=$('monitor-enabled').checked;renderSchedules();};
$('monitor-add').onclick=()=>showEditor();$('monitor-editor-cancel').onclick=hideEditor;$('monitor-editor-add').onclick=addSchedule;
$('monitor-kind').onchange=()=>{if($('monitor-kind').value==='daily'&&!editingSchedule){$('monitor-schedule-name').value='정밀 점검';for(const e of dialog.querySelectorAll('[name=monitor-check]'))e.checked=true;}syncEditor();};
for(const id of ['monitor-all-day','monitor-daily-count'])$(id).onchange=syncEditor;
$('monitor-checks').addEventListener('change',syncEditor);
for(const [id,checked]of [['monitor-check-all',true],['monitor-check-none',false]])$(id).onclick=()=>{for(const e of dialog.querySelectorAll('[name=monitor-check]'))e.checked=checked;syncEditor();};
$('monitor-reload').onclick=async()=>{await refreshPublic();if(!loadError)fillDraft();};
document.addEventListener('click',event=>{const button=event.target.closest('[data-monitor-server]');if(button)void openSettings(button.dataset.monitorServer);if(event.target.closest('[data-monitor-login]'))openDashboardLogin();});
$('monitor-schedule-list').addEventListener('click',event=>{
  const edit=event.target.closest('[data-monitor-edit]');if(edit){showEditor(draft.schedules.find(s=>s.id===edit.dataset.monitorEdit));return;}
  const toggle=event.target.closest('[data-monitor-toggle]');if(toggle){const s=draft.schedules.find(s=>s.id===toggle.dataset.monitorToggle);if(s)s.enabled=!s.enabled;renderSchedules();return;}
  const del=event.target.closest('[data-monitor-delete]');if(del){draft.schedules=draft.schedules.filter(s=>s.id!==del.dataset.monitorDelete);renderSchedules();}
});
document.addEventListener('dashboard:render',renderCards);renderCards();
setInterval(()=>{if(!document.hidden)void refreshPublic();},60000);
