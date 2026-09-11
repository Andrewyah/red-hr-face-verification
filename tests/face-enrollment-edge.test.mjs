// HTTP contract tests with synthetic responses; no face accuracy claims.
import assert from 'node:assert/strict';
import {test,beforeEach} from 'node:test';
import {randomBytes,createHash,createHmac} from 'node:crypto';
let handler,calls=[],deny=false,claimError=false,upstreamError=false,wrongMode=false,purpose='enroll';
const key=randomBytes(32),origin='https://red-aluminium-hr.andrewyah.chatgpt.site',model='https://face-verifier-api-production.up.railway.app';
const userToken='Bearer '+ 'a'.repeat(40),serviceKey='test-only-service-key';
globalThis.Deno={env:{get:n=>({SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:serviceKey})[n]},serve:fn=>handler=fn};
await import('../integration/hr-face-enrollment/index.ts');
globalThis.fetch=async(url,opts)=>{
 const body=JSON.parse(opts.body);calls.push({url,body,headers:opts.headers});
 if(url.endsWith('/rpc/hr_face_self')){
  assert.equal(opts.headers.Authorization,userToken);
  if(deny)return Response.json({message:'Inactive employee'},{status:403});
  if(body.p_action==='binding')return Response.json({user_id:'bound-user',session_id:'bound-session'});
  return Response.json({enrolled:false,mode:'evaluation',login_enabled:false});
 }
 assert.equal(opts.headers.Authorization,url.startsWith(model)?undefined:'Bearer '+serviceKey);
 if(url.endsWith('/rpc/hr_face_job')){
  assert.equal(body.p_user_id,'bound-user');
  if(body.p_action==='claim'){
   assert.equal(body.p_data.session_id,'bound-session');
   if(claimError)return Response.json({message:'face_capture_used'},{status:403});
   return Response.json({subject:'bound-employee',purpose,template:'server-sealed-reference',receipt:'server-receipt'});
  }
  assert.equal(body.p_data.receipt,'server-receipt');
  return Response.json({result:body.p_data.quality_passed?(purpose==='enroll'?'enrolled':'test_match'):'rejected',mode:'evaluation',authenticated:false,login_enabled:false});
 }
 if(url.endsWith('/rpc/hr_face_service_config'))return Response.json({url:model,key:key.toString('base64')});
 assert(url===model+'/v1/enroll'||url===model+'/v1/verify');
 assert.equal(body.subject,'bound-employee');if(purpose==='test')assert.equal(body.template,'server-sealed-reference');
 const h=opts.headers,digest=createHash('sha256').update(opts.body).digest('hex');
 assert.equal(h['X-Face-Signature'],createHmac('sha256',key).update(['POST',new URL(url).pathname,h['X-Face-Timestamp'],h['X-Face-Nonce'],digest].join('\n')).digest('hex'));
 if(upstreamError)return Response.json({error:'exactly_one_face_required'},{status:422});
 return Response.json({mode:wrongMode?'production':'evaluation',authenticated:false,model_version:'red-face-2026-09-v1',quality_passed:true,template:'sealed-template',candidate_match:true});
};
beforeEach(()=>{calls=[];deny=false;claimError=false;upstreamError=false;wrongMode=false;purpose='enroll';});
const capture=()=>({action:'capture',id:'11111111-1111-4111-8111-111111111111',frames:['A'.repeat(104),'B'.repeat(104),'C'.repeat(104)]});
const request=(body,headers={})=>new Request('https://edge/hr-face-enrollment',{method:'POST',headers:{Origin:origin,Authorization:userToken,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
test('missing token and foreign origin never access private backend',async()=>{
 assert.equal((await handler(request({action:'status'},{Authorization:''}))).status,401);
 assert.equal((await handler(request({action:'status'},{Origin:'https://other.invalid'}))).status,403);assert.equal(calls.length,0);
});
test('inactive or invalid employee session stops before model/config',async()=>{
 deny=true;assert.equal((await handler(request(capture()))).status,403);assert.equal(calls.length,1);
});
test('browser cannot choose subject, template or return measured scores',async()=>{
 for(const extra of [{subject:'victim'},{template:'stolen'},{candidate_match:true}]){
  calls=[];assert.equal((await handler(request({...capture(),...extra}))).status,400);assert.equal(calls.length,1);
 }
});
test('already claimed request never reaches inference',async()=>{
 claimError=true;assert.equal((await handler(request(capture()))).status,403);assert.equal(calls.length,2);
});
test('enrollment signs exact body with server identity and returns no template/session',async()=>{
 const r=await handler(request(capture()));assert.equal(r.status,200);const b=await r.json();assert.equal(b.result,'enrolled');
 assert.equal(b.authenticated,false);assert.equal(b.login_enabled,false);assert.equal(b.template,undefined);assert.equal(b.access_token,undefined);
 assert.equal(calls.at(-1).body.p_data.template,'sealed-template');
});
test('test uses server reference and cannot open an auth session',async()=>{
 purpose='test';const r=await handler(request(capture()));assert.equal(r.status,200);assert.equal((await r.json()).result,'test_match');assert(!calls.some(c=>c.url.includes('/auth/')));
});
test('rejected capture is consumed and has a useful safe error',async()=>{
 upstreamError=true;const r=await handler(request(capture()));assert.equal(r.status,422);assert.equal((await r.json()).error,'face_one_person_required');
 assert.deepEqual(calls.at(-1).body.p_data,{receipt:'server-receipt'});
});
test('unexpected upstream mode is rejected without enrollment',async()=>{
 wrongMode=true;const r=await handler(request(capture()));assert.equal(r.status,503);assert.deepEqual(calls.at(-1).body.p_data,{receipt:'server-receipt'});
});
test('oversized payload is refused before claim or model call',async()=>{
 const r=await handler(request({action:'capture',padding:'x'.repeat(1650001)}));assert.equal(r.status,413);assert.equal(calls.length,1);
});
