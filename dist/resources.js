import {resourceState, resourceSummary, pressureAssessment, value} from './resources-model.js';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(n,d=1)=>value(n)===null?'—':n.toLocaleString('ko-KR',{maximumFractionDigits:d});
const pct=n=>value(n)===null?'—':num(n)+'%';
const gib=n=>value(n)===null?'—':num(n/1024**3)+' GiB';
const at=(seconds,short=false)=>!Number.isFinite(seconds)?'—':new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',...(short?{}:{hour:'2-digit',minute:'2-digit',hourCycle:'h23'})}).format(new Date(seconds*1000));
const reasons={
  memory:{title:'RAM 여유 부족',summary:'가용 메모리 감소와 스왑·메모리 대기가 함께 관측됐어요.',
    evidence:[['ram_pct','RAM 사용률','%'],['ram_available_gib','가용 메모리',' GiB'],['swap_mib_s','스왑 입출력',' MiB/s'],['memory_psi_pct','메모리 대기 · PSI some','%']],
    checks:['worker 수·배치 크기·캐시의 메모리 사용량 확인','동시 실행 수를 조정한 뒤 같은 대기가 반복되는지 비교'],
    decision:'조정 후에도 같은 작업량에서 메모리 대기와 스왑이 반복되면 RAM 증설을 검토하세요. 필요한 용량은 피크 수요를 추가로 확인해야 해요.'},
  cpu:{title:'CPU 처리 대기',summary:'높은 CPU 또는 코어 사용률과 CPU 대기가 함께 관측됐어요.',
    evidence:[['cpu_pct','전체 CPU 사용률','%'],['core_peak_pct','가장 바쁜 코어','%'],['cpu_psi_pct','CPU 대기 · PSI some','%']],
    checks:['데이터 로딩·토큰화·전처리 구간과 다른 CPU 작업 확인','worker 수·병렬 처리·캐시 적용 전후의 실험 처리량 비교'],
    decision:'병렬화 가능한 작업에서 대기가 지속되면 CPU 증설을 검토하세요. 단일 스레드 병목은 코어 수를 늘리는 것만으로 해결되지 않을 수 있어요.'},
  io:{title:'저장장치 I/O 대기',summary:'장치의 요청 지연과 I/O 대기가 함께 관측됐어요.',
    evidence:[['io_latency_ms','장치 최대 요청 지연',' ms'],['io_psi_pct','I/O 대기 · PSI some','%'],['read_mib_s','장치 최대 읽기',' MiB/s'],['write_mib_s','장치 최대 쓰기',' MiB/s']],
    checks:['동일 장치의 동시 읽기·쓰기와 작은 파일 접근 패턴 확인','학습 데이터를 로컬 SSD로 옮겨 처리량과 대기 시간을 비교'],
    decision:'로컬 SSD 사용으로 대기가 줄고 실험 처리량이 개선되면 빠른 저장장치 추가를 검토하세요. 남은 용량과 I/O 성능은 별도로 판단해요.'}
};
export class ResourceBoard {
  constructor(config,getServers,manage) {
    this.config=config;this.getServers=getServers;this.manage=manage;this.analysisServer=null;
    $('resource-server').onchange=()=>{this.analysisServer=$('resource-server').value;this.render()};
    $('resource-period').onchange=()=>this.renderStats();
    $('bottleneck-servers').onclick=e=>{const button=e.target.closest('[data-resource-server]');if(button){this.analysisServer=button.dataset.resourceServer;this.renderAnalysis()}};
    $('resources').addEventListener('click',e=>{if(e.target.closest('[data-resource-manage]'))this.manage($('resource-server').value)});
    $('bottlenecks').addEventListener('click',e=>{if(e.target.closest('[data-resource-manage]'))this.manage(this.analysisServer)});
    let frame;
    this.resize=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>this.drawCharts())});
    this.resize.observe($('resource-grid'));
  }
  render() {
    const servers=this.getServers(), previous=$('resource-server').value;
    $('resource-server').innerHTML=servers.map(s=>`<option value="${esc(s.server_id)}">${esc(s.name)}</option>`).join('');
    if(servers.some(s=>s.server_id===previous))$('resource-server').value=previous;
    if(!servers.some(s=>s.server_id===this.analysisServer))this.analysisServer=$('resource-server').value;
    this.renderStats();this.renderAnalysis();
  }
  state(s){return resourceState(s,Date.now(),this.config.stale_after_seconds||1200)}
  empty(state) {
    const text={upgrade:'서버 관리에서 공용 수집기를 v1.1.8 이상으로 업데이트하면 통계가 쌓이기 시작해요. 계정별 설치는 필요하지 않아요.',disabled:'이 서버 설정에서 자원 통계 수집이 꺼져 있어요.',waiting:'첫 측정값을 기다리고 있어요. 통계는 새 수집기를 설치한 시점부터 기록됩니다.'};
    return `<div class="resource-empty"><strong>${esc(state.label)}</strong><p>${text[state.kind]||'표시할 통계가 없습니다.'}</p>${state.kind==='upgrade'?'<button type="button" class="edit-button" data-resource-manage>서버 관리 열기</button>':''}</div>`;
  }
  renderStats() {
    const server=this.getServers().find(s=>s.server_id===$('resource-server').value), state=this.state(server);
    $('resource-state').textContent=state.label;
    $('resource-state').className='resource-badge '+(state.kind==='ready'?'':'muted');
    if(!['ready','stale'].includes(state.kind)) {
      this.summary=null;$('resource-grid').innerHTML=this.empty(state);$('resource-meta').textContent='';$('resource-storage').innerHTML='';$('resource-cores').innerHTML='';return;
    }
    const r=server.resources, hours=Number($('resource-period').value), summary=resourceSummary(r,hours), m=summary.metrics;
    this.summary=summary;
    $('resource-meta').innerHTML=`<span>기간 내 수집 <strong>${num(summary.seconds/3600)} / ${hours}시간 (${num(summary.coverage)}%)</strong></span><span>GPU 배정 <strong>${num(summary.allocation)} GPU·h</strong></span><span>수집 시작 ${at(r.started_at)}</span><span>마지막 관측 ${at(r.current.at)} KST</span>`;
    const cards=[
      ['gpu_pct','GPU 활동률',pct(m.gpu_pct),`등록 GPU 실험 실행 중 평균 ${pct(m.gpu_active_pct)} · VRAM 최대 ${pct(m.vram_pct)}`],
      ['cpu_pct','CPU 사용률',pct(m.cpu_pct),`전체 최대 ${pct(m.cpu_peak_pct)} · 코어 최대 ${pct(m.core_peak_pct)}`],
      ['ram_pct','RAM 사용률',pct(m.ram_pct),`최대 ${pct(m.ram_peak_pct)} · 가용 최소 ${num(m.ram_available_gib)} GiB`],
      ['io_latency_ms','저장장치 요청 지연',`${num(m.io_latency_ms)} ms`,`장치별 구간 평균 중 최대 · I/O 대기 최대 ${pct(m.io_psi_pct)}`]
    ];
    $('resource-grid').innerHTML=cards.map(([key,label,amount,note])=>`<article class="resource-card"><div class="resource-card-top"><h3>${label}</h3><span>${key==='io_latency_ms'?'기간 최대':'기간 평균'}</span></div><strong class="resource-value">${amount}</strong><svg class="resource-chart" data-metric="${key}" role="img" aria-label="${label} 추이"></svg><p>${esc(note)}</p><small>유효 측정 ${num((summary.weights[key]||0)/3600)}시간 · ${hours<=24?'5분':'1시간'} 집계</small></article>`).join('');
    const devices=r.current.devices||[];
    $('resource-storage').innerHTML=`<div class="resource-subheading"><h3>저장장치 현황</h3><span>마지막 관측값 · 용량과 지연을 따로 확인하세요</span></div><div class="resource-table-scroll"><table><thead><tr><th>마운트 · 장치</th><th>용량 사용률</th><th>남은 용량 / 전체</th><th>읽기 / 쓰기</th><th>IOPS</th><th>요청 지연</th></tr></thead><tbody>${(r.current.mounts||[]).map(mount=>{
      const d=devices.find(d=>d.id===mount.io_device_id)||{}, percent=value(mount.used_pct);
      return `<tr><td><strong>${esc(mount.mount)}</strong><small>${esc(mount.io_device||'I/O 미지원')} · ${esc(mount.filesystem)}</small></td><td>${pct(percent)}${percent===null?'':`<div class="resource-meter ${percent>=90?'capacity':''}"><span style="width:${Math.max(0,Math.min(100,percent))}%"></span></div>`}${percent>=90?'<small>용량 확인</small>':''}</td><td>${gib(mount.available_bytes)} / ${gib(mount.total_bytes)}</td><td>${num(d.read_mib_s)} / ${num(d.write_mib_s)} MiB/s</td><td>${num(d.iops)}</td><td>${num(d.latency_ms)} ms</td></tr>`;
    }).join('')||'<tr><td colspan="6">지원되는 로컬 저장장치 정보가 없습니다.</td></tr>'}</tbody></table></div><p class="resource-help">로컬 파일시스템 최대 24개 · NFS·FUSE·가상 파일시스템 제외 · 디스크 사용률은 사용량 / (사용량 + 일반 계정 가용량)</p>`;
    const cores=(r.current.cpu_cores||[]).filter(c=>Number.isInteger(c.index)).sort((a,b)=>(value(b.usage_pct)??-1)-(value(a.usage_pct)??-1)).slice(0,16);
    $('resource-cores').innerHTML=`<details><summary>코어별 최근 사용률 · ${num(r.current.cpu_count,0)}개 중 상위 ${cores.length}개</summary><div class="resource-core-grid">${cores.map(c=>`<div><span>CPU ${c.index}</span><strong>${pct(c.usage_pct)}</strong><div class="resource-meter"><span style="width:${Math.max(0,Math.min(100,value(c.usage_pct)||0))}%"></span></div></div>`).join('')}</div></details>`;
    this.drawCharts();
  }
  drawCharts() {
    if(!this.summary)return;
    const s=this.summary;
    for(const svg of document.querySelectorAll('.resource-chart')) {
      const key=svg.dataset.metric, index=s.columns.indexOf(key), points=s.rows.map(r=>({at:r.at,v:r.weights[index]>0?r.values[index]:null}));
      const valid=points.filter(p=>p.v!==null&&Number.isFinite(p.v));
      const w=Math.max(200,svg.getBoundingClientRect().width), h=140,left=40,right=w-10,top=12,bottom=105;
      const maximum=key==='io_latency_ms'?Math.max(1,...valid.map(p=>p.v))*1.1:100;
      const x=t=>left+(t-s.start)/(s.end-s.start)*(right-left), y=v=>bottom-Math.max(0,Math.min(maximum,v))/maximum*(bottom-top);
      let path='', last=null;
      for(const p of points){if(p.v===null){last=null;continue}const command=last!==null&&p.at-last<=s.width*1.5?'L':'M';path+=`${command}${Math.max(left,x(p.at)).toFixed(2)},${y(p.v).toFixed(2)} `;last=p.at}
      const ticks=[0,maximum/2,maximum].map(v=>`<line x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}" class="resource-gridline"/><text x="${left-7}" y="${y(v)+4}" text-anchor="end">${num(v,maximum<10?1:0)}</text>`).join('');
      const labels=[s.start,(s.start+s.end)/2,s.end].map((t,i)=>`<text x="${x(t)}" y="128" text-anchor="${i===0?'start':i===2?'end':'middle'}">${esc(s.width===300?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(t*1000)):at(t,true))}</text>`).join('');
      svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
      svg.innerHTML=`<title>${esc(key)} · ${key==='io_latency_ms'?'밀리초':'퍼센트'} · 가로축 한국시간 · 누락 구간은 연결하지 않음</title>${ticks}${valid.length?`<path class="resource-line" d="${path}"/>${valid.length===1?`<circle cx="${Math.max(left,x(valid[0].at))}" cy="${y(valid[0].v)}" r="3" class="resource-point"/>`:''}`:`<text x="${(left+right)/2}" y="62" text-anchor="middle">측정 자료 없음</text>`}${labels}`;
    }
  }
  renderAnalysis() {
    const servers=this.getServers();
    $('bottleneck-servers').innerHTML=servers.map(s=>{
      const state=this.state(s), assessments=pressureAssessment(s.resources), count=assessments.reduce((n,a)=>n+a.events.length,0);
      return `<button type="button" class="resource-server-choice" data-resource-server="${esc(s.server_id)}" aria-pressed="${s.server_id===this.analysisServer}"><span>${esc(s.name)}</span><strong>${['ready','stale'].includes(state.kind)?(count?`의심 구간 ${count}회`:'최근 의심 구간 없음'):state.label}</strong><small>${['ready','stale'].includes(state.kind)?(state.kind==='stale'?'마지막 수신 기준':'최근 24시간 · 관측 구간 기준'):'업데이트 이후부터 분석'}</small></button>`;
    }).join('');
    const server=servers.find(s=>s.server_id===this.analysisServer), state=this.state(server);
    if(!['ready','stale'].includes(state.kind)){$('bottleneck-detail').innerHTML=this.empty(state);return}
    const r=server.resources, assessments=pressureAssessment(r), detected=assessments.filter(a=>a.events.length);
    const coverage=resourceSummary(r,24).coverage;
    const report=`<p class="resource-analysis-note">${esc(server.name)} · 최근 24시간 수집률 ${num(coverage)}%${state.kind==='stale'?' · 수신 지연: 마지막 관측 결과':''}</p>`;
    $('bottleneck-detail').innerHTML=report+(detected.length?detected.map(a=>{
      const reason=reasons[a.kind], event=a.events[0], evidence=reason.evidence.concat(event.local_gpu_observed?[['gpu_pct','동시간대 GPU 활동률','%']]:[]);
      return `<article class="bottleneck-card"><div class="resource-subheading"><h3>${reason.title} 의심</h3><span class="resource-badge amber">${a.events.length}회 · 총 ${num(a.seconds/60)}분</span></div><p>${reason.summary}</p><small>최근 구간 ${at(event.start)} — ${at(event.end)} KST · 마지막 동시 관측 근거</small><div class="bottleneck-columns"><dl>${evidence.map(([key,label,unit])=>`<div><dt>${label}</dt><dd>${num(event.evidence[key])}${value(event.evidence[key])===null?'':unit}</dd></div>`).join('')}</dl><div><h4>먼저 확인할 것</h4><ul>${reason.checks.map(text=>`<li>${text}</li>`).join('')}</ul><h4>증설 판단</h4><p>${reason.decision}</p></div></div><p class="resource-help">${event.local_gpu_observed?'로컬 GPU 실험 등록이 있었던 구간 · GPU가 기다린 원인은 추가 확인 필요':'서버 전체 자원 압박 관측 · 특정 실험 또는 GPU 병목으로 단정하지 않음'}</p></article>`;
    }).join(''):`<div class="resource-empty"><strong>${coverage<1?'분석할 측정 구간이 아직 부족해요':'수집된 구간에서 지속적인 자원 압박을 감지하지 못했어요'}</strong><p>병목이 없다는 뜻은 아니에요. 짧은 지연·GPU 내부 병목·네트워크·API 응답 대기는 이 분석만으로 판단할 수 없어요.</p></div>`)+
      `<p class="resource-help">${assessments.filter(a=>!a.supported).map(a=>({cpu:'CPU',memory:'RAM',io:'I/O'}[a.kind])).join(' · ')?'일부 대기 지표 미지원: '+assessments.filter(a=>!a.supported).map(a=>({cpu:'CPU',memory:'RAM',io:'I/O'}[a.kind])).join(' · ')+' · 해당 분석은 제한됩니다.':''}</p>`;
  }
}
