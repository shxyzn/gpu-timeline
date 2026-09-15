export const HOUR=3600000;
export function timestamp(v){if(!v)return null;const t=Date.parse(v);return Number.isFinite(t)?t:null;}
export function health(server,now,staleSeconds){
  if(server.fetch_error)return {ok:false,label:'수신 실패'};
  if(!server.collector_ok)return {ok:false,label:'수집 오류'};
  const t=timestamp(server.updated_at);
  if(t===null||now-t>staleSeconds*1000||t>now+5*60000)return {ok:false,label:'갱신 지연'};
  return {ok:true,label:'정상 수신'};
}
export function gpuState(server,gpu,now,staleSeconds){
  if(!health(server,now,staleSeconds).ok)return 'unknown';
  const active=(server.jobs||[]).some(j=>j.status==='running'&&j.gpu_uuids.includes(gpu.uuid));
  if(active||(gpu.process_count??0)>0||(gpu.utilization??0)>5||(gpu.memory_used_mib??0)>512)return 'busy';
  if((server.jobs||[]).some(j=>j.status==='unknown'&&j.gpu_uuids.includes(gpu.uuid)))return 'unknown';
  if(gpu.process_count===null||gpu.process_count===undefined||gpu.utilization===null||gpu.memory_used_mib===null)return 'unknown';
  return 'idle';
}

export function jobETA(job, snapshotAt){
  const supplied=timestamp(job.expected_end_at);
  if(supplied===null&&job.dashboard_override_fields?.includes('expected_end_at'))return {at:null,source:null};
  if(supplied!==null&&job.eta_source!=='progress')return {at:supplied,source:'manual',approximate:false};
  if(job.status!=='running')return {at:null,source:null};
  const p=job.progress, start=timestamp(job.started_at);
  if(!p||!Number.isFinite(p.completed)||!Number.isFinite(p.total)||p.completed<=0||p.total<=0||p.completed>=p.total||start===null)return {at:null,source:null};
  const recorded=timestamp(p.updated_at), observed=recorded??timestamp(snapshotAt);
  if(observed===null||observed<=start)return {at:null,source:null};
  const at=start+(observed-start)*p.total/p.completed;
  if(!Number.isFinite(at)||at>8.64e15)return {at:null,source:null};
  return {at,source:'progress',observedAt:observed,approximate:recorded===null};
}
export function versionLabel(info){
  if(!info||typeof info.version!=='string'||!/^\d+\.\d+\.\d+$/.test(info.version))return null;
  const revision=/^[0-9a-f]{40}$/.test(info.revision||'')?info.revision.slice(0,7):'unknown';
  return 'v'+info.version+'+'+revision+(info.dirty===true?'.dirty':'');
}

export function layoutJobs(jobs,start,end,now,snapshotAt=null){
  const visible=jobs.map(job=>{
    const from=timestamp(job.started_at);const plannedEnd=jobETA(job,snapshotAt).at;const actual=timestamp(job.ended_at);
    const terminal=['completed','failed','cancelled','stopped'].includes(job.status);
    // Completion requires an actual end; never draw a finished job into the future.
    let to=terminal?actual:plannedEnd;
    const uncertain=job.status==='unknown'||(!terminal&&job.status==='running'&&(to===null||to<now));
    if(uncertain)to=now;
    if(from===null||to===null||to<from||to<=start||from>=end)return null;
    return {job,from:Math.max(from,start),to:Math.min(to,end),uncertain};
  }).filter(Boolean).sort((a,b)=>a.from-b.from||a.to-b.to);
  const lanes=[];
  return visible.map(item=>{let lane=lanes.findIndex(t=>t<=item.from);if(lane<0)lane=lanes.length;lanes[lane]=item.to;return {...item,lane,left:(item.from-start)/(end-start)*100,width:Math.max(.3,(item.to-item.from)/(end-start)*100)};});
}
