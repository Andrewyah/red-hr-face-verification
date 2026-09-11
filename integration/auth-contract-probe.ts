// Temporary restricted hosted Auth contract check. Not a face-login endpoint.
// Bind PROBE_SHA256 and PROBE_UNTIL through server environment or an ephemeral
// deployment module; never commit the plaintext invocation secret.
import { createClient } from 'npm:@supabase/supabase-js@2.111.0';
export function probeHandler(expectedHash: string, validUntil: number) {
 let used=false;
 return async (req: Request) => {
  const bearer=req.headers.get('Authorization')||'';
  if(req.method!=='POST'||Date.now()>validUntil||used||!/^Bearer [a-f0-9]{64}$/.test(bearer))return new Response(null,{status:404});
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(bearer.slice(7)));
  const hash=[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
  if(hash!==expectedHash)return new Response(null,{status:404});
  used=true;
  const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const checks: Record<string,boolean>={};let id: string|undefined,token: string|undefined,stage='create';
  let failure: string|null=null,cleanup=false;
  try {
   const email='face-auth-probe-'+crypto.randomUUID()+'@example.invalid';
   const created=await client.auth.admin.createUser({email,email_confirm:true,user_metadata:{purpose:'temporary-face-auth-contract-check'}});
   if(created.error||!created.data.user)throw Error('create_failed');id=created.data.user.id;
   stage='generate_link';
   const link=await client.auth.admin.generateLink({type:'magiclink',email});
   if(link.error||link.data.user?.id!==id||!link.data.properties?.hashed_token)throw Error('link_failed');
   stage='exchange';
   const result=await client.auth.verifyOtp({type:'email',token_hash:link.data.properties.hashed_token});
   if(result.error||!result.data.session?.access_token||!result.data.session.refresh_token||result.data.user?.id!==id)throw Error('exchange_failed');
   token=result.data.session.access_token;checks.hosted_exchange=true;
   stage='identity';
   const identity=await client.auth.getUser(token);checks.verified_identity=!identity.error&&identity.data.user?.id===id;
   const replay=await client.auth.verifyOtp({type:'email',token_hash:link.data.properties.hashed_token});
   checks.one_use_token=!!replay.error&&!replay.data.session;
   stage='hr_access';
   const profile=await fetch(Deno.env.get('SUPABASE_URL')+'/rest/v1/rpc/hr_read',{method:'POST',headers:{apikey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({p_section:'workspace',p_month:new Date().toISOString().slice(0,7)+'-01',p_employee_id:null})});
   const workspace=await profile.json();checks.unlinked_account_denied=!profile.ok||!workspace?.profile;
   stage='signout';
   const revoked=await client.auth.admin.signOut(token,'local');checks.signout=!revoked.error;
  } catch {failure=stage;}
  finally {
   if(token)await client.auth.admin.signOut(token,'local').catch(()=>{});
   if(id){const removed=await client.auth.admin.deleteUser(id);cleanup=!removed.error;}
  }
  return Response.json({passed:!failure&&cleanup&&Object.values(checks).every(Boolean),checks,cleanup,failure,...(!cleanup&&id?{cleanup_user_id:id}:{})},{headers:{'Cache-Control':'no-store'}});
 };
}
