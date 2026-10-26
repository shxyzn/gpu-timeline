import {health,gpuState,isAPI,apiSlot,jobETA,timestamp} from '../model.js';

const active = job => ['running','unknown'].includes(job.status);
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
