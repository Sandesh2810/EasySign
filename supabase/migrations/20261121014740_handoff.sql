-- YouNMeSign Phase 4 slice 7: delegate and reassign (AT4.6, D-83).
-- * The sender can reassign an unfinished signer or approver to a different person (reassign_recipient); a signer or
--   approver can hand their part to someone else when the sender allowed it for the document (signer_delegate;
--   envelopes.allow_delegation, set before sending with set_delegation).
-- * Either way: the old link is revoked at once and a fresh one is issued; what the old person had started (consent,
--   answers, signature) is cleared, the sender's prefilled values are put back merged for the new person; one row in
--   recipient_handoffs keeps who it was, who it is now, who handed it over, when and why; one audit event
--   ("recipient_reassigned" or "recipient_delegated") records the same. The certificate prints the handoff.
-- * Limits against abuse: a document can be handed over at most 10 times, and one person can hand off at most 3 times;
--   a new address counts towards the sender's daily limit of different people, like any other recipient.
-- * Fix found while building this: correct_recipient cleared prefilled values (D-80) along with the old person's answers;
--   it now puts them back.
-- Down script at the bottom (commented).

alter table public.envelopes add column allow_delegation boolean not null default false;

create table public.recipient_handoffs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  envelope_id uuid not null references public.envelopes (id) on delete cascade,
  recipient_id uuid not null references public.recipients (id) on delete cascade,
  by_kind text not null check (by_kind in ('sender', 'signer')),
  by_user uuid references auth.users (id) on delete set null,
  from_name text not null,
  from_email text not null,
  to_name text not null,
  to_email text not null,
  reason text check (char_length(reason) <= 500),
  created_at timestamptz not null default now()
);
create index recipient_handoffs_envelope_idx on public.recipient_handoffs (envelope_id, created_at);
create index recipient_handoffs_recipient_idx on public.recipient_handoffs (recipient_id);
alter table public.recipient_handoffs enable row level security;
-- the sender's side reads the handoffs of documents it may see (same rule as every other part of a document)
create policy recipient_handoffs_select on public.recipient_handoffs for select to authenticated
  using (exists (select 1 from public.envelopes e where e.id = recipient_handoffs.envelope_id));
revoke all on public.recipient_handoffs from anon, authenticated;
grant select on public.recipient_handoffs to authenticated;
grant select, insert, update, delete on public.recipient_handoffs to service_role;

-- ---------- prefilled values and merged notes for one person (or everyone): used at sending and after a handoff ----------
create function app_private.apply_prefill(p_envelope_id uuid, p_recipient_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  f record;
  v text;
  v_problem text;
  v_sender_name text;
  v_sender_email text;
  v_n int := 0;
  v_all text := '';
begin
  select * into v_env from public.envelopes e where e.id = p_envelope_id;
  select coalesce(nullif(btrim(p.display_name), ''), u.email), u.email into v_sender_name, v_sender_email
    from auth.users u left join public.profiles p on p.id = u.id where u.id = v_env.sender_id;
  for f in select x.id, x.type, x.page, x.options, x.recipient_id, r.name, r.email
             from public.fields x join public.recipients r on r.id = x.recipient_id
            where x.envelope_id = p_envelope_id and (p_recipient_id is null or x.recipient_id = p_recipient_id)
              and ((x.options ? 'prefill' and btrim(x.options ->> 'prefill') <> '')
                   or (x.type = 'note' and coalesce(x.options ->> 'text', '') ~ '\{\{'))
            order by x.page, x.y, x.x loop
    if f.type = 'note' then
      v := app_private.merge_text(f.options ->> 'text', f.name, f.email, v_sender_name, v_sender_email, v_env.title);
      if char_length(v) > 2000 then
        raise exception 'ES_FIELD_SETUP: a note on page % is longer than 2000 characters once merged', f.page using errcode = '22023';
      end if;
    else
      v := btrim(app_private.merge_text(btrim(f.options ->> 'prefill'), f.name, f.email, v_sender_name, v_sender_email, v_env.title));
      v_problem := case when v = '' then 'it is empty once merged'
                        when char_length(v) > 500 then 'it is longer than 500 characters once merged'
                        else app_private.field_value_problem(f.type, f.options, v) end;
      if v_problem is not null then
        raise exception 'ES_FIELD_SETUP: a % field on page % is not ready: prefilled value for %: %', replace(f.type, '_', ' '), f.page, f.name, v_problem
          using errcode = '22023';
      end if;
    end if;
    insert into public.field_values as fv (field_id, org_id, envelope_id, recipient_id, value_text)
      values (f.id, v_env.org_id, p_envelope_id, f.recipient_id, v)
      on conflict (field_id) do update set value_text = excluded.value_text, filled_at = now();
    v_n := v_n + 1;
    v_all := v_all || f.id::text || '=' || v || E'\n';
  end loop;
  return jsonb_build_object('fields', v_n, 'values_sha256', encode(sha256(convert_to(v_all, 'UTF8')), 'hex'));
end
$$;
revoke all on function app_private.apply_prefill(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app_private.envelopes_prefill() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v jsonb;
begin
  if old.status = 'draft' and new.status <> 'draft' then
    v := app_private.apply_prefill(new.id, null);
    if (v ->> 'fields')::int > 0 then
      perform app_private.audit_append('env:' || new.id::text, new.org_id, new.id, null, 'system', null, 'fields_prefilled', v, null, null);
    end if;
  end if;
  return null;
end
$$;

-- ---------- the handoff itself (shared by the sender's reassign and the signer's hand-off) ----------
create function app_private.handoff_core(p_env public.envelopes, p_rcp public.recipients, p_name text, p_email text, p_reason text,
                                         p_token jsonb, p_by text, p_actor uuid, p_ip inet, p_user_agent text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 500), '');
  v_ctl public.account_controls;
  v_mode text;
  v_sender_email text;
  v_external boolean;
  v_day date := app_private.utc_day();
  v_count int;
  v_kind text;
  v_was_active boolean;
  v_prefill jsonb;
  v_id uuid;
begin
  if p_rcp.status not in ('created', 'sent', 'viewed', 'consented') then
    raise exception 'ES_ALREADY_DONE: this person has already finished, so their part can no longer be handed to someone else' using errcode = '42501';
  end if;
  if p_rcp.role not in ('signer', 'approver') then
    raise exception 'ES_INVALID: only someone who signs or approves can be replaced' using errcode = '22023';
  end if;
  if v_name = '' or char_length(v_name) > 120 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
    raise exception 'ES_INVALID: enter the new person''s name and a valid email address' using errcode = '22023';
  end if;
  if v_email = lower(p_rcp.email) then
    raise exception 'ES_INVALID: that is the same email address. To fix a typo in the name, use "Correct" instead' using errcode = '22023';
  end if;
  if exists (select 1 from public.recipients x where x.envelope_id = p_env.id and x.id <> p_rcp.id and lower(x.email) = v_email and x.role = p_rcp.role) then
    raise exception 'ES_DUPLICATE: that email address is already on this document with the same role' using errcode = '22023';
  end if;
  if p_token is null or jsonb_typeof(p_token) <> 'object' then
    raise exception 'a new link record is required' using errcode = '22023';
  end if;
  v_sender_email := coalesce(app_private.user_email(p_env.sender_id), '');
  v_external := v_email <> v_sender_email;
  if v_external then
    -- the sender's account rules apply to the new person, whoever handed over: approval mode and the daily limit of people
    select * into v_ctl from public.account_controls c where c.user_id = p_env.sender_id for update;
    if not found then
      raise exception 'ES_ACCOUNT: the sender''s account is not ready' using errcode = '42501';
    end if;
    select s.value #>> '{}' into v_mode from public.platform_settings s where s.key = 'registration_mode';
    if coalesce(v_mode, 'open') <> 'open' and not v_ctl.approved then
      raise exception 'ES_PENDING_APPROVAL: the sender''s account is waiting for approval, so this document cannot go to a new person yet' using errcode = '42501';
    end if;
    if v_ctl.trust_level = 'restricted'
       and not exists (select 1 from public.usage_recipients u where u.day = v_day and u.user_id = p_env.sender_id and u.email_hash = sha256(convert_to(v_email, 'UTF8')))
       and (select count(*) from public.usage_recipients u where u.day = v_day and u.user_id = p_env.sender_id) >= v_ctl.daily_recipient_cap then
      raise exception 'ES_RECIPIENT_CAP: this sender can send to % different people a day. Try again tomorrow', v_ctl.daily_recipient_cap using errcode = '53400';
    end if;
    insert into public.usage_recipients (day, user_id, email_hash) values (v_day, p_env.sender_id, sha256(convert_to(v_email, 'UTF8'))) on conflict do nothing;
  end if;

  v_was_active := p_rcp.status in ('sent', 'viewed', 'consented');
  -- what the old person started belongs to them: consent withdrawn, answers and signature removed
  update public.consents c set withdrawn_at = now() where c.recipient_id = p_rcp.id and c.withdrawn_at is null;
  delete from public.field_values v where v.recipient_id = p_rcp.id;
  delete from public.signature_assets a where a.recipient_id = p_rcp.id;

  perform app_private.sanction();
  update public.recipients x
     set name = v_name, email = v_email, is_sender = not v_external,
         status = case when v_was_active then 'sent' else x.status end,
         viewed_at = null, consented_at = null
   where x.id = p_rcp.id;
  if v_external and p_env.self_sign then
    update public.envelopes e set self_sign = false where e.id = p_env.id;
  end if;
  perform set_config('easysign.sanctioned', '', true);
  v_prefill := app_private.apply_prefill(p_env.id, p_rcp.id);

  -- the old link stops working at once; the new person gets a fresh one
  update public.recipient_tokens k set revoked_at = now() where k.recipient_id = p_rcp.id and k.revoked_at is null;
  insert into public.recipient_tokens (id, org_id, envelope_id, recipient_id, nonce, token_sha256, expires_at)
    values ((p_token ->> 'token_id')::uuid, p_env.org_id, p_env.id, p_rcp.id,
            decode(p_token ->> 'nonce', 'hex'), decode(p_token ->> 'token_sha256', 'hex'), p_env.expires_at);
  update public.notification_outbox o set status = 'dead', locked_until = null, last_error = 'cancelled: the recipient was replaced'
   where o.recipient_id = p_rcp.id and o.status in ('queued', 'deferred') and o.kind in ('signature_request', 'approval_request', 'view_notice');
  if v_was_active and p_env.delivery = 'email' and v_external then
    select count(*) into v_count from public.notification_outbox o
     where o.recipient_id = p_rcp.id and o.kind in ('signature_request', 'approval_request', 'view_notice');
    v_kind := case p_rcp.role when 'approver' then 'approval_request' else 'signature_request' end;
    insert into public.notification_outbox (org_id, envelope_id, recipient_id, sender_user_id, kind, priority, idempotency_key)
      values (p_env.org_id, p_env.id, p_rcp.id, p_env.sender_id, v_kind, 'P0_REQUEST', 'request:' || p_rcp.id::text || ':' || (v_count + 1)::text);
  end if;

  insert into public.recipient_handoffs (org_id, envelope_id, recipient_id, by_kind, by_user, from_name, from_email, to_name, to_email, reason)
    values (p_env.org_id, p_env.id, p_rcp.id, p_by, p_actor, p_rcp.name, lower(p_rcp.email), v_name, v_email, v_reason)
    returning id into v_id;
  perform app_private.audit_append('env:' || p_env.id::text, p_env.org_id, p_env.id, p_rcp.id,
    case p_by when 'sender' then 'user' else 'signer' end, p_actor,
    case p_by when 'sender' then 'recipient_reassigned' else 'recipient_delegated' end,
    jsonb_build_object('handoff_id', v_id, 'from_name', p_rcp.name, 'to_name', v_name,
      'from_email_sha256', encode(sha256(convert_to(lower(p_rcp.email), 'UTF8')), 'hex'),
      'to_email_sha256', encode(sha256(convert_to(v_email, 'UTF8')), 'hex'),
      'reason', v_reason, 'old_link_revoked', true, 'progress_reset', p_rcp.status in ('viewed', 'consented'),
      'prefilled_again', (v_prefill ->> 'fields')::int),
    p_ip, p_user_agent);
  return v_id;
end
$$;
revoke all on function app_private.handoff_core(public.envelopes, public.recipients, text, text, text, jsonb, text, uuid, inet, text)
  from public, anon, authenticated, service_role;

-- ---------- the sender reassigns ----------
create function public.reassign_recipient(p_actor uuid, p_envelope_id uuid, p_recipient_id uuid, p_name text, p_email text, p_reason text, p_token jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_rcp public.recipients;
begin
  -- the same per-document lock as signing and declining, so a reassignment never crosses a signature in flight
  perform pg_advisory_xact_lock(hashtextextended('env-act:' || coalesce(p_envelope_id::text, ''), 0));
  v_env := app_private.require_open_envelope(p_actor, p_envelope_id);
  select * into v_rcp from public.recipients x where x.id = p_recipient_id and x.envelope_id = p_envelope_id for update;
  if not found then
    raise exception 'ES_NOT_FOUND: that person is not on this document' using errcode = '42501';
  end if;
  return app_private.handoff_core(v_env, v_rcp, p_name, p_email, p_reason, p_token, 'sender', p_actor, null, null);
end
$$;
revoke all on function public.reassign_recipient(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.reassign_recipient(uuid, uuid, uuid, text, text, text, jsonb) to service_role;

-- ---------- the signer hands off (only when the sender allowed it) ----------
create function public.signer_delegate(p_token_id uuid, p_name text, p_email text, p_reason text, p_token jsonb, p_ip inet, p_user_agent text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_env public.envelopes;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('env-act:' || coalesce((select k.envelope_id::text from public.recipient_tokens k where k.id = p_token_id), ''), 0));
  v_rcp := app_private.require_signer(p_token_id);
  select * into v_env from public.envelopes e where e.id = v_rcp.envelope_id for update;
  if not v_env.allow_delegation then
    raise exception 'ES_NOT_ALLOWED: the sender has not allowed handing this document to someone else' using errcode = '42501';
  end if;
  if (select count(*) from public.recipient_handoffs h where h.envelope_id = v_env.id) >= 10 then
    raise exception 'ES_LIMIT: this document has been handed over too many times. Contact the sender' using errcode = '54000';
  end if;
  if (select count(*) from public.recipient_handoffs h where h.recipient_id = v_rcp.id and h.by_kind = 'signer') >= 3 then
    raise exception 'ES_LIMIT: this part has been handed over too many times. Contact the sender' using errcode = '54000';
  end if;
  v_id := app_private.handoff_core(v_env, v_rcp, p_name, p_email, p_reason, p_token, 'signer', null, p_ip, p_user_agent);
  insert into public.notifications (org_id, user_id, kind, payload)
    values (v_env.org_id, v_env.sender_id, 'recipient_delegated',
            jsonb_build_object('envelope_id', v_env.id, 'title', v_env.title, 'by', v_rcp.name, 'to', btrim(p_name)));
  return v_id;
end
$$;
revoke all on function public.signer_delegate(uuid, text, text, text, jsonb, inet, text) from public, anon, authenticated;
grant execute on function public.signer_delegate(uuid, text, text, text, jsonb, inet, text) to service_role;

-- ---------- the sender allows hand-offs (a draft setting, like reminders) ----------
create function public.set_delegation(p_actor uuid, p_envelope_id uuid, p_allow boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_draft(p_actor, p_envelope_id);
  perform app_private.sanction();
  update public.envelopes e set allow_delegation = coalesce(p_allow, false) where e.id = p_envelope_id;
  perform set_config('easysign.sanctioned', '', true);
end
$$;
revoke all on function public.set_delegation(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_delegation(uuid, uuid, boolean) to service_role;

-- ---------- correcting an address keeps the sender's prefilled values ----------
create or replace function public.correct_recipient(p_actor uuid, p_envelope_id uuid, p_recipient_id uuid, p_name text, p_email text, p_token jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_rcp public.recipients;
  v_ctl public.account_controls;
  v_mode text;
  v_name text := btrim(coalesce(p_name, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_sender_email text;
  v_email_changed boolean;
  v_external boolean;
  v_day date := app_private.utc_day();
  v_count int;
  v_kind text;
  v_was_active boolean;
begin
  v_env := app_private.require_open_envelope(p_actor, p_envelope_id);
  select * into v_rcp from public.recipients x where x.id = p_recipient_id and x.envelope_id = p_envelope_id for update;
  if not found then
    raise exception 'ES_NOT_FOUND: that person is not on this document' using errcode = '42501';
  end if;
  if v_rcp.status not in ('created', 'sent', 'viewed', 'consented') then
    raise exception 'ES_ALREADY_DONE: this person has already finished, so their details can no longer be changed' using errcode = '42501';
  end if;
  if v_name = '' or char_length(v_name) > 120 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
    raise exception 'ES_INVALID: enter a name and a valid email address' using errcode = '22023';
  end if;
  v_email_changed := v_email <> lower(v_rcp.email);
  if not v_email_changed and v_name = v_rcp.name then
    return 'unchanged';
  end if;
  if v_email_changed and exists (select 1 from public.recipients x where x.envelope_id = p_envelope_id and x.id <> p_recipient_id
                                   and lower(x.email) = v_email and x.role = v_rcp.role) then
    raise exception 'ES_DUPLICATE: that email address is already on this document with the same role' using errcode = '22023';
  end if;
  v_sender_email := coalesce(app_private.user_email(v_env.sender_id), '');
  v_external := v_email <> v_sender_email;

  if v_email_changed and v_external then
    -- the same account rules as when sending: approval mode and the new-account daily limit on different people
    select * into v_ctl from public.account_controls c where c.user_id = p_actor for update;
    if not found then
      raise exception 'ES_ACCOUNT: your account is not ready to send yet. Sign out, sign in again and retry' using errcode = '42501';
    end if;
    select s.value #>> '{}' into v_mode from public.platform_settings s where s.key = 'registration_mode';
    if coalesce(v_mode, 'open') <> 'open' and not v_ctl.approved then
      raise exception 'ES_PENDING_APPROVAL: your account is waiting for approval. Until then you can sign documents yourself, but not send them to other people' using errcode = '42501';
    end if;
    if v_ctl.trust_level = 'restricted'
       and not exists (select 1 from public.usage_recipients u where u.day = v_day and u.user_id = p_actor and u.email_hash = sha256(convert_to(v_email, 'UTF8')))
       and (select count(*) from public.usage_recipients u where u.day = v_day and u.user_id = p_actor) >= v_ctl.daily_recipient_cap then
      raise exception 'ES_RECIPIENT_CAP: new accounts can send to % different people a day. Try again tomorrow', v_ctl.daily_recipient_cap using errcode = '53400';
    end if;
    insert into public.usage_recipients (day, user_id, email_hash) values (v_day, p_actor, sha256(convert_to(v_email, 'UTF8'))) on conflict do nothing;
  end if;

  v_was_active := v_rcp.status in ('sent', 'viewed', 'consented');
  if v_email_changed then
    -- undo whatever the old address had started; a consent belongs to the person who gave it
    update public.consents c set withdrawn_at = now() where c.recipient_id = p_recipient_id and c.withdrawn_at is null;
    delete from public.field_values v where v.recipient_id = p_recipient_id;
    delete from public.signature_assets a where a.recipient_id = p_recipient_id;
  end if;

  perform app_private.sanction();
  update public.recipients x
     set name = v_name, email = v_email, is_sender = not v_external,
         status = case when v_email_changed and v_was_active then 'sent' else x.status end,
         viewed_at = case when v_email_changed then null else x.viewed_at end,
         consented_at = case when v_email_changed then null else x.consented_at end
   where x.id = p_recipient_id;
  if v_email_changed and v_external and v_env.self_sign then
    update public.envelopes e set self_sign = false where e.id = p_envelope_id;
  end if;
  perform set_config('easysign.sanctioned', '', true);
  -- D-83: the values cleared above include the sender's prefilled ones (D-80); put them back, merged for the new address
  if v_email_changed then
    perform app_private.apply_prefill(p_envelope_id, p_recipient_id);
  end if;

  if v_email_changed and v_rcp.role <> 'cc' then
    if p_token is null or jsonb_typeof(p_token) <> 'object' then
      raise exception 'a new link record is required when the email changes' using errcode = '22023';
    end if;
    update public.recipient_tokens k set revoked_at = now() where k.recipient_id = p_recipient_id and k.revoked_at is null;
    insert into public.recipient_tokens (id, org_id, envelope_id, recipient_id, nonce, token_sha256, expires_at)
      values ((p_token ->> 'token_id')::uuid, v_env.org_id, p_envelope_id, p_recipient_id,
              decode(p_token ->> 'nonce', 'hex'), decode(p_token ->> 'token_sha256', 'hex'), v_env.expires_at);
    -- a request still waiting to go to the old address must not go out (other people's requests stay)
    update public.notification_outbox o set status = 'dead', locked_until = null, last_error = 'cancelled: the recipient was corrected'
     where o.recipient_id = p_recipient_id and o.status in ('queued', 'deferred') and o.kind in ('signature_request', 'approval_request', 'view_notice');
    if v_was_active and v_env.delivery = 'email' and v_external then
      select count(*) into v_count from public.notification_outbox o
       where o.recipient_id = p_recipient_id and o.kind in ('signature_request', 'approval_request', 'view_notice');
      v_kind := case v_rcp.role when 'approver' then 'approval_request' when 'viewer' then 'view_notice' else 'signature_request' end;
      insert into public.notification_outbox (org_id, envelope_id, recipient_id, sender_user_id, kind, priority, idempotency_key)
        values (v_env.org_id, p_envelope_id, p_recipient_id, p_actor, v_kind, 'P0_REQUEST', 'request:' || p_recipient_id::text || ':' || (v_count + 1)::text);
    end if;
  end if;

  -- addresses are kept out of the audit trail; their fingerprints are enough to show what changed
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, p_recipient_id, 'user', p_actor, 'recipient_corrected',
    jsonb_build_object('name_changed', v_name <> v_rcp.name, 'email_changed', v_email_changed, 'link_reissued', v_email_changed and v_rcp.role <> 'cc',
      'progress_reset', v_email_changed and v_rcp.status in ('viewed', 'consented'),
      'old_email_sha256', encode(sha256(convert_to(lower(v_rcp.email), 'UTF8')), 'hex'),
      'new_email_sha256', encode(sha256(convert_to(v_email, 'UTF8')), 'hex')));
  return case when v_email_changed then 'email_changed' else 'name_changed' end;
end
$$;

-- down:
-- drop function public.set_delegation(uuid, uuid, boolean); drop function public.signer_delegate(uuid, text, text, text, jsonb, inet, text);
-- drop function public.reassign_recipient(uuid, uuid, uuid, text, text, text, jsonb);
-- drop function app_private.handoff_core(public.envelopes, public.recipients, text, text, text, jsonb, text, uuid, inet, text);
-- re-run envelopes_prefill from migration 20261121003320 and correct_recipient from 20261118165013;
-- drop function app_private.apply_prefill(uuid, uuid); drop table public.recipient_handoffs;
-- alter table public.envelopes drop column allow_delegation;
