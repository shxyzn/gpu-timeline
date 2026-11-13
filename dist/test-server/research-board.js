import {dashboardView,monitoringAccess,openDashboardLogin,runAdminTask} from '../app.js?patch=workspace-3';
import {GATE} from './gate.js?v=workspace-3';
import {currentSession} from './session.js?v=workspace-3';
import {importDocumentKey,fromBase64} from './workspace-crypto.js?v=workspace-3';
import {ResearchStore} from './research-store.js?v=workspace-3';
import {OUTPUT_KINDS,METRICS,emptyResearch,makeProject,makeOutput,projectProgress,researchOverview,remainingText,outputWarnings,ackText,ACK_LABELS,statusLabel,targetLabel,today,daysUntil,ddayLabel,newID} from './research-model.js?v=workspace-3';

// Research-project tracker of the test-server workspace: what each project owes, by when,
// what already counts, and which acknowledgement (사사) every output carries.
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const day=date=>{if(!date)return '';const [y,m,d]=date.split('-').map(Number);return `${y}. ${m}. ${d}.`;};
const stamp=at=>at?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(at))+' KST':'';
const root=$('workspace-research'),session=currentSession(GATE);
let doc=emptyResearch(),store=null,loaded=false,loading=false,loadError='',lastRead=0,saving=false;
let tab='projects',phase='active',kind='all',projectFilter='all',query='';
let editing=null,pending=null,confirming=null,refocus=null;
const open=new Set(),drawn=new WeakMap();

export function researchState(){return {doc,loaded,loading,loadError,overview:loaded?researchOverview(doc):null};}
const access=()=>monitoringAccess();
const projectName=p=>p.short||p.name;
const tone=days=>days<0?'late':days<=30?'soon':days<=90?'near':'far';

if(root&&session){
  root.innerHTML=`<div class="rs-head"><div><span class="ws-eyebrow">RESEARCH</span><h1 id="rs-title">연구과제</h1><p>과제마다 목표 실적이 몇 개이고, 언제까지이며, 무엇으로 채웠는지 확인해요.</p></div>
    <div class="rs-actions"><button type="button" id="rs-refresh" class="rs-button">새로고침</button><button type="button" id="rs-add-output" class="rs-button">＋ 실적 추가</button><button type="button" id="rs-add-project" class="rs-button primary">＋ 과제 추가</button></div></div>
  <div class="rs-access"><span id="rs-access"></span><button type="button" id="rs-admin" class="rs-link" hidden>관리자 연결</button></div>
  <p id="rs-feedback" class="rs-feedback" role="status" aria-live="polite"></p><p id="rs-error" class="rs-error" role="alert"></p>
  <div id="rs-summary" class="rs-summary" aria-label="연구과제 요약"></div>
  <div class="rs-tabs" role="tablist" aria-label="연구과제 보기"><button type="button" role="tab" id="rs-tab-projects" aria-controls="rs-panel-projects" data-rs-tab="projects">과제별 현황</button><button type="button" role="tab" id="rs-tab-outputs" aria-controls="rs-panel-outputs" data-rs-tab="outputs">실적 목록 <span id="rs-count-outputs"></span></button><button type="button" role="tab" id="rs-tab-schedule" aria-controls="rs-panel-schedule" data-rs-tab="schedule">기한·일정 <span id="rs-count-schedule"></span></button><button type="button" role="tab" id="rs-tab-acks" aria-controls="rs-panel-acks" data-rs-tab="acks">사사문구</button></div>
  <section id="rs-panel-projects" role="tabpanel" aria-labelledby="rs-tab-projects"><div class="rs-chips" role="group" aria-label="과제 상태"><button type="button" data-rs-phase="active">진행 중 <span id="rs-count-active">0</span></button><button type="button" data-rs-phase="ended">종료 <span id="rs-count-ended">0</span></button><button type="button" data-rs-phase="archived">보관 <span id="rs-count-archived">0</span></button></div><div id="rs-projects" class="rs-projects"></div></section>
  <section id="rs-panel-outputs" role="tabpanel" aria-labelledby="rs-tab-outputs" hidden><div class="rs-filters"><div id="rs-kinds" class="rs-chips" role="group" aria-label="실적 종류"></div><label class="rs-select">과제<select id="rs-project-filter" aria-label="과제로 걸러 보기"></select></label><label class="rs-search">검색<input id="rs-query" type="search" maxlength="80" placeholder="제목·저자·학술지" autocomplete="off"></label></div><div id="rs-outputs" class="rs-outputs"></div></section>
  <section id="rs-panel-schedule" role="tabpanel" aria-labelledby="rs-tab-schedule" hidden><div id="rs-schedule" class="rs-schedule"></div></section>
  <section id="rs-panel-acks" role="tabpanel" aria-labelledby="rs-tab-acks" hidden><p class="rs-muted rs-panel-lead">논문·특허를 쓸 때 그대로 붙여 넣을 과제별 표준 사사문구예요.</p><div id="rs-acks" class="rs-outputs"></div></section>
  <p class="rs-note">로그인한 연구실 구성원이 함께 보는 기록이에요. 연구비 금액, 출원 전 특허의 내용, 심사 중인 논문의 익명성이 필요한 정보, 개인정보는 적지 마세요.</p>`;
  document.body.insertAdjacentHTML('beforeend',`<dialog id="rs-project-dialog" class="admin-dialog rs-dialog" aria-labelledby="rs-project-title">
    <div class="dialog-heading"><span class="eyebrow">RESEARCH PROJECT</span><button type="button" data-rs-close aria-label="과제 입력 닫기">×</button></div>
    <h2 id="rs-project-title">과제 추가</h2>
    <form id="rs-project-form" novalidate autocomplete="off">
      <label class="field">과제명<input id="rs-p-name" maxlength="160" required placeholder="예: 멀티모달 주행 데이터 이해 기술 개발"></label>
      <div class="field-grid"><label class="field">약칭 · 선택<input id="rs-p-short" maxlength="24" placeholder="예: IITP 멀티모달"></label><label class="field">과제번호 · 선택<input id="rs-p-number" maxlength="60" placeholder="예: RS-2026-00000000" spellcheck="false"></label></div>
      <label class="field">지원기관·사업명 · 선택<input id="rs-p-agency" maxlength="120" placeholder="예: 한국연구재단 · 중견연구"></label>
      <div class="field-grid"><label class="field">시작일 · 선택<input id="rs-p-start" type="date"></label><label class="field">종료일<input id="rs-p-end" type="date" required></label></div>
      <fieldset class="rs-fieldset"><legend>목표 실적</legend><p class="admin-help">지표와 목표 수를 적어 주세요. 기한을 비우면 과제 종료일이 기한이에요. 같은 지표를 연차별로 나누려면 줄을 추가하고 기한을 다르게 적으면 돼요.</p><div id="rs-p-targets" class="rs-rows"></div><button type="button" id="rs-p-target-add" class="edit-button">＋ 목표 추가</button></fieldset>
      <fieldset class="rs-fieldset"><legend>사사문구</legend><p class="admin-help">논문·특허에 그대로 붙여 쓸 이 과제의 표준 문구예요. 실적마다 다른 문구를 썼다면 실적에서 따로 적을 수 있어요.</p><label class="field">논문 · 영문<textarea id="rs-p-ack-en" maxlength="1200" rows="3" placeholder="This work was supported by ..."></textarea></label><label class="field">논문 · 국문<textarea id="rs-p-ack-ko" maxlength="1200" rows="3" placeholder="이 논문은 ...의 지원을 받아 수행된 연구임 (과제번호)."></textarea></label><label class="field">특허 출원서 표기 · 선택<textarea id="rs-p-ack-patent" maxlength="1200" rows="3" placeholder="과제고유번호, 부처명, 과제관리(전문)기관명, 연구사업명, 연구과제명, 기여율 ..."></textarea></label></fieldset>
      <fieldset class="rs-fieldset"><legend>일정 · 선택</legend><p class="admin-help">연차보고서, 평가처럼 기억해야 할 날짜를 적어 주세요.</p><div id="rs-p-milestones" class="rs-rows"></div><button type="button" id="rs-p-milestone-add" class="edit-button">＋ 일정 추가</button></fieldset>
      <label class="field">메모 · 선택<textarea id="rs-p-note" maxlength="1000" rows="2"></textarea></label>
      <label class="admin-check" id="rs-p-archived-row" hidden><input id="rs-p-archived" type="checkbox">보관 · 진행 중 목록에서 숨기기</label>
      <p id="rs-project-error" class="admin-error" role="alert"></p>
      <div class="dialog-actions"><button type="button" id="rs-project-delete" class="edit-button danger" hidden>과제 삭제</button><button type="button" class="edit-button" data-rs-close>취소</button><button type="submit" id="rs-project-save" class="edit-button primary">과제 저장</button></div>
    </form></dialog>
  <dialog id="rs-output-dialog" class="admin-dialog rs-dialog" aria-labelledby="rs-output-title">
    <div class="dialog-heading"><span class="eyebrow">RESEARCH OUTPUT</span><button type="button" data-rs-close aria-label="실적 입력 닫기">×</button></div>
    <h2 id="rs-output-title">실적 추가</h2>
    <form id="rs-output-form" novalidate autocomplete="off">
      <div class="field-grid"><label class="field">종류<select id="rs-o-kind">${Object.entries(OUTPUT_KINDS).map(([id,k])=>`<option value="${id}">${k.label}</option>`).join('')}</select></label><label class="field" id="rs-o-grade-field">구분<select id="rs-o-grade"></select></label></div>
      <label class="field">제목<input id="rs-o-title" maxlength="300" required placeholder="논문·특허 제목"></label>
      <p class="admin-help">심사 중인 논문과 출원 전 특허는 내용이 드러나지 않는 가제로 적어 주세요.</p>
      <div class="field-grid"><label class="field">상태<select id="rs-o-status"></select></label><label class="field"><span id="rs-o-date-label">날짜 · 선택</span><input id="rs-o-date" type="date"></label></div>
      <div class="field-grid"><label class="field">저자·발명자 · 선택<input id="rs-o-authors" maxlength="300" placeholder="예: 홍길동, 김철수"></label><label class="field"><span id="rs-o-venue-label">학술지 · 선택</span><input id="rs-o-venue" maxlength="160"></label></div>
      <div class="field-grid"><label class="field"><span id="rs-o-identifier-label">DOI · 선택</span><input id="rs-o-identifier" maxlength="120" spellcheck="false"></label><label class="field">링크 · 선택<input id="rs-o-link" type="url" maxlength="500" placeholder="https://" spellcheck="false"></label></div>
      <fieldset class="rs-fieldset"><legend>사사한 과제</legend><p class="admin-help">이 실적에 사사를 표기한 과제를 모두 골라 주세요. 고른 과제의 목표에 자동으로 반영돼요.</p><div id="rs-o-acks" class="rs-ack-options"></div></fieldset>
      <label class="field">메모 · 선택<textarea id="rs-o-note" maxlength="1000" rows="2"></textarea></label>
      <p id="rs-output-error" class="admin-error" role="alert"></p>
      <div class="dialog-actions"><button type="button" id="rs-output-delete" class="edit-button danger" hidden>실적 삭제</button><button type="button" class="edit-button" data-rs-close>취소</button><button type="submit" id="rs-output-save" class="edit-button primary">실적 저장</button></div>
    </form></dialog>
  <dialog id="rs-confirm-dialog" class="admin-dialog rs-dialog rs-confirm" aria-labelledby="rs-confirm-title">
    <h2 id="rs-confirm-title">삭제할까요?</h2><p id="rs-confirm-text" class="admin-help"></p><p id="rs-confirm-error" class="admin-error" role="alert"></p>
    <div class="dialog-actions"><button type="button" class="edit-button" id="rs-confirm-cancel">취소</button><button type="button" class="edit-button danger" id="rs-confirm-ok">삭제</button></div></dialog>`);
  bind();
  document.addEventListener('dashboard:render',onDashboard);
  document.addEventListener('workspace:view',event=>{if(event.detail==='research'&&Date.now()-lastRead>60000)void read();});
  onDashboard();
}

function feedback(message){$('rs-feedback').textContent=message;}
// Write markup only when it changed: a periodic refresh must not drop focus or a text selection.
function setHTML(element,html){if(drawn.get(element)!==html){element.innerHTML=html;drawn.set(element,html);}}
function notify(){document.dispatchEvent(new CustomEvent('research:change'));}

function onDashboard(){
  const view=dashboardView();
  if(!store&&view.config){
    if(view.config.mode!=='live'||!view.config.dashboard){loaded=true;loadError='예시 데이터 모드에서는 연구과제 기록을 불러오지 않아요.';render();notify();return;}
    store={pending:true};
    void (async()=>{
      try{
        const key=await importDocumentKey(fromBase64(session.key));
        store=new ResearchStore(view.config.dashboard,{key,keyID:session.key_id});
        await read();
      }catch{store=null;loadError='로그인 정보를 확인할 수 없어요. 로그아웃한 뒤 다시 로그인해 주세요.';render();notify();}
    })();
  }
  render();
}

async function read(){
  if(!store||store.pending||loading||saving)return;
  loading=true;render();
  try{const next=await store.readPublic();if(next.revision>=doc.revision)doc=next;loaded=true;loadError='';lastRead=Date.now();}
  catch(error){loadError=error.message;}
  finally{loading=false;render();notify();}
}

// ---- Rendering ------------------------------------------------------------------------------

function pill(label,kind){return `<span class="rs-pill ${kind}">${esc(label)}</span>`;}
function dueBadge(date,days,done=false){
  return done?`<span class="rs-due done">${esc(day(date))}</span>`:`<span class="rs-due ${tone(days)}"><strong>${esc(ddayLabel(days))}</strong>${esc(day(date))}${days<0?' · 기한 지남':''}</span>`;
}
function ackBlock(text,label){
  if(!text)return '<p class="rs-muted">등록된 사사문구가 없어요. 과제 수정에서 표준 문구를 적어 두면 여기에서 바로 복사할 수 있어요.</p>';
  return `<div class="rs-ack"><div class="rs-ack-top"><span>${esc(label)}</span><button type="button" class="rs-link" data-rs-copy="${esc(text)}">복사</button></div><p>${esc(text)}</p></div>`;
}
const ackSummary=applied=>applied.source==='custom'?'직접 적은 사사문구':applied.source==='standard'?'표준 사사문구':'사사문구 미등록';
function standardAcks(project){
  const blocks=Object.entries(ACK_LABELS).filter(([field])=>project[field]).map(([field,label])=>ackBlock(project[field],label));
  return blocks.length?blocks.join(''):ackBlock('','');
}
function outputLine(output,project,achieved){
  const ack=output.acks.find(a=>a.project_id===project.id),applied=ackText(ack,project,output),k=OUTPUT_KINDS[output.kind],key='ack:'+project.id+':'+output.id;
  return `<li class="rs-line"><div class="rs-line-main"><span class="rs-dot ${achieved?'done':'pending'}" aria-hidden="true"></span><div><strong>${esc(output.title)}</strong><span>${esc([k.label+(output.grade?' · '+k.grades[output.grade]:''),output.venue,statusLabel(output)+(output.date?' '+day(output.date):'')].filter(Boolean).join(' · '))}</span></div></div>
    <details class="rs-inline" data-rs-open="${key}"${open.has(key)?' open':''}><summary>${ackSummary(applied)}</summary>${ackBlock(applied.text,applied.label)}</details></li>`;
}
function targetRow(row){
  const ratio=Math.min(100,row.done/row.count*100),planned=Math.min(100-ratio,row.pending/row.count*100);
  const need=row.remaining===0?`<span class="rs-need met">달성${row.over?` · ${row.over}${row.unit} 초과`:''}</span>`:`<span class="rs-need ${row.state}">${row.remaining}${row.unit} 더 필요</span>`;
  return `<tr data-rs-target="${row.target.id}" data-state="${row.state}"><th scope="row"><span class="rs-target-name">${esc(row.label)}</span>${row.target.note?`<small>${esc(row.target.note)}</small>`:''}</th>
    <td class="rs-target-progress"><div class="rs-count"><strong>${row.done}</strong><span>/ ${row.count}${row.unit}</span>${row.pipeline.length?`<small>${esc(row.pipeline.map(stage=>`${stage.label} ${stage.count}`).join(' · '))}</small>`:''}</div><div class="rs-bar" role="progressbar" aria-label="${esc(row.label)} 달성" aria-valuemin="0" aria-valuemax="${row.count}" aria-valuenow="${Math.min(row.done,row.count)}"><span style="width:${ratio}%"></span><i style="width:${planned}%"></i></div></td>
    <td class="rs-target-need">${need}</td><td class="rs-target-due">${dueBadge(row.due_on,row.days,row.remaining===0)}</td></tr>`;
}
function projectCard(p,view){
  const project=p.project,key='outputs:'+project.id,ackKey='std:'+project.id,stateText={met:'목표 달성',covered:'진행 중인 실적 반영 시 달성',short:'실적 더 필요',missed:'기한 지난 목표 있음',untargeted:'목표 미등록'}[p.state];
  const phaseLabel=project.archived?'보관':p.phase==='upcoming'?'시작 전':p.phase==='ended'?'종료':'진행 중';
  const rows=p.rows.filter(row=>row.outputs.length);
  const pendingMilestones=project.milestones.filter(m=>!m.done).sort((a,b)=>a.date.localeCompare(b.date));
  return `<article class="rs-project" data-rs-project="${project.id}" data-state="${p.state}" aria-label="${esc(project.name)}">
    <header class="rs-project-head"><div><div class="rs-project-meta">${pill(phaseLabel,'phase '+(project.archived?'archived':p.phase))}${project.agency?`<span>${esc(project.agency)}</span>`:''}${project.number?`<code>${esc(project.number)}</code>`:''}</div><h3>${esc(project.name)}</h3></div>
      <div class="rs-project-end"><span class="rs-due ${p.ended?'late':tone(p.days)}"><strong>${p.ended?'종료':esc(ddayLabel(p.days))}</strong>${esc((project.starts_on?day(project.starts_on)+' ~ ':'')+day(project.ends_on))}</span></div></header>
    <p class="rs-verdict ${p.state}"><span>${esc(stateText)}</span>${esc(remainingText(p))}${p.remaining&&p.pending?` · 그중 ${p.pending}건은 진행 중`:''}</p>
    ${p.rows.length?`<table class="rs-targets"><caption>목표 실적</caption><thead><tr><th scope="col">목표</th><th scope="col">달성 / 목표</th><th scope="col">남은 실적</th><th scope="col">기한</th></tr></thead><tbody>${p.rows.map(targetRow).join('')}</tbody></table>`:`<p class="rs-muted">목표 실적이 아직 없어요.${view.unlocked?' 과제 수정에서 지표와 목표 수를 추가해 주세요.':''}</p>`}
    <details class="rs-fold" data-rs-open="${key}"${open.has(key)?' open':''}><summary>사사한 실적 ${p.linked.length}건</summary>
      ${p.linked.length?'':'<p class="rs-muted">이 과제를 사사한 실적이 아직 없어요.</p>'}
      ${rows.map(row=>`<h4>${esc(row.label)} <span>${row.done} / ${row.count}${row.unit}</span></h4><ul class="rs-lines">${row.outputs.map(item=>outputLine(item.output,project,item.achieved)).join('')}</ul>`).join('')}
      ${p.extra.length?`<h4>목표 외 실적 <span>맞는 목표가 없어 집계하지 않았어요</span></h4><ul class="rs-lines">${p.extra.map(o=>outputLine(o,project,false)).join('')}</ul>`:''}
      ${p.excluded.length?`<h4>집계 제외 <span>집계하지 않도록 지정한 실적</span></h4><ul class="rs-lines">${p.excluded.map(o=>outputLine(o,project,false)).join('')}</ul>`:''}
    </details>
    <details class="rs-fold" data-rs-open="${ackKey}"${open.has(ackKey)?' open':''}><summary>이 과제의 사사문구</summary>${standardAcks(project)}</details>
    ${pendingMilestones.length?`<ul class="rs-milestones" aria-label="남은 일정">${pendingMilestones.map(m=>`<li>${dueBadge(m.date,daysOf(m.date))}<span>${esc(m.title)}</span></li>`).join('')}</ul>`:''}
    ${project.note?`<p class="rs-project-note">${esc(project.note)}</p>`:''}
    <div class="rs-card-foot"><span>${esc(project.updated_by)} · ${esc(stamp(project.updated_at))} 수정</span>${view.unlocked?`<span class="rs-card-actions"><button type="button" class="rs-button" data-rs-action="output-for" data-rs-id="${project.id}"${view.busy?' disabled':''}>이 과제에 실적 추가</button><button type="button" class="rs-button" data-rs-action="project-edit" data-rs-id="${project.id}"${view.busy?' disabled':''}>과제 수정</button></span>`:''}</div></article>`;
}
const daysOf=date=>daysUntil(date,today());

// Where each output landed: "project|output" -> the target rows it fills, or why it fills none.
function placements(){
  const map=new Map(),on=today();
  for(const project of doc.projects){
    const p=projectProgress(project,doc.outputs,on);
    for(const row of p.rows)for(const item of row.outputs){const key=project.id+'|'+item.output.id;if(!map.has(key))map.set(key,{rows:[]});map.get(key).rows.push(row.label);}
    for(const output of p.extra)map.set(project.id+'|'+output.id,{rows:[],reason:'맞는 목표가 없어 집계하지 않았어요'});
    for(const output of p.excluded)map.set(project.id+'|'+output.id,{rows:[],reason:'집계하지 않도록 지정했어요'});
  }
  return map;
}
function outputCard(output,view){
  const k=OUTPUT_KINDS[output.kind],achieved=k.achieved.includes(output.status),warnings=outputWarnings(output,doc.projects);
  const links=output.acks.map(ack=>({ack,project:doc.projects.find(p=>p.id===ack.project_id)})).filter(item=>item.project);
  const meta=[output.authors,output.venue,output.date?day(output.date):''].filter(Boolean).map(esc);
  if(output.identifier)meta.push(`${esc(k.identifierLabel)} ${esc(output.identifier)}`);
  return `<article class="rs-output" data-rs-output="${output.id}" aria-label="${esc(output.title)}"><div class="rs-output-top">${pill(k.label+(output.grade?' · '+k.grades[output.grade]:''),'kind')}${pill(statusLabel(output),'status '+(achieved?'done':'pending'))}${warnings.map(w=>pill(w.label,'warn')).join('')}</div>
    <h3>${esc(output.title)}</h3>${meta.length?`<p class="rs-output-meta">${meta.join(' · ')}</p>`:''}${output.link?`<p class="rs-output-meta"><a href="${esc(output.link)}" target="_blank" rel="noopener noreferrer">링크 열기 ↗</a></p>`:''}
    ${links.length?`<ul class="rs-acks" aria-label="사사한 과제">${links.map(({ack,project})=>{
      const applied=ackText(ack,project,output),key='oack:'+output.id+':'+project.id,where=view.placements.get(project.id+'|'+output.id),target=where?.rows.length?where.rows.join(', ')+' 목표에 반영':where?.reason||'';
      return `<li><div class="rs-acks-head"><strong>${esc(projectName(project))}</strong>${project.number?`<code>${esc(project.number)}</code>`:''}<span>${esc(target)}</span></div><details class="rs-inline" data-rs-open="${key}"${open.has(key)?' open':''}><summary>${ackSummary(applied)}${applied.source==='missing'?'':' 보기'}</summary>${ackBlock(applied.text,applied.label)}</details></li>`;}).join('')}</ul>`:'<p class="rs-warn-line">어느 과제의 실적인지 아직 연결하지 않았어요. 사사한 과제를 지정하면 그 과제의 목표에 반영돼요.</p>'}
    ${output.note?`<p class="rs-project-note">${esc(output.note)}</p>`:''}
    <div class="rs-card-foot"><span>${esc(output.updated_by)} · ${esc(stamp(output.updated_at))} 수정</span>${view.unlocked?`<span class="rs-card-actions"><button type="button" class="rs-button" data-rs-action="output-edit" data-rs-id="${output.id}"${view.busy?' disabled':''}>실적 수정</button></span>`:''}</div></article>`;
}

function render(){
  if(!root||!session)return;
  // Saving re-reads the latest file itself, so a failed refresh does not have to block editing.
  const view=access(),ready=loaded&&!!store&&!store.pending,busy=view.busy||saving;
  $('rs-access').textContent=view.unlocked?'관리자 모드 · 과제와 실적을 추가·수정할 수 있어요.':'읽기 전용 · 추가·수정은 관리자 연결 후 할 수 있어요.';
  $('rs-admin').hidden=view.unlocked||!view.enabled;
  $('rs-error').textContent=loadError;
  for(const id of ['rs-add-project','rs-add-output'])$(id).disabled=!ready||busy;
  $('rs-refresh').disabled=loading||busy||!store||!!store.pending;$('rs-refresh').textContent=loading?'불러오는 중…':'새로고침';
  for(const button of root.querySelectorAll('[data-rs-tab]')){const on=button.dataset.rsTab===tab;button.setAttribute('aria-selected',String(on));button.tabIndex=on?0:-1;$(button.getAttribute('aria-controls')).hidden=!on;}
  const overview=researchOverview(doc),c=overview.counts;
  const next=overview.next,late=overview.overdue.length;
  setHTML($('rs-summary'),!loaded?(loadError&&!loading?'':'<p class="rs-muted rs-loading">연구과제 기록을 불러오는 중이에요.</p>'):[
    ['진행 중 과제',c.projects,'개',c.ended||c.archived?`종료 ${c.ended} · 보관 ${c.archived}`:'등록된 과제 기준',''],
    ['더 필요한 실적',c.remaining,'건',c.remaining?(c.pending?`그중 ${c.pending}건은 진행 중 · 새로 시작할 실적 ${c.gap}건`:'목표에서 달성 수를 뺀 합계'):'남은 목표가 없어요',c.remaining?'need':'ok'],
    ['가장 가까운 기한',next?ddayLabel(next.days):'—','',next?`${day(next.date)} · ${projectName(next.project)} · ${next.title}`:'남은 기한이 없어요',next?tone(next.days):''],
    ['확인할 것',late+c.unacknowledged,'건',late||c.unacknowledged?[late?`기한 지남 ${late}건`:'',c.unacknowledged?`사사 과제 미지정 ${c.unacknowledged}건`:''].filter(Boolean).join(' · '):'모두 정리돼 있어요',late||c.unacknowledged?'warn':'ok'],
  ].map(([label,value,unit,note,kind])=>`<div class="rs-stat ${kind}"><span>${label}</span><strong>${esc(value)}<small>${unit}</small></strong><p>${esc(note)}</p></div>`).join(''));
  const groups={active:overview.progress.filter(p=>p.phase!=='ended'),ended:overview.progress.filter(p=>p.phase==='ended'),archived:doc.projects.filter(p=>p.archived)};
  for(const name of Object.keys(groups)){$('rs-count-'+name).textContent=groups[name].length;root.querySelector(`[data-rs-phase="${name}"]`).setAttribute('aria-pressed',String(name===phase));}
  $('rs-count-outputs').textContent=doc.outputs.length||'';$('rs-count-schedule').textContent=overview.deadlines.length||'';
  const focus=document.activeElement?.closest?.('[data-rs-action]'),focusKey=focus&&root.contains(focus)&&focus.dataset.rsId?[focus.dataset.rsAction,focus.dataset.rsId]:null;
  // Only the open tab holds markup, so a hidden list never keeps stale buttons around.
  for(const [name,id] of [['projects','rs-projects'],['outputs','rs-outputs'],['schedule','rs-schedule'],['acks','rs-acks']])if(!loaded||name!==tab)setHTML($(id),'');
  if(!loaded)return;
  if(tab==='projects'){
    const list=phase==='archived'?researchOverview({...doc,projects:groups.archived.map(p=>({...p,archived:false}))}).progress.map(p=>({...p,project:{...p.project,archived:true}})):groups[phase];
    setHTML($('rs-projects'),list.map(p=>projectCard(p,{...view,busy})).join('')||`<div class="rs-empty"><strong>${phase==='active'?(doc.projects.length?'진행 중인 과제가 없어요.':'아직 등록된 과제가 없어요.'):phase==='ended'?'종료된 과제가 없어요.':'보관한 과제가 없어요.'}</strong><p>${phase==='active'?(view.unlocked?'‘＋ 과제 추가’로 과제와 목표 실적을 등록해 보세요.':'관리자가 과제를 등록하면 이곳에 목표와 달성 현황이 표시돼요.'):phase==='ended'?'종료일이 지난 과제가 이곳에 모여요.':'과제 수정에서 보관하면 이곳으로 옮겨져요.'}</p></div>`);
  }else if(tab==='outputs'){
    const counts=Object.fromEntries(Object.keys(OUTPUT_KINDS).map(id=>[id,doc.outputs.filter(o=>o.kind===id).length]));
    setHTML($('rs-kinds'),`<button type="button" data-rs-kind="all" aria-pressed="${kind==='all'}">전체 <span>${doc.outputs.length}</span></button>`+Object.entries(OUTPUT_KINDS).filter(([id])=>counts[id]||kind===id).map(([id,k])=>`<button type="button" data-rs-kind="${id}" aria-pressed="${kind===id}">${k.label} <span>${counts[id]}</span></button>`).join(''));
    if(projectFilter!=='all'&&projectFilter!=='none'&&!doc.projects.some(p=>p.id===projectFilter))projectFilter='all';
    const options='<option value="all">모든 과제</option><option value="none">사사 과제 미지정</option>'+doc.projects.map(p=>`<option value="${p.id}">${esc(projectName(p))}</option>`).join('');
    setHTML($('rs-project-filter'),options);
    $('rs-project-filter').value=projectFilter;
    const needle=query.trim().toLowerCase();
    const list=doc.outputs.filter(o=>(kind==='all'||o.kind===kind)&&(projectFilter==='all'||(projectFilter==='none'?!o.acks.some(a=>doc.projects.some(p=>p.id===a.project_id)):o.acks.some(a=>a.project_id===projectFilter)))&&(!needle||[o.title,o.authors,o.venue,o.identifier].some(v=>v.toLowerCase().includes(needle))))
      .sort((a,b)=>(b.date||'').localeCompare(a.date||'')||b.updated_at.localeCompare(a.updated_at));
    const placed=placements();
    setHTML($('rs-outputs'),list.map(o=>outputCard(o,{...view,busy,placements:placed})).join('')||`<div class="rs-empty"><strong>${doc.outputs.length?'조건에 맞는 실적이 없어요.':'아직 등록된 실적이 없어요.'}</strong><p>${doc.outputs.length?'종류·과제·검색어를 바꿔 보세요.':view.unlocked?'‘＋ 실적 추가’로 논문·특허를 등록하고 사사한 과제를 골라 주세요.':'관리자가 논문·특허를 등록하면 이곳에 표시돼요.'}</p></div>`);
  }else if(tab==='acks'){
    const list=doc.projects.filter(p=>!p.archived).sort((a,b)=>a.ends_on.localeCompare(b.ends_on));
    setHTML($('rs-acks'),list.map(p=>`<article class="rs-output" data-rs-ack-project="${p.id}" aria-label="${esc(p.name)} 사사문구"><div class="rs-project-meta">${p.agency?`<span>${esc(p.agency)}</span>`:''}${p.number?`<code>${esc(p.number)}</code><button type="button" class="rs-link" data-rs-copy="${esc(p.number)}" data-rs-copied="과제번호를 복사했어요.">과제번호 복사</button>`:''}</div><h3>${esc(p.name)}</h3>${standardAcks(p)}</article>`).join('')||'<div class="rs-empty"><strong>등록된 과제가 없어요.</strong><p>과제에 표준 사사문구를 적어 두면 이곳에서 바로 복사할 수 있어요.</p></div>');
  }else{
    const item=d=>`<li class="${d.days<0?'late':''}">${dueBadge(d.date,d.days)}<div><strong>${esc(d.title)}</strong><span>${esc(projectName(d.project))}${d.kind==='milestone'?' · 일정':d.kind==='end'?'':' · 목표 실적'}</span></div></li>`;
    const upcoming=overview.deadlines.filter(d=>d.days>=0);
    setHTML($('rs-schedule'),(overview.overdue.length?`<h3>기한이 지났어요 <span>${overview.overdue.length}</span></h3><ul class="rs-deadlines">${overview.overdue.map(item).join('')}</ul>`:'')+(upcoming.length?`<h3>다가오는 기한 <span>${upcoming.length}</span></h3><ul class="rs-deadlines">${upcoming.map(item).join('')}</ul>`:'')||'<div class="rs-empty"><strong>남은 기한이 없어요.</strong><p>과제의 종료일, 목표 기한, 일정이 이곳에 날짜순으로 모여요.</p></div>');
  }
  const target=refocus||focusKey;
  if(target&&!document.querySelector('dialog[open]')){root.querySelector(`[data-rs-action="${target[0]}"][data-rs-id="${target[1]}"]:not(:disabled)`)?.focus({preventScroll:true});refocus=null;}
  for(const id of ['rs-project-form','rs-output-form'])for(const field of $(id).querySelectorAll('input,select,textarea,button'))field.disabled=busy;
  if(!view.unlocked)for(const id of ['rs-project-dialog','rs-output-dialog','rs-confirm-dialog'])if($(id).open&&!saving)$(id).close();
}

// ---- Editing --------------------------------------------------------------------------------

function requireAdmin(){
  const view=access();
  if(view.unlocked)return !view.busy&&!saving;
  feedback('관리자 연결 후 다시 눌러 주세요.');openDashboardLogin();return false;
}
function targetRowForm(t={}){
  const row=document.createElement('div');row.className='rs-row rs-target-row';row.dataset.id=t.id||newID('t');
  row.innerHTML=`<label class="field">지표<select data-f="metric">${Object.entries(METRICS).map(([id,m])=>`<option value="${id}">${m.label}</option>`).join('')}</select></label><label class="field">목표 수<input data-f="count" type="number" min="1" max="999" step="1" inputmode="numeric"></label><label class="field">기한 · 선택<input data-f="due_on" type="date"></label><label class="field rs-row-wide"><span data-label>표시 이름 · 선택</span><input data-f="label" maxlength="60" placeholder="예: 1차년도"></label><button type="button" class="rs-row-remove" data-rs-remove aria-label="이 목표 삭제">×</button>`;
  row.querySelector('[data-f=metric]').value=t.metric||'paper_sci';row.querySelector('[data-f=count]').value=t.count||1;row.querySelector('[data-f=due_on]').value=t.due_on||'';row.querySelector('[data-f=label]').value=t.label||'';
  row.dataset.unit=t.unit||'';row.dataset.note=t.note||'';
  syncTargetRow(row);return row;
}
function syncTargetRow(row){const custom=row.querySelector('[data-f=metric]').value==='custom';row.querySelector('[data-label]').textContent=custom?'지표 이름':'표시 이름 · 선택';row.querySelector('[data-f=label]').placeholder=custom?'예: 기술이전':'예: 1차년도';}
function milestoneRowForm(m={}){
  const row=document.createElement('div');row.className='rs-row rs-milestone-row';row.dataset.id=m.id||newID('m');
  row.innerHTML=`<label class="field rs-row-wide">일정<input data-f="title" maxlength="80" placeholder="예: 1차년도 연차보고서 제출"></label><label class="field">날짜<input data-f="date" type="date"></label><label class="admin-check"><input data-f="done" type="checkbox">완료</label><button type="button" class="rs-row-remove" data-rs-remove aria-label="이 일정 삭제">×</button>`;
  row.querySelector('[data-f=title]').value=m.title||'';row.querySelector('[data-f=date]').value=m.date||'';row.querySelector('[data-f=done]').checked=!!m.done;
  return row;
}
function openProject(project=null){
  if(!requireAdmin())return;
  editing=project?{type:'project',record:structuredClone(project)}:{type:'project',record:null};pending=null;
  $('rs-project-form').reset();$('rs-project-error').textContent='';
  $('rs-project-title').textContent=project?'과제 수정':'과제 추가';$('rs-project-save').textContent=project?'변경 저장':'과제 저장';
  $('rs-project-delete').hidden=!project;$('rs-p-archived-row').hidden=!project;
  const p=project||{};
  for(const [id,key] of [['name','name'],['short','short'],['number','number'],['agency','agency'],['start','starts_on'],['end','ends_on'],['ack-en','ack_en'],['ack-ko','ack_ko'],['ack-patent','ack_patent'],['note','note']])$('rs-p-'+id).value=p[key]??'';
  $('rs-p-archived').checked=!!p.archived;
  $('rs-p-targets').replaceChildren(...(p.targets?.length?p.targets:[{}]).map(targetRowForm));
  $('rs-p-milestones').replaceChildren(...(p.milestones||[]).map(milestoneRowForm));
  $('rs-project-dialog').showModal();$('rs-p-name').focus();
}
function readProject(){
  const value=(row,name)=>row.querySelector(`[data-f=${name}]`);
  return {name:$('rs-p-name').value,short:$('rs-p-short').value,number:$('rs-p-number').value,agency:$('rs-p-agency').value,starts_on:$('rs-p-start').value,ends_on:$('rs-p-end').value,
    ack_en:$('rs-p-ack-en').value,ack_ko:$('rs-p-ack-ko').value,ack_patent:$('rs-p-ack-patent').value,note:$('rs-p-note').value,archived:$('rs-p-archived').checked,
    targets:[...$('rs-p-targets').children].map(row=>({id:row.dataset.id,metric:value(row,'metric').value,label:value(row,'label').value,count:value(row,'count').value,due_on:value(row,'due_on').value,unit:row.dataset.unit,note:row.dataset.note})),
    milestones:[...$('rs-p-milestones').children].map(row=>({id:row.dataset.id,title:value(row,'title').value,date:value(row,'date').value,done:value(row,'done').checked})).filter(m=>m.title.trim()||m.date)};
}
function syncOutputKind(output=null){
  const k=OUTPUT_KINDS[$('rs-o-kind').value],grades=Object.entries(k.grades);
  $('rs-o-grade-field').hidden=!grades.length;$('rs-o-grade').innerHTML=grades.map(([id,label])=>`<option value="${id}">${label}</option>`).join('');
  const sample={kind:$('rs-o-kind').value};
  $('rs-o-status').innerHTML=k.statuses.map(s=>`<option value="${s}">${esc(statusLabel({...sample,status:s}))}</option>`).join('');
  if(output){if(grades.length)$('rs-o-grade').value=output.grade;$('rs-o-status').value=output.status;}
  $('rs-o-date-label').textContent=k.dateLabel+' · 선택';$('rs-o-venue-label').textContent=k.venueLabel+' · 선택';$('rs-o-identifier-label').textContent=k.identifierLabel+' · 선택';
}
function openOutput(output=null,projectID=null){
  if(!requireAdmin())return;
  editing={type:'output',record:output?structuredClone(output):null};pending=null;
  $('rs-output-form').reset();$('rs-output-error').textContent='';
  $('rs-output-title').textContent=output?'실적 수정':'실적 추가';$('rs-output-save').textContent=output?'변경 저장':'실적 저장';$('rs-output-delete').hidden=!output;
  const o=output||{kind:'paper',acks:projectID?[{project_id:projectID,target_id:null,text:''}]:[]};
  $('rs-o-kind').value=o.kind;syncOutputKind(output);
  for(const [id,key] of [['title','title'],['date','date'],['authors','authors'],['venue','venue'],['identifier','identifier'],['link','link'],['note','note']])$('rs-o-'+id).value=o[key]??'';
  const choices=doc.projects.filter(p=>!p.archived||o.acks.some(a=>a.project_id===p.id)).sort((a,b)=>a.ends_on.localeCompare(b.ends_on));
  $('rs-o-acks').innerHTML=choices.map(p=>{
    const ack=o.acks.find(a=>a.project_id===p.id);
    return `<div class="rs-ack-option" data-rs-ack="${p.id}"><label class="admin-check"><input type="checkbox" data-f="on"${ack?' checked':''}><span><strong>${esc(projectName(p))}</strong>${p.number?` <code>${esc(p.number)}</code>`:''}${p.archived?' · 보관':''}</span></label>
      <div class="rs-ack-detail"${ack?'':' hidden'}><label class="field">반영할 목표<select data-f="target"><option value="">자동 · 종류에 맞는 목표에 반영</option>${p.targets.map(t=>`<option value="${t.id}">${esc(targetLabel(t))} ${t.count}${esc(METRICS[t.metric].unit)}${t.due_on?' · '+day(t.due_on):''}</option>`).join('')}<option value="none">집계하지 않음</option></select></label><label class="field">실제로 적은 사사문구 · 표준 문구와 다를 때만<textarea data-f="text" maxlength="1200" rows="2" placeholder="비워 두면 과제의 표준 사사문구로 표시돼요."></textarea></label></div></div>`;}).join('')||'<p class="rs-muted">먼저 과제를 등록하면 이 실적에 사사한 과제를 고를 수 있어요.</p>';
  for(const option of $('rs-o-acks').querySelectorAll('[data-rs-ack]')){
    const ack=o.acks.find(a=>a.project_id===option.dataset.rsAck);
    if(ack){option.querySelector('[data-f=target]').value=ack.target_id||'';option.querySelector('[data-f=text]').value=ack.text||'';}
  }
  $('rs-output-dialog').showModal();$('rs-o-title').focus();
}
function readOutput(){
  return {kind:$('rs-o-kind').value,grade:$('rs-o-grade').value,status:$('rs-o-status').value,title:$('rs-o-title').value,date:$('rs-o-date').value,authors:$('rs-o-authors').value,venue:$('rs-o-venue').value,
    identifier:$('rs-o-identifier').value,link:$('rs-o-link').value,note:$('rs-o-note').value,
    acks:[...$('rs-o-acks').querySelectorAll('[data-rs-ack]')].filter(option=>option.querySelector('[data-f=on]').checked).map(option=>({project_id:option.dataset.rsAck,target_id:option.querySelector('[data-f=target]').value||null,text:option.querySelector('[data-f=text]').value}))};
}
async function commit(operation,errorID,done){
  if(saving||access().busy){$(errorID).textContent='앞선 저장이 끝난 뒤 다시 시도해 주세요.';return false;}
  saving=true;render();
  try{
    const next=await runAdminTask(token=>store.save(token,operation));
    if(next.revision>=doc.revision)doc=next;
    loaded=true;loadError='';lastRead=Date.now();done?.();return true;
  }catch(error){$(errorID).textContent=error.message||'저장하지 못했어요. 다시 시도해 주세요.';return false;}
  finally{saving=false;render();notify();}
}
async function saveRecord(event,type){
  event.preventDefault();
  const errorID=`rs-${type}-error`;$(errorID).textContent='';
  if(!access().unlocked){openDashboardLogin();return;}
  try{
    const input=type==='project'?readProject():readOutput(),signature=JSON.stringify(input),previous=editing?.record||null;
    // Reuse the same record for a retry so a save whose reply was lost is not duplicated.
    if(pending?.signature!==signature){
      const at=new Date().toISOString(),options={by:session.name,at,previous};
      const record=type==='project'?makeProject(input,options):makeOutput(input,doc.projects,options);
      pending={signature,operation:{type:type+'_save',[type]:record,base:previous?.updated_at??null,at}};
    }
    const created=!previous;
    const savedID=pending.operation[type].id;
    await commit(pending.operation,errorID,()=>{
      $(`rs-${type}-dialog`).close();pending=null;editing=null;refocus=[type+'-edit',savedID];
      feedback(type==='project'?(created?'과제를 추가했어요.':'과제를 수정했어요.'):(created?'실적을 추가했어요.':'실적을 수정했어요.'));
      // Show the list the saved record now lives in.
      if(type==='project'){tab='projects';phase=input.archived?'archived':input.ends_on<today()?'ended':'active';}
    });
  }catch(error){$(errorID).textContent=error.message||'입력 내용을 확인해 주세요.';}
}
function askDelete(type){
  const record=editing?.record;if(!record)return;
  confirming={type,record};$('rs-confirm-error').textContent='';
  $('rs-confirm-title').textContent=type==='project'?'과제를 삭제할까요?':'실적을 삭제할까요?';
  $('rs-confirm-text').textContent=`‘${type==='project'?record.name:record.title}’ 기록을 삭제해요. 삭제한 기록은 이 화면에서 되돌릴 수 없어요.${type==='project'?' 잠시 숨기려면 과제 수정의 ‘보관’을 이용해 주세요.':''}`;
  $('rs-confirm-dialog').showModal();$('rs-confirm-cancel').focus();
}
async function confirmDelete(){
  if(!confirming)return;
  const {type,record}=confirming;
  await commit({type:type+'_delete',id:record.id,base:record.updated_at,at:new Date().toISOString()},'rs-confirm-error',()=>{
    $('rs-confirm-dialog').close();$(`rs-${type}-dialog`).close();confirming=null;editing=null;
    feedback(type==='project'?'과제를 삭제했어요.':'실적을 삭제했어요.');
  });
}

function bind(){
  $('rs-refresh').onclick=()=>void read();
  $('rs-admin').onclick=()=>openDashboardLogin();
  $('rs-add-project').onclick=()=>openProject();
  $('rs-add-output').onclick=()=>openOutput();
  root.addEventListener('click',async event=>{
    const tabButton=event.target.closest('[data-rs-tab]');if(tabButton){tab=tabButton.dataset.rsTab;render();return;}
    const phaseButton=event.target.closest('[data-rs-phase]');if(phaseButton){phase=phaseButton.dataset.rsPhase;render();return;}
    const kindButton=event.target.closest('[data-rs-kind]');if(kindButton){kind=kindButton.dataset.rsKind;render();return;}
    const copy=event.target.closest('[data-rs-copy]');
    if(copy){try{await navigator.clipboard.writeText(copy.dataset.rsCopy);feedback(copy.dataset.rsCopied||'사사문구를 복사했어요.');const label=copy.textContent;copy.textContent='복사됨';setTimeout(()=>{if(copy.isConnected)copy.textContent=label;},2000);}catch{feedback('복사하지 못했어요. 문구를 직접 선택해서 복사해 주세요.');}return;}
    const action=event.target.closest('[data-rs-action]');if(!action)return;
    const id=action.dataset.rsId;
    if(action.dataset.rsAction==='project-edit')openProject(doc.projects.find(p=>p.id===id));
    else if(action.dataset.rsAction==='output-for')openOutput(null,id);
    else if(action.dataset.rsAction==='output-edit')openOutput(doc.outputs.find(o=>o.id===id));
  });
  root.querySelector('.rs-tabs').addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const tabs=[...root.querySelectorAll('[data-rs-tab]')],index=tabs.indexOf(document.activeElement);if(index<0)return;
    event.preventDefault();
    const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
    tab=tabs[next].dataset.rsTab;render();tabs[next].focus();
  });
  root.addEventListener('toggle',event=>{const key=event.target.dataset?.rsOpen;if(key){if(event.target.open)open.add(key);else open.delete(key);}},true);
  $('rs-project-filter').onchange=()=>{projectFilter=$('rs-project-filter').value;render();};
  $('rs-query').oninput=()=>{query=$('rs-query').value;render();};
  $('rs-p-target-add').onclick=()=>{if($('rs-p-targets').children.length>=30)return;const row=targetRowForm();$('rs-p-targets').append(row);row.querySelector('select').focus();};
  $('rs-p-milestone-add').onclick=()=>{if($('rs-p-milestones').children.length>=40)return;const row=milestoneRowForm();$('rs-p-milestones').append(row);row.querySelector('input').focus();};
  for(const id of ['rs-p-targets','rs-p-milestones'])$(id).addEventListener('click',event=>{const button=event.target.closest('[data-rs-remove]');if(button)button.closest('.rs-row').remove();});
  $('rs-p-targets').addEventListener('change',event=>{if(event.target.dataset.f==='metric')syncTargetRow(event.target.closest('.rs-row'));});
  $('rs-o-kind').onchange=()=>syncOutputKind();
  $('rs-o-acks').addEventListener('change',event=>{if(event.target.dataset.f==='on')event.target.closest('[data-rs-ack]').querySelector('.rs-ack-detail').hidden=!event.target.checked;});
  $('rs-project-form').addEventListener('submit',event=>void saveRecord(event,'project'));
  $('rs-output-form').addEventListener('submit',event=>void saveRecord(event,'output'));
  $('rs-project-delete').onclick=()=>askDelete('project');
  $('rs-output-delete').onclick=()=>askDelete('output');
  $('rs-confirm-ok').onclick=()=>void confirmDelete();
  $('rs-confirm-cancel').onclick=()=>{if(!saving)$('rs-confirm-dialog').close();};
  for(const id of ['rs-project-dialog','rs-output-dialog','rs-confirm-dialog']){
    const dialog=$(id);
    dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
    for(const button of dialog.querySelectorAll('[data-rs-close]'))button.addEventListener('click',()=>{if(!saving)dialog.close();});
  }
}
