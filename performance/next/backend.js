// Authentication stays in memory, never in files, URLs or web storage.
(() => {
 const backend=window.AT_TRACK_CONFIG?.backend||'',remote=Boolean(backend&&new URL(backend).origin!==location.origin);
 let authorization='',loginTask=null;
 const dialog=document.getElementById('backend-dialog'),form=document.getElementById('backend-form'),error=document.getElementById('backend-error'),connect=document.getElementById('backend-connect');
 connect.hidden=!remote;
 async function signIn(){
  if(!remote||authorization)return;if(loginTask)return loginTask;
  loginTask=new Promise((resolve,reject)=>{
   error.textContent='';dialog.showModal();
   const cancel=()=>{loginTask=null;reject(Error('Connect to Cloudflare to view performance data.'));};
   dialog.oncancel=cancel;document.getElementById('backend-cancel').onclick=()=>{dialog.close();cancel();};
   form.onsubmit=async event=>{
    event.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;
    try{
     const value='Basic '+btoa('admin:'+form.elements.password.value);
     const response=await fetch(backend+'/api/status',{headers:{Authorization:value},cache:'no-store',credentials:'omit'});
     if(!response.ok)throw Error(response.status===401?'Incorrect dashboard password.':'Cloudflare connection failed ('+response.status+').');
     authorization=value;form.reset();dialog.close();loginTask=null;connect.textContent='Disconnect performance';resolve();
    }catch(e){error.textContent=e.message;}finally{button.disabled=false;}
   };
  });return loginTask;
 }
 async function request(path,options={}){
  if(!remote)return fetch(path,options);
  if(!path.startsWith('/api/'))throw Error('Invalid performance API path');
  await signIn();const headers=new Headers(options.headers);headers.set('Authorization',authorization);
  const response=await fetch(backend+path,{...options,headers,credentials:'omit',cache:'no-store'});
  if(response.status===401){authorization='';connect.textContent='Connect performance';throw Error('Session rejected. Connect performance again.');}
  return response;
 }
 window.ATBackend={remote,get connected(){return !remote||Boolean(authorization);},fetch:request,signIn};
 connect.onclick=async()=>{if(authorization){authorization='';location.reload();return;}try{await signIn();await window.ATWorkspace.refresh(true);}catch{}};
 document.addEventListener('workspace:view',async event=>{if(!remote||event.detail==='live')return;try{await signIn();await window.ATWorkspace?.refresh(true);}catch(e){const notice=document.getElementById('notice');notice.textContent=e.message;notice.hidden=false;}});
 document.getElementById('export').addEventListener('click',async event=>{
  if(!remote)return;event.preventDefault();
  try{const response=await request(document.getElementById('export').getAttribute('href'));if(!response.ok){const data=await response.json();throw Error(data.error||'Export failed');}const blob=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=blob;link.download='route-performance.csv';link.click();setTimeout(()=>URL.revokeObjectURL(blob),1000);}catch(e){const notice=document.getElementById('notice');notice.textContent=e.message;notice.hidden=false;}
 });
})();
