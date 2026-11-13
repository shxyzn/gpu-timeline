// Entry gate of the test-server workspace. index.html checks the shared password and starts a
// session; preview.html loads the workspace only for a signed-in browser. This is separate from
// dashboard administration, which still needs the administrator's own GitHub connection.
import {GATE} from './gate.js?v=workspace-3a';
import {openGate,toBase64} from './workspace-crypto.js?v=workspace-3a';
import {currentSession,startSession,endSession,lastName,cleanName} from './session.js?v=workspace-3a';

const form=document.getElementById('workspace-login');
const previewURL=new URL('./preview.html',import.meta.url);
const entryURL=new URL('./',import.meta.url);
const anchors=new Set(['home','research','now','timeline','resources','servers','parcel','more','release-video','api-usage-board','patch-notes']);

if(form){
  const name=document.getElementById('workspace-name'),password=document.getElementById('workspace-password');
  const remember=document.getElementById('workspace-remember'),error=document.getElementById('workspace-error');
  const submit=form.querySelector('button[type=submit]');
  // replace(): the entry page must not stay in history, or Back would bounce forward again.
  const enter=()=>{const anchor=new URLSearchParams(location.search).get('panel');if(anchors.has(anchor))previewURL.hash=anchor;location.replace(previewURL.href);};
  const fail=(message,field)=>{error.textContent=message;field?.setAttribute('aria-invalid','true');field?.focus();};
  window.addEventListener('pageshow',event=>{if(event.persisted&&currentSession(GATE))enter();});
  if(currentSession(GATE))enter();
  else{
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      if(submit.disabled)return;
      for(const field of [name,password])field.removeAttribute('aria-invalid');
      const visitor=cleanName(name.value);
      if(!visitor)return fail('이름을 입력해 주세요.',name);
      if(!password.value)return fail('비밀번호를 입력해 주세요.',password);
      submit.disabled=true;submit.textContent='확인 중…';error.textContent='';
      try{
        const key=await openGate(GATE,password.value);
        if(!key){password.value='';fail('비밀번호가 맞지 않아요.',password);return;}
        startSession(GATE,{name:visitor,key:toBase64(key),remember:remember.checked});
        password.value='';
        enter();
      }catch(problem){
        fail(problem?.message||'로그인할 수 없어요. 브라우저 설정을 확인해 주세요.');
      }finally{submit.disabled=false;submit.textContent='로그인';}
    });
    for(const field of [name,password])field.addEventListener('input',()=>{field.removeAttribute('aria-invalid');error.textContent='';});
    name.value=lastName();
    for(const field of [name,password,remember,submit])field.disabled=false;
    (name.value?password:name).focus();
  }
}else{
  const leave=()=>{const anchor=location.hash.slice(1);if(anchors.has(anchor))entryURL.searchParams.set('panel',anchor);location.replace(entryURL.href);};
  const session=currentSession(GATE);
  if(!session)leave();
  else{
    // A page restored from the back/forward cache still holds the earlier visitor's records and
    // name in memory. Start over so the gate decides again from nothing.
    window.addEventListener('pageshow',event=>{if(event.persisted){document.querySelector('main').hidden=true;if(currentSession(GATE))location.reload();else leave();}});
    window.addEventListener('storage',()=>{if(!currentSession(GATE))leave();});
    // The name and sign-out belong to the gate: they must work while the dashboard is still
    // loading, and when it fails to load. Hide the page before leaving: a browser may keep it
    // for Back, and it must come back empty.
    document.getElementById('workspace-user').textContent=session.name+'님';
    document.getElementById('workspace-logout').onclick=()=>{document.querySelector('main').hidden=true;endSession();location.assign(entryURL.href);};
    document.querySelector('main').hidden=false;
    try{
      await Promise.all([
        import('./kimi-tribute.js?v=2.1-kimi'),
        import('../promo.js?patch=closed-panels'),
        import('../usage.js'),
        import('./app.js?patch=workspace-3'),
        import('./workspace.js?v=workspace-3a'),
        import('./research-board.js?v=workspace-3a'),
      ]);
    }catch{
      const problem=document.getElementById('workspace-load-error');
      if(problem)problem.hidden=false;
      document.body.dataset.workspace='failed';
    }
  }
}
