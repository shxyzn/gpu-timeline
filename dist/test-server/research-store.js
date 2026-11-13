import {GitHubEditsStore,encodeJSON,decodeJSON} from '../edits.js?v=1.2.0';
import {emptyResearch,validateResearch,applyResearchOperation} from './research-model.js?v=workspace-3a';
import {isEnvelope,sealJSON,openJSON} from './workspace-crypto.js?v=workspace-3a';

// The research document of the test server. It is stored sealed with the workspace key, so the
// file on the public status branch is unreadable without the shared login password. Commit
// messages stay generic for the same reason.
export const RESEARCH_PATH='dashboard/research-test.json';
const CONTEXT='cvml-workspace/research/v1';

export class ResearchStore{
  // session: {key: CryptoKey, keyID: string, retired?: Map<keyID, CryptoKey>} from the workspace
  // login. A file sealed with a retired key is still read, and the next save re-seals it.
  constructor(dashboard,session,fetcher=(...args)=>fetch(...args)){
    this.client=new GitHubEditsStore(dashboard,fetcher);this.fetcher=fetcher;this.session=session;
    this.root=this.client.root;this.path=RESEARCH_PATH;this.url=`${this.root}/contents/${this.path}`;
    this.rawURL=`https://raw.githubusercontent.com/${dashboard.repository}/status/${this.path}`;
    this.saving=false;
  }
  async open(stored){
    if(!isEnvelope(stored))throw new Error('연구과제 문서 형식을 읽을 수 없어요. 원본을 확인해 주세요.');
    const retired=this.session.retired?.get(stored.key_id);
    return validateResearch(retired?await openJSON(retired,stored.key_id,stored,CONTEXT):await openJSON(this.session.key,this.session.keyID,stored,CONTEXT));
  }
  async readPublic(){
    let response;
    try{response=await this.fetcher(this.rawURL+'?_='+Date.now(),{cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});}
    catch{throw new Error('연구과제 기록을 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.');}
    if(response.status===404)return emptyResearch();
    if(!response.ok)throw new Error('연구과제 기록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
    let stored;
    try{stored=await response.json();}catch{throw new Error('연구과제 문서 형식을 읽을 수 없어요. 원본을 확인해 주세요.');}
    return this.open(stored);
  }
  async readLatest(token){
    try{
      const file=await this.client.request(this.url+'?ref=status&_='+Date.now(),token);
      if(file.type!=='file'||file.encoding!=='base64'||typeof file.content!=='string'||!file.sha)throw new Error('원본 연구과제 문서를 확인할 수 없어 저장을 멈췄어요.');
      return {data:await this.open(decodeJSON(file.content)),sha:file.sha};
    }catch(error){
      if(error.status!==404)throw error;
      // A missing file is a first save; a missing branch or an unreadable repository is not.
      await this.client.request(this.root+'/git/ref/heads/status',token);
      return {data:emptyResearch(),sha:null};
    }
  }
  async save(token,operation){
    if(!token)throw new Error('관리자 로그인 후 저장할 수 있어요.');
    if(this.saving)throw new Error('앞선 저장이 끝난 뒤 다시 시도해 주세요.');
    this.saving=true;
    try{
      for(let attempt=0;attempt<4;attempt++){
        const {data,sha}=await this.readLatest(token),next=applyResearchOperation(data,operation);
        if(next.revision===data.revision)return data;
        const sealed=await sealJSON(this.session.key,this.session.keyID,next,CONTEXT);
        try{
          await this.client.request(this.url,token,{method:'PUT',body:JSON.stringify({message:'research: update workspace records',branch:'status',content:encodeJSON(sealed),...(sha?{sha}:{})})});
          return next;
        }catch(error){if(![409,422].includes(error.status)||attempt===3)throw error;await this.client.pause(200*(attempt+1));}
      }
    }finally{this.saving=false;}
  }
}
