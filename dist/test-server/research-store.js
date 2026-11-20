import {GitHubEditsStore,encodeJSON,decodeJSON} from '../edits.js?v=1.2.0';
import {emptyResearch,validateResearch,applyResearchOperation} from './research-model.js?v=workspace-12';
import {isEnvelope,sealJSON,openJSON} from './workspace-crypto.js?v=workspace-12';
import {PROFILE} from './profile.js?v=workspace-12';

// The research document of this site (see profile.js). It is stored sealed with the workspace key, so the
// file on the public status branch is unreadable without the shared login password. Commit
// messages stay generic for the same reason.
export const RESEARCH_PATH=PROFILE.files.research;
const CONTEXT='cvml-workspace/research/v1';

export class ResearchStore{
  // session: {key: CryptoKey, keyID: string, retired?: Map<keyID, CryptoKey>} from the workspace
  // login. A file sealed with a retired key is still read, and the next save re-seals it.
  constructor(dashboard,session,fetcher=(...args)=>fetch(...args)){
    this.client=new GitHubEditsStore(dashboard,fetcher);this.fetcher=fetcher;this.session=session;
    this.root=this.client.root;this.path=RESEARCH_PATH;this.url=`${this.root}/contents/${this.path}`;
    this.rawRoot=`https://raw.githubusercontent.com/${dashboard.repository}/status/`;
    this.saving=false;
  }
  async open(stored){
    if(!isEnvelope(stored))throw new Error('연구과제 문서 형식을 읽을 수 없어요. 원본을 확인해 주세요.');
    const retired=this.session.retired?.get(stored.key_id);
    return validateResearch(retired?await openJSON(retired,stored.key_id,stored,CONTEXT):await openJSON(this.session.key,this.session.keyID,stored,CONTEXT));
  }
  // Reads this site's own document, or another one named by the profile (the real records, when
  // the test server refreshes its practice copy). Reading never needs the administrator.
  async readPublic(path=this.path){
    let response;
    try{response=await this.fetcher(this.rawRoot+path+'?_='+Date.now(),{cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});}
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
          await this.client.request(this.url,token,{method:'PUT',body:JSON.stringify({message:PROFILE.commits.research+': update workspace records',branch:'status',content:encodeJSON(sealed),...(sha?{sha}:{})})});
          return next;
        }catch(error){if(![409,422].includes(error.status)||attempt===3)throw error;await this.client.pause(200*(attempt+1));}
      }
    }finally{this.saving=false;}
  }
  // Replaces this site's whole document with `source`: the practice copy of the test server takes
  // over the real records. Only a site whose profile names such a source can do this, so the
  // real records themselves are never replaced as a whole. The revision moves past both documents,
  // which makes every open tab accept the result.
  async replaceWith(token,source,at){
    if(!PROFILE.practiceSource)throw new Error('이 화면의 기록은 다른 기록으로 바꿀 수 없어요.');
    if(!token)throw new Error('관리자 로그인 후 가져올 수 있어요.');
    if(!source?.revision)throw new Error('정식 기록이 아직 없어요.');
    if(this.saving)throw new Error('앞선 저장이 끝난 뒤 다시 시도해 주세요.');
    this.saving=true;
    try{
      for(let attempt=0;attempt<4;attempt++){
        const {data,sha}=await this.readLatest(token);
        const next=validateResearch({...structuredClone(source),revision:Math.max(data.revision,source.revision)+1,updated_at:at});
        const sealed=await sealJSON(this.session.key,this.session.keyID,next,CONTEXT);
        try{
          await this.client.request(this.url,token,{method:'PUT',body:JSON.stringify({message:PROFILE.commits.research+': replace with the production records',branch:'status',content:encodeJSON(sealed),...(sha?{sha}:{})})});
          return next;
        }catch(error){if(![409,422].includes(error.status)||attempt===3)throw error;await this.client.pause(200*(attempt+1));}
      }
    }finally{this.saving=false;}
  }
}
