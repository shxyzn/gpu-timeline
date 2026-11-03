export const MONITOR_VERSION='2.1';
export const CHECKS=[
  {id:'gpu_response',group:'GPU',name:'GPU 응답',detail:'nvidia-smi 응답과 제한 시간 확인'},
  {id:'gpu_count',group:'GPU',name:'GPU 인식 개수',detail:'설정한 GPU 개수가 모두 인식되는지 확인'},
  {id:'gpu_temperature',group:'GPU',name:'GPU 온도',detail:'설정한 경고 온도와 비교'},
  {id:'driver_loaded',group:'GPU',name:'NVIDIA 드라이버',detail:'커널 드라이버 로드 상태 확인'},
  {id:'xid_errors',group:'GPU',name:'GPU 오류 로그',detail:'최근 24시간의 Xid 기록 · 로그 권한 필요',deep:true},
  {id:'cpu_load',group:'서버',name:'CPU 부하',detail:'1분 평균 부하와 논리 CPU 수 비교'},
  {id:'cpu_pressure',group:'서버',name:'CPU 대기',detail:'CPU PSI 최근 1분 대기율 확인'},
  {id:'memory_available',group:'서버',name:'메모리 여유',detail:'사용 가능한 메모리가 5% 이하인지 확인'},
  {id:'uptime',group:'서버',name:'가동 시간',detail:'부팅 후 경과 시간 기록'},
  {id:'collector_upload',group:'서버',name:'수집기 업로드',detail:'마지막 업로드 성공 시각 확인'},
  {id:'disk_space',group:'저장장치',name:'시스템 디스크 여유',detail:'루트(/) 파일시스템의 남은 공간 확인'},
  {id:'io_pressure',group:'저장장치',name:'저장장치 대기',detail:'I/O PSI 최근 1분 대기율 확인',deep:true},
];
export const DAYS=['월','화','수','목','금','토','일'];
const known=new Set(CHECKS.map(c=>c.id));
const timePattern=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
const validDate=v=>typeof v==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const fail=message=>{throw new Error(message);};
export function monitoringID(source=globalThis.crypto){
  if(typeof source?.randomUUID==='function')return source.randomUUID();
  const bytes=source.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
export const emptyMonitoring=()=>({schema_version:1,revision:0,updated_at:null,servers:[]});
export function defaultConfig(server){return {server_id:server.server_id,revision:0,updated_at:null,enabled:true,expected_gpu_count:Math.max(1,server.gpus?.length||0),timeout_seconds:15,temperature_warn_c:85,schedules:[]};}
export function makeSchedule(kind='interval'){
  return {id:'mon-'+monitoringID(),name:kind==='daily'?'정밀 점검':'일반 점검',enabled:true,kind,
    interval_minutes:30,all_day:true,start_time:'09:00',end_time:'18:00',days:[0,1,2,3,4,5,6],
    times:kind==='daily'?['09:00']:[],checks:kind==='daily'?CHECKS.map(c=>c.id):['gpu_response','gpu_count','driver_loaded','collector_upload']};
}
export function validateSchedule(s){
  if(!s||!/^mon-[a-f0-9-]{36}$/.test(s.id||'')||typeof s.name!=='string'||!s.name.trim()||s.name.length>60)fail('점검 일정 이름을 60자 이내로 입력해 주세요.');
  if(typeof s.enabled!=='boolean'||!['interval','daily'].includes(s.kind))fail('점검 일정 종류를 확인해 주세요.');
  if(!integer(s.interval_minutes,5,1440)||typeof s.all_day!=='boolean'||!timePattern.test(s.start_time)||!timePattern.test(s.end_time))fail('점검 간격은 5~1440분, 시간은 올바른 시각으로 입력해 주세요.');
  if(!s.all_day&&s.start_time===s.end_time)fail('운영 시작과 종료 시각을 다르게 선택하거나 24시간을 선택해 주세요.');
  if(!Array.isArray(s.days)||!s.days.length||s.days.length>7||s.days.some(d=>!integer(d,0,6))||new Set(s.days).size!==s.days.length)fail('점검할 요일을 한 개 이상 선택해 주세요.');
  if(!Array.isArray(s.checks)||!s.checks.length||s.checks.length>CHECKS.length||s.checks.some(c=>!known.has(c))||new Set(s.checks).size!==s.checks.length)fail('점검 항목을 한 개 이상 선택해 주세요.');
  if(!Array.isArray(s.times)||(s.kind==='interval'?s.times.length!==0:![1,2].includes(s.times.length))||s.times.some(t=>!timePattern.test(t))||new Set(s.times).size!==s.times.length)fail('정밀 점검 시각을 하루 1회 또는 서로 다른 2회로 선택해 주세요.');
  return s;
}
export function validateConfig(c){
  if(!c||typeof c.server_id!=='string'||c.server_id.length>100||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.server_id)||!integer(c.revision,0,Number.MAX_SAFE_INTEGER)||!(c.updated_at===null||validDate(c.updated_at))||typeof c.enabled!=='boolean')fail('서버 모니터링 설정 형식을 확인해 주세요.');
  if(!integer(c.expected_gpu_count,1,32)||!integer(c.timeout_seconds,5,60)||!integer(c.temperature_warn_c,50,110))fail('GPU 개수(1~32), 응답 제한(5~60초), 경고 온도(50~110°C)를 확인해 주세요.');
  if(!Array.isArray(c.schedules)||c.schedules.length>12||new Set(c.schedules.map(s=>s?.id)).size!==c.schedules.length)fail('서버당 점검 일정은 중복 없이 최대 12개까지 저장할 수 있어요.');
  c.schedules.forEach(validateSchedule);
  if(c.enabled&&!c.schedules.some(s=>s.enabled))fail('모니터링을 켜려면 활성화한 점검 일정을 한 개 이상 추가해 주세요.');
  if(c.request_id!==undefined&&!/^[a-f0-9-]{36}$/.test(c.request_id))fail('저장 요청 식별자를 확인해 주세요.');
  return c;
}
export function validateMonitoring(data){
  if(!data||data.schema_version!==1||!integer(data.revision,0,Number.MAX_SAFE_INTEGER)||!(data.updated_at===null||validDate(data.updated_at))||!Array.isArray(data.servers)||data.servers.length>30)fail('공용 모니터링 설정을 읽을 수 없어요.');
  if(new Set(data.servers.map(s=>s?.server_id)).size!==data.servers.length)fail('중복된 서버 설정이 있어요.');
  data.servers.forEach(validateConfig);
  if(new TextEncoder().encode(JSON.stringify(data)).length>180000)fail('모니터링 설정 용량 한도를 초과했어요.');
  return data;
}
const minute=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
function parts(at){const d=new Date(at+9*3600000);return {day:Math.floor((at+9*3600000)/86400000),weekday:(d.getUTCDay()+6)%7,minute:d.getUTCHours()*60+d.getUTCMinutes()};}
export function inWindow(s,at){
  const p=parts(at);if(s.kind==='daily'||s.all_day)return s.days.includes(p.weekday);
  const a=minute(s.start_time),b=minute(s.end_time);
  if(a<b)return s.days.includes(p.weekday)&&p.minute>=a&&p.minute<b;
  return p.minute>=a?s.days.includes(p.weekday):p.minute<b&&s.days.includes((p.weekday+6)%7);
}
export function nextRun(s,now=Date.now(),lastRun=null){
  if(!s.enabled)return null;
  const p=parts(now),last=typeof lastRun==='string'?Date.parse(lastRun):null;
  if(s.kind==='interval'&&inWindow(s,now)){
    const due=Number.isFinite(last)?Math.max(now,last+s.interval_minutes*60000):now;
    if(inWindow(s,due))return due;
  }
  for(let offset=0;offset<=8;offset++){
    const day=p.day+offset,weekday=(p.weekday+offset)%7;
    if(!s.days.includes(weekday))continue;
    for(const m of s.kind==='daily'?s.times.map(minute).sort((a,b)=>a-b):[s.all_day?0:minute(s.start_time)]){
      const t=day*86400000-9*3600000+m*60000;if(t>now)return t;
    }
  }
  return null;
}
export function scheduleLabel(s){
  const days=s.days.length===7?'매일':s.days.map(d=>DAYS[d]).join('·');
  return s.kind==='daily'?`${days} · 하루 ${s.times.length}회 · ${s.times.join(' / ')} KST`:`${s.interval_minutes}분마다 · ${days} · ${s.all_day?'24시간':s.start_time+'~'+s.end_time+(s.start_time>s.end_time?' 다음 날':'')} KST`;
}
