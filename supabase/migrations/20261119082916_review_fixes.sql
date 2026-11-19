-- EasySign Phase 2 / migration 19: fixes from the independent review of Phase 2 (slice 11; DECISIONS D-63).
--  M1  A code email now counts against the sender's own daily limits (it is a request, sent on the sender's
--      behalf), and a person can be sent at most 5 codes per day (and 5 per hour, as before).
--  M2  While a sender is suspended their documents do not expire and collect no reminders; lifting the
--      suspension moves the expiry date and the links on by the time spent on hold.
--  m1  No email about a held document is handed out, whoever queued it.
--  m3  A person who becomes "the sender signing their own document" (after a corrected address) loses the
--      extra check, so the certificate never names a check that did not run.
--  m5  The database itself refuses a signing step from a person who has not passed their identity check
--      (until now only the app enforced it).
--  m6  A code check whose second step never arrived stops counting as "running" after 2 minutes.

alter table public.recipient_auth add column pending_since timestamptz;

create or replace function public.process_due(p_now timestamptz default now())
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
  -- Accident guard: with a future time this function would expire real documents. The worker always
  -- passes the real time. Tests move the clock inside a transaction that is rolled back, and say so.
  if p_now > now() + interval '5 minutes' and coalesce(current_setting('easysign.test_clock', true), '') <> 'on' then
    raise exception 'process_due was given a time in the future' using errcode = '22023';
  end if;

  for v_env in select * from public.envelopes e
                where e.status in ('sent', 'in_progress') and e.expires_at is not null and e.expires_at <= p_now
                  and not exists (select 1 from public.seal_jobs j where j.envelope_id = e.id)
                  and not app_private.sender_on_hold(e.id)
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
              and not app_private.sender_on_hold(e.id)
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

create or replace function public.admin_set_suspension(p_actor uuid, p_user uuid, p_suspended boolean, p_reason text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_ctl public.account_controls;
  v_org uuid;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 500), '');
begin
  perform app_private.require_admin(p_actor);
  if p_suspended is null then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  select * into v_ctl from public.account_controls c where c.user_id = p_user for update;
  if not found then
    raise exception 'ES_NOT_FOUND: account not found' using errcode = '42501';
  end if;
  if v_ctl.is_platform_admin or p_user = p_actor then
    raise exception 'ES_ADMIN_ACCOUNT: an administrator account cannot be suspended here' using errcode = '42501';
  end if;
  if (v_ctl.trust_level = 'suspended') = p_suspended then
    return 'unchanged';
  end if;
  if p_suspended then
    update public.account_controls c
       set trust_before_suspension = c.trust_level, trust_level = 'suspended', suspended_at = now(), suspended_reason = v_reason
     where c.user_id = p_user;
  else
    -- the time on hold does not count: links and the expiry date move on by exactly that long
    if v_ctl.suspended_at is not null then
      perform app_private.sanction();
      update public.envelopes e set expires_at = e.expires_at + (now() - v_ctl.suspended_at)
       where e.sender_id = p_user and e.status in ('sent', 'in_progress') and e.expires_at is not null;
      perform set_config('easysign.sanctioned', '', true);
      update public.recipient_tokens k set expires_at = k.expires_at + (now() - v_ctl.suspended_at)
       where k.revoked_at is null and k.envelope_id in (select e.id from public.envelopes e where e.sender_id = p_user and e.status in ('sent', 'in_progress'));
    end if;
    update public.account_controls c
       set trust_level = coalesce(c.trust_before_suspension, 'restricted'), trust_before_suspension = null, suspended_at = null, suspended_reason = null
     where c.user_id = p_user;
  end if;
  select m.org_id into v_org from public.memberships m where m.user_id = p_user and m.role = 'owner' limit 1;
  if v_org is not null then
    -- the reason is the administrator's own note; the audit trail keeps only that one was given
    perform app_private.audit_append('org:' || v_org::text, v_org, null, null, 'admin', p_actor,
      case when p_suspended then 'account_suspended' else 'account_suspension_lifted' end,
      jsonb_build_object('user_id', p_user, 'reason_given', v_reason is not null));
    insert into public.notifications (org_id, user_id, kind, payload)
      values (v_org, p_user, case when p_suspended then 'account_suspended' else 'account_suspension_lifted' end, '{}'::jsonb);
  end if;
  return case when p_suspended then 'suspended' else 'lifted' end;
end
$$;

create or replace function public.claim_outbox(p_limit int default 10, p_lease_seconds int default 120) returns setof public.notification_outbox
language plpgsql security definer set search_path = '' as $$
begin
  update public.notification_outbox o set status = 'dead', locked_until = null,
         last_error = coalesce(o.last_error, 'gave up after repeated interrupted attempts')
   where o.status = 'sending' and o.locked_until <= now() and o.attempts >= 6;
  return query
    update public.notification_outbox o
       set status = 'sending', attempts = o.attempts + 1, locked_until = now() + make_interval(secs => p_lease_seconds)
     where o.id in (
       select q.id from public.notification_outbox q
        where q.not_before <= now()
          and (q.status in ('queued', 'deferred') or (q.status = 'sending' and q.locked_until <= now()))
          and not exists (select 1 from public.account_controls c where c.user_id = q.sender_user_id and c.trust_level = 'suspended')
          and (q.envelope_id is null or not app_private.sender_on_hold(q.envelope_id))
        order by case q.priority when 'P0_AUTH' then 0 when 'P0_REQUEST' then 1 when 'P1' then 2 when 'P2' then 3 else 4 end, q.created_at
        for update skip locked limit greatest(1, least(p_limit, 50)))
    returning o.*;
end
$$;

create or replace function app_private.require_signer(p_token_id uuid) returns public.recipients
language plpgsql security definer set search_path = '' as $$
declare
  v_tok public.recipient_tokens;
  v_rcp public.recipients;
  v_status text;
begin
  select * into v_tok from public.recipient_tokens k where k.id = p_token_id;
  if not found or v_tok.revoked_at is not null or v_tok.expires_at <= now() then
    raise exception 'ES_LINK_INVALID: this link is no longer valid' using errcode = '42501';
  end if;
  -- Row lock: everything one person does through one link runs one step at a time.
  select * into v_rcp from public.recipients x where x.id = v_tok.recipient_id for update;
  select e.status into v_status from public.envelopes e where e.id = v_tok.envelope_id;
  if v_status not in ('sent', 'in_progress') then
    raise exception 'ES_LINK_INVALID: this document is no longer open for signing' using errcode = '42501';
  end if;
  if app_private.sender_on_hold(v_tok.envelope_id) then
    raise exception 'ES_ON_HOLD: this document is on hold and cannot be signed right now' using errcode = '42501';
  end if;
  -- 2 hours = the signer session's lifetime; a new link (corrected address) starts with no pass at all
  if v_rcp.auth_method <> 'link' and not v_rcp.is_sender and not exists (
       select 1 from public.recipient_auth a where a.recipient_id = v_rcp.id and a.last_passed_at > now() - interval '2 hours') then
    raise exception 'ES_CHECK_NEEDED: pass the extra identity check first' using errcode = '42501';
  end if;
  if v_rcp.role not in ('signer', 'in_person', 'approver') then
    raise exception 'ES_NOT_AN_ACTOR: there is nothing for you to sign on this document' using errcode = '42501';
  end if;
  if v_rcp.status = 'created' or v_rcp.routing_order is distinct from app_private.routing_active_order(v_tok.envelope_id) then
    if v_rcp.status in ('signed', 'approved') then
      raise exception 'ES_ALREADY_DONE: you have already finished this document' using errcode = '42501';
    end if;
    raise exception 'ES_NOT_YOUR_TURN: it is not your turn yet. You will be told when the document is ready for you' using errcode = '42501';
  end if;
  if v_rcp.status not in ('sent', 'viewed', 'consented') then
    raise exception 'ES_ALREADY_DONE: you have already finished this document' using errcode = '42501';
  end if;
  return v_rcp;
end
$$;

create or replace function public.signer_request_otp(p_token_id uuid, p_ip inet, p_user_agent text)
returns table (status text, retry_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  a public.recipient_auth;
begin
  v_rcp := app_private.signer_gate(p_token_id);
  if v_rcp.auth_method <> 'email_otp' then
    raise exception 'ES_NO_SUCH_CHECK: this link does not use an emailed code' using errcode = '22023';
  end if;
  insert into public.recipient_auth (recipient_id, org_id, envelope_id) values (v_rcp.id, v_rcp.org_id, v_rcp.envelope_id) on conflict do nothing;
  select * into a from public.recipient_auth x where x.recipient_id = v_rcp.id for update;
  if a.locked_until is not null and a.locked_until > now() then
    return query select 'locked'::text, a.locked_until;
    return;
  end if;
  if a.otp_requested_at is not null and a.otp_requested_at + interval '60 seconds' > now() then
    return query select 'wait'::text, a.otp_requested_at + interval '60 seconds';
    return;
  end if;
  if not public.rate_limit_hit('otp_request', v_rcp.id::text, 5, 3600) then
    return query select 'limit'::text, now() + interval '1 hour';
    return;
  end if;
  if not public.rate_limit_hit('otp_day', v_rcp.id::text, 5, 86400) then
    return query select 'limit'::text, now() + interval '1 day';
    return;
  end if;
  -- a new request cancels the previous code at once
  update public.recipient_auth x set otp_hash = null, otp_expires_at = null, otp_requested_at = now(), otp_requests = x.otp_requests + 1
   where x.recipient_id = v_rcp.id returning * into a;
  insert into public.notification_outbox (org_id, envelope_id, recipient_id, sender_user_id, kind, priority, idempotency_key)
    values (v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, (select e.sender_id from public.envelopes e where e.id = v_rcp.envelope_id),
            'otp', 'P0_REQUEST', 'otp:' || p_token_id::text || ':' || a.otp_requests::text);
  perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'code_requested',
    jsonb_build_object('number', a.otp_requests), p_ip, p_user_agent);
  return query select 'queued'::text, now() + interval '60 seconds';
end
$$;

create or replace function public.signer_auth_begin(p_token_id uuid)
returns table (status text, access_code_hash text, locked_until timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  a public.recipient_auth;
begin
  v_rcp := app_private.signer_gate(p_token_id);
  if v_rcp.auth_method <> 'access_code' then
    raise exception 'ES_NO_SUCH_CHECK: this link does not use an access code' using errcode = '22023';
  end if;
  insert into public.recipient_auth (recipient_id, org_id, envelope_id) values (v_rcp.id, v_rcp.org_id, v_rcp.envelope_id) on conflict do nothing;
  select * into a from public.recipient_auth x where x.recipient_id = v_rcp.id for update;
  if a.pending_checks > 0 and (a.pending_since is null or a.pending_since < now() - interval '2 minutes') then
    update public.recipient_auth x set pending_checks = 0 where x.recipient_id = v_rcp.id;
    a.pending_checks := 0;
  end if;
  if a.locked_until is not null and a.locked_until > now() then
    return query select 'locked'::text, null::text, a.locked_until;
    return;
  end if;
  if a.locked_until is not null then   -- an earlier lock has run out: the count starts again
    a.failed_attempts := 0;
  end if;
  update public.recipient_auth x
     set failed_attempts = a.failed_attempts + 1, pending_checks = x.pending_checks + 1, pending_since = now(),
         locked_until = case when a.failed_attempts + 1 >= 5 then app_private.auth_lock_until(x.lockouts) end,
         lockouts = x.lockouts + case when a.failed_attempts + 1 >= 5 then 1 else 0 end
   where x.recipient_id = v_rcp.id;
  return query select 'check'::text, v_rcp.access_code_hash, null::timestamptz;
end
$$;

create or replace function public.signer_auth_finish(p_token_id uuid, p_ok boolean, p_ip inet, p_user_agent text)
returns table (status text, attempts_left int, locked_until timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  a public.recipient_auth;
begin
  v_rcp := app_private.signer_gate(p_token_id);
  select * into a from public.recipient_auth x where x.recipient_id = v_rcp.id for update;
  if not found or a.pending_checks < 1 or p_ok is null or v_rcp.auth_method <> 'access_code' then
    raise exception 'ES_NO_CHECK_IN_PROGRESS: there is no code check to finish' using errcode = '42501';
  end if;
  if p_ok then
    update public.recipient_auth x
       set failed_attempts = 0, pending_checks = greatest(x.pending_checks - 1, 0), last_passed_at = now(), locked_until = null,
           lockouts = x.lockouts - case when a.locked_until is not null then 1 else 0 end
     where x.recipient_id = v_rcp.id;
    perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'check_passed',
      jsonb_build_object('check', 'access_code'), p_ip, p_user_agent);
    return query select 'ok'::text, 5, null::timestamptz;
    return;
  end if;
  update public.recipient_auth x set pending_checks = greatest(x.pending_checks - 1, 0) where x.recipient_id = v_rcp.id;
  -- the lock is announced only by the last check still running: an earlier one cannot know yet whether the
  -- fifth try, which set the lock in advance, will turn out to be right
  perform app_private.auth_note_failure(v_rcp, 'access_code', a.failed_attempts, case when a.pending_checks = 1 then a.locked_until end, p_ip, p_user_agent);
  return query select case when a.locked_until is not null then 'locked' else 'wrong' end, 5 - a.failed_attempts, a.locked_until;
end
$$;

create function app_private.recipient_sender_no_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.is_sender and not coalesce(old.is_sender, false) and new.auth_method <> 'link' then
    new.auth_method := 'link';
    new.access_code_hash := null;
  end if;
  return new;
end
$$;
create trigger recipients_sender_no_check before update of is_sender on public.recipients
  for each row execute function app_private.recipient_sender_no_check();

do $$
declare fn text;
begin
  revoke all on function app_private.recipient_sender_no_check(), app_private.require_signer(uuid)
    from public, anon, authenticated, service_role;
  foreach fn in array array[
    'public.process_due(timestamptz)',
    'public.admin_set_suspension(uuid, uuid, boolean, text)',
    'public.claim_outbox(int, int)',
    'public.signer_request_otp(uuid, inet, text)',
    'public.signer_auth_begin(uuid)',
    'public.signer_auth_finish(uuid, boolean, inet, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- down (manual): re-run process_due from migration 13, admin_set_suspension, claim_outbox and require_signer from
-- migration 17, signer_request_otp, signer_auth_begin and signer_auth_finish from migration 15; then
-- drop trigger recipients_sender_no_check on public.recipients; drop function app_private.recipient_sender_no_check();
-- alter table public.recipient_auth drop column pending_since;
