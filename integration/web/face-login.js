/* Hands-free login client. Activate only with the validated server exchange. */
(() => {
 'use strict';
 let active=null;
 const stop=s=>s?.getTracks().forEach(t=>t.stop());
 const fail=code=>Object.assign(new Error(code),{code});
 const delay=(ms,signal)=>new Promise((resolve,reject)=>{
  const abort=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 });
 const messages={face_login_not_enabled:'Face login is not available yet. Please use Sign in.',face_not_recognized:'Face not recognized. Keep your whole face visible.',face_one_person_required:'Keep only your face in view.',face_move_closer:'Move closer to the camera.',face_lighting_required:'Use better lighting and hold the phone steady.',face_capture_again:'Hold the phone steady.',face_capture_rejected:'Unable to verify your face. Please use Sign in.',face_rate_limited:'Too many attempts. Try again later.',face_unsteady:'Hold your phone steady and try again.',face_service_unavailable:'Face login is temporarily unavailable. Please use Sign in.'};
 function explain(e){if(e.name==='NotAllowedError')return 'Allow camera access in your browser settings.';if(e.name==='NotFoundError')return 'No camera was found.';return messages[e.code]||'Unable to verify your face. Please use Sign in.';}
 function capture(video){
  if(video.readyState<2||!video.videoWidth||!video.videoHeight)throw fail('face_capture_again');
  const canvas=document.createElement('canvas'),scale=Math.min(1,640/Math.max(video.videoWidth,video.videoHeight));
  canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
  canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
  try{const jpeg=canvas.toDataURL('image/jpeg',0.82).split(',')[1];if(!jpeg||jpeg.length>533336)throw fail('face_capture_again');return jpeg;}
  finally{canvas.width=0;canvas.height=0;}
 }
 async function steady(video,signal){
  const canvas=document.createElement('canvas');canvas.width=24;canvas.height=24;
  const context=canvas.getContext('2d',{willReadFrequently:true});let previous=null,count=0;
  try{for(let i=0;i<24;i++){
   await delay(500,signal);if(video.readyState<2)continue;
   context.drawImage(video,0,0,24,24);const pixels=context.getImageData(0,0,24,24).data;
   if(previous){let change=0;for(let j=0;j<pixels.length;j+=4)change+=Math.abs(pixels[j]-previous[j])+Math.abs(pixels[j+1]-previous[j+1])+Math.abs(pixels[j+2]-previous[j+2]);
    count=change/(24*24*3)<8?count+1:0;if(count>=3)return;}
   previous=new Uint8ClampedArray(pixels);
  }throw fail('face_unsteady');}finally{previous=null;canvas.width=0;canvas.height=0;}
 }
 function open({client,config,onContinue=()=>{},onDone=()=>{}}){
  active?.close();const controller=new AbortController(),signal=controller.signal;
  let stream=null,closed=false,session=null,keep=false,installed=false;
  const dialog=document.createElement('dialog');dialog.className='face-dialog';dialog.setAttribute('aria-labelledby','faceLoginTitle');
  dialog.innerHTML=`<div class="face-heading"><div><h2 id="faceLoginTitle">Face login</h2></div><button class="btn face-close" type="button">Close</button></div><div class="face-body"><div class="face-view"><video autoplay muted playsinline aria-label="Front camera preview"></video><span class="face-guide" aria-hidden="true"></span><span class="face-light" aria-hidden="true"></span></div><p class="face-feedback" role="status" aria-live="polite">Hold your phone steady and look at the camera.</p></div>`;
  document.body.append(dialog);const video=dialog.querySelector('video'),feedback=dialog.querySelector('.face-feedback');
  const show=(text,state='checking')=>{if(!closed){feedback.textContent=text;dialog.dataset.state=state;}};
  const clear=()=>{stop(stream);stream=null;video.srcObject=null;};
  async function discard(value){
   if(!value?.access_token)return;
   if(installed){await client.auth.signOut({scope:'local'}).catch(()=>{});return;}
   await fetch(config.SUPABASE_URL+'/auth/v1/logout?scope=local',{method:'POST',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(10000),headers:{apikey:config.SUPABASE_PUBLISHABLE_KEY,Authorization:'Bearer '+value.access_token}}).catch(()=>{});
  }
  function close(){if(closed)return;closed=true;controller.abort();clear();window.removeEventListener('pagehide',close);document.removeEventListener('visibilitychange',hidden);dialog.close();dialog.remove();if(active?.close===close)active=null;if(!keep&&session)void discard(session);session=null;onDone();}
  const hidden=()=>{if(document.hidden)close();};active={close};window.addEventListener('pagehide',close);document.addEventListener('visibilitychange',hidden);
  dialog.querySelector('.face-close').onclick=close;dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.addEventListener('close',()=>{if(!closed)close();});
  async function request(body){const r=await fetch(config.SUPABASE_URL+'/functions/v1/hr-face-login',{method:'POST',credentials:'omit',cache:'no-store',headers:{apikey:config.SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(45000)])});const value=await r.json();if(!r.ok)throw fail(value.error||'face_service_unavailable');return value;}
  async function verify(){
   if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw fail('face_service_unavailable');
   const opened=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'user'},width:{ideal:640},height:{ideal:640}},audio:false});
   if(closed){stop(opened);return;}stream=opened;video.srcObject=stream;await video.play();if(closed)return;
   for(let attempt=0;attempt<3&&!closed;attempt++){
    let frames=[];
    try{
     await steady(video,signal);const challenge=await request({action:'begin'});show('Checking your face…');
     for(let i=0;i<3;i++){await delay(800,signal);frames.push(capture(video));}
     const result=await request({action:'capture',id:challenge.id,proof:challenge.proof,frames});frames.fill('');
     if(result.authenticated!==true||!result.session?.access_token||!result.session.refresh_token)throw fail('face_service_unavailable');
     session=result.session;if(closed){await discard(session);session=null;return;}
     const identity=await client.auth.getUser(session.access_token);if(closed)return;
     if(identity.error||!identity.data.user?.id)throw fail('face_service_unavailable');
     const value=session;const established=await client.auth.setSession(value);installed=true;
     if(closed){await discard(value);return;}
     if(established.error||established.data.user?.id!==identity.data.user.id)throw fail('face_service_unavailable');
     show('Verified. Signing in…','verified');clear();await delay(650,signal);if(closed)return;
     keep=true;close();onContinue(true);return;
    }catch(e){
     if(closed||e.name==='AbortError')return;
     if(attempt<2&&['face_not_recognized','face_one_person_required','face_move_closer','face_lighting_required','face_capture_again'].includes(e.code)){show(explain(e));await delay(1200,signal);continue;}
     throw e;
    }finally{frames.fill('');frames=[];}
   }
  }
  dialog.showModal();dialog.querySelector('.face-close').focus();
  // Camera starts from the original tap; no nested Sign in or capture button.
  void verify().catch(async e=>{clear();if(session&&!keep){await discard(session);session=null;}if(!closed&&e.name!=='AbortError')show(explain(e),'failed');});
  return {close};
 }
 window.HRFaceLogin=Object.freeze({open,close:()=>active?.close()});
})();
