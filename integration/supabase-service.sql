-- Additive backend configuration and diagnostic replay protection.
-- No employee, Auth or attendance rows are modified.
create schema if not exists hr_face_private;
revoke all on schema hr_face_private from public, anon, authenticated;
grant usage on schema hr_face_private to service_role;

create table hr_face_private.probe_nonces (
  nonce text primary key check (nonce ~ '^[A-Za-z0-9_-]{24,80}$'),
  created_at timestamptz not null default now()
);
alter table hr_face_private.probe_nonces enable row level security;
create policy backend_only on hr_face_private.probe_nonces for all to service_role using (true) with check (true);
revoke all on hr_face_private.probe_nonces from public, anon, authenticated;
grant select, insert, delete on hr_face_private.probe_nonces to service_role;

create function public.hr_face_service_config() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'url', (select decrypted_secret from vault.decrypted_secrets where name='red_hr_face_service_url'),
    'key', (select decrypted_secret from vault.decrypted_secrets where name='red_hr_face_service_hmac')
  )
$$;
revoke all on function public.hr_face_service_config() from public, anon, authenticated;
grant execute on function public.hr_face_service_config() to service_role;

create function public.hr_face_claim_probe(p_nonce text) returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
  if p_nonce is null or p_nonce !~ '^[A-Za-z0-9_-]{24,80}$' then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(771904112);
  delete from hr_face_private.probe_nonces where created_at < now()-interval '5 minutes';
  if exists(select 1 from hr_face_private.probe_nonces where nonce=p_nonce)
     or (select count(*) from hr_face_private.probe_nonces where created_at > now()-interval '1 minute') >= 6
  then return false; end if;
  insert into hr_face_private.probe_nonces(nonce) values(p_nonce);
  return true;
end;
$$;
revoke all on function public.hr_face_claim_probe(text) from public, anon, authenticated;
grant execute on function public.hr_face_claim_probe(text) to service_role;
