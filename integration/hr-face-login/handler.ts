/** Backend-only authorization. No browser-supplied employee, match or template. */
const enc = new TextEncoder();
const ORIGIN = 'https://red-aluminium-hr.andrewyah.chatgpt.site';
const MODEL = 'https://face-verifier-api-production.up.railway.app';
const MODEL_VERSION = 'red-face-2026-09-v1', RECIPE = 'red-face-identify-v1';
const hex = b => [...new Uint8Array(b)].map(v=>v.toString(16).padStart(2,'0')).join('');
const hash = async text => hex(await crypto.subtle.digest('SHA-256',enc.encode(text)));
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
class Failure extends Error { constructor(code,status=400){super(code);this.code=code;this.status=status;} }
const response = (data,status=200) => Response.json(data,{status,headers:{
 'Access-Control-Allow-Origin':ORIGIN,'Vary':'Origin','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
}});
function exact(data,keys){if(!data||Array.isArray(data)||typeof data!=='object'||Object.keys(data).sort().join(',')!==keys.sort().join(','))throw new Failure('face_invalid_request');}
async function read(req){
 const reader=req.body?.getReader();if(!reader)throw new Failure('face_invalid_request');
 let size=0,expired=false;const chunks=[];
 const timer=setTimeout(()=>{expired=true;void reader.cancel();},12000);
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1650000){await reader.cancel();throw new Failure('face_capture_too_large',413);}chunks.push(value);}}
 finally{clearTimeout(timer);}
 if(expired)throw new Failure('face_capture_expired',408);
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Failure('face_invalid_request');}
}

export function makeHandler({url,serviceKey,createAuth}){
 async function rpc(name,data){
  const r=await fetch(url+'/rest/v1/rpc/'+name,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{
   apikey:serviceKey,Authorization:'Bearer '+serviceKey,'Content-Type':'application/json'},body:JSON.stringify(data)});
  const value=await r.json();if(!r.ok){const code=/^face_[a-z_]+$/.test(value.message||'')?value.message:'face_service_unavailable';throw new Failure(code,code==='face_rate_limited'?429:503);}return value;
 }
 async function job(action,id,data){return rpc('hr_face_login',{p_action:action,p_id:id,p_data:data});}
 async function measure(candidates,frames){
  const config=await rpc('hr_face_service_config',{});
  if(config.url!==MODEL)throw new Failure('face_service_unavailable',503);
  const bytes=Uint8Array.from(atob(config.key),c=>c.charCodeAt(0));if(bytes.length!==32)throw new Failure('face_service_unavailable',503);
  const key=await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const body=JSON.stringify({candidates,frames}),path='/v1/identify',timestamp=String(Math.floor(Date.now()/1000)),nonce=random();
  const signature=hex(await crypto.subtle.sign('HMAC',key,enc.encode(['POST',path,timestamp,nonce,await hash(body)].join('\n'))));
  const r=await fetch(MODEL+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),body,headers:{
   'Content-Type':'application/json','X-Face-Timestamp':timestamp,'X-Face-Nonce':nonce,'X-Face-Signature':signature}});
  const value=await r.json();if(!r.ok){const errors={exactly_one_face_required:'face_one_person_required',adjust_distance:'face_move_closer',improve_lighting_or_focus:'face_lighting_required',duplicate_frames:'face_capture_again',service_busy:'face_rate_limited'};throw new Failure(errors[value.error]||'face_capture_rejected',r.status===429?429:422);}
  if(value.mode!=='evaluation'||value.authenticated!==false||value.model_version!==MODEL_VERSION||value.recipe!==RECIPE
   ||typeof value.quality_passed!=='boolean'||typeof value.candidate_match!=='boolean')throw new Failure('face_service_unavailable',503);
  // Measurements may only be consumed after the database release gate succeeds.
  if(value.candidate_match&&(typeof value.subject!=='string'||!candidates.some(c=>c.subject===value.subject)
   ||!Number.isFinite(value.similarity)||value.similarity<0.65||!Number.isFinite(value.margin)||value.margin<0.12))throw new Failure('face_capture_rejected',422);
  return value;
 }
 return async function handler(req){
  if(req.headers.get('Origin')!==ORIGIN)return response({error:'face_origin_denied'},403);
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':ORIGIN,'Vary':'Origin','Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'apikey,content-type'}});
  if(req.method!=='POST')return response({error:'face_method_not_allowed'},405);
  if((req.headers.get('Content-Type')||'').split(';')[0]!=='application/json')return response({error:'face_json_required'},415);
  let input;
  try{
   if(!url||!serviceKey)throw new Failure('face_service_unavailable',503);
   input=await read(req);
   if(input?.action==='begin'){
    exact(input,['action']);const proof=random(),proof_hash=await hash(proof);
    const begun=await job('begin',null,{proof_hash});return response({id:begun.id,expires_at:begun.expires_at,proof});
   }
   exact(input,['action','id','proof','frames']);
   if(input.action!=='capture'||typeof input.id!=='string'||!/^[0-9a-f-]{36}$/.test(input.id)
    ||typeof input.proof!=='string'||!/^[0-9a-f]{64}$/.test(input.proof)||!Array.isArray(input.frames)||input.frames.length!==3
    ||!input.frames.every(f=>typeof f==='string'&&f.length>100&&f.length<=533336&&/^[A-Za-z0-9+/]+={0,2}$/.test(f)))throw new Failure('face_invalid_request');
   // Fingerprint decoded bytes; changing base64 padding or order cannot replay a capture.
   const digests=await Promise.all(input.frames.map(async f=>hex(await crypto.subtle.digest('SHA-256',Uint8Array.from(atob(f),c=>c.charCodeAt(0))))));
   if(new Set(digests).size!==3)throw new Failure('face_capture_again',422);
   const proof_hash=await hash(input.proof),frame_hash=await hash(digests.sort().join(':'));
   const claimed=await job('claim',input.id,{proof_hash,frame_hash});
   let result;
   try{result=await measure(claimed.candidates,input.frames);}
   catch(error){await job('finish',input.id,{proof_hash,receipt:claimed.receipt}).catch(()=>{});throw error;}
   input.frames.fill('');
   const matched=await job('finish',input.id,{proof_hash,receipt:claimed.receipt,subject:result.subject,
    candidate_match:result.candidate_match,quality_passed:result.quality_passed,model_version:result.model_version,recipe:result.recipe});
   if(matched.matched!==true)return response({authenticated:false,error:'face_not_recognized'},422);
   if(req.signal.aborted)throw new Failure('face_capture_expired');
   const auth=createAuth();let session;
   try{
    // The matched user comes only from the active enrollment snapshot in Postgres.
    const existing=await auth.admin.getUserById(matched.user_id);
    if(existing.error||existing.data.user?.id!==matched.user_id||existing.data.user.email!==matched.email||!existing.data.user.email_confirmed_at)throw new Failure('face_capture_expired');
    const link=await auth.admin.generateLink({type:'magiclink',email:matched.email});
    if(link.error||link.data.user?.id!==matched.user_id||!link.data.properties?.hashed_token)throw new Failure('face_service_unavailable',503);
    // Server-side exchange only: no email, OTP, URL token or sign-in link is sent to the employee.
    const verified=await auth.verifyOtp({type:'email',token_hash:link.data.properties.hashed_token});session=verified.data.session;
    if(verified.error||!session?.access_token||!session.refresh_token||session.user?.id!==matched.user_id)throw new Failure('face_service_unavailable',503);
    const identity=await auth.getUser(session.access_token);
    if(identity.error||identity.data.user?.id!==matched.user_id)throw new Failure('face_capture_expired');
    const segment=session.access_token.split('.')[1];
    const payload=JSON.parse(atob(segment.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(segment.length/4)*4,'=')));
    const finished=await job('finalize',input.id,{proof_hash,receipt:claimed.receipt,session_id:payload.session_id,email:matched.email});
    if(finished.authenticated!==true||finished.user_id!==matched.user_id||req.signal.aborted)throw new Failure('face_capture_expired');
    return response({authenticated:true,session:{access_token:session.access_token,refresh_token:session.refresh_token}});
   }catch(error){if(session?.access_token)await auth.admin.signOut(session.access_token,'local').catch(()=>{});throw error;}
  }catch(error){return response({authenticated:false,error:error instanceof Failure?error.code:'face_service_unavailable'},error instanceof Failure?error.status:503);}
  finally{if(Array.isArray(input?.frames))input.frames.fill('');}
 };
}
