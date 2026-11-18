-- EasySign Phase 2 / migration 14: notifications and the email budget (slice 6; AT2.6, carried AT1.11, D-49 #9).
--  1. finish_outbox records "this email was sent" and its place in the email budget in ONE transaction,
--     so neither can exist without the other (before, the worker made two separate calls).
--  2. When an email has to wait for tomorrow's allowance, the sender gets one in-app notice per document per day.
--  3. The sender gets an in-app notice when someone signs or approves (never by email unless they opt in).
--  4. Daily digest: an opt-in, at most one email a day, lowest email class (P3), listing those notices.
--  5. An overview of the email queue for the administrator's meter.
-- All new public functions are server-only (service role).

alter table public.profiles add column digest_opt_in boolean not null default false;
alter table public.profiles add column digest_through timestamptz;
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;

-- ---------------------------------------------------------------- 1 + 2: one step for "sent" and the budget
create or replace function public.finish_outbox(p_id uuid, p_outcome text, p_not_before timestamptz, p_provider_message_id text, p_error text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.notification_outbox;
  v_result text;
  v_restricted boolean := false;
begin
  select * into v_row from public.notification_outbox o where o.id = p_id for update;
  if not found or v_row.status <> 'sending' then
    return 'ignored';
  end if;
  if p_outcome = 'sent' then
    update public.notification_outbox o set status = 'sent', sent_at = now(), locked_until = null, provider_message_id = p_provider_message_id, last_error = null where o.id = p_id;
    -- counted here, in the same transaction as the status change: a row can become "sent" only once
    -- (the check above), so an email is counted exactly once, and never without being marked sent
    if v_row.sender_user_id is not null then
      select c.trust_level = 'restricted' into v_restricted from public.account_controls c where c.user_id = v_row.sender_user_id;
    end if;
    perform public.email_budget_record(v_row.priority, v_row.sender_user_id, coalesce(v_restricted, false));
    v_result := 'sent';
  elsif p_outcome = 'deferred' then
    update public.notification_outbox o set status = 'deferred', locked_until = null, attempts = greatest(o.attempts - 1, 0),
           not_before = coalesce(p_not_before, now() + interval '1 hour'), last_error = left(p_error, 500) where o.id = p_id;
    if v_row.sender_user_id is not null and v_row.envelope_id is not null
       and not exists (select 1 from public.notifications q
                        where q.user_id = v_row.sender_user_id and q.kind = 'email_deferred'
                          and q.payload ->> 'envelope_id' = v_row.envelope_id::text and q.created_at >= (app_private.utc_day()::timestamp at time zone 'UTC')) then
      insert into public.notifications (org_id, user_id, kind, payload)
        values (v_row.org_id, v_row.sender_user_id, 'email_deferred',
                jsonb_build_object('envelope_id', v_row.envelope_id, 'kind', v_row.kind,
                                   'title', (select e.title from public.envelopes e where e.id = v_row.envelope_id)));
    end if;
    v_result := 'deferred';
  elsif v_row.attempts >= 5 then
    update public.notification_outbox o set status = 'dead', locked_until = null, last_error = left(p_error, 500) where o.id = p_id;
    if v_row.sender_user_id is not null then
      insert into public.notifications (org_id, user_id, kind, payload)
        values (v_row.org_id, v_row.sender_user_id, 'email_failed', jsonb_build_object('envelope_id', v_row.envelope_id, 'kind', v_row.kind));
    end if;
    v_result := 'failed';
  else
    update public.notification_outbox o set status = 'queued', locked_until = null, last_error = left(p_error, 500),
           not_before = now() + make_interval(secs => 60 * (2 ^ v_row.attempts)::int) where o.id = p_id;
    v_result := 'retry';
  end if;
  if v_row.envelope_id is not null and v_result in ('sent', 'deferred', 'failed') then
    perform app_private.audit_append('env:' || v_row.envelope_id::text, v_row.org_id, v_row.envelope_id, v_row.recipient_id, 'system', null,
      'email_' || v_result, jsonb_build_object('kind', v_row.kind, 'outbox_id', v_row.id));
  end if;
  return v_result;
end
$$;

-- ---------------------------------------------------------------- 3: progress notices for the sender
create function app_private.notify_sender_progress() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
begin
  select * into v_env from public.envelopes e where e.id = new.envelope_id;
  -- nobody needs to be told about their own signature
  if v_env.sender_id is null or lower(new.email) = coalesce(app_private.user_email(v_env.sender_id), '') then
    return null;
  end if;
  insert into public.notifications (org_id, user_id, kind, payload)
    values (v_env.org_id, v_env.sender_id, case new.status when 'signed' then 'recipient_signed' else 'recipient_approved' end,
            jsonb_build_object('envelope_id', v_env.id, 'title', v_env.title, 'by', new.name));
  return null;
end
$$;
create trigger recipients_notify_progress after update of status on public.recipients
  for each row when (old.status is distinct from new.status and new.status in ('signed', 'approved'))
  execute function app_private.notify_sender_progress();

-- ---------------------------------------------------------------- 4: daily digest (opt-in)
create function public.set_digest_opt_in(p_actor uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_actor is null or p_on is null then
    raise exception 'a user and a choice are required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_actor) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- the first digest covers what happens from now on, not the past
  update public.profiles p set digest_opt_in = p_on, digest_through = case when p_on then now() else null end
   where p.id = p_actor and p.digest_opt_in is distinct from p_on;
  return p_on;
end
$$;

-- Queues at most one digest per person per 24 hours, and only if there is something to report.
-- Safe to run twice or from two workers: the person's row is locked, and the key is unique per day.
create function public.queue_digests(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = '' as $$
declare
  p record;
  v_from timestamptz;
  v_queued int := 0;
  v_inserted int;
begin
  if p_now is null then
    raise exception 'a time is required' using errcode = '22023';
  end if;
  if p_now > now() + interval '5 minutes' and coalesce(current_setting('easysign.test_clock', true), '') <> 'on' then
    raise exception 'queue_digests was given a time in the future' using errcode = '22023';
  end if;
  for p in select pr.id, pr.digest_through from public.profiles pr
            where pr.digest_opt_in and (pr.digest_through is null or pr.digest_through <= p_now - interval '24 hours')
            order by pr.id
            for update skip locked loop
    v_from := coalesce(p.digest_through, p_now - interval '24 hours');
    if exists (select 1 from public.notifications q where q.user_id = p.id and q.created_at > v_from and q.created_at <= p_now) then
      insert into public.notification_outbox (to_user_id, sender_user_id, kind, priority, payload, idempotency_key, created_at)
        values (p.id, p.id, 'digest', 'P3', jsonb_build_object('from', v_from, 'to', p_now),
                'digest:' || p.id::text || ':' || to_char(p_now at time zone 'UTC', 'YYYY-MM-DD'), p_now)
        on conflict (idempotency_key) do nothing;
      get diagnostics v_inserted = row_count;
      v_queued := v_queued + v_inserted;
    end if;
    update public.profiles pr set digest_through = p_now where pr.id = p.id;
  end loop;
  return v_queued;
end
$$;

-- ---------------------------------------------------------------- 5: the administrator's view of the queue
create function public.admin_email_overview(p_actor uuid)
returns table (queued int, deferred int, sending int, dead int, sent_today int, oldest_waiting timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.require_admin(p_actor);
  return query
    select count(*) filter (where o.status = 'queued')::int, count(*) filter (where o.status = 'deferred')::int,
           count(*) filter (where o.status = 'sending')::int, count(*) filter (where o.status = 'dead')::int,
           count(*) filter (where o.status = 'sent' and o.sent_at >= (app_private.utc_day()::timestamp at time zone 'UTC'))::int,
           min(o.created_at) filter (where o.status in ('queued', 'deferred'))
      from public.notification_outbox o;
end
$$;

do $$
declare fn text;
begin
  revoke all on function app_private.notify_sender_progress() from public, anon, authenticated, service_role;
  foreach fn in array array[
    'public.finish_outbox(uuid, text, timestamptz, text, text)',
    'public.set_digest_opt_in(uuid, boolean)',
    'public.queue_digests(timestamptz)',
    'public.admin_email_overview(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- down (manual): restore finish_outbox from migration 7 (20261118073919_send_sign_seal); then
-- drop trigger recipients_notify_progress on public.recipients; drop function app_private.notify_sender_progress();
-- drop function public.admin_email_overview(uuid), public.queue_digests(timestamptz), public.set_digest_opt_in(uuid, boolean);
-- drop index public.notifications_unread_idx;
-- alter table public.profiles drop column digest_through, drop column digest_opt_in;
