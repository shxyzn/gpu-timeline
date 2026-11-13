const notice=document.getElementById('kimi-service-notice');
const trigger=document.getElementById('kimi-tribute-open');
const dialog=document.getElementById('kimi-tribute-dialog');
const close=document.getElementById('kimi-tribute-close');

if(notice&&trigger&&dialog&&close){
  function openTribute(){
    if(dialog.open||document.querySelector('dialog[open]'))return;
    document.querySelector('#release-video video')?.pause();
    dialog.showModal();
    document.documentElement.classList.add('kimi-tribute-open');
  }
  trigger.addEventListener('click',openTribute);
  close.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>document.documentElement.classList.remove('kimi-tribute-open'));
  dialog.addEventListener('click',event=>{
    if(event.target!==dialog)return;
    const bounds=dialog.getBoundingClientRect();
    if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)dialog.close();
  });
  document.addEventListener('keydown',event=>{
    if((event.key.toLowerCase()!=='x'&&event.code!=='KeyX')||event.repeat||event.isComposing||event.ctrlKey||event.altKey||event.metaKey)return;
    // The shortcut belongs to the notice: it does nothing while the notice is closed or its view
    // (the GPU dashboard) is not the one on screen.
    if(!notice.open||notice.closest('[hidden]')||document.hidden||document.querySelector('dialog[open]'))return;
    const target=event.target;
    if(target instanceof Element&&target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"]'))return;
    event.preventDefault();openTribute();
  });
}
