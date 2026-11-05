import {GitHubEditsStore,encodeJSON,decodeJSON} from '../edits.js?v=1.2.0';
import {emptyHistory,validateHistory,mergeSamples} from './api-usage-model.js?v=2.1.1';

export class APIUsageStore{
  constructor(dashboard,fetcher=(...args)=>fetch(...args)){
    this.client=new GitHubEditsStore(dashboard,fetcher);this.fetcher=fetcher;this.root=this.client.root;
    this.path='dashboard/openrouter-usage-test.json';this.url=this.root+'/contents/'+this.path;
    this.rawURL=`https://raw.githubusercontent.com/${dashboard.repository}/status/${this.path}`;this.saving=false;
  }
  async readPublic(){
    const response=await this.fetcher(this.rawURL+'?_='+Date.now(),{cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});
    if(response.status===404)return emptyHistory();
    if(!response.ok)throw new Error('사용량 이력을 불러오지 못했습니다.');
    return validateHistory(await response.json());
  }
  async readLatest(token){
    try{
      const file=await this.client.request(this.url+'?ref=status&_='+Date.now(),token);
      if(file.type!=='file'||file.encoding!=='base64'||!file.sha||typeof file.content!=='string'||file.content.length>1500000||(file.size||0)>1000000)throw new Error('원본 사용량 이력을 확인할 수 없습니다.');
      return {data:validateHistory(decodeJSON(file.content)),sha:file.sha};
    }catch(error){if(error.status!==404)throw error;await this.client.request(this.root+'/git/ref/heads/status',token);return {data:emptyHistory(),sha:null};}
  }
  async append(token,samples,now=Date.now()){
    if(!token)throw new Error('관리자 로그인이 필요합니다.');
    if(this.saving)throw new Error('앞선 이력 저장이 끝난 뒤 다시 시도해 주세요.');
    this.saving=true;
    try{
      for(let attempt=0;attempt<4;attempt++){
        const {data,sha}=await this.readLatest(token),next=mergeSamples(data,samples,now);
        if(JSON.stringify(next.samples)===JSON.stringify(data.samples))return data;
        next.revision=data.revision+1;next.updated_at=new Date(now).toISOString();validateHistory(next);
        try{
          await this.client.request(this.url,token,{method:'PUT',body:JSON.stringify({message:'test usage charts: record public cost observations',branch:'status',content:encodeJSON(next),...(sha?{sha}:{})})});
          return next;
        }catch(error){if(![409,422].includes(error.status)||attempt===3)throw error;await this.client.pause(200*(attempt+1));}
      }
    }finally{this.saving=false;}
  }
}
