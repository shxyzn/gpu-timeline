// No synthetic history: absent/unsupported metrics stay null.
export const RESOURCE_SCHEMA = 1;
const number = n => typeof n === 'number' && Number.isFinite(n);
export const value = n => number(n) ? n : null;
export function resourceState(server, now = Date.now(), staleSeconds = 1200) {
  const r = server?.resources;
  if (!r || r.schema_version !== RESOURCE_SCHEMA) return {kind:'upgrade',label:'수집기 업데이트 필요'};
  if (!r.enabled) return {kind:'disabled',label:'통계 수집 꺼짐'};
  if (!number(r.current?.at)) return {kind:'waiting',label:'첫 측정 대기'};
  if (server.fetch_error || r.error || now / 1000 - r.current.at > staleSeconds || r.current.at > now / 1000 + 300) return {kind:'stale',label:'마지막 수신 통계'};
  return {kind:'ready',label:'통계 수집 중'};
}
export function resourceSummary(resource, hours = 24, now = Date.now()) {
  const duration = hours * 3600, end = now / 1000, start = end - duration;
  const width = hours <= 24 ? 300 : 3600;
  const source = hours <= 24 ? resource?.fine : resource?.hourly;
  const columns = Array.isArray(resource?.columns) ? resource.columns.slice(0,40) : [];
  const reducers = resource?.reducers || [];
  const rows = [], seen = new Set();
  for (const raw of (Array.isArray(source)?source:[]).slice(-1000)) {
    if (!Array.isArray(raw) || raw.length !== 4 || !number(raw[0]) || raw[0] > end || seen.has(raw[0]) ||
        !number(raw[1]) || raw[1] < 0 || raw[1] > width+1 || !Array.isArray(raw[2]) || !Array.isArray(raw[3])) continue;
    const measuredEnd = Math.min(raw[0]+width, value(resource?.current?.at) ?? raw[0]+width);
    const overlap = Math.min(end,measuredEnd)-Math.max(start,raw[0]);
    if (overlap <= 0 || measuredEnd <= raw[0]) continue;
    const ratio = Math.min(1,overlap/(measuredEnd-raw[0]));
    const weights = columns.map((_,i)=>number(raw[3][i]) && raw[3][i]>=0 && raw[3][i]<=raw[1]+1 ? raw[3][i]*ratio:0);
    rows.push({at:raw[0],seconds:raw[1]*ratio,values:columns.map((_,i)=>value(raw[2][i])),weights});
    seen.add(raw[0]);
  }
  rows.sort((a,b)=>a.at-b.at);
  const metrics = Object.create(null), weights = Object.create(null), integrals = Object.create(null);
  for (const [i,key] of columns.entries()) {
    if (typeof key !== 'string') continue;
    let combined = null, weight = 0, integral = 0;
    for (const row of rows) {
      const v=row.values[i], w=row.weights[i];
      if (v===null || !w) continue;
      integral += v*w;
      combined = combined===null?v:reducers[i]==='max'?Math.max(combined,v):reducers[i]==='min'?Math.min(combined,v):(combined*weight+v*w)/(weight+w);
      weight += w;
    }
    metrics[key]=combined;weights[key]=weight;integrals[key]=weight?integral:null;
  }
  const seconds = rows.reduce((sum,r)=>sum+r.seconds,0);
  const allocation = integrals.allocated_gpus===null || integrals.allocated_gpus===undefined ? null:integrals.allocated_gpus/3600;
  return {start,end,width,columns,rows,metrics,weights,seconds,coverage:Math.min(100,seconds/duration*100),allocation};
}
export function resourceEvents(resource, now = Date.now(), hours = 24) {
  const start=now/1000-hours*3600, end=now/1000;
  return (Array.isArray(resource?.events)?resource.events:[]).filter(e => e && ['memory','cpu','io'].includes(e.kind) &&
    number(e.start) && number(e.end) && e.start<e.end && e.end-e.start>=119 && e.start<=end && e.end>start && e.end<=end+300 &&
    e.evidence && typeof e.evidence==='object').slice(-240).map(e=>({...e, seconds:Math.min(e.end,end)-Math.max(e.start,start)}));
}
export function pressureAssessment(resource, now = Date.now()) {
  const events=resourceEvents(resource,now), kinds=['memory','cpu','io'];
  return kinds.map(kind=>{
    const matches=events.filter(e=>e.kind===kind).sort((a,b)=>b.end-a.end);
    const support=resource?.current?.psi_supported?.[kind==='memory'?'memory':kind];
    return {kind,events:matches,seconds:matches.reduce((sum,e)=>sum+e.seconds,0),supported:!!support};
  });
}
