// Browser-only fictional telemetry. Never imported by the live dashboard.
export function resourceFixture(now=Date.now(),error=false) {
  const t=Math.floor(now/1000), start=Math.floor((t-6*3600)/300)*300;
  const columns=['gpu_pct','gpu_active_pct','cpu_pct','cpu_peak_pct','core_peak_pct','ram_pct','ram_peak_pct','ram_available_gib','swap_mib_s','cpu_psi_pct','memory_psi_pct','io_psi_pct','io_latency_ms','read_mib_s','write_mib_s','iops','vram_pct','allocated_gpus','gpu_count','local_gpu_jobs','api_jobs','cpu_iowait_pct'];
  const reducers=['mean','mean','mean','max','max','mean','max','min','max','max','max','max','max','mean','mean','mean','max','mean','mean','mean','mean','mean'];
  const row=(stamp,width,i)=>{
    const seconds=Math.min(width,t-stamp),gpu=Math.max(5,65+Math.sin(i/5)*25-(i>40?30:0));
    return [stamp,seconds,[gpu,gpu,44,79,97,88,98,1.9,26,4,14,2,3.4,183,41,300,92,1,1,1,2,3],columns.map(()=>seconds)];
  };
  return {schema_version:1,enabled:true,error,sample_seconds:15,started_at:start,columns,reducers,
    current:{at:t,memory_total_bytes:64*1024**3,cpu_count:16,cpu_cores:Array.from({length:16},(_,i)=>({index:i,usage_pct:50+i*3})),
      psi_supported:{cpu:true,memory:true,io:true},devices:[{id:'8:0',name:'sda',read_mib_s:183,write_mib_s:41,iops:300,latency_ms:3.4}],
      mounts:[{mount:'/ssd',filesystem:'ext4',io_device:'sda',io_device_id:'8:0',used_pct:70,available_bytes:0.6*1024**4,total_bytes:2*1024**4},
        {mount:'/data<script>',filesystem:'xfs',io_device:'sda',io_device_id:'8:0',used_pct:92.5,available_bytes:0.6*1024**4,total_bytes:8*1024**4}]},
    fine:Array.from({length:Math.ceil((t-start)/300)},(_,i)=>row(start+i*300,300,i)),
    hourly:Array.from({length:6},(_,i)=>row(Math.floor(start/3600)*3600+i*3600,3600,i*12)),
    events:[{kind:'memory',start:t-3600,end:t-2400,local_gpu_observed:true,evidence:{ram_pct:97,ram_available_gib:1.9,swap_mib_s:26,memory_psi_pct:14,gpu_pct:24}}]};
}
