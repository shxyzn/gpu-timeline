import {dashboardView} from '../app.js?patch=workspace-3';
import {GATE} from './gate.js?v=workspace-3a';
import {currentSession} from './session.js?v=workspace-3a';
import {researchState} from './research-board.js?v=workspace-3a';
import {availableCurrentView} from './availability-model.js?v=2.1-as';
import {ddayLabel} from './research-model.js?v=workspace-3a';

// Shell of the test-server workspace: one bar to move between the home, the research tracker
// and the GPU dashboard, and a home that summarises both. The URL hash names the view, so the
// browser's Back button and shared links work; GPU tab names (#now, #timeline, ...) stay as is.
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const day=date=>{const [y,m,d]=date.split('-').map(Number);return `${y}. ${m}. ${d}.`;};
const GPU_ANCHORS=new Set(['now','timeline','resources','servers','parcel','more','release-video','api-usage-board','patch-notes']);
const TITLES={home:'CVML Workspace',research:'연구과제 · CVML Workspace',gpu:'GPU 대시보드 · CVML Workspace'};
const session=currentSession(GATE),home=$('workspace-home');
let current=null,drawnHome='';

const viewOf=()=>{const anchor=location.hash.slice(1);return anchor==='research'?'research':GPU_ANCHORS.has(anchor)?'gpu':'home';};
function show(){
  const view=viewOf();
  for(const section of document.querySelectorAll('[data-ws-section]'))section.hidden=section.dataset.wsSection!==view;
  for(const link of document.querySelectorAll('[data-ws-view]')){if(link.dataset.wsView===view)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
  document.title=TITLES[view];
  if(view===current)return;
  const first=current===null;current=view;
  if(!first)window.scrollTo({top:0});
  // A film in a hidden view would keep playing, heard but with no control in sight.
  for(const media of document.querySelectorAll('[data-ws-section][hidden] video,[data-ws-section][hidden] audio'))media.pause();
  document.dispatchEvent(new CustomEvent('workspace:view',{detail:view}));
}

function researchCard(){
  const {loaded,loadError,overview}=researchState();
  // After a failed refresh the last records are still the best answer; say so instead of hiding them.
  if(!loaded||!overview)return loadError?{title:'기록을 불러오지 못했어요',kind:'',facts:[esc(loadError)]}:{title:'불러오는 중…',kind:'',facts:['과제와 실적 기록을 확인하고 있어요.']};
  const c=overview.counts,next=overview.next,late=overview.overdue.length,verdict=overview.verdict;
  if(verdict==='empty')return {title:'등록된 과제가 없어요',kind:'',facts:['과제와 목표 실적을 등록하면 남은 실적과 기한이 여기에 표시돼요.']};
  const facts=[];
  if(c.remaining&&c.pending)facts.push(`그중 <strong>${c.pending}건</strong>은 진행 중 · ${c.gap?`새로 시작할 실적 <strong>${c.gap}건</strong>`:'새로 시작할 실적은 없어요'}`);
  facts.push([`진행 중인 과제 <strong>${c.projects}개</strong>`,c.untargeted?`목표 미등록 <strong>${c.untargeted}개</strong>`:'',c.ended?`종료 ${c.ended}개`:''].filter(Boolean).join(' · '));
  if(verdict==='untargeted')facts.push('과제에 목표 실적을 등록하면 남은 실적을 계산해요.');
  if(next)facts.push(`가장 가까운 기한 <strong>${esc(ddayLabel(next.days))}</strong> · ${esc(day(next.date))} ${esc(next.project.short||next.project.name)}`);
  if(late||c.unacknowledged)facts.push([late?`기한 지남 <strong>${late}건</strong>`:'',c.unacknowledged?`사사 과제 미지정 <strong>${c.unacknowledged}건</strong>`:''].filter(Boolean).join(' · '));
  if(loadError)facts.push('최신 기록을 불러오지 못해 마지막으로 받은 내용을 보여 드려요.');
  // "모든 목표 달성" is the model's call (researchOverview): never for a project without targets
  // or while a target of an ended project is still unmet.
  const title={need:`실적 ${c.remaining}<small>건</small> 더 필요`,late:`기한 지난 목표 ${c.late_targets}<small>건</small>`,met:'모든 목표 달성',untargeted:'목표 실적 미등록',idle:'진행 중인 과제가 없어요'}[verdict];
  return {title,kind:{need:'need',late:'late',met:'ok'}[verdict]||'',facts};
}
function gpuCard(){
  const view=dashboardView();
  // This module runs after the dashboard core has started, so a missing config is a failed one.
  if(!view.config)return {title:'불러오지 못했어요',kind:'',facts:['대시보드 설정을 불러오지 못했어요. 페이지를 새로고침해 주세요.']};
  if(!view.lastFetch)return {title:'불러오는 중…',kind:'',facts:['서버 상태를 확인하고 있어요.']};
  const now=Date.now(),g=availableCurrentView(view.servers,view.telemetryServers,now,view.config.stale_after_seconds||1200);
  const facts=[`점유 <strong>${g.busy}</strong> · 확인 필요 <strong>${g.unknown}</strong> · API 실험 <strong>${g.apiRunning}</strong>`];
  if(g.alerts.length)facts.push(`${g.alerts.map(a=>esc(a.server.name)).join(', ')} · 수신 상태 확인 필요`);
  if(g.excluded.length)facts.push(`${g.excluded.map(e=>esc(e.server.name)).join(', ')} · A/S로 집계 제외`);
  return {title:`여유 GPU ${g.idle}<small> / ${g.total}</small>`,kind:g.idle?'ok':'',facts};
}
function card(href,label,content,go){
  return `<a class="ws-card" href="${href}"><span class="ws-card-label">${label}</span><strong class="ws-card-title ${content.kind}">${content.title}</strong><ul class="ws-facts">${content.facts.map(f=>`<li>${f}</li>`).join('')}</ul><span class="ws-card-go">${go} →</span></a>`;
}
function renderHome(){
  if(!home||!session)return;
  const {overview}=researchState(),upcoming=(overview?.deadlines||[]).filter(d=>d.days>=0).slice(0,5),late=overview?.overdue||[];
  const item=d=>`<li class="${d.days<0?'late':''}"><span class="rs-due ${d.days<0?'late':d.days<=30?'soon':d.days<=90?'near':'far'}"><strong>${esc(ddayLabel(d.days))}</strong>${esc(day(d.date))}</span><div><strong>${esc(d.title)}</strong><span>${esc(d.project.short||d.project.name)}</span></div></li>`;
  const html=`<span class="ws-eyebrow">CVML WORKSPACE</span><h1 id="ws-home-title">${esc(session.name)}님, 안녕하세요.</h1><p>연구실 과제의 남은 실적과 GPU 현황을 한곳에서 확인해요.</p>
    <div class="ws-cards">${card('#research','연구과제',researchCard(),'과제별 실적 보기')}${card($('workspace-gpu-link')?.getAttribute('href')||'#now','GPU 대시보드',gpuCard(),'GPU·실험 현황 보기')}</div>
    ${late.length||upcoming.length?`<section class="ws-upcoming" aria-labelledby="ws-upcoming-title"><h2 id="ws-upcoming-title">챙겨야 할 기한</h2><ul class="rs-deadlines">${[...late.slice(0,3),...upcoming].map(item).join('')}</ul></section>`:''}`;
  if(drawnHome!==html){home.innerHTML=html;drawnHome=html;}
}

// The bar's GPU link and the home card return to the dashboard tab that is open, however it was
// chosen: a click, the arrow keys, a button inside the dashboard, or the address itself.
function syncGpuLink(){
  const link=$('workspace-gpu-link'),href='#'+(document.querySelector('#gpu-workspace [data-panel][aria-selected="true"]')?.dataset.panel||'now');
  if(link&&link.getAttribute('href')!==href){link.setAttribute('href',href);renderHome();}
}

if(session){
  const tabs=document.querySelector('#gpu-workspace [role=tablist]');
  if(tabs)new MutationObserver(syncGpuLink).observe(tabs,{attributes:true,subtree:true,attributeFilter:['aria-selected']});
  window.addEventListener('hashchange',show);
  document.addEventListener('dashboard:render',()=>{document.title=TITLES[current||viewOf()];renderHome();});
  document.addEventListener('research:change',renderHome);
  show();syncGpuLink();renderHome();
  // Lets scripts and checks tell when the bar and the first view are wired up.
  document.body.dataset.workspace='ready';
}
