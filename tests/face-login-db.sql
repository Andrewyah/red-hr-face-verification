-- Local synthetic contract, not biometric validation. Always roll back.
begin;
do $$
declare u uuid:=gen_random_uuid();other_user uuid:=gen_random_uuid();e uuid:=gen_random_uuid();other_employee uuid:=gen_random_uuid();
 s uuid:=gen_random_uuid();j jsonb;claim jsonb;result jsonb;denied boolean;proof text:=repeat('a',64);i integer;
begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 denied:=false;begin perform public.hr_face_login('begin',null,jsonb_build_object('proof_hash',proof));
 exception when others then denied:=sqlerrm='face_login_not_enabled';end;assert denied,'Empty release policy denies all logins';
 assert not has_function_privilege('anon','public.hr_face_login(text,uuid,jsonb)','EXECUTE'),'Anonymous cannot mint sessions through SQL';
 assert not has_function_privilege('authenticated','public.hr_face_login(text,uuid,jsonb)','EXECUTE'),'Users cannot authorize themselves';
 assert not has_table_privilege('anon','hr_face_private.login_jobs','SELECT'),'No public challenges or identities';
 assert not has_table_privilege('authenticated','hr_face_private.login_policy','UPDATE'),'No user release switch';
 assert (select bool_and(relrowsecurity) from pg_class where oid in ('hr_face_private.login_policy'::regclass,'hr_face_private.login_jobs'::regclass)),'Private tables use RLS';
 -- This fixture is NOT a release approval. It never survives this transaction.
 insert into hr_face_private.login_policy(enabled,model_version,recipe,validation_report_sha256,validated_at,valid_until)
 values(true,'red-face-2026-09-v1','red-face-identify-v1',repeat('0',64),now()-interval '1 second',now()+interval '1 hour');
 insert into auth.users(id,email,email_confirmed_at) values(u,'face-test@example.invalid',now()),(other_user,'excluded@example.invalid',now());
 insert into public.employees(id,auth_user_id,status) values(e,u,'ACTIVE'),(other_employee,other_user,'INACTIVE');
 insert into hr_face_private.enrollments(user_id,employee_id,template,model_version,consent_version)
 values(u,e,repeat('synthetic-',30),'red-face-2026-09-v1','face-enrollment-1'),(other_user,other_employee,repeat('synthetic-',30),'red-face-2026-09-v1','face-enrollment-1');
 insert into auth.sessions(id,user_id) values(s,u);
 perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
 denied:=false;begin perform hr_face_private.login('begin',null,jsonb_build_object('proof_hash',proof));
 exception when insufficient_privilege then denied:=true;end;assert denied,'Definer also checks caller role';
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 j:=public.hr_face_login('begin',null,jsonb_build_object('proof_hash',proof));
 denied:=false;begin perform public.hr_face_login('claim',(j->>'id')::uuid,jsonb_build_object('proof_hash',repeat('b',64),'frame_hash',repeat('1',64)));
 exception when others then denied:=sqlerrm='face_capture_expired';end;assert denied,'Wrong browser proof denied';
 claim:=public.hr_face_login('claim',(j->>'id')::uuid,jsonb_build_object('proof_hash',proof,'frame_hash',repeat('1',64)));
 assert jsonb_array_length(claim->'candidates')=1,'Inactive employees excluded';
 assert claim->'candidates'->0->>'subject'=e::text,'Server selected active enrollment';
 assert not (claim->'candidates'->0 ? 'user_id'),'Inference service receives no Auth identifier';
 denied:=false;begin perform public.hr_face_login('claim',(j->>'id')::uuid,jsonb_build_object('proof_hash',proof,'frame_hash',repeat('1',64)));
 exception when others then denied:=sqlerrm='face_capture_used';end;assert denied,'Claim is single-use';
 result:=public.hr_face_login('finish',(j->>'id')::uuid,jsonb_build_object('proof_hash',proof,'receipt',claim->>'receipt','subject',e,'quality_passed',true,'candidate_match',true,'model_version','red-face-2026-09-v1','recipe','red-face-identify-v1'));
 assert result->'matched'='true'::jsonb and result->>'user_id'=u::text,'Only matched active user can exchange';
 denied:=false;begin perform public.hr_face_login('finish',(j->>'id')::uuid,jsonb_build_object('proof_hash',proof,'receipt',claim->>'receipt'));
 exception when others then denied:=sqlerrm='face_capture_used';end;assert denied,'Completion cannot be replayed';
 result:=public.hr_face_login('finalize',(j->>'id')::uuid,jsonb_build_object('proof_hash',proof,'receipt',claim->>'receipt','session_id',s,'email','face-test@example.invalid'));
 assert result->'authenticated'='true'::jsonb and result->>'user_id'=u::text,'Existing real Auth session binding is required';
 denied:=false;begin perform public.hr_face_login('finalize',(j->>'id')::uuid,jsonb_build_object('proof_hash',proof,'receipt',claim->>'receipt','session_id',s));
 exception when others then denied:=sqlerrm='face_capture_used';end;assert denied,'Finalize is single-use';
 j:=public.hr_face_login('begin',null,jsonb_build_object('proof_hash',proof));
 denied:=false;begin perform public.hr_face_login('claim',(j->>'id')::uuid,jsonb_build_object('proof_hash',proof,'frame_hash',repeat('1',64)));
 exception when others then denied:=sqlerrm='face_capture_used';end;assert denied,'Identical capture cannot use a fresh challenge';
 claim:=public.hr_face_login('claim',(j->>'id')::uuid,jsonb_build_object('proof_hash',proof,'frame_hash',repeat('2',64)));
 result:=public.hr_face_login('finish',(j->>'id')::uuid,jsonb_build_object('proof_hash',proof,'receipt',claim->>'receipt','subject',other_employee,'quality_passed',true,'candidate_match',true,'model_version','red-face-2026-09-v1','recipe','red-face-identify-v1'));
 assert result->'matched'='false'::jsonb,'Out-of-snapshot identities rejected';
 j:=public.hr_face_login('begin',null,jsonb_build_object('proof_hash',proof));
 claim:=public.hr_face_login('claim',(j->>'id')::uuid,jsonb_build_object('proof_hash',proof,'frame_hash',repeat('3',64)));
 update hr_face_private.enrollments set revision=gen_random_uuid() where user_id=u;
 result:=public.hr_face_login('finish',(j->>'id')::uuid,jsonb_build_object('proof_hash',proof,'receipt',claim->>'receipt','subject',e,'quality_passed',true,'candidate_match',true,'model_version','red-face-2026-09-v1','recipe','red-face-identify-v1'));
 assert result->'matched'='false'::jsonb,'Re-enrollment invalidates in-flight match';
 j:=public.hr_face_login('begin',null,jsonb_build_object('proof_hash',proof));
 claim:=public.hr_face_login('claim',(j->>'id')::uuid,jsonb_build_object('proof_hash',proof,'frame_hash',repeat('4',64)));
 result:=public.hr_face_login('finish',(j->>'id')::uuid,jsonb_build_object('proof_hash',proof,'receipt',claim->>'receipt','subject',e,'quality_passed',true,'candidate_match',true,'model_version','red-face-2026-09-v1','recipe','red-face-identify-v1'));
 assert result->'matched'='true'::jsonb;
 delete from hr_face_private.enrollments where user_id=u;
 denied:=false;begin perform public.hr_face_login('finalize',(j->>'id')::uuid,jsonb_build_object('proof_hash',proof,'receipt',claim->>'receipt','session_id',s,'email','face-test@example.invalid'));
 exception when others then denied:=sqlerrm='face_capture_expired';end;assert denied,'Revoked registration blocks token release';
 j:=public.hr_face_login('begin',null,jsonb_build_object('proof_hash',proof));
 update hr_face_private.login_jobs set expires_at=now()-interval '1 second' where id=(j->>'id')::uuid;
 denied:=false;begin perform public.hr_face_login('claim',(j->>'id')::uuid,jsonb_build_object('proof_hash',proof,'frame_hash',repeat('5',64)));
 exception when others then denied:=sqlerrm='face_capture_expired';end;assert denied,'Expired challenge rejected';
 denied:=false;for i in 1..25 loop
 begin perform public.hr_face_login('begin',null,jsonb_build_object('proof_hash',proof));
 exception when others then denied:=sqlerrm='face_rate_limited';exit;end;
 end loop;assert denied,'Challenge issue rate is bounded';
 update hr_face_private.login_policy set valid_until=now()-interval '0.5 seconds';
 denied:=false;begin perform public.hr_face_login('begin',null,jsonb_build_object('proof_hash',proof));
 exception when others then denied:=sqlerrm='face_login_not_enabled';end;assert denied,'Expired release policy disables exchange';
end $$;
rollback;
