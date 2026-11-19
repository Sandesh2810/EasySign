-- EasySign Phase 2 / migration 15: an extra identity check before a signing link opens anything (slice 7, AT2.7).
-- Two optional checks per person, chosen by the sender while the document is a draft:
--   access code  - the sender invents it and gives it to the person separately. Only a slow salted hash
--                  (scrypt, computed by the app) is stored; the code itself is never stored or emailed.
--   emailed code - six digits sent to the person's own email address on request, valid 10 minutes, usable once.
--                  The background worker creates the code at the moment it sends the email; the database only
--                  ever holds a keyed hash of it (DECISIONS D-21).
-- Wrong tries are counted per person. Five wrong tries lock the link: 15 minutes the first time, an hour the
-- second time, and after that until the sender unlocks it. All functions are server-only (service role).

create table public.recipient_auth (
  recipient_id uuid primary key references public.recipients (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete restrict,
  envelope_id uuid not null references public.envelopes (id) on delete cascade,
  failed_attempts int not null default 0 check (failed_attempts between 0 and 5),
  pending_checks int not null default 0 check (pending_checks >= 0),
  lockouts int not null default 0 check (lockouts >= 0),
  locked_until timestamptz,
  otp_hash bytea check (otp_hash is null or octet_length(otp_hash) = 32),
  otp_expires_at timestamptz,
  otp_requested_at timestamptz,
  otp_requests int not null default 0,
  last_passed_at timestamptz,
  created_at timestamptz not null default now()
);
create index recipient_auth_org_idx on public.recipient_auth (org_id);
create index recipient_auth_envelope_idx on public.recipient_auth (envelope_id);
alter table public.recipient_auth enable row level security;   -- no policies: nobody but the server reads it
revoke all on public.recipient_auth from public, anon, authenticated;

alter table public.recipients add constraint recipients_access_code_needs_hash
  check (auth_method <> 'access_code' or access_code_hash is not null);
alter table public.recipients add constraint recipients_access_code_hash_shape
  check (access_code_hash is null or (char_length(access_code_hash) <= 200
         and access_code_hash ~ '^scrypt\$[0-9]{4,7}\$[0-9]{1,2}\$[0-9]{1,2}\$[A-Za-z0-9_-]{22,44}\$[A-Za-z0-9_-]{43,86}$'));

-- A new link (after a corrected email address) starts with a clean slate: no counters, no lock, no code,
-- and a code email still waiting for the old address is cancelled.
create function app_private.recipient_auth_reset() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.recipient_auth a where a.recipient_id = new.recipient_id;
  update public.notification_outbox o set status = 'dead', locked_until = null, last_error = 'cancelled: the link was replaced'
   where o.recipient_id = new.recipient_id and o.kind = 'otp' and o.status in ('queued', 'deferred');
  return null;
end
$$;
create trigger recipient_tokens_reset_auth after insert on public.recipient_tokens
  for each row execute function app_private.recipient_auth_reset();

-- ---------------------------------------------------------------- the sender chooses the check (draft only)
create function public.set_recipient_auth(p_actor uuid, p_envelope_id uuid, p_recipient_id uuid, p_method text, p_access_code_hash text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_rcp public.recipients;
begin
  v_env := app_private.require_draft(p_actor, p_envelope_id);
  if p_method is null or p_method not in ('link', 'access_code', 'email_otp') then
    raise exception 'unknown kind of check' using errcode = '22023';
  end if;
  select * into v_rcp from public.recipients x where x.id = p_recipient_id and x.envelope_id = p_envelope_id for update;
  if not found then
    raise exception 'ES_NOT_FOUND: person not found on this document' using errcode = '42501';
  end if;
  if p_method <> 'link' and (v_rcp.role = 'cc' or v_rcp.is_sender) then
    raise exception 'ES_NO_CHECK_FOR_THIS_PERSON: an extra check cannot be set for someone who only gets a copy, or for yourself' using errcode = '22023';
  end if;
  if p_method = 'access_code' then
    if p_access_code_hash is null and (v_rcp.auth_method <> 'access_code' or v_rcp.access_code_hash is null) then
      raise exception 'ES_ACCESS_CODE_NEEDED: type an access code for this person' using errcode = '22023';
    end if;
    -- no new code given: the one already set stays
    update public.recipients x set auth_method = 'access_code', access_code_hash = coalesce(p_access_code_hash, x.access_code_hash) where x.id = p_recipient_id;
  else
    update public.recipients x set auth_method = p_method, access_code_hash = null where x.id = p_recipient_id;
  end if;
  if v_rcp.auth_method is distinct from p_method or (p_method = 'access_code' and p_access_code_hash is not null) then
    -- the audit trail says which check was chosen, never the code or its hash
    perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, p_recipient_id, 'user', p_actor, 'recipient_check_set',
      jsonb_build_object('check', p_method));
  end if;
  return p_method;
end
$$;

-- ---------------------------------------------------------------- shared pieces
-- The link must be live and the document open or completed. Locks the person's row, so everything
-- done through one link runs one step at a time.
create function app_private.signer_gate(p_token_id uuid) returns public.recipients
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
  select * into v_rcp from public.recipients x where x.id = v_tok.recipient_id for update;
  select e.status into v_status from public.envelopes e where e.id = v_tok.envelope_id;
  if v_status not in ('sent', 'in_progress', 'completed') then
    raise exception 'ES_LINK_INVALID: this document is no longer open' using errcode = '42501';
  end if;
  return v_rcp;
end
$$;

-- How long the n-th lockout lasts (n counts earlier lockouts): 15 minutes, 1 hour, then until the sender unlocks.
create function app_private.auth_lock_until(p_earlier_lockouts int) returns timestamptz
language sql stable set search_path = '' as $$
  select case when p_earlier_lockouts <= 0 then now() + interval '15 minutes'
              when p_earlier_lockouts = 1 then now() + interval '1 hour'
              else 'infinity'::timestamptz end
$$;

-- Writes the audit events for a wrong try and, when it locked the link, tells the sender in the app.
create function app_private.auth_note_failure(p_rcp public.recipients, p_method text, p_attempt int, p_locked_until timestamptz, p_ip inet, p_user_agent text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
begin
  select * into v_env from public.envelopes e where e.id = p_rcp.envelope_id;
  perform app_private.audit_append('env:' || v_env.id::text, v_env.org_id, v_env.id, p_rcp.id, 'signer', null, 'check_failed',
    jsonb_build_object('check', p_method, 'attempt', p_attempt), p_ip, p_user_agent);
  if p_locked_until is not null then
    perform app_private.audit_append('env:' || v_env.id::text, v_env.org_id, v_env.id, p_rcp.id, 'system', null, 'link_locked',
      jsonb_build_object('check', p_method, 'until_sender_unlocks', p_locked_until = 'infinity'::timestamptz), p_ip, p_user_agent);
    insert into public.notifications (org_id, user_id, kind, payload)
      values (v_env.org_id, v_env.sender_id, 'signer_locked',
              jsonb_build_object('envelope_id', v_env.id, 'title', v_env.title, 'by', p_rcp.name, 'needs_sender', p_locked_until = 'infinity'::timestamptz));
  end if;
end
$$;

-- ---------------------------------------------------------------- what the signer's screen needs to know
create function public.signer_auth_state(p_token_id uuid)
returns table (method text, locked_until timestamptz, attempts_left int, otp_status text, otp_expires_at timestamptz, can_request_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  a public.recipient_auth;
  v_out text;
begin
  v_rcp := app_private.signer_gate(p_token_id);
  select * into a from public.recipient_auth x where x.recipient_id = v_rcp.id;
  -- the email that belongs to the latest request made through this very link
  if a.otp_requests > 0 then
    select o.status into v_out from public.notification_outbox o where o.idempotency_key = 'otp:' || p_token_id::text || ':' || a.otp_requests::text;
  end if;
  return query select
    v_rcp.auth_method,
    case when a.locked_until > now() then a.locked_until end,
    case when a.locked_until > now() then 0 when a.locked_until is not null then 5 else 5 - coalesce(a.failed_attempts, 0) end,
    case when v_rcp.auth_method <> 'email_otp' or v_out is null then 'none'
         when v_out in ('queued', 'sending') then 'sending'
         when v_out = 'deferred' then 'delayed'
         when v_out = 'sent' and a.otp_hash is not null and a.otp_expires_at > now() then 'sent'
         when v_out in ('failed', 'dead') then 'failed'
         else 'none' end,
    case when a.otp_hash is not null and a.otp_expires_at > now() then a.otp_expires_at end,
    case when a.otp_requested_at is not null and a.otp_requested_at + interval '60 seconds' > now() then a.otp_requested_at + interval '60 seconds' end;
end
$$;

-- ---------------------------------------------------------------- access code: two steps around the slow hash
-- Step 1 hands the stored hash to the app and counts the try BEFORE the answer is known, under a row lock,
-- so many guesses sent at the same moment still get five tries in total, not five each.
create function public.signer_auth_begin(p_token_id uuid)
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
  if a.locked_until is not null and a.locked_until > now() then
    return query select 'locked'::text, null::text, a.locked_until;
    return;
  end if;
  if a.locked_until is not null then   -- an earlier lock has run out: the count starts again
    a.failed_attempts := 0;
  end if;
  update public.recipient_auth x
     set failed_attempts = a.failed_attempts + 1, pending_checks = x.pending_checks + 1,
         locked_until = case when a.failed_attempts + 1 >= 5 then app_private.auth_lock_until(x.lockouts) end,
         lockouts = x.lockouts + case when a.failed_attempts + 1 >= 5 then 1 else 0 end
   where x.recipient_id = v_rcp.id;
  return query select 'check'::text, v_rcp.access_code_hash, null::timestamptz;
end
$$;

-- Step 2: the app reports whether the code matched. A match wipes the count (and the lock a fifth try set in
-- advance); a miss leaves the count as step 1 set it and is written to the audit trail.
create function public.signer_auth_finish(p_token_id uuid, p_ok boolean, p_ip inet, p_user_agent text)
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
       set failed_attempts = 0, pending_checks = x.pending_checks - 1, last_passed_at = now(), locked_until = null,
           lockouts = x.lockouts - case when a.locked_until is not null then 1 else 0 end
     where x.recipient_id = v_rcp.id;
    perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'check_passed',
      jsonb_build_object('check', 'access_code'), p_ip, p_user_agent);
    return query select 'ok'::text, 5, null::timestamptz;
    return;
  end if;
  update public.recipient_auth x set pending_checks = x.pending_checks - 1 where x.recipient_id = v_rcp.id;
  -- the lock is announced only by the last check still running: an earlier one cannot know yet whether the
  -- fifth try, which set the lock in advance, will turn out to be right
  perform app_private.auth_note_failure(v_rcp, 'access_code', a.failed_attempts, case when a.pending_checks = 1 then a.locked_until end, p_ip, p_user_agent);
  return query select case when a.locked_until is not null then 'locked' else 'wrong' end, 5 - a.failed_attempts, a.locked_until;
end
$$;

-- ---------------------------------------------------------------- emailed code
-- Asks for a code. The code does not exist yet: the worker makes it when it sends the email.
-- Not more often than once a minute, and at most five codes an hour, per person.
create function public.signer_request_otp(p_token_id uuid, p_ip inet, p_user_agent text)
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
  -- a new request cancels the previous code at once
  update public.recipient_auth x set otp_hash = null, otp_expires_at = null, otp_requested_at = now(), otp_requests = x.otp_requests + 1
   where x.recipient_id = v_rcp.id returning * into a;
  insert into public.notification_outbox (org_id, envelope_id, recipient_id, kind, priority, idempotency_key)
    values (v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'otp', 'P0_AUTH', 'otp:' || p_token_id::text || ':' || a.otp_requests::text);
  perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'code_requested',
    jsonb_build_object('number', a.otp_requests), p_ip, p_user_agent);
  return query select 'queued'::text, now() + interval '60 seconds';
end
$$;

-- Called by the worker just before it sends the email. Refuses a request that is stale (older than ten
-- minutes), that a newer request has replaced, or that was made through a link that is no longer live,
-- so an old email can never carry a working code.
create function public.signer_store_otp(p_outbox_id uuid, p_otp_hash bytea) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  o public.notification_outbox;
  a public.recipient_auth;
begin
  if p_otp_hash is null or octet_length(p_otp_hash) <> 32 then
    raise exception 'invalid code hash' using errcode = '22023';
  end if;
  select * into o from public.notification_outbox x where x.id = p_outbox_id and x.kind = 'otp' and x.status = 'sending';
  if not found or o.created_at <= now() - interval '10 minutes' then
    return false;
  end if;
  select * into a from public.recipient_auth x where x.recipient_id = o.recipient_id for update;
  if not found or (a.locked_until is not null and a.locked_until > now())
     or not exists (select 1 from public.recipient_tokens k
                     where k.recipient_id = o.recipient_id and k.revoked_at is null and k.expires_at > now()
                       and o.idempotency_key = 'otp:' || k.id::text || ':' || a.otp_requests::text) then
    return false;
  end if;
  update public.recipient_auth x set otp_hash = p_otp_hash, otp_expires_at = now() + interval '10 minutes' where x.recipient_id = o.recipient_id;
  return true;
end
$$;

-- One step: the app sends the keyed hash of what the person typed. Usable once; five wrong tries lock the link.
create function public.signer_verify_otp(p_token_id uuid, p_otp_hash bytea, p_ip inet, p_user_agent text)
returns table (status text, attempts_left int, locked_until timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  a public.recipient_auth;
  v_lock timestamptz;
begin
  v_rcp := app_private.signer_gate(p_token_id);
  if v_rcp.auth_method <> 'email_otp' then
    raise exception 'ES_NO_SUCH_CHECK: this link does not use an emailed code' using errcode = '22023';
  end if;
  if p_otp_hash is null or octet_length(p_otp_hash) <> 32 then
    raise exception 'invalid code hash' using errcode = '22023';
  end if;
  insert into public.recipient_auth (recipient_id, org_id, envelope_id) values (v_rcp.id, v_rcp.org_id, v_rcp.envelope_id) on conflict do nothing;
  select * into a from public.recipient_auth x where x.recipient_id = v_rcp.id for update;
  if a.locked_until is not null and a.locked_until > now() then
    return query select 'locked'::text, 0, a.locked_until;
    return;
  end if;
  if a.locked_until is not null then
    a.failed_attempts := 0;
  end if;
  -- no code to compare with: nothing is counted
  if a.otp_hash is null or a.otp_expires_at is null or a.otp_expires_at <= now() then
    update public.recipient_auth x set otp_hash = null, otp_expires_at = null, failed_attempts = a.failed_attempts, locked_until = null where x.recipient_id = v_rcp.id;
    return query select 'expired'::text, 5 - a.failed_attempts, null::timestamptz;
    return;
  end if;
  if a.otp_hash = p_otp_hash then
    update public.recipient_auth x
       set otp_hash = null, otp_expires_at = null, failed_attempts = 0, locked_until = null, last_passed_at = now()
     where x.recipient_id = v_rcp.id;
    perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'check_passed',
      jsonb_build_object('check', 'email_otp'), p_ip, p_user_agent);
    return query select 'ok'::text, 5, null::timestamptz;
    return;
  end if;
  if a.failed_attempts + 1 >= 5 then
    v_lock := app_private.auth_lock_until(a.lockouts);
  end if;
  -- a lock also destroys the code that was being guessed
  update public.recipient_auth x
     set failed_attempts = a.failed_attempts + 1, locked_until = v_lock,
         lockouts = x.lockouts + case when v_lock is not null then 1 else 0 end,
         otp_hash = case when v_lock is not null then null else x.otp_hash end,
         otp_expires_at = case when v_lock is not null then null else x.otp_expires_at end
   where x.recipient_id = v_rcp.id;
  perform app_private.auth_note_failure(v_rcp, 'email_otp', a.failed_attempts + 1, v_lock, p_ip, p_user_agent);
  return query select case when v_lock is not null then 'locked' else 'wrong' end, 5 - (a.failed_attempts + 1), v_lock;
end
$$;

-- ---------------------------------------------------------------- the sender lifts a lock
create function public.unlock_recipient_auth(p_actor uuid, p_envelope_id uuid, p_recipient_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_was_locked boolean;
begin
  v_env := app_private.require_open_envelope(p_actor, p_envelope_id);
  if not exists (select 1 from public.recipients x where x.id = p_recipient_id and x.envelope_id = p_envelope_id) then
    raise exception 'ES_NOT_FOUND: person not found on this document' using errcode = '42501';
  end if;
  select (a.locked_until is not null and a.locked_until > now()) into v_was_locked from public.recipient_auth a where a.recipient_id = p_recipient_id for update;
  if not coalesce(v_was_locked, false) then
    return false;
  end if;
  update public.recipient_auth a
     set failed_attempts = 0, pending_checks = 0, lockouts = 0, locked_until = null, otp_hash = null, otp_expires_at = null
   where a.recipient_id = p_recipient_id;
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, p_recipient_id, 'user', p_actor, 'link_unlocked', '{}'::jsonb);
  return true;
end
$$;

do $$
declare fn text;
begin
  revoke all on function app_private.recipient_auth_reset(), app_private.signer_gate(uuid), app_private.auth_lock_until(int),
    app_private.auth_note_failure(public.recipients, text, int, timestamptz, inet, text)
    from public, anon, authenticated, service_role;
  foreach fn in array array[
    'public.set_recipient_auth(uuid, uuid, uuid, text, text)',
    'public.signer_auth_state(uuid)',
    'public.signer_auth_begin(uuid)',
    'public.signer_auth_finish(uuid, boolean, inet, text)',
    'public.signer_request_otp(uuid, inet, text)',
    'public.signer_store_otp(uuid, bytea)',
    'public.signer_verify_otp(uuid, bytea, inet, text)',
    'public.unlock_recipient_auth(uuid, uuid, uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- down (manual):
-- drop function public.unlock_recipient_auth(uuid, uuid, uuid), public.signer_verify_otp(uuid, bytea, inet, text), public.signer_store_otp(uuid, bytea),
--   public.signer_request_otp(uuid, inet, text), public.signer_auth_finish(uuid, boolean, inet, text), public.signer_auth_begin(uuid),
--   public.signer_auth_state(uuid), public.set_recipient_auth(uuid, uuid, uuid, text, text);
-- drop function app_private.auth_note_failure(public.recipients, text, int, timestamptz, inet, text), app_private.auth_lock_until(int), app_private.signer_gate(uuid);
-- drop trigger recipient_tokens_reset_auth on public.recipient_tokens; drop function app_private.recipient_auth_reset();
-- alter table public.recipients drop constraint recipients_access_code_hash_shape, drop constraint recipients_access_code_needs_hash;
-- drop table public.recipient_auth;
