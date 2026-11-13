import {dashboardView,monitoringAccess,saveTestAPIUsageHistory} from '../app.js?patch=workspace-3';
import {dollars,usageStatus} from '../openrouter-model.js?v=1.2.0';
import {emptyHistory,chartData,needsRecording} from './api-usage-model.js?v=2.1.1';
import {APIUsageStore} from './api-usage-store.js?v=2.1.1';

const $=id=>document.getElementById(id),board=$('api-usage-board');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors=['#0071e3','#009e85','#885bd7','#d78114','#d64c74','#4b7b8f','#5b8e35','#b76337'];
const color=index=>colors[index%colors.length];
const stamp=at=>at?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(at))+' KST':'아직 없음';
const short=day=>`${Number(day.slice(5,7))}/${Number(day.slice(8,10))}`;
let history=emptyHistory(),store=null,loaded=false,loading=false,recording=false,loadError='',saveError='',lastRead=0,retryAt=0;
let key='all',days=7,metric='daily',plotWidth=0,optionsSignature='';

if(board){
  board.innerHTML=`<div class="api-usage-heading"><div><div class="api-usage-title-line"><h3 id="api-usage-title">API 사용량 추이</h3><span>v2.1.1</span></div><p>키별 사용액의 흐름을 확인하세요.</p></div><button type="button" id="api-usage-reload">이력 새로고침</button></div>
  <div class="api-usage-controls"><label>API 키<select id="api-usage-key" aria-label="그래프 API 키"><option value="all">전체 API 키</option></select></label><label>표시<select id="api-usage-metric" aria-label="사용량 그래프 종류"><option value="daily">일별 사용액</option><option value="cumulative">누적 사용액</option></select></label><div class="api-usage-period" role="group" aria-label="사용량 그래프 기간">${[7,30,90].map(d=>`<button type="button" data-usage-days="${d}" aria-pressed="${d===7}">${d}일</button>`).join('')}</div></div>
  <div class="api-usage-summary"><div><span id="api-usage-amount-label">기록된 일별 사용액</span><strong id="api-usage-amount">—</strong><p id="api-usage-basis"></p></div><div class="api-usage-coverage"><span id="api-usage-coverage"></span><small id="api-usage-updated"></small></div></div>
  <div id="api-usage-legend" class="api-usage-legend"></div><div id="api-usage-plot" class="api-usage-plot"></div><p id="api-usage-chart-note" class="api-usage-chart-note"></p>
  <p id="api-usage-state" class="api-usage-state" role="status" aria-live="polite"></p><details class="api-usage-records"><summary>관측 기록 보기</summary><div id="api-usage-table" class="api-usage-table"></div></details><p class="api-usage-help">USD · 일별 사용액은 UTC 날짜별 마지막 조회값이며 하루 최종 정산액이 아닙니다. 미관측 기간은 0으로 채우지 않습니다.<br>테스트 페이지에서 관리자 로그인 중일 때 조회 이력을 저장합니다. 최대 90일 이력 · BYOK 사용액은 별도입니다.</p>`;
  $('api-usage-key').onchange=()=>{key=$('api-usage-key').value;render();};
  $('api-usage-metric').onchange=()=>{metric=$('api-usage-metric').value;render();};
  board.addEventListener('click',event=>{const button=event.target.closest('[data-usage-days]');if(button){days=Number(button.dataset.usageDays);render();}});
  $('api-usage-reload').onclick=async()=>{retryAt=0;await read();void record();};
  const resize=new ResizeObserver(entries=>{const width=Math.round(entries[0].contentRect.width);if(width>0&&width!==plotWidth){plotWidth=width;render();}});resize.observe($('api-usage-plot'));
  document.addEventListener('dashboard:render',update);update();
}

function setHTML(element,html){if(element.innerHTML!==html)element.innerHTML=html;}
function render(){
  const tokens=dashboardView().tokens;
  if(key!=='all'&&!tokens.some(t=>t.id===key))key='all';
  const options='<option value="all">전체 API 키</option>'+tokens.map(t=>`<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  if(options!==optionsSignature){optionsSignature=options;$('api-usage-key').innerHTML=options;}$('api-usage-key').value=key;
  for(const b of board.querySelectorAll('[data-usage-days]'))b.setAttribute('aria-pressed',String(Number(b.dataset.usageDays)===days));
  const data=chartData(history,tokens,{days,key}),daily=metric==='daily';
  $('api-usage-amount-label').textContent=daily?'기록된 일별 사용액':'마지막 관측 누적 사용액';
  $('api-usage-amount').textContent=dollars(daily?data.dailyTotal:data.cumulativeTotal);
  $('api-usage-basis').textContent=daily?'각 UTC 날짜의 마지막 조회값 합계 · 미관측 날짜 제외':'선택한 키별 마지막 조회값 합계';
  $('api-usage-coverage').textContent=daily?`${days}일 중 ${data.observedDays}일 관측`:`${data.sampleCount}개 조회 기록`;
  $('api-usage-updated').textContent='마지막 관측 '+stamp(data.lastAt);
  setHTML($('api-usage-legend'),data.selected.map((t,i)=>`<span><i style="background:${color(i)}"></i>${esc(t.name)}</span>`).join(''));
  setHTML($('api-usage-plot'),plot(data));
  $('api-usage-chart-note').textContent=daily?'날짜 기준 UTC · 비어 있는 날짜는 기록 없음 · 금액 위에 마우스를 올리면 상세를 볼 수 있어요.':`조회 시각 기준 KST · 실제 관측점만 표시${data.resets?' · 누적값 감소 '+data.resets+'회 구간 분리':''} · 긴 수집 공백은 선으로 연결하지 않습니다.`;
  const stale=data.selected.some(t=>usageStatus(t)!=='조회 완료');
  $('api-usage-state').textContent=loadError||saveError||(loading?'공용 이력 불러오는 중…':recording?'관측 이력 저장 중…':!data.sampleCount?'아직 관측 기록이 없습니다. 키 사용량을 갱신하면 그래프가 시작됩니다.':stale?'마지막 조회 기록입니다. 최신 사용액은 연결된 키에서 갱신해 주세요.':!history.samples.length?'첫 관측값입니다. 조회 이력이 쌓이면 날짜별 변화를 볼 수 있어요.':`${data.selected.length}개 키의 관측 기록${monitoringAccess().unlocked?' · 관리자 로그인 중':''}`);
  $('api-usage-state').classList.toggle('warning',!!(loadError||saveError));
  $('api-usage-reload').disabled=loading||recording;
  const rows=data.daily.filter(d=>d.observed);
  setHTML($('api-usage-table'),rows.length?`<table><caption>일별 마지막 관측값 · 날짜 UTC</caption><thead><tr><th scope="col">날짜</th>${data.selected.map(t=>`<th scope="col">${esc(t.name)}</th>`).join('')}<th scope="col">관측 합계</th><th scope="col">마지막 조회 · KST</th></tr></thead><tbody>${rows.map(d=>`<tr><th scope="row">${d.day}</th>${data.selected.map(t=>`<td>${Object.hasOwn(d.values,t.id)?dollars(d.values[t.id]):'—'}</td>`).join('')}<td>${dollars(d.total)}${d.observed<data.selected.length?'<small>일부 키 미관측</small>':''}</td><td>${esc(stamp(d.last_at))}</td></tr>`).join('')}</tbody></table>`:'<p class="api-usage-empty-records">선택 기간에 기록된 일별 사용액이 없습니다.</p>');
}
function plot(data){
  if(!data.sampleCount)return '<div class="api-usage-empty"><strong>사용량 기록을 기다리고 있어요.</strong><span>과거 기록을 임의로 채우지 않고, 실제 조회값부터 표시합니다.</span></div>';
  const daily=metric==='daily',w=Math.max(260,plotWidth||800),h=240,left=52,right=14,top=20,bottom=40,pw=w-left-right,ph=h-top-bottom;
  const values=daily?data.daily.map(d=>d.total).filter(v=>v!==null):data.series.flatMap(s=>s.points.map(p=>p.total));
  if(!values.length)return '<div class="api-usage-empty"><strong>일별 금액을 확인할 수 없어요.</strong><span>누적 사용액 보기에서 조회 기록을 확인해 주세요.</span></div>';
  const maximum=Math.max(...values),limit=maximum>0?maximum*1.1:1,max=Number.isFinite(limit)?limit:maximum;
  const y=v=>top+ph*(1-v/max),axis=v=>v===0?'$0':v>=1000?'$'+(v/1000).toLocaleString('en-US',{maximumFractionDigits:1})+'k':v>=1?'$'+v.toLocaleString('en-US',{maximumFractionDigits:1}):'$'+v.toLocaleString('en-US',{maximumSignificantDigits:2});
  let svg=`<svg role="img" aria-label="${daily?'일별':'누적'} API 사용액 그래프, ${days}일" viewBox="0 0 ${w} ${h}" width="100%" height="${h}"><title>${daily?'일별 사용액 · UTC':'누적 사용액 · 조회 시각 KST'}</title><desc>기록된 관측값만 표시합니다. 정확한 금액은 관측 기록 표에서 확인할 수 있습니다.</desc>`;
  for(let i=0;i<=4;i++){const value=max*i/4,at=y(value);svg+=`<line x1="${left}" y1="${at}" x2="${w-right}" y2="${at}" stroke="#e8edf3"/><text x="${left-9}" y="${at+3}" text-anchor="end">${axis(value)}</text>`;}
  const tickEvery=Math.max(1,Math.ceil(days/(w<500?4:7)));
  data.daily.forEach((d,i)=>{
    const center=left+(i+.5)*pw/days;
    if(i%tickEvery===0||i===days-1)svg+=`<text x="${center}" y="${h-15}" text-anchor="middle">${short(d.day)}</text>`;
    if(!daily)return;
    const barWidth=Math.max(1,pw/days*.6),x=center-barWidth/2;
    const title=d.day+' UTC · '+data.selected.map(t=>t.name+': '+(Object.hasOwn(d.values,t.id)?dollars(d.values[t.id]):'기록 없음')).join(' · ');
    if(!d.observed||d.total===null){svg+=`<rect class="api-usage-missing" x="${x}" y="${top+ph-4}" width="${barWidth}" height="4" rx="1"><title>${esc(title)}</title></rect>`;return;}
    let sum=0;
    data.selected.forEach((t,index)=>{if(!Object.hasOwn(d.values,t.id))return;const amount=d.values[t.id],height=amount/max*ph;svg+=`<rect data-usage-day="${d.day}" x="${x}" y="${y(sum+amount)}" width="${barWidth}" height="${Math.max(height,amount===0?2:0.7)}" rx="${height>5?2:0}" fill="${color(index)}"><title>${esc(title)}</title></rect>`;sum+=amount;});
  });
  if(!daily){
    const x=at=>left+(Date.parse(at)-data.start)/(data.end-data.start)*pw;
    data.series.forEach((s,i)=>{for(const segment of s.segments){if(segment.length>1)svg+=`<path d="${segment.map((p,j)=>(j?'L':'M')+x(p.at).toFixed(2)+','+y(p.total).toFixed(2)).join(' ')}" fill="none" stroke="${color(i)}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;for(const p of segment)svg+=`<circle cx="${x(p.at)}" cy="${y(p.total)}" r="3.2" fill="${color(i)}" stroke="white" stroke-width="1"><title>${esc(s.name+' · '+stamp(p.at)+' · '+dollars(p.total))}</title></circle>`;}});
  }
  return svg+'</svg>';
}
async function read(){
  if(!store||loading)return;loading=true;render();
  try{const next=await store.readPublic();if(next.revision>=history.revision)history=next;loaded=true;loadError='';}
  catch{loadError='공용 이력을 불러오지 못했어요. 마지막 기록을 유지합니다.';}
  finally{loading=false;lastRead=Date.now();render();}
}
async function record(){
  const access=monitoringAccess();
  if(!store||!loaded||loadError||recording||!access.unlocked||access.busy||Date.now()<retryAt||!needsRecording(history,dashboardView().tokens))return;
  recording=true;render();
  try{const next=await saveTestAPIUsageHistory();if(next.revision>=history.revision)history=next;saveError='';}
  catch{saveError='이력을 저장하지 못했어요. 표시 중인 조회값은 유지됩니다. 이력 새로고침으로 다시 시도할 수 있어요.';retryAt=Date.now()+60000;}
  finally{recording=false;render();}
}
function update(){
  if(!board)return;
  const view=dashboardView();if(!store&&view.config?.dashboard)store=new APIUsageStore(view.config.dashboard);
  render();
  if(store&&Date.now()-lastRead>=60000&&!loading)void read().then(record);
  else void record();
}
