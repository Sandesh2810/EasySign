-- D-89 (Phase 4 slice 13, AT3.8/AT4.9): fixes from the independent security review (docs\SECURITY_REVIEW.md).
-- F1  an in-person session that ended without the host's PIN (signer declined, document voided or expired, 2 hours
--     passed, replaced, wrong PINs) no longer unlocks the host's account: only the PIN or signing out clears it.
-- F2  two-step sign-in now also protects direct reads and writes through the Data API: an extra restrictive rule on
--     every table signed-in users can reach requires an authenticator-verified session (aal2) from anyone who has
--     set up an authenticator.
-- F3  an in-person signer's link never leaves the host's device: it is not revealed ("Copy link"), a request cannot be
--     re-sent to them, and answers to questions are not emailed to them.
-- F9  creator-only access to a bulk batch or a public form ends when the creator leaves the workspace.

-- ---------- F1: in-person sessions must be cleared by the host ----------
alter table public.in_person_sessions add column host_cleared boolean not null default false;
-- sessions that ended before this rule existed stay as they were (unlocked)
update public.in_person_sessions s set host_cleared = true where s.ended_at is not null;

create or replace function app_private.in_person_close(p_session public.in_person_sessions, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- only the host's PIN (finished, host returned) or signing out clears the host's lock; any other ending keeps it
  update public.in_person_sessions s set ended_at = now(), end_reason = p_reason, host_cleared = (p_reason in ('finished', 'host_returned', 'signed_out'))
   where s.id = p_session.id and s.ended_at is null;
  if not found then return; end if;
  update public.recipient_tokens k set revoked_at = now() where k.id = p_session.token_id and k.revoked_at is null;
  perform app_private.audit_append('env:' || p_session.envelope_id::text, p_session.org_id, p_session.envelope_id, p_session.recipient_id,
    'user', p_session.host_user_id, 'in_person_ended', jsonb_build_object('session_id', p_session.id, 'reason', p_reason, 'host_name', p_session.host_name));
end
$$;

-- the host's sessions that still lock their account: open ones, and ended ones the host has not cleared with the PIN
drop function public.in_person_host_open(uuid);
create function public.in_person_host_open(p_actor uuid)
returns table (session_id uuid, envelope_id uuid, title text, signer_name text, pin_hash text, started_at timestamptz, ended boolean)
language plpgsql security definer set search_path = '' as $$
declare
  s public.in_person_sessions;
begin
  for s in select * from public.in_person_sessions x where x.host_user_id = p_actor and x.ended_at is null
            and (x.started_at < now() - interval '2 hours'
                 or exists (select 1 from public.recipient_tokens k where k.id = x.token_id and (k.revoked_at is not null or k.expires_at <= now()))) for update loop
    perform app_private.in_person_close(s, 'expired');   -- ends the signing, keeps the host's lock
  end loop;
  return query
    select x.id, x.envelope_id, e.title, r.name, x.pin_hash, x.started_at, x.ended_at is not null
      from public.in_person_sessions x join public.envelopes e on e.id = x.envelope_id join public.recipients r on r.id = x.recipient_id
     where x.host_user_id = p_actor and not x.host_cleared
     order by x.started_at desc;
end
$$;
revoke all on function public.in_person_host_open(uuid) from public, anon, authenticated;
grant execute on function public.in_person_host_open(uuid) to service_role;

-- the host returns with the PIN: an open session ends ('host_returned', or 'finished' once the person signed); an ended
-- one is cleared. 5 wrong PINs answer 'locked_out' (the app then signs the browser out, which clears the lock).
create or replace function public.in_person_host_end(p_actor uuid, p_session_id uuid, p_ok boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  s public.in_person_sessions;
  v_done boolean;
begin
  select * into s from public.in_person_sessions x where x.id = p_session_id and x.host_user_id = p_actor for update;
  if not found or s.host_cleared then return 'ended'; end if;
  if not coalesce(p_ok, false) then
    update public.in_person_sessions x set wrong_pins = least(x.wrong_pins + 1, 10) where x.id = s.id returning * into s;
    perform app_private.audit_append('env:' || s.envelope_id::text, s.org_id, s.envelope_id, s.recipient_id, 'user', p_actor, 'in_person_wrong_pin',
      jsonb_build_object('session_id', s.id, 'count', s.wrong_pins, 'where', 'host account'));
    if s.wrong_pins >= 5 then
      if s.ended_at is null then perform app_private.in_person_close(s, 'wrong_pin'); end if;
      return 'locked_out';
    end if;
    return 'wrong';
  end if;
  if s.ended_at is null then
    select x.status in ('signed', 'approved') into v_done from public.recipients x where x.id = s.recipient_id;
    perform app_private.in_person_close(s, case when v_done then 'finished' else 'host_returned' end);
  else
    update public.in_person_sessions x set host_cleared = true where x.id = s.id;
    perform app_private.audit_append('env:' || s.envelope_id::text, s.org_id, s.envelope_id, s.recipient_id, 'user', p_actor, 'in_person_host_returned',
      jsonb_build_object('session_id', s.id, 'ended_as', s.end_reason));
  end if;
  return 'ended';
end
$$;

-- signing out ends every open session of the host and clears every lock (a full sign-in is needed to come back)
create or replace function public.in_person_end_for_host(p_actor uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  s public.in_person_sessions;
  n int := 0;
begin
  for s in select * from public.in_person_sessions x where x.host_user_id = p_actor and x.ended_at is null for update loop
    perform app_private.in_person_close(s, 'signed_out');
    n := n + 1;
  end loop;
  update public.in_person_sessions x set host_cleared = true where x.host_user_id = p_actor and not x.host_cleared;
  return n;
end
$$;

-- ---------- F9: creator-only access needs an active membership ----------
create or replace function app_private.bulk_access(p_actor uuid, p_batch public.bulk_batches) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_actor is not null
    and ((p_batch.created_by = p_actor and app_private.member_role(p_actor, p_batch.org_id) is not null)
         or app_private.member_role(p_actor, p_batch.org_id) in ('owner', 'admin')), false)
$$;

create or replace function app_private.power_form_manage(p_actor uuid, p_form public.power_forms) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_actor is not null
    and ((p_form.created_by = p_actor and app_private.member_role(p_actor, p_form.org_id) is not null)
         or app_private.member_role(p_actor, p_form.org_id) in ('owner', 'admin')), false)
$$;

-- ---------- F2: two-step sign-in protects direct Data API access too ----------
-- true when this request's session has passed the authenticator check, or when the user has no authenticator
create function app_private.mfa_satisfied() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f where f.user_id = (select auth.uid()) and f.status = 'verified')
$$;
revoke all on function app_private.mfa_satisfied() from public, anon;
grant execute on function app_private.mfa_satisfied() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['account_controls', 'audit_archives', 'audit_events', 'consents', 'envelope_comments', 'envelope_documents',
    'envelopes', 'field_attachments', 'field_values', 'fields', 'filing_rules', 'folders', 'memberships', 'notifications', 'org_settings',
    'organizations', 'profiles', 'recipient_handoffs', 'recipients', 'scheduled_sends', 'seal_jobs', 'sender_tasks', 'signature_assets'] loop
    execute format('create policy %I on public.%I as restrictive for all to authenticated using ((select app_private.mfa_satisfied())) with check ((select app_private.mfa_satisfied()))',
      t || '_mfa', t);
  end loop;
end
$$;

-- ---------- F3: copies of the applied versions plus D-89 ----------
create or replace function public.reveal_signing_links(p_actor uuid, p_envelope_id uuid)
returns table (token_id uuid, nonce_hex text, recipient_name text, recipient_role text, recipient_order integer, recipient_status text)
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
begin
  if p_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  select * into v_env from public.envelopes e where e.id = p_envelope_id;
  if not found or not app_private.may_handle_envelope(p_actor, v_env.org_id, v_env.sender_id, 'member') then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  if exists (select 1 from public.account_controls c where c.user_id = p_actor and c.trust_level = 'suspended')
     or exists (select 1 from public.org_controls o where o.org_id = v_env.org_id and o.status = 'suspended') then
    raise exception 'ES_SUSPENDED: account suspended' using errcode = '42501';
  end if;
  if v_env.status not in ('sent', 'in_progress') then
    raise exception 'ES_NOT_OPEN: this document is not open for signing' using errcode = '42501';
  end if;
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'user', p_actor, 'link_revealed',
    jsonb_build_object('recipients', (select coalesce(jsonb_agg(k.recipient_id order by k.created_at), '[]'::jsonb)
                                        from public.recipient_tokens k join public.recipients x on x.id = k.recipient_id
                                       where k.envelope_id = p_envelope_id and k.revoked_at is null and x.role <> 'in_person')));
  return query
    select k.id, encode(k.nonce, 'hex'), x.name, x.role, x.routing_order, x.status
      from public.recipient_tokens k join public.recipients x on x.id = k.recipient_id
     where k.envelope_id = p_envelope_id and k.revoked_at is null
       and x.role <> 'in_person'   -- D-89 F3: an in-person signer's link never leaves the host's device
     order by x.routing_order, x.created_at;
end
$$;

create or replace function public.resend_request(p_actor uuid, p_envelope_id uuid, p_recipient_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_rcp public.recipients;
  v_count int;
  v_last timestamptz;
  v_kind text;
begin
  v_env := app_private.require_open_envelope(p_actor, p_envelope_id);
  select * into v_rcp from public.recipients x where x.id = p_recipient_id and x.envelope_id = p_envelope_id;
  if not found or v_rcp.role in ('cc', 'in_person') then   -- D-89 F3: no emailed link for an in-person signer
    raise exception 'ES_NOT_FOUND: that person is not waiting for a link on this document' using errcode = '42501';
  end if;
  if v_env.delivery <> 'email' then
    raise exception 'ES_LINK_DELIVERY: you chose to share the links yourself for this document. Copy the person''s link again instead' using errcode = '22023';
  end if;
  if v_rcp.status not in ('sent', 'viewed', 'consented') then
    raise exception 'ES_NOT_THEIR_TURN: a request can be sent again only to someone whose turn it is and who has not finished' using errcode = '22023';
  end if;
  if lower(v_rcp.email) = coalesce(app_private.user_email(v_env.sender_id), '') then
    raise exception 'ES_SELF: this person is you. Open your own signing link instead' using errcode = '22023';
  end if;
  select count(*), max(o.created_at) into v_count, v_last from public.notification_outbox o
   where o.recipient_id = p_recipient_id and o.kind in ('signature_request', 'approval_request', 'view_notice');
  if v_last is not null and v_last > now() - interval '10 minutes' then
    raise exception 'ES_TOO_SOON: a request went to this person a few minutes ago. Wait ten minutes before sending another' using errcode = '53400';
  end if;
  if v_count >= 6 then
    raise exception 'ES_RESEND_LIMIT: this person has already been sent the request six times' using errcode = '53400';
  end if;
  v_kind := case v_rcp.role when 'approver' then 'approval_request' when 'viewer' then 'view_notice' else 'signature_request' end;
  insert into public.notification_outbox (org_id, envelope_id, recipient_id, sender_user_id, kind, priority, idempotency_key)
    values (v_env.org_id, p_envelope_id, p_recipient_id, p_actor, v_kind, 'P1', 'request:' || p_recipient_id::text || ':' || (v_count + 1)::text);
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, p_recipient_id, 'user', p_actor, 'request_resent',
    jsonb_build_object('kind', v_kind, 'number', v_count + 1));
end
$$;

create or replace function public.sender_comment(p_actor uuid, p_envelope_id uuid, p_recipient_id uuid, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_rcp public.recipients;
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  v_env := app_private.require_open_envelope(p_actor, p_envelope_id);
  select * into v_rcp from public.recipients x where x.id = p_recipient_id and x.envelope_id = p_envelope_id;
  if not found or v_rcp.role not in ('signer', 'approver') then   -- D-89 F3: answers are emailed with a link; not to an in-person signer
    raise exception 'ES_NOT_FOUND: that person is not someone who signs or approves this document' using errcode = '42501';
  end if;
  if char_length(v_body) not between 1 and 1000 then
    raise exception 'ES_INVALID: write your answer (up to 1000 characters)' using errcode = '22023';
  end if;
  if (select count(*) from public.envelope_comments c where c.recipient_id = v_rcp.id) >= 100 then
    raise exception 'ES_LIMIT: this conversation is full' using errcode = '54000';
  end if;
  insert into public.envelope_comments (org_id, envelope_id, recipient_id, author_kind, author_user, body)
    values (v_env.org_id, p_envelope_id, v_rcp.id, 'sender', p_actor, v_body) returning id into v_id;
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, v_rcp.id, 'user', p_actor, 'comment_added',
    jsonb_build_object('comment_id', v_id, 'by', 'sender', 'body', v_body));
  -- the person is emailed the answer with their link, when the sender sends by email and they still have something to do
  if v_env.delivery = 'email' and lower(v_rcp.email) <> lower(coalesce(app_private.user_email(v_env.sender_id), ''))
     and v_rcp.status in ('sent', 'viewed', 'consented') then
    insert into public.notification_outbox (org_id, envelope_id, recipient_id, sender_user_id, kind, priority, payload, idempotency_key)
      values (v_env.org_id, p_envelope_id, v_rcp.id, p_actor, 'comment_reply', 'P1', jsonb_build_object('comment_id', v_id), 'comment:' || v_id::text);
  end if;
  return v_id;
end
$$;

-- down: restore in_person_close, in_person_host_open (old return type), in_person_host_end, in_person_end_for_host from
-- 20261121035734_in_person.sql; bulk_access from 20261121031928_bulk_access_fix.sql; power_form_manage from
-- 20261121065008_power_forms.sql; reveal_signing_links from 20261120191012_teams.sql; resend_request from
-- 20261118165013_void_resend_correct.sql; sender_comment from 20261121022730_answer_priority.sql; then
-- drop the 23 policies named <table>_mfa; drop function app_private.mfa_satisfied(); alter table public.in_person_sessions drop column host_cleared;
