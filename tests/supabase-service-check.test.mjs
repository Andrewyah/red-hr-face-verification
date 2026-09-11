import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHmac, createHash, randomBytes} from 'node:crypto';

const key = randomBytes(32);
let handler;
globalThis.Deno = {env:{get:name=>({SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-only-backend-key'})[name]},serve:fn=>{handler=fn;}};
await import('../integration/hr-face-service-check/index.ts');
const raw = '{"operation":"probe"}';
const signed = (body=raw,path='/hr-face-service-check') => {
  const ts=String(Math.floor(Date.now()/1000)),nonce=randomBytes(24).toString('base64url');
  const digest=createHash('sha256').update(body).digest('hex');
  return {'Content-Type':'application/json','x-face-timestamp':ts,'x-face-nonce':nonce,
    'x-face-signature':createHmac('sha256',key).update(['POST',path,ts,nonce,digest].join('\n')).digest('hex')};
};
let calls=[], claimed=true, mode='evaluation';
globalThis.fetch = async (url, options={}) => {
  const target=String(url); calls.push(target);
  if(target.endsWith('/rpc/hr_face_service_config')) return Response.json({url:'https://face-verifier-api-production.up.railway.app',key:key.toString('base64')});
  if(target.endsWith('/rpc/hr_face_claim_probe')) return Response.json(claimed);
  if(target.endsWith('/readyz')) return Response.json({ready:true,mode,login_enabled:false,model_version:'test-model'});
  if(target.endsWith('/v1/enroll')) {
    assert.equal(options.body,'{"subject":"connectivity-probe","frames":[]}');
    const h=options.headers;
    const digest=createHash('sha256').update(options.body).digest('hex');
    assert.equal(h['X-Face-Signature'],createHmac('sha256',key).update(['POST','/v1/enroll',h['X-Face-Timestamp'],h['X-Face-Nonce'],digest].join('\n')).digest('hex'));
    return Response.json({error:'three_to_six_frames_required'},{status:400});
  }
  throw Error('Unapproved destination');
};

test('unsigned request cannot read config or call model service', async()=>{
  calls=[];
  const result=await handler(new Request('https://edge/hr-face-service-check',{method:'POST',headers:{'Content-Type':'application/json'},body:raw}));
  assert.equal(result.status,401); assert.equal(calls.length,0);
});
test('valid signed probe verifies upstream HMAC without issuing a session',async()=>{
  calls=[];
  const result=await handler(new Request('https://edge/hr-face-service-check',{method:'POST',headers:signed(),body:raw}));
  assert.equal(result.status,200);
  const data=await result.json();
  assert.equal(data.signing_verified,true); assert.equal(data.login_enabled,false);
  assert.equal(data.mode,'evaluation'); assert.equal(data.access_token,undefined);
  assert.equal(calls.length,4);
});
test('proof for another endpoint is not accepted',async()=>{
  calls=[];
  const result=await handler(new Request('https://edge/hr-face-service-check',{method:'POST',headers:signed(raw,'/v1/enroll'),body:raw}));
  assert.equal(result.status,401); assert.equal(calls.length,1);
});
test('replay or rate limit does not reach model service',async()=>{
  calls=[]; claimed=false;
  try {
    const result=await handler(new Request('https://edge/hr-face-service-check',{method:'POST',headers:signed(),body:raw}));
    assert.equal(result.status,429); assert.equal(calls.length,2);
  } finally {claimed=true;}
});
test('probe cannot relay employee data or other payloads',async()=>{
  calls=[];
  const body=JSON.stringify({subject:'employee-1',frames:['x']});
  const result=await handler(new Request('https://edge/hr-face-service-check',{method:'POST',headers:signed(body),body}));
  assert.equal(result.status,400); assert.equal(calls.length,0);
});
test('unexpected login-enabled release does not pass readiness check',async()=>{
  calls=[]; mode='production';
  try {
    const result=await handler(new Request('https://edge/hr-face-service-check',{method:'POST',headers:signed(),body:raw}));
    assert.equal(result.status,503); assert.equal(calls.length,3);
  } finally {mode='evaluation';}
});
