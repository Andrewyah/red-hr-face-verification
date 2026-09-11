/** First-party camera enrollment and evaluation. Never issues a login session. */
const enc = new TextEncoder();
const ORIGIN = "https://red-aluminium-hr.andrewyah.chatgpt.site";
const MODEL_ORIGIN = "https://face-verifier-api-production.up.railway.app";
const MODEL_VERSION = "red-face-2026-09-v1";
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(n=>n.toString(16).padStart(2,"0")).join("");
class Failure extends Error {
 code: string; status: number;
 constructor(code: string, status = 400) { super(code); this.code=code; this.status=status; }
}
const reply = (data: unknown, status=200) => new Response(JSON.stringify(data), {status,headers:{
 "Content-Type":"application/json", "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff",
 "Access-Control-Allow-Origin":ORIGIN, "Vary":"Origin",
}});

async function rpc(name: string, body: unknown, bearer: string) {
 const url=Deno.env.get("SUPABASE_URL"), key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(!url||!key) throw new Failure("face_service_unavailable",503);
 const r=await fetch(`${url}/rest/v1/rpc/${name}`,{method:"POST",redirect:"error",signal:AbortSignal.timeout(10000),
  headers:{"Content-Type":"application/json",apikey:key,Authorization:bearer},body:JSON.stringify(body)});
 const data=await r.json();
 if(!r.ok) {
  const code=/^face_[a-z_]+$/.test(data.message||"")?data.message:"face_auth_required";
  throw new Failure(code, code==="face_rate_limited"||code==="face_service_busy"?429:403);
 }
 return data;
}
async function boundedJSON(req: Request) {
 const reader=req.body?.getReader(); if(!reader) throw new Failure("face_invalid_request");
 let size=0, expired=false; const chunks: Uint8Array[]=[];
 const timer=setTimeout(()=>{expired=true;void reader.cancel();},12000);
 try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;
  if(size>1650000){await reader.cancel();throw new Failure("face_capture_too_large",413);}chunks.push(value);}}
 finally{clearTimeout(timer);}
 if(expired)throw new Failure("face_capture_timeout",408);
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}
 catch{throw new Failure("face_invalid_request");}
}
function keysOnly(data: object, keys: string[]) {
 if(Object.keys(data).sort().join(",")!==keys.sort().join(","))throw new Failure("face_invalid_request");
}
async function infer(job: any, frames: string[], config: any) {
 if(config.url!==MODEL_ORIGIN)throw new Failure("face_service_unavailable",503);
 const bytes=Uint8Array.from(atob(config.key),c=>c.charCodeAt(0));
 if(bytes.length!==32)throw new Failure("face_service_unavailable",503);
 const key=await crypto.subtle.importKey("raw",bytes,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const path=job.purpose==="enroll"?"/v1/enroll":"/v1/verify";
 const payload: any={subject:job.subject,frames};if(job.purpose==="test")payload.template=job.template;
 const body=JSON.stringify(payload),ts=String(Math.floor(Date.now()/1000)),nonce=hex(crypto.getRandomValues(new Uint8Array(24)).buffer);
 const proof=enc.encode(["POST",path,ts,nonce,hex(await crypto.subtle.digest("SHA-256",enc.encode(body)))].join("\n"));
 const signature=hex(await crypto.subtle.sign("HMAC",key,proof));
 const r=await fetch(MODEL_ORIGIN+path,{method:"POST",redirect:"error",signal:AbortSignal.timeout(25000),
  headers:{"Content-Type":"application/json","X-Face-Timestamp":ts,"X-Face-Nonce":nonce,"X-Face-Signature":signature},body});
 const result=await r.json();
 if(!r.ok) {
  const errors: Record<string,string>={exactly_one_face_required:"face_one_person_required",adjust_distance:"face_move_closer",
   face_outside_frame:"face_center_required",improve_lighting_or_focus:"face_lighting_required",face_alignment:"face_center_required",duplicate_frames:"face_capture_again",service_busy:"face_service_busy"};
  throw new Failure(errors[result.error]||"face_capture_rejected",r.status===429?429:422);
 }
 if(result.mode!=="evaluation"||result.authenticated!==false||result.model_version!==MODEL_VERSION||typeof result.quality_passed!=="boolean")
  throw new Failure("face_service_unavailable",503);
 return result;
}

Deno.serve(async(req: Request)=>{
 // Browser access is limited to the existing HR origin. CORS is not auth.
 if(req.headers.get("Origin")!==ORIGIN)return reply({error:"face_origin_denied"},403);
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":ORIGIN,
  "Access-Control-Allow-Methods":"POST", "Access-Control-Allow-Headers":"authorization,apikey,content-type", "Vary":"Origin"}});
 if(req.method!=="POST")return reply({error:"face_method_not_allowed"},405);
 const bearer=req.headers.get("Authorization")||"";
 if(!/^Bearer [A-Za-z0-9._-]{30,8192}$/.test(bearer))return reply({error:"face_auth_required"},401);
 if((req.headers.get("Content-Type")||"").split(";")[0]!=="application/json")return reply({error:"face_json_required"},415);
 try{
  // This RPC verifies the JWT, active employee, auth.sessions membership and
  // session expiry before any expensive model call or template access.
  const binding=await rpc("hr_face_self",{p_action:"binding",p_data:{}},bearer);
  const input=await boundedJSON(req);
  if(!input||Array.isArray(input)||typeof input!=="object")throw new Failure("face_invalid_request");
  if(input.action==="status"||input.action==="revoke"){
   keysOnly(input,["action"]);return reply(await rpc("hr_face_self",{p_action:input.action,p_data:{}},bearer));
  }
  if(input.action==="begin"){
   keysOnly(input,["action","purpose","consent"]);
   if(!["enroll","test"].includes(input.purpose))throw new Failure("face_invalid_request");
   return reply(await rpc("hr_face_self",{p_action:"begin",p_data:{purpose:input.purpose,consent:input.consent}},bearer));
  }
  if(input.action!=="capture")throw new Failure("face_invalid_request");
  keysOnly(input,["action","id","frames"]);
  if(typeof input.id!=="string"||!/^[0-9a-f-]{36}$/.test(input.id)||!Array.isArray(input.frames)||input.frames.length!==3||
    !input.frames.every((f: unknown)=>typeof f==="string"&&f.length>100&&f.length<=533336&&/^[A-Za-z0-9+/]+={0,2}$/.test(f)))
   throw new Failure("face_invalid_request");
  const service="Bearer "+Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const job=await rpc("hr_face_job",{p_action:"claim",p_user_id:binding.user_id,p_id:input.id,p_data:{session_id:binding.session_id}},service);
  let measured: any;
  try{ measured=await infer(job,input.frames,await rpc("hr_face_service_config",{},service)); }
  catch(error){
   // Consume failed captures too. Do not store frames or exception payloads.
   await rpc("hr_face_job",{p_action:"finish",p_user_id:binding.user_id,p_id:input.id,p_data:{receipt:job.receipt}},service).catch(()=>{});
   throw error;
  }
  const result=await rpc("hr_face_job",{p_action:"finish",p_user_id:binding.user_id,p_id:input.id,p_data:{receipt:job.receipt,
   model_version:measured.model_version,quality_passed:measured.quality_passed,
   ...(job.purpose==="enroll"?{template:measured.template}:{candidate_match:measured.candidate_match===true})}},service);
  // The browser receives no reference template, employee ID, scores or tokens.
  return reply(result);
 }catch(error){
  return reply({error:error instanceof Failure?error.code:"face_service_unavailable",authenticated:false},error instanceof Failure?error.status:503);
 }
});
