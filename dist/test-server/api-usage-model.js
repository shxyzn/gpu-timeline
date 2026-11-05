export const DAY=86400000,HISTORY_DAYS=90,MAX_SAMPLES=6000;
const idPattern=/^or-[a-f0-9-]{36}$/;
const numeric=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const only=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k));
const validDate=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
export const utcDay=at=>new Date(at).toISOString().slice(0,10);
export const emptyHistory=()=>({schema_version:1,revision:0,updated_at:null,samples:[]});
function sample(value){
  if(!only(value,['key_id','at','total','daily'])||!idPattern.test(value.key_id||'')||!validDate(value.at)||!numeric(value.total)||!(value.daily===null||numeric(value.daily)))throw new Error('API 사용량 이력 형식을 확인해 주세요.');
  return {key_id:value.key_id,at:new Date(value.at).toISOString(),total:value.total,daily:value.daily};
}
export function validateHistory(value){
  if(!only(value,['schema_version','revision','updated_at','samples'])||value.schema_version!==1||!Number.isSafeInteger(value.revision)||value.revision<0||!(value.updated_at===null||validDate(value.updated_at))||!Array.isArray(value.samples)||value.samples.length>MAX_SAMPLES)throw new Error('API 사용량 이력 파일을 확인해 주세요.');
  const seen=new Set();const samples=value.samples.map(s=>{const next=sample(s),key=next.key_id+'/'+next.at;if(seen.has(key))throw new Error('API 사용량 이력이 중복되어 있습니다.');seen.add(key);return next;});
  return {...value,samples};
}
// Only the public record ID, timestamp and two numeric cost fields are saved.
// Provider labels, raw responses, credentials and account identifiers never enter history.
export function samplesFromTokens(tokens,now=Date.now()){
  return tokens.flatMap(token=>{
    if(!idPattern.test(token?.id||'')||token.error!=null||!validDate(token.checked_at)||Date.parse(token.checked_at)>now+300000||!numeric(token.usage?.usage))return [];
    return [{key_id:token.id,at:new Date(token.checked_at).toISOString(),total:token.usage.usage,daily:numeric(token.usage.usage_daily)?token.usage.usage_daily:null}];
  });
}
export function mergeSamples(original,incoming,now=Date.now()){
  const document=validateHistory(original),cutoff=Date.parse(utcDay(now))-(HISTORY_DAYS-1)*DAY;
  const unique=new Map();
  for(const raw of [...document.samples,...incoming]){
    const value=sample(raw),at=Date.parse(value.at),key=value.key_id+'/'+value.at;
    if(at<cutoff||at>now+300000||unique.has(key))continue;
    unique.set(key,value);
  }
  const sorted=[...unique.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.key_id.localeCompare(b.key_id));
  const daily=new Map(),hourly=new Map();
  for(const s of sorted){
    daily.set(s.key_id+'/'+s.at.slice(0,10),s);
    if(Date.parse(s.at)>=now-2*DAY)hourly.set(s.key_id+'/'+s.at.slice(0,13),s);
  }
  const retained=new Map([...daily.values(),...hourly.values()].map(s=>[s.key_id+'/'+s.at,s]));
  return {...document,samples:[...retained.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.key_id.localeCompare(b.key_id)).slice(-MAX_SAMPLES)};
}
export function needsRecording(document,tokens,now=Date.now()){
  const merged=mergeSamples(document,samplesFromTokens(tokens,now),now);
  return JSON.stringify(merged.samples)!==JSON.stringify(document.samples);
}
export function chartData(document,tokens,{days=7,key='all',now=Date.now()}={}){
  if(![7,30,90].includes(days))throw new Error('조회 기간을 확인해 주세요.');
  const selected=tokens.filter(t=>idPattern.test(t.id||'')&&(key==='all'||t.id===key));
  const ids=new Set(selected.map(t=>t.id));
  const merged=mergeSamples(document,samplesFromTokens(tokens,now),now);
  const end=Date.parse(utcDay(now))+DAY,start=end-days*DAY;
  const samples=merged.samples.filter(s=>ids.has(s.key_id)&&Date.parse(s.at)>=start&&Date.parse(s.at)<end);
  const daily=Array.from({length:days},(_,i)=>({day:utcDay(start+i*DAY),values:{},last_at:null}));
  const byDay=new Map(daily.map(d=>[d.day,d]));
  for(const s of samples){const d=byDay.get(utcDay(s.at));if(s.daily!==null)d.values[s.key_id]=s.daily;d.last_at=s.at;}
  for(const d of daily){const values=Object.values(d.values);d.observed=values.length;d.total=values.length?values.reduce((a,b)=>a+b,0):null;if(!Number.isFinite(d.total))d.total=null;}
  let resets=0;
  const series=selected.map(token=>{
    const points=samples.filter(s=>s.key_id===token.id);const segments=[];let segment=[];
    for(const point of points){const previous=segment.at(-1);if(previous&&(point.total<previous.total||Date.parse(point.at)-Date.parse(previous.at)>36*3600000)){if(point.total<previous.total)resets++;segments.push(segment);segment=[];}segment.push(point);}
    if(segment.length)segments.push(segment);
    return {id:token.id,name:token.name,points,segments};
  });
  const totals=series.map(s=>s.points.at(-1)?.total).filter(n=>n!==undefined);
  return {selected,daily,series,start,end,resets,observedDays:daily.filter(d=>d.observed).length,
    dailyTotal:daily.some(d=>d.observed)&&daily.every(d=>!d.observed||d.total!==null)&&Number.isFinite(daily.reduce((n,d)=>n+(d.total??0),0))?daily.reduce((n,d)=>n+(d.total??0),0):null,
    cumulativeTotal:totals.length&&Number.isFinite(totals.reduce((a,b)=>a+b,0))?totals.reduce((a,b)=>a+b,0):null,lastAt:samples.at(-1)?.at||null,sampleCount:samples.length};
}
