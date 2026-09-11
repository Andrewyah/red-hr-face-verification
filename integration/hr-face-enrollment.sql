-- Authenticated enrollment/testing only. No anonymous login or session issuance.
create table hr_face_private.enrollments (
 user_id uuid primary key references auth.users(id) on delete cascade,
 employee_id uuid not null references public.employees(id) on delete cascade,
 revision uuid not null default gen_random_uuid(),
 template text not null check(length(template) between 100 and 12000),
 model_version text not null check(model_version='red-face-2026-09-v1'),
 consent_version text not null check(consent_version='face-enrollment-1'),
 consent_at timestamptz not null default now(),
 created_at timestamptz not null default now()
);
create table hr_face_private.capture_jobs (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 employee_id uuid not null references public.employees(id) on delete cascade,
 session_id uuid not null,
 purpose text not null check(purpose in ('enroll','test')),
 enrollment_revision uuid,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '90 seconds',
 claimed_at timestamptz,
 receipt uuid,
 finished_at timestamptz
);
create index hr_face_capture_user_time on hr_face_private.capture_jobs(user_id,created_at);
create table hr_face_private.capture_events (
 id bigint generated always as identity primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 action text not null check(action in ('capture_started','enrolled','test_match','test_no_match','rejected','revoked')),
 created_at timestamptz not null default now()
);
create index hr_face_events_user_time on hr_face_private.capture_events(user_id,created_at);
create index hr_face_events_time on hr_face_private.capture_events(created_at);
do $$ declare t text; begin
 foreach t in array array['enrollments','capture_jobs','capture_events'] loop
 execute format('alter table hr_face_private.%I enable row level security',t);
 execute format('revoke all on hr_face_private.%I from public,anon,authenticated',t);
 execute format('grant select,insert,update,delete on hr_face_private.%I to service_role',t);
 execute format('create policy backend_only on hr_face_private.%I for all to service_role using (true) with check (true)',t);
 end loop;
end $$;

-- Private definer is necessary to mediate employee-owned private data. Every
-- user operation calls the existing active-employee and live-session guard.
create function hr_face_private.self(p_action text,p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.employees%rowtype; e hr_face_private.enrollments%rowtype;
 j hr_face_private.capture_jobs%rowtype; purpose text; sid uuid;
begin
 if auth.uid() is null then raise exception 'face_auth_required' using errcode='42501'; end if;
 a:=hr_app_private.actor(); sid:=(auth.jwt()->>'session_id')::uuid;
 perform pg_advisory_xact_lock(hashtextextended('hr-face:'||auth.uid()::text,0));
 select * into e from hr_face_private.enrollments where user_id=auth.uid();
 if p_action='binding' then
  return jsonb_build_object('user_id',auth.uid(),'session_id',sid);
 elsif p_action='status' then
  return jsonb_build_object('enrolled',e.user_id is not null,'created_at',e.created_at,'mode','evaluation','login_enabled',false);
 elsif p_action='revoke' then
  if (select count(*) from hr_face_private.capture_events where user_id=auth.uid() and action='revoked' and created_at>now()-interval '5 minutes')>=5
    then raise exception 'face_rate_limited'; end if;
  delete from hr_face_private.enrollments where user_id=auth.uid();
  delete from hr_face_private.capture_jobs where user_id=auth.uid();
  insert into hr_face_private.capture_events(user_id,action) values(auth.uid(),'revoked');
  return jsonb_build_object('revoked',true,'login_enabled',false);
 elsif p_action='begin' then
  purpose:=p_data->>'purpose';
  if purpose not in ('enroll','test') or purpose is null then raise exception 'face_invalid_request'; end if;
  if purpose='enroll' then
   if e.user_id is not null then raise exception 'face_already_enrolled'; end if;
   if p_data->>'consent' is distinct from 'face-enrollment-1' then raise exception 'face_consent_required'; end if;
   if not exists(select 1 from jsonb_array_elements(coalesce(auth.jwt()->'amr','[]')) m
    where m->>'method' in ('password','otp') and (m->>'timestamp')::numeric>=extract(epoch from now()-interval '10 minutes'))
    then raise exception 'face_recent_signin_required' using errcode='42501'; end if;
  elsif e.user_id is null then raise exception 'face_enrollment_required'; end if;
  delete from hr_face_private.capture_jobs where created_at<now()-interval '1 day';
  delete from hr_face_private.capture_events where created_at<now()-interval '90 days';
  -- A separate audit counter survives registration removal; global lock keeps
  -- concurrent users from racing past the shared model capacity limit.
  perform pg_advisory_xact_lock(771904113);
  if (select count(*) from hr_face_private.capture_events where user_id=auth.uid() and action='capture_started' and created_at>now()-interval '5 minutes')>=5
    then raise exception 'face_rate_limited'; end if;
  if (select count(*) from hr_face_private.capture_events where action='capture_started' and created_at>now()-interval '1 minute')>=30
    then raise exception 'face_service_busy'; end if;
  insert into hr_face_private.capture_jobs(user_id,employee_id,session_id,purpose,enrollment_revision)
    values(auth.uid(),a.id,sid,purpose,e.revision) returning * into j;
  insert into hr_face_private.capture_events(user_id,action) values(auth.uid(),'capture_started');
  return jsonb_build_object('id',j.id,'purpose',purpose,'expires_at',j.expires_at,'frames',3,'login_enabled',false);
 else raise exception 'face_invalid_request'; end if;
end $$;
revoke all on function hr_face_private.self(text,jsonb) from public,anon;
grant usage on schema hr_face_private to authenticated;
grant execute on function hr_face_private.self(text,jsonb) to authenticated;
create function public.hr_face_self(p_action text,p_data jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$select hr_face_private.self(p_action,p_data)$$;
revoke all on function public.hr_face_self(text,jsonb) from public,anon;
grant execute on function public.hr_face_self(text,jsonb) to authenticated;

-- Service-only job access. Caller user_id is obtained from Supabase Auth by the
-- Edge Function, never from browser JSON. Session ownership is checked here too.
create function hr_face_private.job(p_action text,p_user_id uuid,p_id uuid,p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare j hr_face_private.capture_jobs%rowtype; e hr_face_private.enrollments%rowtype; action text;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' or p_user_id is null
   then raise exception 'face_backend_required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('hr-face:'||p_user_id::text,0));
 select * into j from hr_face_private.capture_jobs where id=p_id and user_id=p_user_id for update;
 if j.id is null or j.expires_at<=now() or j.finished_at is not null
  or not exists(select 1 from auth.sessions s where s.id=j.session_id and s.user_id=p_user_id and (s.not_after is null or s.not_after>now()))
  or not exists(select 1 from public.employees p where p.id=j.employee_id and p.auth_user_id=p_user_id and p.status='ACTIVE')
  then raise exception 'face_capture_expired' using errcode='42501'; end if;
 select * into e from hr_face_private.enrollments where user_id=p_user_id;
 if (j.purpose='test' and (e.user_id is null or e.revision is distinct from j.enrollment_revision))
   or (j.purpose='enroll' and e.user_id is not null) then raise exception 'face_capture_expired'; end if;
 if p_action='claim' then
  if j.session_id::text is distinct from p_data->>'session_id' then raise exception 'face_capture_expired'; end if;
  if j.claimed_at is not null then raise exception 'face_capture_used'; end if;
  update hr_face_private.capture_jobs set claimed_at=now(),receipt=gen_random_uuid() where id=j.id returning * into j;
  return jsonb_build_object('subject',j.employee_id::text,'purpose',j.purpose,'template',e.template,'receipt',j.receipt);
 elsif p_action='finish' then
  if j.claimed_at is null or j.receipt::text is distinct from p_data->>'receipt' then raise exception 'face_capture_used'; end if;
  action:='rejected';
  if p_data->>'model_version'='red-face-2026-09-v1' and p_data->'quality_passed'='true'::jsonb then
   if j.purpose='enroll' and length(p_data->>'template') between 100 and 12000 then
    insert into hr_face_private.enrollments(user_id,employee_id,template,model_version,consent_version)
     values(p_user_id,j.employee_id,p_data->>'template','red-face-2026-09-v1','face-enrollment-1');
    action:='enrolled';
   elsif j.purpose='test' then
    action:=case when p_data->'candidate_match'='true'::jsonb then 'test_match' else 'test_no_match' end;
   end if;
  end if;
  update hr_face_private.capture_jobs set finished_at=now(),receipt=null where id=j.id;
  insert into hr_face_private.capture_events(user_id,action) values(p_user_id,action);
  return jsonb_build_object('result',action,'mode','evaluation','authenticated',false,'login_enabled',false);
 else raise exception 'face_invalid_request'; end if;
end $$;
revoke all on function hr_face_private.job(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function hr_face_private.job(text,uuid,uuid,jsonb) to service_role;
create function public.hr_face_job(p_action text,p_user_id uuid,p_id uuid,p_data jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$select hr_face_private.job(p_action,p_user_id,p_id,p_data)$$;
revoke all on function public.hr_face_job(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.hr_face_job(text,uuid,uuid,jsonb) to service_role;
