import {currentView} from './current-model.js?v=1.2.0';

// Test-only manual availability. Clear the entry when Kimi returns from repair;
// receiving telemetry does not make a server available for new experiments.
export const REPAIR_SERVERS=Object.freeze({
  'server-a':Object.freeze({label:'A/S 중',title:'사용 일시 중단',returnText:'복귀 일정 미정',gpuCount:1})
});
export const repairState=(id,states=REPAIR_SERVERS)=>Object.hasOwn(states,id)?states[id]:null;
export const isUnavailable=(id,states=REPAIR_SERVERS)=>!!repairState(id,states);

export function availableCurrentView(servers,telemetryServers,now=Date.now(),stale=1200,states=REPAIR_SERVERS){
  const all=currentView(servers,telemetryServers,now,stale);
  const available=currentView(servers.filter(s=>!isUnavailable(s.server_id,states)),telemetryServers,now,stale);
  const gpuRows=[];
  for(const server of servers){
    const repair=repairState(server.server_id,states),rows=all.gpuRows.filter(r=>r.server.server_id===server.server_id);
    if(!repair){gpuRows.push(...rows);continue;}
    const preserved=rows.length?rows:[{server,gpu:{index:0,uuid:'repair-placeholder',name:'GPU 정보 보관 중'},jobs:[],next:null}];
    gpuRows.push(...preserved.map(row=>({...row,state:'maintenance',healthy:false,next:null,repair})));
  }
  const excluded=servers.filter(s=>isUnavailable(s.server_id,states)).map(server=>({server,gpuCount:server.gpus.length||repairState(server.server_id,states).gpuCount}));
  return {...available,gpuRows,apiRows:all.apiRows.map(row=>isUnavailable(row.server.server_id,states)?{...row,healthy:false,repair:repairState(row.server.server_id,states),eta:{at:null}}:row),apiTotal:available.apiRows.length,excluded};
}
