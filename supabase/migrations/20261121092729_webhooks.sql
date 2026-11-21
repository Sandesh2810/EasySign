-- D-92 (Phase 5 slice 3, AT5.2): webhooks. Owners and administrators add endpoints (https only, public internet only;
-- the app checks the address again, name by name and address by address, at every delivery) and choose events. When a
-- document's status changes, or a person signs or approves, a delivery is queued for each live endpoint that chose the
-- event; the worker signs it (Standard Webhooks, HMAC-SHA256 with a timestamp) and posts it, retrying with backoff
-- (7 attempts over about 21 hours); every attempt is logged. An endpoint stops receiving when it is switched off,
-- when the person who added it is no longer an owner or administrator, or when they or the workspace are suspended;
-- it switches itself off after 5 deliveries in a row fail completely. Secrets are stored encrypted by the app (they
-- must be readable again to sign); the database never sees them in clear. New objects only.

create table public.webhook_endpoints (
  id uuid primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  url text not null check (char_length(url) <= 2000 and (url ~ '^https://[^[:space:]]+$' or url ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(/[^[:space:]]*)?$')),
  description text not null default '' check (char_length(description) <= 200),
  events text[] not null check (cardinality(events) between 1 and 6
    and events <@ array['document.sent', 'document.completed', 'document.declined', 'document.voided', 'document.expired', 'person.completed']),
  enabled boolean not null default true,
  disabled_reason text,
  secret_enc text not null check (secret_enc ~ '^v1\.[A-Za-z0-9_-]{40,}$'),
  previous_secret_enc text check (previous_secret_enc ~ '^v1\.[A-Za-z0-9_-]{40,}$'),
  previous_until timestamptz,
  consecutive_failures int not null default 0,
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index webhook_endpoints_org_idx on public.webhook_endpoints (org_id);

create table public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.webhook_endpoints (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  event_type text not null,
  envelope_id uuid references public.envelopes (id) on delete set null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'delivered', 'failed')),
  attempts int not null default 0,
  manual_retry boolean not null default false,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_status_code int,
  last_error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index webhook_deliveries_due_idx on public.webhook_deliveries (next_attempt_at) where status in ('pending', 'sending');
create index webhook_deliveries_endpoint_idx on public.webhook_deliveries (endpoint_id, created_at desc);
create index webhook_deliveries_envelope_idx on public.webhook_deliveries (envelope_id) where envelope_id is not null;

create table public.webhook_attempts (
  id bigint generated always as identity primary key,
  delivery_id uuid not null references public.webhook_deliveries (id) on delete cascade,
  attempt int not null,
  at timestamptz not null default now(),
  status_code int,
  error text,
  duration_ms int not null default 0
);
create index webhook_attempts_delivery_idx on public.webhook_attempts (delivery_id, attempt);

do $$
declare t text;
begin
  foreach t in array array['webhook_endpoints', 'webhook_deliveries', 'webhook_attempts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to anon, authenticated using (false) with check (false)', t || '_deny_all', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end
$$;

-- an endpoint receives only while its creator is still an owner or administrator and neither they nor the workspace
-- is suspended (true or false, never NULL)
create function app_private.webhook_live(p_created_by uuid, p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(app_private.member_role(p_created_by, p_org) in ('owner', 'admin')
    and not exists (select 1 from public.account_controls c where c.user_id = p_created_by and c.trust_level = 'suspended')
    and not exists (select 1 from public.org_controls o where o.org_id = p_org and o.status = 'suspended'), false)
$$;
revoke all on function app_private.webhook_live(uuid, uuid) from public, anon, authenticated, service_role;

-- only the scheme and host go into the audit trail (a query string can carry the receiver's own token)
create function app_private.webhook_origin(p_url text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(substring(p_url from '^https?://[^/?#]+'), '')
$$;
revoke all on function app_private.webhook_origin(text) from public, anon, authenticated, service_role;

create function app_private.webhook_events(p_events text[]) returns text[]
language plpgsql immutable set search_path = '' as $$
declare v text[];
begin
  select array_agg(distinct s order by s) into v from unnest(coalesce(p_events, '{}')) s;
  if v is null or not (v <@ array['document.sent', 'document.completed', 'document.declined', 'document.voided', 'document.expired', 'person.completed']) then
    raise exception 'ES_EVENTS: choose at least one event' using errcode = '22023';
  end if;
  return v;
end
$$;
revoke all on function app_private.webhook_events(text[]) from public, anon, authenticated, service_role;

create function app_private.webhook_document(e public.envelopes) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'title', e.title, 'status', e.status, 'verification_code', e.public_code,
    'sent_at', e.sent_at, 'completed_at', e.completed_at, 'sealed', e.sealed_storage_path is not null)
$$;
revoke all on function app_private.webhook_document(public.envelopes) from public, anon, authenticated, service_role;

-- queue one delivery per live endpoint of the workspace that chose this event
create function app_private.webhook_enqueue(p_org uuid, p_event text, p_envelope uuid, p_data jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into public.webhook_deliveries (endpoint_id, org_id, event_type, envelope_id, payload)
  select w.id, w.org_id, p_event, p_envelope, jsonb_build_object('type', p_event, 'timestamp', now(), 'data', p_data)
    from public.webhook_endpoints w
   where w.org_id = p_org and w.enabled and p_event = any (w.events) and app_private.webhook_live(w.created_by, w.org_id);
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function app_private.webhook_enqueue(uuid, text, uuid, jsonb) from public, anon, authenticated, service_role;

create function app_private.webhook_on_envelope_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.webhook_enqueue(new.org_id, 'document.' || new.status, new.id, jsonb_build_object('document', app_private.webhook_document(new)));
  return null;
end
$$;
revoke all on function app_private.webhook_on_envelope_status() from public, anon, authenticated, service_role;
create trigger envelopes_webhooks after update of status on public.envelopes
  for each row when (old.status is distinct from new.status and new.status in ('sent', 'completed', 'declined', 'voided', 'expired'))
  execute function app_private.webhook_on_envelope_status();

create function app_private.webhook_on_recipient_status() returns trigger
language plpgsql security definer set search_path = '' as $$
declare e public.envelopes;
begin
  select * into e from public.envelopes x where x.id = new.envelope_id;
  if found then
    perform app_private.webhook_enqueue(e.org_id, 'person.completed', e.id, jsonb_build_object('document', app_private.webhook_document(e),
      'person', jsonb_build_object('id', new.id, 'name', new.name, 'email', new.email, 'role', new.role, 'status', new.status, 'completed_at', new.completed_at)));
  end if;
  return null;
end
$$;
revoke all on function app_private.webhook_on_recipient_status() from public, anon, authenticated, service_role;
create trigger recipients_webhooks after update of status on public.recipients
  for each row when (old.status is distinct from new.status and new.status in ('signed', 'approved'))
  execute function app_private.webhook_on_recipient_status();

-- ---------------------------------------------------------------- managing endpoints (owners and administrators)
create function public.webhook_endpoint_create(p_actor uuid, p_org uuid, p_id uuid, p_url text, p_description text, p_events text[], p_secret_enc text) returns uuid
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
  if (select count(*) from public.webhook_endpoints w where w.org_id = p_org) >= 10 then
    raise exception 'ES_TOO_MANY: a workspace can have up to 10 webhook endpoints; delete one first' using errcode = '22023';
  end if;
  insert into public.webhook_endpoints (id, org_id, created_by, url, description, events, secret_enc)
    values (p_id, p_org, p_actor, btrim(p_url), btrim(coalesce(p_description, '')), v_events, p_secret_enc);
  perform app_private.audit_append('org:' || p_org::text, p_org, null, null, 'user', p_actor, 'webhook_created',
    jsonb_build_object('endpoint_id', p_id, 'origin', app_private.webhook_origin(p_url), 'events', to_jsonb(v_events)));
  return p_id;
end
$$;

-- null leaves a value unchanged; switching an endpoint back on clears its failure count
create function public.webhook_endpoint_update(p_actor uuid, p_id uuid, p_events text[], p_enabled boolean, p_description text) returns void
language plpgsql security definer set search_path = '' as $$
declare w public.webhook_endpoints;
begin
  select * into w from public.webhook_endpoints x where x.id = p_id for update;
  if not found or not app_private.api_key_admin(p_actor, w.org_id) then
    raise exception 'ES_NOT_FOUND: endpoint not found' using errcode = '42501';
  end if;
  perform app_private.require_not_suspended(p_actor, w.org_id);
  if char_length(coalesce(p_description, '')) > 200 then
    raise exception 'ES_DESCRIPTION: keep the description to 200 characters' using errcode = '22023';
  end if;
  update public.webhook_endpoints x set
      events = case when p_events is null then x.events else app_private.webhook_events(p_events) end,
      enabled = coalesce(p_enabled, x.enabled),
      disabled_reason = case when p_enabled is true then null when p_enabled is false then 'Switched off by a person' else x.disabled_reason end,
      consecutive_failures = case when p_enabled is true and not x.enabled then 0 else x.consecutive_failures end,
      description = coalesce(btrim(p_description), x.description),
      updated_at = now()
    where x.id = p_id;
  perform app_private.audit_append('org:' || w.org_id::text, w.org_id, null, null, 'user', p_actor, 'webhook_changed',
    jsonb_build_object('endpoint_id', p_id, 'origin', app_private.webhook_origin(w.url), 'enabled', coalesce(p_enabled, w.enabled),
      'events', to_jsonb((select x.events from public.webhook_endpoints x where x.id = p_id))));
end
$$;

-- a new secret; the old one keeps signing alongside it for 24 hours so the receiver can switch without missing events
create function public.webhook_endpoint_rotate(p_actor uuid, p_id uuid, p_secret_enc text) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare w public.webhook_endpoints; v_until timestamptz := now() + interval '24 hours';
begin
  select * into w from public.webhook_endpoints x where x.id = p_id for update;
  if not found or not app_private.api_key_admin(p_actor, w.org_id) then
    raise exception 'ES_NOT_FOUND: endpoint not found' using errcode = '42501';
  end if;
  perform app_private.require_not_suspended(p_actor, w.org_id);
  update public.webhook_endpoints x set previous_secret_enc = x.secret_enc, previous_until = v_until, secret_enc = p_secret_enc, updated_at = now() where x.id = p_id;
  perform app_private.audit_append('org:' || w.org_id::text, w.org_id, null, null, 'user', p_actor, 'webhook_secret_changed',
    jsonb_build_object('endpoint_id', p_id, 'origin', app_private.webhook_origin(w.url)));
  return v_until;
end
$$;

create function public.webhook_endpoint_delete(p_actor uuid, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare w public.webhook_endpoints;
begin
  select * into w from public.webhook_endpoints x where x.id = p_id for update;
  if not found or not app_private.api_key_admin(p_actor, w.org_id) then
    raise exception 'ES_NOT_FOUND: endpoint not found' using errcode = '42501';
  end if;
  delete from public.webhook_endpoints x where x.id = p_id;
  perform app_private.audit_append('org:' || w.org_id::text, w.org_id, null, null, 'user', p_actor, 'webhook_deleted',
    jsonb_build_object('endpoint_id', p_id, 'origin', app_private.webhook_origin(w.url)));
end
$$;

-- no secrets in the answer
create function public.webhook_endpoint_list(p_actor uuid, p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app_private.api_key_admin(p_actor, p_org) then
    raise exception 'ES_NOT_FOUND: workspace not found' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', w.id, 'url', w.url, 'description', w.description, 'events', to_jsonb(w.events),
             'enabled', w.enabled, 'disabled_reason', w.disabled_reason, 'live', app_private.webhook_live(w.created_by, w.org_id),
             'created_at', w.created_at, 'last_success_at', w.last_success_at,
             'previous_until', case when w.previous_until > now() then w.previous_until end,
             'created_by_name', (select coalesce(nullif(btrim(p.display_name), ''), 'Unknown') from public.profiles p where p.id = w.created_by),
             'week', (select jsonb_build_object('delivered', count(*) filter (where d.status = 'delivered'), 'failed', count(*) filter (where d.status = 'failed'),
                        'waiting', count(*) filter (where d.status in ('pending', 'sending')))
                        from public.webhook_deliveries d where d.endpoint_id = w.id and d.created_at > now() - interval '7 days'))
           order by w.created_at)
      from public.webhook_endpoints w where w.org_id = p_org), '[]'::jsonb);
end
$$;

-- the delivery log: the latest deliveries with every attempt
create function public.webhook_delivery_list(p_actor uuid, p_endpoint uuid, p_limit int) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare w public.webhook_endpoints;
begin
  select * into w from public.webhook_endpoints x where x.id = p_endpoint;
  if not found or not app_private.api_key_admin(p_actor, w.org_id) then
    raise exception 'ES_NOT_FOUND: endpoint not found' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', d.id, 'event_type', d.event_type, 'status', d.status, 'attempts', d.attempts, 'created_at', d.created_at,
             'delivered_at', d.delivered_at, 'next_attempt_at', case when d.status = 'pending' then d.next_attempt_at end,
             'last_status_code', d.last_status_code, 'last_error', d.last_error, 'payload', d.payload,
             'tries', coalesce((select jsonb_agg(jsonb_build_object('attempt', a.attempt, 'at', a.at, 'status_code', a.status_code, 'error', a.error, 'duration_ms', a.duration_ms)
                         order by a.attempt) from public.webhook_attempts a where a.delivery_id = d.id), '[]'::jsonb))
           order by d.created_at desc)
      from (select * from public.webhook_deliveries x where x.endpoint_id = p_endpoint order by x.created_at desc limit greatest(1, least(coalesce(p_limit, 50), 200))) d),
    '[]'::jsonb);
end
$$;

-- "Send a test event" (at most 5 a minute per endpoint)
create function public.webhook_test(p_actor uuid, p_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare w public.webhook_endpoints; v_id uuid;
begin
  select * into w from public.webhook_endpoints x where x.id = p_id;
  if not found or not app_private.api_key_admin(p_actor, w.org_id) then
    raise exception 'ES_NOT_FOUND: endpoint not found' using errcode = '42501';
  end if;
  perform app_private.require_not_suspended(p_actor, w.org_id);
  if not w.enabled then
    raise exception 'ES_DISABLED: switch the endpoint on first' using errcode = '22023';
  end if;
  if (select count(*) from public.webhook_deliveries d where d.endpoint_id = p_id and d.event_type = 'webhook.test' and d.created_at > now() - interval '1 minute') >= 5 then
    raise exception 'ES_TOO_MANY: wait a minute before sending more test events' using errcode = '22023';
  end if;
  insert into public.webhook_deliveries (endpoint_id, org_id, event_type, payload)
    values (p_id, w.org_id, 'webhook.test', jsonb_build_object('type', 'webhook.test', 'timestamp', now(),
      'data', jsonb_build_object('message', 'A test event from YouNMeSign. If you can read this, the endpoint works.')))
    returning id into v_id;
  return v_id;
end
$$;

-- try a failed delivery once more (same webhook-id, so the receiver can recognise a repeat)
create function public.webhook_redeliver(p_actor uuid, p_delivery uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.webhook_deliveries; w public.webhook_endpoints;
begin
  select * into d from public.webhook_deliveries x where x.id = p_delivery for update;
  if found then select * into w from public.webhook_endpoints x where x.id = d.endpoint_id; end if;
  if d.id is null or not app_private.api_key_admin(p_actor, w.org_id) then
    raise exception 'ES_NOT_FOUND: delivery not found' using errcode = '42501';
  end if;
  perform app_private.require_not_suspended(p_actor, w.org_id);
  if d.status <> 'failed' then
    raise exception 'ES_STATE: only a failed delivery can be sent again' using errcode = '22023';
  end if;
  if not w.enabled then
    raise exception 'ES_DISABLED: switch the endpoint on first' using errcode = '22023';
  end if;
  update public.webhook_deliveries x set status = 'pending', manual_retry = true, next_attempt_at = now(), locked_until = null where x.id = p_delivery;
end
$$;

-- ---------------------------------------------------------------- the worker
create function public.webhook_claim(p_limit int)
returns table (id uuid, endpoint_id uuid, url text, event_type text, payload jsonb, attempts int, secret_enc text, previous_secret_enc text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
begin
  -- due deliveries whose endpoint went dark stop without an attempt
  update public.webhook_deliveries x set status = 'failed', locked_until = null, manual_retry = false,
         last_error = 'Not sent: the endpoint is switched off, or the person who added it is no longer an owner or administrator'
    from public.webhook_endpoints w
   where w.id = x.endpoint_id and x.status in ('pending', 'sending') and x.next_attempt_at <= now()
     and (not w.enabled or not app_private.webhook_live(w.created_by, w.org_id));
  return query
  with picked as (
    select x.id from public.webhook_deliveries x
     where (x.status = 'pending' and x.next_attempt_at <= now()) or (x.status = 'sending' and x.locked_until < now())
     order by x.next_attempt_at
     limit greatest(1, least(coalesce(p_limit, 10), 50))
     for update skip locked),
  claimed as (
    update public.webhook_deliveries x set status = 'sending', locked_until = now() + interval '2 minutes'
      from picked, public.webhook_endpoints w
     where x.id = picked.id and w.id = x.endpoint_id
    returning x.id as d_id, x.endpoint_id as d_endpoint, w.url as d_url, x.event_type as d_event, x.payload as d_payload, x.attempts as d_attempts,
              w.secret_enc as d_secret, case when w.previous_until > now() then w.previous_secret_enc end as d_previous)
  select c.d_id, c.d_endpoint, c.d_url, c.d_event, c.d_payload, c.d_attempts, c.d_secret, c.d_previous from claimed c;
end
$$;

-- record one attempt; returns 'delivered', 'retry', 'failed' or 'ignored'
create function public.webhook_result(p_delivery uuid, p_ok boolean, p_status_code int, p_error text, p_duration_ms int) returns text
language plpgsql security definer set search_path = '' as $$
declare
  d public.webhook_deliveries;
  v_attempt int;
  v_delays int[] := array[60, 300, 1800, 7200, 21600, 43200];   -- seconds before attempts 2..7 (src/lib/webhooks/events.ts)
  v_fails int;
  v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 300);
  v_code int := case when p_status_code between 100 and 599 then p_status_code end;
begin
  select * into d from public.webhook_deliveries x where x.id = p_delivery for update;
  if not found or d.status <> 'sending' then return 'ignored'; end if;
  v_attempt := d.attempts + 1;
  insert into public.webhook_attempts (delivery_id, attempt, status_code, error, duration_ms)
    values (d.id, v_attempt, v_code, case when p_ok then null else v_error end, greatest(0, least(coalesce(p_duration_ms, 0), 600000)));
  if p_ok then
    update public.webhook_deliveries x set status = 'delivered', attempts = v_attempt, delivered_at = now(), locked_until = null, manual_retry = false,
           last_status_code = v_code, last_error = null where x.id = d.id;
    update public.webhook_endpoints w set consecutive_failures = 0, last_success_at = now() where w.id = d.endpoint_id;
    return 'delivered';
  end if;
  if d.manual_retry or v_attempt >= array_length(v_delays, 1) + 1 then
    update public.webhook_deliveries x set status = 'failed', attempts = v_attempt, locked_until = null, manual_retry = false,
           last_status_code = v_code, last_error = v_error where x.id = d.id;
    if not d.manual_retry and d.event_type <> 'webhook.test' then
      update public.webhook_endpoints w set consecutive_failures = w.consecutive_failures + 1 where w.id = d.endpoint_id
        returning w.consecutive_failures into v_fails;
      if v_fails >= 5 then
        update public.webhook_endpoints w set enabled = false, updated_at = now(),
               disabled_reason = 'Switched off automatically: 5 deliveries in a row failed after every retry'
         where w.id = d.endpoint_id and w.enabled;
      end if;
    end if;
    return 'failed';
  end if;
  update public.webhook_deliveries x set status = 'pending', attempts = v_attempt, locked_until = null, last_status_code = v_code, last_error = v_error,
         next_attempt_at = now() + make_interval(secs => v_delays[v_attempt]) where x.id = d.id;
  return 'retry';
end
$$;

-- the log keeps 30 days (at least 7)
create function public.webhook_prune(p_days int) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from public.webhook_deliveries x where x.status in ('delivered', 'failed') and x.created_at < now() - make_interval(days => greatest(coalesce(p_days, 30), 7));
  get diagnostics n = row_count;
  return n;
end
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.webhook_endpoint_create(uuid, uuid, uuid, text, text, text[], text)',
    'public.webhook_endpoint_update(uuid, uuid, text[], boolean, text)',
    'public.webhook_endpoint_rotate(uuid, uuid, text)',
    'public.webhook_endpoint_delete(uuid, uuid)',
    'public.webhook_endpoint_list(uuid, uuid)',
    'public.webhook_delivery_list(uuid, uuid, int)',
    'public.webhook_test(uuid, uuid)',
    'public.webhook_redeliver(uuid, uuid)',
    'public.webhook_claim(int)',
    'public.webhook_result(uuid, boolean, int, text, int)',
    'public.webhook_prune(int)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- down:
-- drop trigger recipients_webhooks on public.recipients; drop trigger envelopes_webhooks on public.envelopes;
-- drop function public.webhook_prune(int); drop function public.webhook_result(uuid, boolean, int, text, int); drop function public.webhook_claim(int);
-- drop function public.webhook_redeliver(uuid, uuid); drop function public.webhook_test(uuid, uuid); drop function public.webhook_delivery_list(uuid, uuid, int);
-- drop function public.webhook_endpoint_list(uuid, uuid); drop function public.webhook_endpoint_delete(uuid, uuid);
-- drop function public.webhook_endpoint_rotate(uuid, uuid, text); drop function public.webhook_endpoint_update(uuid, uuid, text[], boolean, text);
-- drop function public.webhook_endpoint_create(uuid, uuid, uuid, text, text, text[], text);
-- drop function app_private.webhook_on_recipient_status(); drop function app_private.webhook_on_envelope_status();
-- drop function app_private.webhook_enqueue(uuid, text, uuid, jsonb); drop function app_private.webhook_document(public.envelopes);
-- drop function app_private.webhook_events(text[]); drop function app_private.webhook_origin(text); drop function app_private.webhook_live(uuid, uuid);
-- drop table public.webhook_attempts; drop table public.webhook_deliveries; drop table public.webhook_endpoints;
