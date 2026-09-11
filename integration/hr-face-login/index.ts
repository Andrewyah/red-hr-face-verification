// Draft, disabled by the database release gate. No public deployment yet.
import { createClient } from 'npm:@supabase/supabase-js@2.111.0';
import { makeHandler } from './handler.ts';
const url=Deno.env.get('SUPABASE_URL'),serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
Deno.serve(makeHandler({url,serviceKey,createAuth:()=>createClient(url,serviceKey,{
 auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
}).auth}));
