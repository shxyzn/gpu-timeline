import {health,gpuState,isAPI,apiSlot,jobETA,timestamp} from '../model.js';

const active = job => ['running','unknown'].includes(job.status);
export function experimentPresentation(job) {
  const original=String(job?.name||'이름 미등록').trim();
  const reference=original.match(/^(exp(?:[_-][a-z]+)*[_-]?\d+)\b/i)?.[1]||'';
  const parts=original.split('·').map(p=>p.trim()).filter(Boolean);
  const dataset=parts.map(p=>p.replace(/^(exp(?:[_-][a-z]+)*[_-]?\d+)\s*/i,'').trim())
    .find(p=>/^(AIME\d*|IFBench|HoVer|HotPotQA|LiveBench(?:-Math)?|MATH(?:-500)?|GSM8K|GPQA(?:-Diamond)?)$/i.test(p));
  const named=[...new Set([...original.matchAll(/\b(?:Qwen|GPT|Claude|Llama|Gemma|DeepSeek|Kimi|Mistral|Phi)[\w.-]*\b/gi)].map(m=>m[0]))];
  const sizes=[...new Set([...original.matchAll(/\b\d+(?:\.\d+)?B\b/gi)].map(m=>m[0]))];
  const models=(named.length?named:sizes).slice(0,2).join(' + ');
  const prefix=reference||(parts.length>1?parts[0]:'');
  const activity=/\bproblem generation\b/i.test(original)?'문제 생성':/\brouter\b/i.test(original)?'Router':'';
  let title=dataset?[prefix,[dataset,models].filter(Boolean).join(' / ')].filter(Boolean).join(' · '):
    reference&&models?[reference,[models,activity].filter(Boolean).join(' ')].join(' · '):
    parts.length>1?parts.slice(0,2).join(' · '):original;
  if([...title].length>80)title=[...title].slice(0,79).join('')+'…';
  const method=original.match(/일반\s+GEPA|\bAdaptive[- ]GEPA\b|\bGEPA\b|\bRouter\b|task\+reflection/i)?.[0];
  const seed=original.match(/\bseed\s*[:=_-]?\s*(\d+)\b/i)?.[1];
  const meta=[method&&!title.toLowerCase().includes(method.toLowerCase())?method:'',seed!==undefined?'seed '+seed:'',job?.owner||''].filter(Boolean);
  return {title,meta,original};
}
export function humanDuration(milliseconds) {
  const minutes=Math.max(0,Math.ceil(milliseconds/60000));
  if(minutes<60)return minutes+'분';
  if(minutes<24*60)return Math.floor(minutes/60)+'시간'+(minutes%60?' '+minutes%60+'분':'');
  const hours=Math.round(minutes/60),days=Math.floor(hours/24),rest=hours%24;
  return '약 '+days+'일'+(rest?' '+rest+'시간':'');
}
export function gpuReadings(gpu) {
  const numeric=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
  const utilization=numeric(gpu?.utilization)&&gpu.utilization<=100?gpu.utilization:null;
  const used=numeric(gpu?.memory_used_mib)?gpu.memory_used_mib/1024:null;
  const total=numeric(gpu?.memory_total_mib)&&gpu.memory_total_mib>0?gpu.memory_total_mib/1024:null;
  return {utilization,used,total};
}
export function progressValue(job) {
  const p=job?.progress;
  return p && Number.isFinite(p.completed) && Number.isFinite(p.total) && p.total>0 && p.completed>=0
    ? Math.max(0,Math.min(100,p.completed/p.total*100)):null;
}
export function currentView(servers,telemetryServers,now=Date.now(),stale=1200) {
  const gpuRows=[],apiRows=[],alerts=[];
  for(const server of servers) {
    const raw=telemetryServers.find(s=>s.server_id===server.server_id)||server;
    const status=health(raw,now,stale);
    if(!status.ok)alerts.push({server,label:status.label,at:timestamp(raw.updated_at)});
    for(const gpu of [...server.gpus].sort((a,b)=>a.index-b.index)) {
      const state=gpuState(raw,gpu,now,stale);
      const jobs=server.jobs.filter(j=>!isAPI(j)&&active(j)&&j.gpu_uuids.includes(gpu.uuid));
      const next=server.jobs.filter(j=>!isAPI(j)&&j.status==='planned'&&j.gpu_uuids.includes(gpu.uuid)&&
        timestamp(j.started_at)!==null).sort((a,b)=>timestamp(a.started_at)-timestamp(b.started_at))[0]||null;
      gpuRows.push({server,gpu,state,healthy:status.ok,jobs,next});
    }
    for(const job of server.jobs.filter(j=>isAPI(j)&&active(j)).sort((a,b)=>apiSlot(a)-apiSlot(b))) {
      apiRows.push({server,job,healthy:status.ok,eta:jobETA(job,server.updated_at)});
    }
  }
  const apiRunning=apiRows.filter(r=>r.healthy&&r.job.status==='running').length;
  return {gpuRows,apiRows,alerts,total:gpuRows.length,
    idle:gpuRows.filter(r=>r.state==='idle').length,busy:gpuRows.filter(r=>r.state==='busy').length,
    unknown:gpuRows.filter(r=>r.state==='unknown').length,apiRunning,
    apiUncertain:apiRows.length-apiRunning};
}
