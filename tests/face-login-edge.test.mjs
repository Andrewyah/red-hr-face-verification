import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {makeHandler} from '../integration/hr-face-login/handler.ts';
const origin='https://red-aluminium-hr.andrewyah.chatgpt.site',model='https://face-verifier-api-production.up.railway.app';
let calls=[],disabled=false,denied=false,match=true,wrongSubject=false,finalizeDenied=false,wrongUser=false,claimed=false,consumed=false;
const key=Buffer.alloc(32,7),id='11111111-1111-4111-8111-111111111111',user='user-a';
const payload=Buffer.from(JSON.stringify({session_id:'22222222-2222-4222-8222-222222222222'})).toString('base64url');
const session={access_token:'fixture.'+payload+'.signature',refresh_token:'fixture-refresh',user:{id:user}};
const handler=makeHandler({url:'https://test.supabase.co',serviceKey:'fixture-service',createAuth:()=>({
 admin:{getUserById:async()=>({data:{user:{id:user,email:'fixture@example.invalid',email_confirmed_at:'2026-09-11'}}}),
 generateLink:async params=>{calls.push({action:'generateLink',params});return {data:{user:{id:user},properties:{hashed_token:'fixture-token-hash'}}};},
 signOut:async()=>{calls.push({action:'revokeSession'});return {}; }},
 verifyOtp:async params=>{calls.push({action:'verifyOtp',params});return {data:{session}};},
 getUser:async()=>({data:{user:{id:wrongUser?'wrong-user':user}}}),
})});
globalThis.fetch=async(url,opts)=>{
 const body=JSON.parse(opts.body);calls.push({url,body});
 if(url.endsWith('/rpc/hr_face_login')){
  assert.equal(opts.headers.Authorization,'Bearer fixture-service');
  if(disabled)return Response.json({message:'face_login_not_enabled'},{status:403});
  if(body.p_action==='begin')return Response.json({id,expires_at:new Date(Date.now()+60000).toISOString()});
  if(body.p_action==='claim'){
   if(denied||claimed)return Response.json({message:'face_capture_used'},{status:403});claimed=true;
   return Response.json({receipt:'receipt-a',candidates:[{subject:'employee-a',template:'server-sealed-template'}]});
  }
  if(body.p_action==='finish'){
   assert.equal(body.p_data.receipt,'receipt-a');if(consumed)return Response.json({message:'face_capture_used'},{status:403});consumed=true;
   return Response.json(body.p_data.candidate_match===true?{matched:true,user_id:user,email:'fixture@example.invalid'}:{matched:false});
  }
  if(finalizeDenied)return Response.json({message:'face_capture_expired'},{status:403});
  assert.equal(body.p_data.session_id,'22222222-2222-4222-8222-222222222222');
  return Response.json({authenticated:true,user_id:user});
 }
 if(url.endsWith('/rpc/hr_face_service_config'))return Response.json({url:model,key:key.toString('base64')});
 assert.equal(url,model+'/v1/identify');assert.deepEqual(body.candidates,[{subject:'employee-a',template:'server-sealed-template'}]);
 const headers=opts.headers,digest=createHash('sha256').update(opts.body).digest('hex');
 assert.equal(headers['X-Face-Signature'],createHmac('sha256',key).update(['POST','/v1/identify',headers['X-Face-Timestamp'],headers['X-Face-Nonce'],digest].join('\n')).digest('hex'));
 return Response.json({mode:'evaluation',authenticated:false,model_version:'red-face-2026-09-v1',recipe:'red-face-identify-v1',quality_passed:true,candidate_match:match,subject:wrongSubject?'other-employee':match?'employee-a':null,similarity:0.9,margin:0.3});
};
beforeEach(()=>{calls=[];disabled=false;denied=false;match=true;wrongSubject=false;finalizeDenied=false;wrongUser=false;claimed=false;consumed=false;});
const capture=()=>({action:'capture',id,proof:'a'.repeat(64),frames:['A'.repeat(104),'B'.repeat(104),'C'.repeat(104)]});
const request=(body,extra={})=>new Request('https://edge/hr-face-login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
test('release is closed: begin returns no challenge or session before validation',async()=>{
 disabled=true;const r=await handler(request({action:'begin'}));assert.equal(r.status,503);assert.equal((await r.json()).error,'face_login_not_enabled');assert.equal(calls.length,1);
});
test('foreign origins and injected identity/result/template never reach the database',async()=>{
 assert.equal((await handler(request({action:'begin'},{Origin:'https://other.invalid'}))).status,403);
 for(const extra of [{subject:'victim'},{email:'victim@example.invalid'},{candidate_match:true},{template:'fake'}])assert.equal((await handler(request({...capture(),...extra}))).status,400);
 assert.equal(calls.length,0);
});
test('one-use challenge hash is stored, plaintext proof is returned only to the initiating browser',async()=>{
 const r=await handler(request({action:'begin'}));const data=await r.json();assert.match(data.proof,/^[0-9a-f]{64}$/);assert.equal(calls[0].body.p_data.proof_hash,createHash('sha256').update(data.proof).digest('hex'));assert(!JSON.stringify(calls).includes(data.proof));
});
test('expired or replayed challenge stops before private model and Auth',async()=>{
 denied=true;assert.equal((await handler(request(capture()))).status,503);assert.equal(calls.length,1);
});
test('non-match consumes challenge but never calls Auth or returns identity',async()=>{
 match=false;const r=await handler(request(capture()));assert.equal(r.status,422);assert.equal((await r.json()).authenticated,false);assert(!calls.some(c=>c.action==='generateLink'));assert(consumed);
});
test('model cannot choose an employee outside the backend enrollment snapshot',async()=>{
 wrongSubject=true;assert.equal((await handler(request(capture()))).status,422);assert(consumed);assert(!calls.some(c=>c.action==='generateLink'));
});
test('validated match creates one session with no email delivery or user-entered OTP',async()=>{
 const r=await handler(request(capture()));assert.equal(r.status,200);assert.deepEqual(await r.json(),{authenticated:true,session:{access_token:session.access_token,refresh_token:session.refresh_token}});
 assert.equal(calls.filter(c=>c.action==='generateLink').length,1);assert.equal(calls.filter(c=>c.action==='verifyOtp').length,1);
 assert.deepEqual(calls.find(c=>c.action==='generateLink').params,{type:'magiclink',email:'fixture@example.invalid'});
 assert.deepEqual(calls.find(c=>c.action==='verifyOtp').params,{type:'email',token_hash:'fixture-token-hash'});
 assert.equal((await handler(request(capture()))).status,503);assert.equal(calls.filter(c=>c.action==='generateLink').length,1);
});
test('revoked enrollment or unexpected Auth identity discards the minted session',async()=>{
 finalizeDenied=true;let r=await handler(request(capture()));assert.equal(r.status,503);assert.equal((await r.json()).authenticated,false);assert(calls.some(c=>c.action==='revokeSession'));
 claimed=false;consumed=false;calls=[];finalizeDenied=false;wrongUser=true;r=await handler(request(capture()));assert.notEqual(r.status,200);assert(calls.some(c=>c.action==='revokeSession'));assert(!calls.some(c=>c.body?.p_action==='finalize'));
});
