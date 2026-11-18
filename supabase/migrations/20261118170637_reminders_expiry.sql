-- EasySign Phase 2 / migration 12: reminders and expiry (AT2.4).
-- One function, process_due(p_now), does both. The time is passed in, so the rules can be tested with any
-- date; the worker calls it with the real time about once a minute. It is safe to run twice, or from two
-- workers at once: each reminder has a unique key, and rows being processed are skipped by the other run.
-- All functions are server-only (service role).

alter table public.envelopes add column remind_after_days smallint check (remind_after_days between 1 and 30);
alter table public.envelopes add column remind_every_days smallint check (remind_every_days between 1 and 30);
alter table public.envelopes add column remind_max smallint not null default 0 check (remind_max between 0 and 10);
alter table public.envelopes add column expired_at timestamptz;

-- Reminders count as requests when a document is stopped: unsent ones must not go out.
create or replace function app_private.cancel_pending_requests(p_envelope_id uuid, p_reason text) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
begin
  update public.notification_outbox o
     set status = 'dead', locked_until = null, last_error = left(p_reason, 500)
   where o.envelope_id = p_envelope_id and o.status in ('queued', 'deferred')
     and o.kind in ('signature_request', 'approval_request', 'view_notice', 'reminder');
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- The sender chooses reminders while the document is a draft. p_max 0 (or no first interval) means none.
create function public.set_reminders(p_actor uuid, p_envelope_id uuid, p_after_days int, p_every_days int, p_max int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_draft(p_actor, p_envelope_id);
  if coalesce(p_max, 0) = 0 or p_after_days is null then
    perform app_private.sanction();
    update public.envelopes e set remind_after_days = null, remind_every_days = null, remind_max = 0 where e.id = p_envelope_id;
    perform set_config('easysign.sanctioned', '', true);
    return;
  end if;
  if p_after_days not between 1 and 30 or coalesce(p_every_days, p_after_days) not between 1 and 30 or p_max not between 1 and 10 then
    raise exception 'ES_INVALID: reminders can start after 1 to 30 days, repeat every 1 to 30 days, and be sent up to 10 times' using errcode = '22023';
  end if;
  perform app_private.sanction();
  update public.envelopes e
     set remind_after_days = p_after_days, remind_every_days = coalesce(p_every_days, p_after_days), remind_max = p_max
   where e.id = p_envelope_id;
  perform set_config('easysign.sanctioned', '', true);
end
$$;

-- Everything that depends on the passing of time.
--  1. Expiry: an open document whose date has passed (and whose sealing is not already queued) is closed:
--     everyone still waiting becomes "expired", every link is revoked, unsent requests are cancelled, the
--     sender is told. "Expired" is a terminal state.
--  2. Reminders: someone whose turn it is and who has not finished is reminded when the chosen interval has
--     passed since they were last contacted, up to the chosen number of times, and never in the last hour
--     before expiry. Only when the product emails the requests; never to the sender themselves.
create function public.process_due(p_now timestamptz default now())
returns table (expired_count int, reminder_count int)
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  r public.recipients;
  v_expired int := 0;
  v_reminders int := 0;
  v_count int;
  v_last timestamptz;
  v_inserted int;
begin
  if p_now is null then
    raise exception 'a time is required' using errcode = '22023';
  end if;

  for v_env in select * from public.envelopes e
                where e.status in ('sent', 'in_progress') and e.expires_at is not null and e.expires_at <= p_now
                  and not exists (select 1 from public.seal_jobs j where j.envelope_id = e.id)
                order by e.expires_at
                for update skip locked loop
    perform app_private.sanction();
    update public.recipients x set status = 'expired'
     where x.envelope_id = v_env.id and x.status in ('created', 'sent', 'viewed', 'consented');
    update public.envelopes e set status = 'expired', expired_at = p_now where e.id = v_env.id;
    perform set_config('easysign.sanctioned', '', true);
    update public.recipient_tokens k set revoked_at = p_now where k.envelope_id = v_env.id and k.revoked_at is null;
    perform app_private.cancel_pending_requests(v_env.id, 'cancelled: the document expired');
    perform app_private.audit_append('env:' || v_env.id::text, v_env.org_id, v_env.id, null, 'system', null, 'envelope_expired',
      jsonb_build_object('expires_at', v_env.expires_at, 'links_revoked', true));
    insert into public.notifications (org_id, user_id, kind, payload)
      values (v_env.org_id, v_env.sender_id, 'envelope_expired', jsonb_build_object('envelope_id', v_env.id, 'title', v_env.title));
    insert into public.notification_outbox (org_id, envelope_id, to_user_id, sender_user_id, kind, priority, idempotency_key)
      values (v_env.org_id, v_env.id, v_env.sender_id, v_env.sender_id, 'expired_sender', 'P2', 'expired:' || v_env.id::text)
      on conflict (idempotency_key) do nothing;
    v_expired := v_expired + 1;
  end loop;

  for r in select x.* from public.recipients x join public.envelopes e on e.id = x.envelope_id
            where e.status in ('sent', 'in_progress') and e.delivery = 'email'
              and e.remind_max > 0 and e.remind_after_days is not null
              and (e.expires_at is null or e.expires_at > p_now + interval '1 hour')
              and x.role in ('signer', 'in_person', 'approver') and x.status in ('sent', 'viewed', 'consented')
            order by x.sent_at, x.id
            for update of x skip locked loop
    select * into v_env from public.envelopes e where e.id = r.envelope_id;
    continue when lower(r.email) = coalesce(app_private.user_email(v_env.sender_id), '');
    select count(*) filter (where o.kind = 'reminder'), max(o.created_at) into v_count, v_last
      from public.notification_outbox o
     where o.recipient_id = r.id and o.kind in ('signature_request', 'approval_request', 'reminder');
    v_last := coalesce(v_last, r.sent_at);
    continue when v_last is null or v_count >= v_env.remind_max;
    continue when p_now < v_last + make_interval(days => case when v_count = 0 then v_env.remind_after_days else coalesce(v_env.remind_every_days, v_env.remind_after_days) end);
    -- created_at carries the time this run was asked about, so a second run for the same moment finds it and does nothing
    insert into public.notification_outbox (org_id, envelope_id, recipient_id, sender_user_id, kind, priority, idempotency_key, created_at)
      values (v_env.org_id, v_env.id, r.id, v_env.sender_id, 'reminder', 'P2', 'reminder:' || r.id::text || ':' || (v_count + 1)::text, p_now)
      on conflict (idempotency_key) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 1 then
      perform app_private.audit_append('env:' || v_env.id::text, v_env.org_id, v_env.id, r.id, 'system', null, 'reminder_queued',
        jsonb_build_object('number', v_count + 1));
      v_reminders := v_reminders + 1;
    end if;
  end loop;

  return query select v_expired, v_reminders;
end
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.set_reminders(uuid, uuid, int, int, int)',
    'public.process_due(timestamptz)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- down (manual): re-run cancel_pending_requests from migration 11; then
-- drop function if exists public.process_due(timestamptz), public.set_reminders(uuid, uuid, int, int, int);
-- alter table public.envelopes drop column expired_at, drop column remind_max, drop column remind_every_days, drop column remind_after_days;
