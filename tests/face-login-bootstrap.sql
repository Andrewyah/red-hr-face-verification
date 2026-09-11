-- Minimal local contract for the existing Supabase/HR schema. Synthetic data only.
-- Never run this file in a shared or production database.
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create schema hr_face_private;
grant usage on schema hr_face_private to service_role;
create function auth.jwt() returns jsonb language sql stable as
 $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
create table public.employees(id uuid primary key default gen_random_uuid(),auth_user_id uuid references auth.users(id),status text);
