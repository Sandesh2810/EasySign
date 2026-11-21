-- D-86 (Phase 4 slice 10, AT4.7): in-person signing on the host's device.
-- The host (the sender, or a teammate who may handle the document) starts a session for an in-person signer whose
-- turn it is and chooses a PIN. The session gets its own short-lived link record; the signer signs on the host's device.
-- The screen locks after inactivity (and the database refuses every signer action while locked); only the host's PIN
-- unlocks it or ends it; 5 wrong PINs end it. While a host has a session open, their own account pages ask for the PIN.
-- An in-person signer is never emailed and can never sign through a link.

create table public.in_person_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  envelope_id uuid not null references public.envelopes (id) on delete cascade,
  recipient_id uuid not null references public.recipients (id) on delete cascade,
  host_user_id uuid not null references auth.users (id) on delete cascade,
  host_name text not null check (char_length(host_name) between 1 and 200),
  host_email text not null check (char_length(host_email) between 3 and 320),
  token_id uuid not null unique references public.recipient_tokens (id) on delete cascade,
  pin_hash text not null check (char_length(pin_hash) between 20 and 300),
  started_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  locked_at timestamptz,
  wrong_pins int not null default 0 check (wrong_pins between 0 and 10),
  ended_at timestamptz,
  end_reason text check (end_reason in ('finished', 'host_returned', 'wrong_pin', 'signed_out', 'replaced', 'expired')),
  check ((ended_at is null) = (end_reason is null))
);
create index in_person_sessions_host_open_idx on public.in_person_sessions (host_user_id) where ended_at is null;
create index in_person_sessions_recipient_idx on public.in_person_sessions (recipient_id, started_at desc);
create index in_person_sessions_envelope_idx on public.in_person_sessions (envelope_id);
alter table public.in_person_sessions enable row level security;
create policy in_person_sessions_deny_all on public.in_person_sessions for all to anon, authenticated using (false) with check (false);
revoke all on public.in_person_sessions from anon, authenticated;
grant select, insert, update, delete on public.in_person_sessions to service_role;

-- ends a session: records why, revokes its link, writes the audit event
create function app_private.in_person_close(p_session public.in_person_sessions, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.in_person_sessions s set ended_at = now(), end_reason = p_reason where s.id = p_session.id and s.ended_at is null;
  if not found then return; end if;
  update public.recipient_tokens k set revoked_at = now() where k.id = p_session.token_id and k.revoked_at is null;
  perform app_private.audit_append('env:' || p_session.envelope_id::text, p_session.org_id, p_session.envelope_id, p_session.recipient_id,
    'user', p_session.host_user_id, 'in_person_ended', jsonb_build_object('session_id', p_session.id, 'reason', p_reason, 'host_name', p_session.host_name));
end
$$;
revoke all on function app_private.in_person_close(public.in_person_sessions, text) from public, anon, authenticated, service_role;

-- ---------- start ----------
create function public.start_in_person(p_actor uuid, p_envelope_id uuid, p_recipient_id uuid, p_token_id uuid, p_nonce text,
                                       p_token_sha256 text, p_pin_hash text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_rcp public.recipients;
  v_name text;
  v_email text;
  v_old public.in_person_sessions;
  v_id uuid;
begin
  select * into v_env from public.envelopes e where e.id = p_envelope_id for update;
  if not found or p_actor is null or not app_private.may_handle_envelope(p_actor, v_env.org_id, v_env.sender_id, 'member') then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  perform app_private.require_not_suspended(p_actor, v_env.org_id);
  if v_env.status not in ('sent', 'in_progress') then
    raise exception 'ES_NOT_OPEN: this document is not open for signing' using errcode = '22023';
  end if;
  if app_private.sender_on_hold(p_envelope_id) then
    raise exception 'ES_ON_HOLD: this document is on hold and cannot be signed right now' using errcode = '42501';
  end if;
  select * into v_rcp from public.recipients x where x.id = p_recipient_id and x.envelope_id = p_envelope_id for update;
  if not found or v_rcp.role <> 'in_person' or v_rcp.is_sender then
    raise exception 'ES_NOT_IN_PERSON: this person does not sign in person' using errcode = '22023';
  end if;
  if v_rcp.status in ('signed', 'declined', 'expired', 'skipped') then
    raise exception 'ES_ALREADY_DONE: this person has already finished' using errcode = '22023';
  end if;
  if v_rcp.status = 'created' or v_rcp.routing_order is distinct from app_private.routing_active_order(p_envelope_id) then
    raise exception 'ES_NOT_YOUR_TURN: it is not this person''s turn yet' using errcode = '22023';
  end if;
  if p_pin_hash is null or char_length(p_pin_hash) not between 20 and 300 or p_nonce !~ '^[0-9a-f]{32,128}$' or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid session details' using errcode = '22023';
  end if;
  v_email := app_private.user_email(p_actor);
  select coalesce(nullif(btrim(p.display_name), ''), v_email) into v_name from public.profiles p where p.id = p_actor;
  v_name := left(coalesce(v_name, v_email, 'Host'), 200);
  -- one place, one device: an open session for this person, or of this host, is ended first
  for v_old in select * from public.in_person_sessions s
                where s.ended_at is null and (s.recipient_id = p_recipient_id or s.host_user_id = p_actor) for update loop
    perform app_private.in_person_close(v_old, 'replaced');
  end loop;
  -- the link made at sending is never shown or emailed for an in-person signer; it is retired here
  update public.recipient_tokens k set revoked_at = now() where k.recipient_id = p_recipient_id and k.revoked_at is null;
  insert into public.recipient_tokens (id, org_id, envelope_id, recipient_id, nonce, token_sha256, expires_at)
    values (p_token_id, v_env.org_id, p_envelope_id, p_recipient_id, decode(p_nonce, 'hex'), decode(p_token_sha256, 'hex'),
            least(coalesce(v_env.expires_at, now() + interval '2 hours'), now() + interval '2 hours'));
  insert into public.in_person_sessions (org_id, envelope_id, recipient_id, host_user_id, host_name, host_email, token_id, pin_hash)
    values (v_env.org_id, p_envelope_id, p_recipient_id, p_actor, v_name, coalesce(v_email, 'unknown'), p_token_id, p_pin_hash)
    returning id into v_id;
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, p_recipient_id, 'user', p_actor, 'in_person_started',
    jsonb_build_object('session_id', v_id, 'host_name', v_name, 'host_email_sha256', encode(sha256(convert_to(lower(coalesce(v_email, '')), 'UTF8')), 'hex')));
  return v_id;
end
$$;

-- ---------- the signer's device: state on every request (keeps it alive, or locks it after 5 idle minutes) ----------
create function public.in_person_touch(p_token_id uuid)
returns table (session_id uuid, envelope_id uuid, host_name text, state text)
language plpgsql security definer set search_path = '' as $$
declare
  s public.in_person_sessions;
begin
  select * into s from public.in_person_sessions x where x.token_id = p_token_id for update;
  if not found then return; end if;
  if s.ended_at is null and s.started_at < now() - interval '2 hours' then
    perform app_private.in_person_close(s, 'expired');
    s.ended_at := now();
  end if;
  if s.ended_at is null and s.locked_at is null and s.last_active_at < now() - interval '5 minutes' then
    update public.in_person_sessions x set locked_at = now() where x.id = s.id;
    s.locked_at := now();
    perform app_private.audit_append('env:' || s.envelope_id::text, s.org_id, s.envelope_id, s.recipient_id, 'system', null, 'in_person_locked',
      jsonb_build_object('session_id', s.id, 'reason', 'inactive'));
  elsif s.ended_at is null and s.locked_at is null then
    update public.in_person_sessions x set last_active_at = now() where x.id = s.id;
  end if;
  return query select s.id, s.envelope_id, s.host_name,
    case when s.ended_at is not null then 'ended' when s.locked_at is not null then 'locked' else 'active' end;
end
$$;

-- the screen's own lock (after 3 quiet minutes, or the signer's "Lock now")
create function public.in_person_lock(p_token_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.in_person_sessions;
begin
  if p_reason not in ('inactive', 'manual') then
    raise exception 'invalid reason' using errcode = '22023';
  end if;
  select * into s from public.in_person_sessions x where x.token_id = p_token_id for update;
  if not found or s.ended_at is not null or s.locked_at is not null then return; end if;
  update public.in_person_sessions x set locked_at = now() where x.id = s.id;
  perform app_private.audit_append('env:' || s.envelope_id::text, s.org_id, s.envelope_id, s.recipient_id, 'system', null, 'in_person_locked',
    jsonb_build_object('session_id', s.id, 'reason', p_reason));
end
$$;

-- the host's PIN on the signer's device: 'unlock' (back to signing) or 'end' (hand back; ends the session).
-- The PIN itself is checked by the server against pin_hash; this records the outcome. 5 wrong PINs end the session.
create function public.in_person_pin(p_token_id uuid, p_ok boolean, p_action text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  s public.in_person_sessions;
  v_done boolean;
begin
  if p_action not in ('unlock', 'end') or p_ok is null then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  select * into s from public.in_person_sessions x where x.token_id = p_token_id for update;
  if not found or s.ended_at is not null then return 'ended'; end if;
  if not p_ok then
    update public.in_person_sessions x set wrong_pins = x.wrong_pins + 1 where x.id = s.id returning * into s;
    perform app_private.audit_append('env:' || s.envelope_id::text, s.org_id, s.envelope_id, s.recipient_id, 'system', null, 'in_person_wrong_pin',
      jsonb_build_object('session_id', s.id, 'count', s.wrong_pins));
    if s.wrong_pins >= 5 then
      perform app_private.in_person_close(s, 'wrong_pin');
      return 'ended';
    end if;
    return 'wrong';
  end if;
  if p_action = 'unlock' then
    update public.in_person_sessions x set locked_at = null, last_active_at = now(), wrong_pins = 0 where x.id = s.id;
    if s.locked_at is not null then
      perform app_private.audit_append('env:' || s.envelope_id::text, s.org_id, s.envelope_id, s.recipient_id, 'user', s.host_user_id, 'in_person_unlocked',
        jsonb_build_object('session_id', s.id));
    end if;
    return 'unlocked';
  end if;
  select x.status in ('signed', 'approved') into v_done from public.recipients x where x.id = s.recipient_id;
  perform app_private.in_person_close(s, case when v_done then 'finished' else 'host_returned' end);
  return 'ended';
end
$$;

-- ---------- the host's account ----------
-- open sessions of this host (expired ones are closed on the way); the app asks for the PIN while one is open
create function public.in_person_host_open(p_actor uuid)
returns table (session_id uuid, envelope_id uuid, title text, signer_name text, pin_hash text, started_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  s public.in_person_sessions;
begin
  for s in select * from public.in_person_sessions x where x.host_user_id = p_actor and x.ended_at is null
            and (x.started_at < now() - interval '2 hours'
                 or exists (select 1 from public.recipient_tokens k where k.id = x.token_id and (k.revoked_at is not null or k.expires_at <= now()))) for update loop
    perform app_private.in_person_close(s, 'expired');
  end loop;
  return query
    select x.id, x.envelope_id, e.title, r.name, x.pin_hash, x.started_at
      from public.in_person_sessions x join public.envelopes e on e.id = x.envelope_id join public.recipients r on r.id = x.recipient_id
     where x.host_user_id = p_actor and x.ended_at is null
     order by x.started_at desc;
end
$$;

-- the host returns to their account: with the right PIN the session ends ('host_returned', or 'finished' if the
-- person had signed); 5 wrong PINs end it too. Signing out ends every open session of the host without a PIN.
create function public.in_person_host_end(p_actor uuid, p_session_id uuid, p_ok boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  s public.in_person_sessions;
  v_done boolean;
begin
  select * into s from public.in_person_sessions x where x.id = p_session_id and x.host_user_id = p_actor for update;
  if not found or s.ended_at is not null then return 'ended'; end if;
  if not coalesce(p_ok, false) then
    update public.in_person_sessions x set wrong_pins = x.wrong_pins + 1 where x.id = s.id returning * into s;
    perform app_private.audit_append('env:' || s.envelope_id::text, s.org_id, s.envelope_id, s.recipient_id, 'user', p_actor, 'in_person_wrong_pin',
      jsonb_build_object('session_id', s.id, 'count', s.wrong_pins, 'where', 'host account'));
    if s.wrong_pins >= 5 then
      perform app_private.in_person_close(s, 'wrong_pin');
      return 'ended';
    end if;
    return 'wrong';
  end if;
  select x.status in ('signed', 'approved') into v_done from public.recipients x where x.id = s.recipient_id;
  perform app_private.in_person_close(s, case when v_done then 'finished' else 'host_returned' end);
  return 'ended';
end
$$;

create function public.in_person_end_for_host(p_actor uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  s public.in_person_sessions;
  n int := 0;
begin
  for s in select * from public.in_person_sessions x where x.host_user_id = p_actor and x.ended_at is null for update loop
    perform app_private.in_person_close(s, 'signed_out');
    n := n + 1;
  end loop;
  return n;
end
$$;

-- ---------- every signer action: in-person links only while the session is open (copy of the applied version plus D-86) ----------
create or replace function app_private.require_signer(p_token_id uuid) returns public.recipients
language plpgsql security definer set search_path = '' as $$
declare
  v_tok public.recipient_tokens;
  v_rcp public.recipients;
  v_status text;
  v_ips public.in_person_sessions;
begin
  select * into v_tok from public.recipient_tokens k where k.id = p_token_id;
  if not found or v_tok.revoked_at is not null or v_tok.expires_at <= now() then
    raise exception 'ES_LINK_INVALID: this link is no longer valid' using errcode = '42501';
  end if;
  -- D-86: a link made for an in-person session works only while that session is open, unlocked and in use
  -- (5 minutes without any activity locks it, as does the screen's own lock after 3 minutes)
  select * into v_ips from public.in_person_sessions s where s.token_id = p_token_id;
  if v_ips.id is not null then
    if v_ips.ended_at is not null then
      raise exception 'ES_LINK_INVALID: this in-person signing has ended' using errcode = '42501';
    end if;
    if v_ips.locked_at is not null or v_ips.last_active_at < now() - interval '5 minutes' then
      raise exception 'ES_IN_PERSON_LOCKED: the screen is locked; hand the device to the host to unlock it' using errcode = '42501';
    end if;
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
  if v_rcp.status = 'skipped' and v_rcp.group_completed_by is not null then   -- D-81
    raise exception 'ES_GROUP_DONE: % has already signed for your signing group; nothing more is needed from you',
      (select x.name from public.recipients x where x.id = v_rcp.group_completed_by) using errcode = '42501';
  end if;
  if v_rcp.role = 'in_person' and v_ips.id is null then   -- D-86: never through a link
    raise exception 'ES_IN_PERSON_ONLY: this person signs in person on the host''s device, not through a link' using errcode = '42501';
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

-- ---------- turns: no email for in-person signers; the sender is told instead (copy of the applied version plus D-86) ----------
create or replace function app_private.routing_advance(p_envelope_id uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_active int;
  v_sender_email text;
  v_count int := 0;
  v_kind text;
  r public.recipients;
begin
  select * into v_env from public.envelopes e where e.id = p_envelope_id;
  v_active := app_private.routing_active_order(p_envelope_id);
  if v_active is null or v_env.status not in ('sent', 'in_progress') then
    return 0;
  end if;
  v_sender_email := coalesce(app_private.user_email(v_env.sender_id), '');
  for r in select * from public.recipients x
            where x.envelope_id = p_envelope_id and x.status = 'created'
              and ((x.role in ('signer', 'in_person', 'approver') and x.routing_order = v_active) or (x.role = 'viewer' and x.routing_order <= v_active))
            order by x.routing_order, x.created_at, x.id
            for update loop
    perform app_private.sanction();
    update public.recipients x set status = 'sent', sent_at = now() where x.id = r.id;
    perform set_config('easysign.sanctioned', '', true);
    v_count := v_count + 1;
    perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, r.id, 'system', null, 'recipient_activated',
      jsonb_build_object('role', r.role, 'order', r.routing_order));
    if r.role = 'in_person' then
      -- D-86: an in-person signer gets no email and no link; the sender is told it is their turn
      insert into public.notifications (org_id, user_id, kind, payload)
        values (v_env.org_id, v_env.sender_id, 'in_person_turn', jsonb_build_object('envelope_id', p_envelope_id, 'title', v_env.title, 'by', r.name));
    elsif v_env.delivery = 'email' and lower(r.email) <> v_sender_email then
      v_kind := case r.role when 'approver' then 'approval_request' when 'viewer' then 'view_notice' else 'signature_request' end;
      insert into public.notification_outbox (org_id, envelope_id, recipient_id, sender_user_id, kind, priority, idempotency_key)
        values (v_env.org_id, p_envelope_id, r.id, v_env.sender_id, v_kind, case r.role when 'viewer' then 'P2' else 'P0_REQUEST' end, 'request:' || r.id::text || ':1')
        on conflict (idempotency_key) do nothing;
      perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, r.id, 'system', null, 'email_queued',
        jsonb_build_object('kind', v_kind));
    end if;
  end loop;
  return v_count;
end
$$;

-- ---------- reminders: none for in-person signers (copy of the applied version plus D-86) ----------
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
              and x.role in ('signer', 'approver') and x.status in ('sent', 'viewed', 'consented')   -- D-86: no reminders for in-person signers
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

-- ---------- server only ----------
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.start_in_person(uuid, uuid, uuid, uuid, text, text, text)',
    'public.in_person_touch(uuid)',
    'public.in_person_lock(uuid, text)',
    'public.in_person_pin(uuid, boolean, text)',
    'public.in_person_host_open(uuid)',
    'public.in_person_host_end(uuid, uuid, boolean)',
    'public.in_person_end_for_host(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- down:
-- restore app_private.require_signer from 20261121005244_signing_groups.sql, app_private.routing_advance from
-- 20261118160949_multi_party_routing.sql (as "create or replace") and public.process_due from 20261119082916_review_fixes.sql;
-- drop function public.in_person_end_for_host(uuid); drop function public.in_person_host_end(uuid, uuid, boolean);
-- drop function public.in_person_host_open(uuid); drop function public.in_person_pin(uuid, boolean, text);
-- drop function public.in_person_lock(uuid, text); drop function public.in_person_touch(uuid);
-- drop function public.start_in_person(uuid, uuid, uuid, uuid, text, text, text);
-- drop function app_private.in_person_close(public.in_person_sessions, text); drop table public.in_person_sessions;
