export function demoSnapshot(now=Date.now()) {
  const time=h=>new Date(now+h*3600000).toISOString();
  const gpu=(index,name,total,used,util,processes)=>({index,uuid:`GPU-demo-${name}-${index}`,name,memory_total_mib:total,memory_used_mib:used,utilization:util,process_count:processes});
  const a=[gpu(0,'RTX 4090',24564,21030,97,1),gpu(1,'RTX 4090',24564,12,0,0)];
  const b=[gpu(0,'RTX PRO 5000',49140,36700,89,2)];
  const c=[gpu(0,'GTX 1080 Ti',11264,8200,76,1),gpu(1,'GTX 1080 Ti',11264,7,0,0)];
  const job=(id,name,gpus,start,end,status='running',more={})=>({id,name,gpu_uuids:gpus.map(g=>g.uuid),started_at:time(start),expected_end_at:end===null?null:time(end),ended_at:status==='completed'?time(end):null,status,eta_source:'manual',...more});
  return [
    {server_id:'server-a',name:'Atlas',updated_at:time(-.003),collector_ok:true,gpus:a,jobs:[
      job('a1','GEPA · Qwen3-8B',[a[0]],-14,9,'running',{description:'AIME25 · prompt optimization · seed 42',progress:{completed:168,total:280}}),
      job('a2','AIME · baseline',[a[1]],-12,-2,'completed',{description:'Qwen3-4B · thinking on'}),
      job('a3','GEPA · ablation',[a[1]],4,19,'planned',{description:'Reflection minibatch size 비교'})]},
    {server_id:'server-b',name:'Nova',updated_at:time(-.015),collector_ok:true,gpus:b,jobs:[
      job('b0','데이터 검증',[b[0]],-22,-13,'completed'),
      job('b1','Data augmentation',[b[0]],-11,19,'running',{description:'실패 문제 기반 synthetic data 생성',progress:{completed:740,total:2000}}),
      job('b2','증강 데이터 평가',[b[0]],22,41,'planned')]},
    {server_id:'server-c',name:'Orion',updated_at:time(-1.2),collector_ok:true,gpus:c,jobs:[
      job('c1','Audio · feature extraction',[c[0]],-17,null,'running',{description:'종료 예정시간 미등록 · 마지막 수신 상태'}),
      job('c2','CAN encoder eval',[c[1]],-18,-6,'completed')]}];
}
