import {demoSnapshot} from './demo.js';
import {HOUR,timestamp,health,gpuState,layoutJobs} from './model.js';
const $=id=>document.getElementById(id);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(value,options={})=>{const t=typeof value==='number'?value:timestamp(value);return t===null?'미등록':new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',...options}).format(t);};
const time=v=>fmt(v,{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const ago=t=>{const minutes=Math.max(0,Math.floor((Date.now()-(timestamp(t)??Date.now()))/60000));return minutes<1?'방금':minutes<60?`${minutes}분 전`:`${Math.floor(minutes/60)}시간 ${minutes%60}분 전`;};
const jobLabel=j=>[j.name,j.owner].filter(Boolean).join(' · ');
const statusLabels={running:'실행 중',planned:'예정',completed:'완료',failed:'실패',cancelled:'취소',stopped:'프로세스 종료 · 결과 미확인',unknown:'확인 필요'};
let config,servers=[],hours=72,offset=0,lastFetch=null,fetchErrors=0,selected=null;
const demo=demoSnapshot();
function viewWindow(){const now=Date.now();const anchor=Math.floor((now+9*HOUR)/(24*HOUR))*24*HOUR-9*HOUR;return {now,start:anchor+(offset*hours)*HOUR,end:anchor+(offset*hours+hours)*HOUR};}
async function readJSON(url){const u=new URL(url,location.href);u.searchParams.set('_',String(Math.floor(Date.now()/60000)));const r=await fetch(u,{cache:'no-store',signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();}
function checkServer(s,id){
  if(s.server_id!==id||!Array.isArray(s.gpus)||!Array.isArray(s.jobs))throw new Error('잘못된 서버 데이터');
  const ids=new Set();for(const g of s.gpus){if(typeof g.uuid!=='string'||ids.has(g.uuid)||!Number.isInteger(g.index))throw new Error('잘못된 GPU 데이터');ids.add(g.uuid);}
  for(const j of s.jobs){if(typeof j.id!=='string'||!Array.isArray(j.gpu_uuids))throw new Error('잘못된 실험 데이터');}
  return s;
}
async function refresh(){
  $('refresh').disabled=true;
  try{
    if(config.mode==='demo'){servers=demo;fetchErrors=0;}
    else{
      const results=await Promise.allSettled(config.servers.map(async item=>checkServer(await readJSON(new URL(item.file,config.data_base_url).href),item.id)));
      fetchErrors=0;
      servers=results.map((r,i)=>{if(r.status==='fulfilled')return r.value;fetchErrors++;const item=config.servers[i],previous=servers.find(s=>s.server_id===item.id);return {...(previous||{server_id:item.id,name:item.name,gpus:[],jobs:[],updated_at:null,collector_ok:false}),fetch_error:true};});
    }
    lastFetch=Date.now();render();
  }catch(error){$('notice').textContent='데이터를 불러오지 못했습니다. 마지막 수신 상태를 표시합니다.';$('notice').className='notice error';}
  finally{$('refresh').disabled=false;}
}
function render(){
  const {now,start,end}=viewWindow();const stale=config.stale_after_seconds||1200;
  document.title=config.title||'CVML GPU Timeline';$('clock').textContent=fmt(now,{hour:'2-digit',minute:'2-digit',hourCycle:'h23'})+' KST';$('mode').textContent=config.mode==='demo'?'예시 데이터':'조회 전용';
  const states=servers.flatMap(s=>s.gpus.map(g=>gpuState(s,g,now,stale)));
  const unknownServers=servers.filter(s=>!health(s,now,stale).ok).length;
  const stats=[['전체 GPU',states.length,'개',`${servers.length}개 서버`,''],['현재 점유',states.filter(x=>x==='busy').length,'개','등록 실험·실제 사용 기준','purple'],['현재 여유',states.filter(x=>x==='idle').length,'개','예약·독점 사용은 보장하지 않음','green'],['확인 필요',states.filter(x=>x==='unknown').length,'개',`${unknownServers}개 서버 수신 상태 확인`,'amber']];
  $('overview').innerHTML=stats.map(([label,value,unit,note,color])=>`<div class="stat"><span>${label}</span><strong class="${color}">${value}<small>${unit}</small></strong><p>${note}</p></div>`).join('');
  $('window-label').textContent=fmt(start,{year:'numeric',month:'long',day:'numeric'})+' — '+fmt(end-1,{month:'long',day:'numeric'});
  $('notice').className=fetchErrors?'notice error':'notice';
  $('notice').textContent=config.mode==='demo'?'화면 확인용 예시입니다. 실제 서버는 아직 연결되지 않았습니다.':fetchErrors?`${fetchErrors}개 서버의 수신에 실패했습니다. 남아 있는 데이터는 마지막 수신 상태입니다.`:unknownServers?`${unknownServers}개 서버의 갱신이 지연되거나 수집에 문제가 있습니다. 마지막 수신 정보로 표시합니다.`:'';
  const step=hours===24?4:hours===72?12:24,ticks=[];
  for(let h=0;h<=hours;h+=step)ticks.push(`<div class="tick" style="left:${h/hours*100}%"><strong>${fmt(start+h*HOUR,{month:'numeric',day:'numeric'})}</strong><span>${fmt(start+h*HOUR,{hour:'2-digit',hourCycle:'h23'})}</span></div>`);
  const nowX=(now-start)/(end-start)*100;
  const line=nowX>=0&&nowX<=100?`<div class="now-line" style="left:${nowX}%"></div>`:'';
  let html=`<div class="axis"><div class="axis-label">서버 / GPU</div><div class="axis-scale">${ticks.join('')}${nowX>=0&&nowX<=100?`<span class="now-tag" style="left:${nowX}%">현재</span>`:''}</div></div>`;
  servers.forEach((s,si)=>{
    if(!s.gpus.length){html+=`<div class="lane group-start"><div class="gpu-label"><strong>${escape(s.name)}</strong></div><div class="track"><span class="empty-track">서버 데이터 수신 대기</span></div></div>`;return;}
    s.gpus.forEach((g,gi)=>{
      const jobs=s.jobs.filter(j=>j.gpu_uuids.includes(g.uuid));const bars=layoutJobs(jobs,start,end,now);const height=Math.max(84,(Math.max(0,...bars.map(b=>b.lane))+1)*54+30);
      const ok=health(s,now,stale).ok;
      const empty=bars.length?'':!ok?'마지막 상태 · 수신 확인 필요':gpuState(s,g,now,stale)==='busy'?'점유 중 · 표시할 실험 일정 없음':'표시할 실험 없음';
      html+=`<div class="lane ${gi===0?'group-start':''} ${ok?'':'stale'}" style="min-height:${height}px"><div class="gpu-label"><div><strong>${escape(s.name)}</strong><small>${escape(g.name)}</small></div><span class="gpu-num">GPU ${g.index}</span></div><div class="track" style="--grid:${step/hours*100}%">${line}${empty?`<span class="empty-track">${empty}</span>`:''}${bars.map(b=>`<button class="job-bar ${b.job.status==='running'?['','violet','green'][si%3]:escape(b.job.status)} ${b.uncertain?'uncertain':''}" style="left:${b.left}%;width:${Math.min(b.width,100-b.left)}%;top:${20+b.lane*54}px" data-server="${escape(s.server_id)}" data-job="${escape(b.job.id)}" aria-label="${escape(jobLabel(b.job))} · ${escape(statusLabels[b.job.status]||b.job.status)} · ${b.uncertain?'종료 미정 또는 예정 초과':time(b.job.expected_end_at)}">${escape(jobLabel(b.job))}${b.uncertain?' · 종료 확인':''}</button>`).join('')}</div></div>`;
    });
  });
  $('timeline').innerHTML=servers.length?html:'<div class="blank">연결된 서버가 없습니다.</div>';
  $('sync-label').textContent=`화면 조회 ${lastFetch?time(lastFetch):'—'} · ${config.refresh_seconds||60}초마다 확인`;
  $('servers').innerHTML=servers.map(s=>serverCard(s,now,stale)).join('');
  if(selected&&$('detail-dialog').open)fillDetail(selected.server,selected.id);
}
function serverCard(s,now,stale){
  const h=health(s,now,stale);
  const rows=s.gpus.map(g=>{
    const state=gpuState(s,g,now,stale),running=s.jobs.filter(j=>['running','unknown'].includes(j.status)&&j.gpu_uuids.includes(g.uuid));
    const util=Number.isFinite(g.utilization)?g.utilization:null,used=Number.isFinite(g.memory_used_mib)?g.memory_used_mib:null,total=g.memory_total_mib;
    const pct=total>0&&used!==null?Math.min(100,used/total*100):0;
    const giB=v=>Number.isFinite(v)?(v/1024).toFixed(1):'—';
    return `<div class="gpu-detail"><div class="gpu-detail-title"><strong>GPU ${g.index}</strong><small>${state==='unknown'?'확인 필요':state==='busy'?'점유 중':'현재 여유'}</small></div><div class="meter-line"><span>GPU 사용률${h.ok?'':' · 마지막 수신'}</span><span>${util===null?'—':util+'%'}</span></div><div class="meter"><div class="meter-fill" style="width:${Math.max(0,Math.min(100,util||0))}%"></div></div><div class="meter-line"><span>VRAM</span><span>${giB(used)} / ${giB(total)} GiB</span></div><div class="meter"><div class="meter-fill vram" style="width:${pct}%"></div></div>${running.map(j=>`<div class="gpu-experiment"><span>${escape(jobLabel(j))}</span><span>${j.status==='unknown'?'실행 상태 확인 필요':j.expected_end_at?time(j.expected_end_at)+' 예정':'종료 미정'}</span></div>`).join('')}${!running.length&&state==='busy'?'<div class="gpu-experiment"><span>미등록 GPU 사용 감지</span></div>':''}</div>`;
  }).join('');
  return `<article class="server-card"><div class="server-heading"><h3>${escape(s.name)}</h3><span class="state ${h.ok?'':'warning'}">${h.label}</span></div><p class="server-meta">${escape([...new Set(s.gpus.map(g=>g.name))].join(' / ')||'GPU 정보 대기')} · ${s.gpus.length} GPU<br>마지막 수신 ${s.updated_at?ago(s.updated_at):'없음'}</p>${rows||'<p class="server-meta">서버 수집 프로그램의 연결을 확인해 주세요.</p>'}</article>`;
}
function fillDetail(server,id){
  const s=servers.find(x=>x.server_id===server),j=s?.jobs.find(x=>x.id===id);if(!j)return;
  const now=Date.now(),started=timestamp(j.started_at),actualEnd=timestamp(j.ended_at);
  const elapsed=j.status==='unknown'?'실행 상태 확인 필요':started===null||j.status==='planned'?'—':`${Math.max(0,((actualEnd??now)-started)/HOUR).toFixed(1)}시간`;
  const eta=timestamp(j.expected_end_at),isOver=j.status==='running'&&eta!==null&&eta<now;
  const fields=[['서버',s.name],['GPU',s.gpus.filter(g=>j.gpu_uuids.includes(g.uuid)).map(g=>`GPU ${g.index}`).join(', ')],['상태',statusLabels[j.status]||j.status],['시작',time(j.started_at)],['사용 시간',elapsed],['예상 종료',eta===null?'미등록':time(eta)+(isOver?' · 예정 초과':'')],['종료 기준',j.eta_source==='progress'?'진행률 기반 추정':'직접 입력'],['실제 종료',time(j.ended_at)]];
  if(j.owner)fields.splice(1,0,['등록자',j.owner]);
  if(j.progress)fields.push(['진행',`${j.progress.completed} / ${j.progress.total}`]);
  if(j.end_source==='observed')fields.push(['종료 관측','수집 시점에 PID 종료 감지 · 성공 여부 미확인']);
  if(j.execution_source==='gputl-run')fields.push(['기록 방식','gputl run 자동 기록']);
  if(Number.isInteger(j.exit_code))fields.push(['종료 코드',String(j.exit_code)]);
  if(Number.isInteger(j.stop_signal))fields.push(['종료 신호',String(j.stop_signal)]);
  if(j.end_source==='launch_error')fields.push(['실행 결과','명령을 시작하지 못했거나 시작 전 취소됨']);
  if(j.end_source==='tracking_lost')fields.push(['실행 확인',`${time(j.tracking_lost_at)} 추적 연결 끊김 · 종료 결과 미확인`]);
  const reference=`${s.server_id}/${j.id}`;
  $('job-detail').innerHTML=`<h3>${escape(j.name)}</h3><div class="experiment-reference"><div class="experiment-reference-text"><span>실험 ID</span><code id="experiment-reference-value">${escape(reference)}</code></div><button type="button" data-copy-experiment-id aria-label="실험 ID 복사">복사</button></div><p id="experiment-copy-feedback" class="experiment-copy-feedback" role="status" aria-live="polite"></p><p>${escape(j.description||'')}</p><dl>${fields.map(([k,v])=>`<dt>${k}</dt><dd>${escape(v)}</dd>`).join('')}</dl>${!health(s,now,config.stale_after_seconds||1200).ok?'<p>갱신이 지연되어 마지막 수신 정보입니다.</p>':''}`;
}
$('job-detail').addEventListener('click',async e=>{
  const button=e.target.closest('button[data-copy-experiment-id]');if(!button)return;
  const value=$('experiment-reference-value')?.textContent;if(!value)return;
  button.disabled=true;
  try{
    await navigator.clipboard.writeText(value);
    if(!button.isConnected)return;
    button.textContent='복사됨';
    $('experiment-copy-feedback').textContent='실험 ID를 복사했어요. 이 ID로 실험을 알려주세요.';
  }catch{
    if(!button.isConnected)return;
    button.textContent='복사 실패';
    $('experiment-copy-feedback').textContent='위 ID를 직접 선택해서 복사해 주세요.';
  }finally{
    button.disabled=false;
    setTimeout(()=>{if(button.isConnected)button.textContent='복사';},2200);
  }
});
$('timeline').addEventListener('click',e=>{const b=e.target.closest('[data-job]');if(!b)return;selected={server:b.dataset.server,id:b.dataset.job};fillDetail(selected.server,selected.id);$('detail-dialog').showModal();});
$('close-detail').onclick=()=>$('detail-dialog').close();
$('detail-dialog').addEventListener('click',e=>{if(e.target===$('detail-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
document.querySelectorAll('[data-hours]').forEach(b=>b.onclick=()=>{hours=Number(b.dataset.hours);offset=0;document.querySelectorAll('[data-hours]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',String(x===b));});render();});
$('previous').onclick=()=>{offset--;render();};$('next').onclick=()=>{offset++;render();};$('today').onclick=()=>{offset=0;render();};$('refresh').onclick=refresh;
try{config=await readJSON('./config.json');if(!['demo','live'].includes(config.mode))throw new Error('mode');if(config.mode==='live'&&!Array.isArray(config.servers))throw new Error('servers');await refresh();setInterval(refresh,Math.max(30,config.refresh_seconds||60)*1000);setInterval(()=>render(),30000);}catch(error){$('mode').textContent='설정 확인 필요';$('notice').textContent='설정을 불러오지 못했습니다. config.json과 웹 서버 연결을 확인해 주세요.';$('notice').className='notice error';$('timeline').innerHTML='<div class="blank">표시할 데이터가 없습니다.</div>';}
