-- D-98 (Phase 5 slice 10): fixes from the independent security review of Phase 5. Copies of existing functions, each
-- changed only where marked "D-98", plus two new server-only functions:
-- * only an approved account can make API keys or webhook endpoints (an unapproved one could otherwise create drafts
--   or send requests from our server at scale);
-- * revoking a key deletes its stored idempotent answers; stored answers older than 24 hours are deleted by the worker
--   (api_idem_prune); answers stored before this change that contained signing links are removed now;
-- * a webhook test event is tried once; one endpoint gets at most two deliveries per worker pass; test events and
--   manual re-sends are in the workspace audit trail;
-- * api_audit: what an API key did to a document is recorded in that document's audit trail, with the key.

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
  if not coalesce((select c.approved from public.account_controls c where c.user_id = p_actor), false) then
    raise exception 'ES_NOT_APPROVED: your account must be approved before it can make API keys' using errcode = '42501';
  end if;
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

create or replace function public.revoke_api_key(p_actor uuid, p_key_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k public.api_keys;
begin
  select * into k from public.api_keys x where x.id = p_key_id for update;
  if not found or not app_private.api_key_admin(p_actor, k.org_id) then
    raise exception 'ES_NOT_FOUND: key not found' using errcode = '42501';
  end if;
  if k.revoked_at is not null then return; end if;
  update public.api_keys x set revoked_at = now(), revoked_by = p_actor where x.id = k.id;
  delete from public.api_idempotency x where x.key_id = k.id;   -- D-98: its stored answers go too
  perform app_private.audit_append('org:' || k.org_id::text, k.org_id, null, null, 'user', p_actor, 'api_key_revoked',
    jsonb_build_object('key_id', k.id, 'name', k.name, 'prefix', k.prefix));
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
  if not coalesce((select c.approved from public.account_controls c where c.user_id = p_actor), false) then
    raise exception 'ES_NOT_APPROVED: your account must be approved before it can add webhook endpoints' using errcode = '42501';
  end if;
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

create or replace function public.webhook_result(p_delivery uuid, p_ok boolean, p_status_code int, p_error text, p_duration_ms int) returns text
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
  -- D-98: a test event is tried once (it is for checking the endpoint now, not for later)
  if d.manual_retry or d.event_type = 'webhook.test' or v_attempt >= array_length(v_delays, 1) + 1 then
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

create or replace function public.webhook_claim(p_limit int)
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
  -- D-98: at most two deliveries per endpoint in one pass, so one slow receiver cannot take every slot
  with due as (
    select x.id, row_number() over (partition by x.endpoint_id order by x.next_attempt_at) as rn
      from public.webhook_deliveries x
     where (x.status = 'pending' and x.next_attempt_at <= now()) or (x.status = 'sending' and x.locked_until < now())),
  picked as (
    select x.id from public.webhook_deliveries x join due on due.id = x.id
     where due.rn <= 2
     order by x.next_attempt_at
     limit greatest(1, least(coalesce(p_limit, 10), 50))
     for update of x skip locked),
  claimed as (
    update public.webhook_deliveries x set status = 'sending', locked_until = now() + interval '2 minutes'
      from picked, public.webhook_endpoints w
     where x.id = picked.id and w.id = x.endpoint_id
    returning x.id as d_id, x.endpoint_id as d_endpoint, w.url as d_url, x.event_type as d_event, x.payload as d_payload, x.attempts as d_attempts,
              w.secret_enc as d_secret, case when w.previous_until > now() then w.previous_secret_enc end as d_previous)
  select c.d_id, c.d_endpoint, c.d_url, c.d_event, c.d_payload, c.d_attempts, c.d_secret, c.d_previous from claimed c;
end
$$;

create or replace function public.webhook_test(p_actor uuid, p_id uuid) returns uuid
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
  perform app_private.audit_append('org:' || w.org_id::text, w.org_id, null, null, 'user', p_actor, 'webhook_tested',
    jsonb_build_object('endpoint_id', p_id, 'delivery_id', v_id, 'origin', app_private.webhook_origin(w.url)));
  return v_id;
end
$$;

create or replace function public.webhook_redeliver(p_actor uuid, p_delivery uuid) returns void
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
  perform app_private.audit_append('org:' || w.org_id::text, w.org_id, null, null, 'user', p_actor, 'webhook_redelivered',
    jsonb_build_object('endpoint_id', w.id, 'delivery_id', d.id, 'event', d.event_type, 'origin', app_private.webhook_origin(w.url)));
end
$$;


-- the stored answers of the idempotency store older than its 24-hour window (run by the worker)
create function public.api_idem_prune() returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from public.api_idempotency x where x.created_at < now() - interval '24 hours';
  get diagnostics n = row_count;
  return n;
end
$$;

-- an API key's action on a document, in that document's audit trail (the person is the key's creator; the key is named)
create function public.api_audit(p_key_id uuid, p_envelope_id uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare k public.api_keys; e public.envelopes;
begin
  if p_action is null or p_action not in ('created_from_template', 'sent') then
    raise exception 'ES_INVALID: unknown API action' using errcode = '22023';
  end if;
  select * into k from public.api_keys x where x.id = p_key_id;
  select * into e from public.envelopes x where x.id = p_envelope_id;
  if k.id is null or e.id is null or e.org_id <> k.org_id then
    raise exception 'ES_NOT_FOUND: not found' using errcode = '42501';
  end if;
  perform app_private.audit_append('env:' || e.id::text, e.org_id, e.id, null, 'user', k.created_by, 'api_call',
    jsonb_build_object('action', p_action, 'key_id', k.id, 'key_prefix', k.prefix, 'key_name', k.name));
end
$$;

-- answers stored before this change could hold live signing links: removed
delete from public.api_idempotency x where x.response ? 'signing_links';

do $$
declare fn text;
begin
  foreach fn in array array['public.api_idem_prune()', 'public.api_audit(uuid, uuid, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- down: restore create_api_key and webhook_endpoint_create from 20261121193911_plans_usage, revoke_api_key from
-- 20261121082938_api_keys, webhook_result, webhook_claim, webhook_test and webhook_redeliver from 20261121092729_webhooks
-- (create or replace); drop function public.api_audit(uuid, uuid, text); drop function public.api_idem_prune();
