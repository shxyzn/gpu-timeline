import {GitHubEditsStore,encodeJSON,decodeJSON} from '../edits.js?v=1.2.0';
import {emptyMonitoring,validateMonitoring,validateConfig} from './monitoring-model.js?v=2.1';

export class MonitoringStore {
  constructor(dashboard,fetcher=(...args)=>fetch(...args)){
    this.client=new GitHubEditsStore(dashboard,fetcher);this.fetcher=fetcher;
    this.root=this.client.root;this.branch='status';this.path='dashboard/monitoring-test.json';
    this.url=`${this.root}/contents/${this.path}`;
    this.rawURL=`https://raw.githubusercontent.com/${dashboard.repository}/status/${this.path}`;
    this.saving=false;
  }
  async readPublic(){
    const response=await this.fetcher(this.rawURL+'?_='+Date.now(),{cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});
    if(response.status===404)return emptyMonitoring();
    if(!response.ok)throw new Error('공용 모니터링 설정을 불러오지 못했어요. 마지막 설정을 유지합니다.');
    return validateMonitoring(await response.json());
  }
  async readLatest(token){
    try{
      const file=await this.client.request(this.url+'?ref=status&_='+Date.now(),token);
      if(file.type!=='file'||file.encoding!=='base64'||typeof file.content!=='string'||!file.sha)throw new Error('원본 모니터링 설정을 확인할 수 없어 저장을 멈췄어요.');
      return {data:validateMonitoring(decodeJSON(file.content)),sha:file.sha};
    }catch(error){
      if(error.status!==404)throw error;
      await this.client.request(this.root+'/git/ref/heads/status',token);
      return {data:emptyMonitoring(),sha:null};
    }
  }
  async saveServer(token,draft,expectedRevision,requestID){
    if(!token)throw new Error('관리자 로그인 후 저장할 수 있어요.');
    validateConfig(draft);
    if(this.saving)throw new Error('앞선 저장이 끝난 뒤 다시 시도해 주세요.');
    this.saving=true;
    try{
      for(let attempt=0;attempt<4;attempt++){
        const {data,sha}=await this.readLatest(token),previous=data.servers.find(c=>c.server_id===draft.server_id);
        if(previous?.request_id===requestID)return data;
        if((previous?.revision||0)!==expectedRevision)throw new Error('다른 관리자가 이 서버 설정을 바꿨어요. 최신 설정을 다시 불러온 뒤 변경해 주세요.');
        const at=new Date().toISOString(),saved={...structuredClone(draft),revision:expectedRevision+1,updated_at:at,request_id:requestID};
        const next={...data,revision:data.revision+1,updated_at:at,servers:[...data.servers.filter(c=>c.server_id!==draft.server_id),saved]};
        validateMonitoring(next);
        try{
          await this.client.request(this.url,token,{method:'PUT',body:JSON.stringify({message:`monitoring-test: ${draft.server_id} schedule`,branch:'status',content:encodeJSON(next),...(sha?{sha}:{})})});
          return next;
        }catch(error){if(![409,422].includes(error.status)||attempt===3)throw error;await this.client.pause(200*(attempt+1));}
      }
    }finally{this.saving=false;}
  }
}
