-- D-94 (Phase 5 slice 5): usage metering and plan limits. Plans are data: every workspace is on "free" unless a row in
-- org_plans says otherwise (no way to change it yet: there is no paid tier; the "paid_placeholder" row exists only so
-- the code is written for more than one plan, and is not offered). The workspace limits that already existed now come
-- from the plan: active API keys (10), webhook endpoints (10), API requests a minute per key (60); a monthly API
-- request limit is added (none on free). API requests are counted per workspace per UTC month. Owners and
-- administrators see the month's usage on Settings. The per-person daily sending caps (trust levels, D-27/D-45) are
-- anti-abuse limits, not plan limits, and are unchanged.

create table public.plans (
  id text primary key check (id ~ '^[a-z][a-z0-9_]{1,30}$'),
  name text not null check (char_length(name) between 1 and 60),
  offered boolean not null,
  max_api_keys int not null check (max_api_keys between 0 and 1000),
  max_webhook_endpoints int not null check (max_webhook_endpoints between 0 and 1000),
  api_requests_per_minute int not null check (api_requests_per_minute between 1 and 100000),
  monthly_api_calls int check (monthly_api_calls >= 0),   -- null: no monthly limit
  note text not null default ''
);
insert into public.plans (id, name, offered, max_api_keys, max_webhook_endpoints, api_requests_per_minute, monthly_api_calls, note) values
  ('free', 'Free', true, 10, 10, 60, null, 'Everything, within the per-person daily sending limits.'),
  ('paid_placeholder', 'Paid (not offered yet)', false, 10, 10, 60, null, 'Placeholder for a future paid tier. Not offered; no price exists.');

create table public.org_plans (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  plan_id text not null references public.plans (id),
  set_at timestamptz not null default now(),
  set_by uuid references auth.users (id) on delete set null
);

create table public.usage_monthly (
  org_id uuid not null references public.organizations (id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  api_calls bigint not null default 0,
  primary key (org_id, month)
);

do $$
declare t text;
begin
  foreach t in array array['plans', 'org_plans', 'usage_monthly'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to anon, authenticated using (false) with check (false)', t || '_deny_all', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end
$$;
-- plans change only through migrations
grant select on public.plans to service_role;
grant select, insert, update, delete on public.org_plans, public.usage_monthly to service_role;

-- the workspace's plan (free when nothing else is set)
create function app_private.org_plan(p_org uuid) returns public.plans
language sql stable security definer set search_path = '' as $$
  select p.* from public.plans p where p.id = coalesce((select o.plan_id from public.org_plans o where o.org_id = p_org), 'free')
$$;
revoke all on function app_private.org_plan(uuid) from public, anon, authenticated, service_role;

-- who is calling (as before), plus the plan's per-minute and monthly limits and this month's count including this call
drop function public.api_key_resolve(text);
create function public.api_key_resolve(p_key_sha256 text)
returns table (key_id uuid, org_id uuid, user_id uuid, scopes text[], role text, per_minute int, month_limit int, month_calls bigint)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  k public.api_keys;
  v_role text;
  v_plan public.plans;
  v_calls bigint;
begin
  if p_key_sha256 !~ '^[0-9a-f]{64}$' then return; end if;
  select * into k from public.api_keys x where x.key_sha256 = p_key_sha256 and x.revoked_at is null;
  if not found then return; end if;
  v_role := app_private.member_role(k.created_by, k.org_id);
  if v_role is null
     or exists (select 1 from public.account_controls c where c.user_id = k.created_by and c.trust_level = 'suspended')
     or exists (select 1 from public.org_controls o where o.org_id = k.org_id and o.status = 'suspended') then
    return;
  end if;
  if k.last_used_at is null or k.last_used_at < now() - interval '1 minute' then
    update public.api_keys x set last_used_at = now() where x.id = k.id;
  end if;
  v_plan := app_private.org_plan(k.org_id);
  insert into public.usage_monthly as u (org_id, month, api_calls) values (k.org_id, date_trunc('month', now() at time zone 'UTC')::date, 1)
    on conflict (org_id, month) do update set api_calls = u.api_calls + 1
    returning u.api_calls into v_calls;
  return query select k.id, k.org_id, k.created_by, k.scopes, v_role, v_plan.api_requests_per_minute, v_plan.monthly_api_calls, v_calls;
end
$$;
revoke all on function public.api_key_resolve(text) from public, anon, authenticated;
grant execute on function public.api_key_resolve(text) to service_role;

-- the existing limits on keys and webhook endpoints, now from the plan

create or replace function public.create_api_key(p_actor uuid, p_org uuid, p_name text, p_scopes text[], p_prefix text, p_key_sha256 text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_scopes text[];
begin
  if not app_private.api_key_admin(p_actor, p_org) then
    raise exception 'ES_NOT_FOUND: workspace not found' using errcode = '42501';
  end if;
  perform app_private.require_not_suspended(p_actor, p_org);
  if p_name is null or btrim(p_name) = '' or char_length(btrim(p_name)) > 80 then
    raise exception 'ES_NAME: give the key a name of up to 80 characters' using errcode = '22023';
  end if;
  select array_agg(distinct s order by s) into v_scopes from unnest(coalesce(p_scopes, '{}')) s;
  if v_scopes is null or not (v_scopes <@ array['documents:read', 'documents:write', 'documents:send']) then
    raise exception 'ES_SCOPES: choose what the key may do' using errcode = '22023';
  end if;
  if (select count(*) from public.api_keys k where k.org_id = p_org and k.revoked_at is null) >= (app_private.org_plan(p_org)).max_api_keys then
    raise exception 'ES_TOO_MANY: this workspace''s plan allows % active API keys; revoke one first', (app_private.org_plan(p_org)).max_api_keys using errcode = '22023';
  end if;
  insert into public.api_keys (org_id, created_by, name, prefix, key_sha256, scopes)
    values (p_org, p_actor, btrim(p_name), p_prefix, p_key_sha256, v_scopes) returning id into v_id;
  perform app_private.audit_append('org:' || p_org::text, p_org, null, null, 'user', p_actor, 'api_key_created',
    jsonb_build_object('key_id', v_id, 'name', btrim(p_name), 'prefix', p_prefix, 'scopes', to_jsonb(v_scopes)));
  return v_id;
end
$$;


create or replace function public.webhook_endpoint_create(p_actor uuid, p_org uuid, p_id uuid, p_url text, p_description text, p_events text[], p_secret_enc text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_events text[];
begin
  if not app_private.api_key_admin(p_actor, p_org) then
    raise exception 'ES_NOT_FOUND: workspace not found' using errcode = '42501';
  end if;
  perform app_private.require_not_suspended(p_actor, p_org);
  v_events := app_private.webhook_events(p_events);
  if char_length(coalesce(p_description, '')) > 200 then
    raise exception 'ES_DESCRIPTION: keep the description to 200 characters' using errcode = '22023';
  end if;
  if (select count(*) from public.webhook_endpoints w where w.org_id = p_org) >= (app_private.org_plan(p_org)).max_webhook_endpoints then
    raise exception 'ES_TOO_MANY: this workspace''s plan allows % webhook endpoints; delete one first', (app_private.org_plan(p_org)).max_webhook_endpoints using errcode = '22023';
  end if;
  insert into public.webhook_endpoints (id, org_id, created_by, url, description, events, secret_enc)
    values (p_id, p_org, p_actor, btrim(p_url), btrim(coalesce(p_description, '')), v_events, p_secret_enc);
  perform app_private.audit_append('org:' || p_org::text, p_org, null, null, 'user', p_actor, 'webhook_created',
    jsonb_build_object('endpoint_id', p_id, 'origin', app_private.webhook_origin(p_url), 'events', to_jsonb(v_events)));
  return p_id;
end
$$;


-- the month's usage and the plan's limits (owners and administrators). Documents and people count what was sent in
-- the month; API requests are the month's count; storage, members, keys and endpoints are as they are now.
create function public.usage_summary(p_actor uuid, p_org uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_plan public.plans;
  v_month date := date_trunc('month', coalesce(p_month, (now() at time zone 'UTC')::date))::date;
  v_start timestamptz;
  v_end timestamptz;
begin
  if not app_private.api_key_admin(p_actor, p_org) then
    raise exception 'ES_NOT_FOUND: workspace not found' using errcode = '42501';
  end if;
  v_start := v_month::timestamp at time zone 'UTC';
  v_end := (v_month + interval '1 month')::timestamp at time zone 'UTC';
  v_plan := app_private.org_plan(p_org);
  return jsonb_build_object(
    'month', to_char(v_month, 'YYYY-MM'),
    'plan', jsonb_build_object('id', v_plan.id, 'name', v_plan.name, 'max_api_keys', v_plan.max_api_keys, 'max_webhook_endpoints', v_plan.max_webhook_endpoints,
              'api_requests_per_minute', v_plan.api_requests_per_minute, 'monthly_api_calls', v_plan.monthly_api_calls),
    'documents_sent', (select count(*) from public.envelopes e where e.org_id = p_org and e.sent_at >= v_start and e.sent_at < v_end),
    'people_sent_to', (select count(*) from public.recipients r where r.org_id = p_org and not r.is_sender and r.sent_at >= v_start and r.sent_at < v_end),
    'api_calls', coalesce((select u.api_calls from public.usage_monthly u where u.org_id = p_org and u.month = v_month), 0),
    'storage_bytes', coalesce((select sum((o.metadata ->> 'size')::bigint) from storage.objects o where o.name like p_org::text || '/%'), 0),
    'members', (select count(*) from public.memberships m where m.org_id = p_org and m.deactivated_at is null),
    'api_keys', (select count(*) from public.api_keys k where k.org_id = p_org and k.revoked_at is null),
    'webhook_endpoints', (select count(*) from public.webhook_endpoints w where w.org_id = p_org));
end
$$;
revoke all on function public.usage_summary(uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.usage_summary(uuid, uuid, date) to service_role;

-- down:
-- restore public.create_api_key from 20261121082938_api_keys and public.webhook_endpoint_create from 20261121092729_webhooks
-- (create or replace); drop function public.api_key_resolve(text) and re-create it from 20261121082938_api_keys (with its
-- grants); drop function public.usage_summary(uuid, uuid, date); drop function app_private.org_plan(uuid);
-- drop table public.usage_monthly; drop table public.org_plans; drop table public.plans;
