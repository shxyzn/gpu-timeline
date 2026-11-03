const notice=document.getElementById('production-maintenance-notice');
if(notice){
  const end=Date.parse(notice.dataset.ends),remaining=end-Date.now();
  if(!Number.isFinite(end)||remaining<=0)notice.hidden=true;
  else setTimeout(()=>{notice.hidden=true;},remaining);
}
