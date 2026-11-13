import {monitoringAccess,openDashboardLogin,saveResearchDraft} from '../app.js?patch=snapshot3-1';
const $=id=>document.getElementById(id),name=sessionStorage.getItem('cvml.test.username')||'';
if(!name){sessionStorage.removeItem('cvml-gpu-timeline.test-preview.v1');location.replace('./');}
else {
const labels={project:'과제',schedule:'일정',achievement:'실적',acknowledgement:'사사',paper:'논문'};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let records=[],kind='all';
$('snapshot-user').textContent=name+'님';
$('snapshot-logout').onclick=()=>{sessionStorage.removeItem('cvml.test.username');sessionStorage.removeItem('cvml-gpu-timeline.test-preview.v1');location.assign('./');};
function showHome(){$('gpu-workspace').hidden=true;$('research-board').hidden=true;$('snapshot-home').hidden=false;window.scrollTo({top:0});}
$('snapshot-back').onclick=showHome;
$('research-back').onclick=showHome;
document.querySelectorAll('[data-workspace]').forEach(b=>b.onclick=()=>{const research=b.dataset.workspace==='research';$('research-board').hidden=!research;$('snapshot-home').hidden=true;$('gpu-workspace').hidden=research;window.scrollTo({top:0});if(research)load();});
$('research-admin').onclick=()=>{$('research-board').hidden=true;$('gpu-workspace').hidden=false;openDashboardLogin();};
$('research-add').onclick=()=>{if(!monitoringAccess().unlocked){$('research-status').textContent='기록을 저장하려면 관리자 연결이 필요해요.';return;} $('research-error').textContent='';$('research-form').reset();$('research-project').innerHTML='<option value="">선택 안 함</option>'+records.filter(r=>r.kind==='project').map(r=>'<option value="'+esc(r.title)+'">'+esc(r.title)+'</option>').join('');$('research-dialog').showModal();};
$('research-cancel').onclick=()=>$('research-dialog').close();
document.querySelectorAll('[data-kind]').forEach(b=>b.onclick=()=>{kind=b.dataset.kind;render();});
function render(){document.querySelectorAll('[data-kind]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.kind===kind)));const list=records.filter(r=>kind==='all'||r.kind===kind);$('research-list').innerHTML=list.map(r=>'<article class="research-item"><span class="research-meta">'+esc(labels[r.kind]||r.kind)+(r.project?' · '+esc(r.project):'')+' · '+esc(r.date||'날짜 미지정')+'</span><h3>'+esc(r.title)+'</h3><p>'+esc(r.detail)+'</p><span class="research-meta">'+esc(r.username)+' · '+esc((r.created_at||'').slice(0,10))+'</span></article>').join('')||'<div class="research-item">아직 등록된 기록이 없어요.</div>';}
async function load(){try{const r=await fetch('https://raw.githubusercontent.com/shxyzn/gpu-timeline/status/dashboard/research-snapshot1.json?_='+Date.now(),{cache:'no-store'});if(r.status===404)records=[];else if(r.ok){const d=await r.json();if(d.schema_version!==1||!Array.isArray(d.records))throw Error();records=d.records;}else throw Error();$('research-status').textContent='읽기 모드 · 저장하려면 관리자 연결이 필요해요.';render();}catch{$('research-status').textContent='과제 기록을 불러오지 못했어요.';}}
$('research-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),button=e.target.querySelector('[type=submit]');button.disabled=true;try{const d=await saveResearchDraft({kind:f.get('kind'),project:f.get('project'),title:f.get('title').trim(),date:f.get('date'),detail:f.get('detail').trim()},name);records=d.records;$('research-dialog').close();$('research-status').textContent='공유 기록에 저장했어요.';render();}catch(err){$('research-error').textContent=err.message||'저장에 실패했어요.';}finally{button.disabled=false;}};
render();
}
