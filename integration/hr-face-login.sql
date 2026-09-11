-- Draft: additive passwordless exchange. No release authorization is installed.
-- Apply after hr-face-enrollment.sql. The empty policy keeps every login disabled.
create table hr_face_private.login_policy (
 id boolean primary key default true check(id),
 enabled boolean not null default false,
 model_version text not null,
 recipe text not null,
 validation_report_sha256 text not null check(validation_report_sha256 ~ '^[0-9a-f]{64}$'),
 validated_at timestamptz not null,
 valid_until timestamptz not null,
 check(valid_until>validated_at)
);
create table hr_face_private.login_jobs (
 id uuid primary key default gen_random_uuid(),
 proof_hash text not null check(proof_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '60 seconds',
 claimed_at timestamptz,
 consumed_at timestamptz,
 frame_hash text,
 receipt uuid,
 candidates jsonb,
 user_id uuid references auth.users(id) on delete cascade,
 enrollment_revision uuid,
 session_id uuid,
 outcome text not null default 'pending' check(outcome in ('pending','rejected','exchanging','signed_in'))
);
create index hr_face_login_time on hr_face_private.login_jobs(created_at);
create unique index hr_face_login_frames on hr_face_private.login_jobs(frame_hash) where frame_hash is not null;
do $$ declare t text;begin
 foreach t in array array['login_policy','login_jobs'] loop
 execute format('alter table hr_face_private.%I enable row level security',t);
 execute format('revoke all on hr_face_private.%I from public,anon,authenticated',t);
 execute format('grant select,insert,update,delete on hr_face_private.%I to service_role',t);
 execute format('create policy backend_only on hr_face_private.%I for all to service_role using (true) with check (true)',t);
 end loop;
end $$;

create function hr_face_private.login(p_action text,p_id uuid,p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare j hr_face_private.login_jobs%rowtype; refs jsonb; e hr_face_private.enrollments%rowtype;
 u auth.users%rowtype; snapshot jsonb;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then
  raise exception 'face_backend_required' using errcode='42501'; end if;
 if not exists(select 1 from hr_face_private.login_policy where enabled and id
   and model_version='red-face-2026-09-v1' and recipe='red-face-identify-v1'
   and validated_at<=now() and valid_until>now()) then
  raise exception 'face_login_not_enabled'; end if;
 perform pg_advisory_xact_lock(771904114);
 if p_action='begin' then
  if coalesce(p_data->>'proof_hash','') !~ '^[0-9a-f]{64}$' then raise exception 'face_invalid_request'; end if;
  delete from hr_face_private.login_jobs where created_at<now()-interval '1 day';
  if (select count(*) from hr_face_private.login_jobs where created_at>now()-interval '1 minute')>=20 then
   raise exception 'face_rate_limited'; end if;
  insert into hr_face_private.login_jobs(proof_hash) values(p_data->>'proof_hash') returning * into j;
  return jsonb_build_object('id',j.id,'expires_at',j.expires_at);
 end if;
 select * into j from hr_face_private.login_jobs where id=p_id for update;
 if j.id is null or j.expires_at<=now() or j.proof_hash is distinct from p_data->>'proof_hash' then
  raise exception 'face_capture_expired'; end if;
 if p_action='claim' then
  if j.claimed_at is not null or j.consumed_at is not null then raise exception 'face_capture_used'; end if;
  if coalesce(p_data->>'frame_hash','') !~ '^[0-9a-f]{64}$' then raise exception 'face_invalid_request'; end if;
  if exists(select 1 from hr_face_private.login_jobs where frame_hash=p_data->>'frame_hash') then
   raise exception 'face_capture_used'; end if;
  if (select count(*) from hr_face_private.login_jobs where claimed_at>now()-interval '1 minute')>=10 then
   raise exception 'face_rate_limited'; end if;
  select jsonb_agg(jsonb_build_object('subject',r.employee_id,'user_id',r.user_id,'revision',r.revision,'template',r.template)) into refs
  from hr_face_private.enrollments r join public.employees p on p.id=r.employee_id and p.auth_user_id=r.user_id
  join auth.users a on a.id=r.user_id
  where p.status='ACTIVE' and a.email_confirmed_at is not null and a.deleted_at is null
   and (a.banned_until is null or a.banned_until<=now()) and r.model_version='red-face-2026-09-v1';
  if refs is null or jsonb_array_length(refs)>64 then raise exception 'face_service_unavailable'; end if;
  update hr_face_private.login_jobs set claimed_at=now(),receipt=gen_random_uuid(),frame_hash=p_data->>'frame_hash',
   candidates=(select jsonb_agg(value-'template') from jsonb_array_elements(refs)) where id=j.id returning * into j;
  return jsonb_build_object('receipt',j.receipt,'candidates',(select jsonb_agg(value-'user_id'-'revision') from jsonb_array_elements(refs)));
 end if;
 if j.claimed_at is null or j.receipt::text is distinct from p_data->>'receipt' then raise exception 'face_capture_used'; end if;
 if p_action='finish' then
  if j.consumed_at is not null then raise exception 'face_capture_used'; end if;
  select value into snapshot from jsonb_array_elements(j.candidates) where value->>'subject'=p_data->>'subject';
  select * into e from hr_face_private.enrollments where user_id=(snapshot->>'user_id')::uuid;
  select * into u from auth.users where id=e.user_id;
  if p_data->'candidate_match' is distinct from 'true'::jsonb or p_data->'quality_passed' is distinct from 'true'::jsonb
   or p_data->>'model_version' is distinct from 'red-face-2026-09-v1' or p_data->>'recipe' is distinct from 'red-face-identify-v1'
   or e.user_id is null or e.revision::text is distinct from snapshot->>'revision'
   or u.email_confirmed_at is null or u.deleted_at is not null or u.banned_until>now()
   or not exists(select 1 from public.employees where id=e.employee_id and auth_user_id=u.id and status='ACTIVE') then
   update hr_face_private.login_jobs set consumed_at=now(),outcome='rejected',receipt=null,candidates=null where id=j.id;
   return jsonb_build_object('matched',false);
  end if;
  update hr_face_private.login_jobs set consumed_at=now(),outcome='exchanging',user_id=u.id,enrollment_revision=e.revision,
   candidates=null where id=j.id;
  return jsonb_build_object('matched',true,'user_id',u.id,'email',u.email);
 elsif p_action='finalize' then
  if j.outcome<>'exchanging' or j.session_id is not null then raise exception 'face_capture_used'; end if;
  if not exists(select 1 from hr_face_private.enrollments r join public.employees p on p.id=r.employee_id
   join auth.users a on a.id=r.user_id where r.user_id=j.user_id and r.revision=j.enrollment_revision
   and p.auth_user_id=a.id and p.status='ACTIVE' and a.email_confirmed_at is not null
   and a.deleted_at is null and (a.banned_until is null or a.banned_until<=now()) and a.email=p_data->>'email')
   or not exists(select 1 from auth.sessions where id=(p_data->>'session_id')::uuid and user_id=j.user_id
    and (not_after is null or not_after>now())) then raise exception 'face_capture_expired'; end if;
  update hr_face_private.login_jobs set outcome='signed_in',session_id=(p_data->>'session_id')::uuid,receipt=null where id=j.id;
  return jsonb_build_object('authenticated',true,'user_id',j.user_id);
 else raise exception 'face_invalid_request'; end if;
end $$;
revoke all on function hr_face_private.login(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function hr_face_private.login(text,uuid,jsonb) to service_role;
create function public.hr_face_login(p_action text,p_id uuid default null,p_data jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$select hr_face_private.login(p_action,p_id,p_data)$$;
revoke all on function public.hr_face_login(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.hr_face_login(text,uuid,jsonb) to service_role;
