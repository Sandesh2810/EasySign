-- YouNMeSign Phase 4 slice 6: signing groups (AT4.5, D-81).
-- * recipients.signing_group: signers with the same group name (case ignored) share one place in the order; each has
--   the same fields (the app copies the group's fields to every member). The first member to sign completes the step:
--   the others still waiting become "skipped" with group_completed_by = who signed, one "group_completed" audit event
--   records who signed and who was no longer needed, and routing moves on.
-- * Skipped people no longer hold up a turn (routing_active_order); the only other ways to "skipped" (decline, void)
--   end the document, so nothing else changes.
-- * A member who is no longer needed is told who signed (require_signer: ES_GROUP_DONE).
-- * Completing and declining take a per-document lock first, so two members finishing at the same moment are handled
--   one after the other: exactly one signs for the group.
-- * Sending checks: at least two people per group, one place in the order, identical fields; field names now need to
--   be unique per person (each group member has the same names).
-- The same rules are in src/lib/routing.ts (validateRouting, applyAction), property-tested.
-- Down script at the bottom (commented).

alter table public.recipients
  add column signing_group text check (signing_group is null or char_length(signing_group) between 1 and 60),
  add column group_completed_by uuid references public.recipients (id) on delete set null,
  add constraint recipients_group_signers check (signing_group is null or role = 'signer');

-- skipped people (another group member signed; or the document was declined or voided) never hold up a turn
create or replace function app_private.routing_active_order(p_envelope_id uuid) returns int
language sql stable security definer set search_path = '' as $$
  select min(x.routing_order) from public.recipients x
   where x.envelope_id = p_envelope_id and x.role in ('signer', 'in_person', 'approver') and x.status not in ('signed', 'approved', 'skipped')
$$;

-- ---------- drafts: the signing group is saved with each person ----------
create or replace function public.save_recipients(p_actor uuid, p_envelope_id uuid, p_recipients jsonb) returns setof public.recipients
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  r jsonb;
  v_ids uuid[] := '{}';
  v_id uuid;
begin
  v_env := app_private.require_draft(p_actor, p_envelope_id);
  if jsonb_typeof(p_recipients) <> 'array' or jsonb_array_length(p_recipients) > 25 then
    raise exception 'invalid recipient list' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_recipients) loop
    v_id := nullif(r ->> 'id', '')::uuid;
    if v_id is not null and exists (select 1 from public.recipients x where x.id = v_id and x.envelope_id = p_envelope_id) then
      if exists (select 1 from public.fields f where f.recipient_id = v_id and f.locked)
         and (select x.role from public.recipients x where x.id = v_id) is distinct from coalesce(r ->> 'role', 'signer') then
        raise exception 'ES_LOCKED: this person has fields fixed by the template, so their role cannot change' using errcode = '42501';
      end if;
      update public.recipients x
         set name = btrim(r ->> 'name'), email = lower(btrim(r ->> 'email')),
             role = coalesce(r ->> 'role', 'signer'), routing_order = coalesce((r ->> 'routing_order')::int, 1),
             is_sender = coalesce((r ->> 'is_sender')::boolean, false),
             signing_group = nullif(btrim(coalesce(r ->> 'signing_group', '')), '')
       where x.id = v_id;
    else
      insert into public.recipients (org_id, envelope_id, name, email, role, routing_order, is_sender, signing_group)
        values (v_env.org_id, p_envelope_id, btrim(r ->> 'name'), lower(btrim(r ->> 'email')),
                coalesce(r ->> 'role', 'signer'), coalesce((r ->> 'routing_order')::int, 1),
                coalesce((r ->> 'is_sender')::boolean, false), nullif(btrim(coalesce(r ->> 'signing_group', '')), ''))
        returning id into v_id;
    end if;
    v_ids := v_ids || v_id;
  end loop;
  if exists (select 1 from public.recipients x join public.fields f on f.recipient_id = x.id and f.locked
              where x.envelope_id = p_envelope_id and not (x.id = any (v_ids))) then
    raise exception 'ES_LOCKED: a person with fields fixed by the template cannot be removed' using errcode = '42501';
  end if;
  delete from public.recipients x where x.envelope_id = p_envelope_id and not (x.id = any (v_ids));
  return query select * from public.recipients x where x.envelope_id = p_envelope_id order by x.routing_order, x.created_at;
end
$$;

-- ---------- the signer guard: a member no longer needed is told who signed ----------
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
  if v_rcp.status = 'skipped' and v_rcp.group_completed_by is not null then   -- D-81
    raise exception 'ES_GROUP_DONE: % has already signed for your signing group; nothing more is needed from you',
      (select x.name from public.recipients x where x.id = v_rcp.group_completed_by) using errcode = '42501';
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

-- ---------- signing: signing for the group ----------
create or replace function public.signer_complete(p_token_id uuid, p_intent_text_sha256 text, p_local_date text, p_ip inet, p_user_agent text,
                                       p_hidden uuid[] default '{}') returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_env public.envelopes;
  v_sig uuid;
  v_ini uuid;
  v_n int;
  v_stamps int := 0;
  v_date date;
  v_hidden uuid[] := coalesce(p_hidden, '{}');
  v_skipped uuid[];
  f public.fields;
begin
  -- D-81: one signing step per document at a time (complete and decline), taken before anyone's row is locked, so two
  -- members of a signing group finishing together are handled one after the other, never both and never deadlocked
  perform pg_advisory_xact_lock(hashtextextended('env-act:' || coalesce((select k.envelope_id::text from public.recipient_tokens k where k.id = p_token_id), ''), 0));
  v_rcp := app_private.require_signer(p_token_id);
  if v_rcp.role = 'approver' then
    raise exception 'ES_WRONG_ACTION: an approver approves or declines; there is nothing to sign' using errcode = '42501';
  end if;
  if v_rcp.status <> 'consented' then
    raise exception 'ES_CONSENT_REQUIRED: agree to use electronic records and signatures first' using errcode = '42501';
  end if;
  if p_local_date !~ '^\d{4}-\d{2}-\d{2}$' or p_intent_text_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid completion data' using errcode = '22023';
  end if;
  begin
    v_date := p_local_date::date;
  exception when others then
    raise exception 'invalid completion data' using errcode = '22023';
  end;
  if abs(v_date - app_private.utc_day()) > 1 then
    raise exception 'ES_DATE: the date on your device looks wrong. Check its clock and try again' using errcode = '22023';
  end if;
  -- D-79: only this signer's own fields that carry a condition can be hidden
  if coalesce(array_length(v_hidden, 1), 0) > 500
     or exists (select 1 from unnest(v_hidden) h(id)
                 where not exists (select 1 from public.fields x
                                    where x.id = h.id and x.recipient_id = v_rcp.id and x.options ? 'show_if'
                                      and x.type not in ('signature', 'initials'))) then
    raise exception 'invalid hidden fields' using errcode = '22023';
  end if;
  select * into v_env from public.envelopes e where e.id = v_rcp.envelope_id for update;

  select a.id into v_sig from public.signature_assets a where a.recipient_id = v_rcp.id and a.kind = 'signature' order by a.created_at desc limit 1;
  select a.id into v_ini from public.signature_assets a where a.recipient_id = v_rcp.id and a.kind = 'initials' order by a.created_at desc limit 1;
  if v_sig is null and exists (select 1 from public.fields x where x.recipient_id = v_rcp.id and x.type = 'signature') then
    raise exception 'ES_SIGNATURE_MISSING: create your signature first' using errcode = '22023';
  end if;
  if v_ini is null and exists (select 1 from public.fields x where x.recipient_id = v_rcp.id and x.type = 'initials') then
    raise exception 'ES_INITIALS_MISSING: create your initials first' using errcode = '22023';
  end if;

  -- convenience fills for fields the signer left blank
  insert into public.field_values (field_id, org_id, envelope_id, recipient_id, value_text)
    select x.id, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id,
           case x.type when 'date_signed' then to_char(v_date, 'YYYY-MM-DD') when 'name' then v_rcp.name else v_rcp.email end
      from public.fields x where x.recipient_id = v_rcp.id and x.type in ('date_signed', 'name', 'email')
    on conflict (field_id) do update set value_text = excluded.value_text, filled_at = now();

  -- notes, links and calculated fields are shown, never filled in (D-78, D-79); hidden fields are not asked for (D-79)
  if exists (select 1 from public.fields x where x.recipient_id = v_rcp.id and x.required
               and x.type not in ('signature', 'initials', 'note', 'hyperlink', 'formula')
               and not (x.id = any (v_hidden))
               and not exists (select 1 from public.field_values v where v.field_id = x.id)) then
    raise exception 'ES_FIELDS_MISSING: some required fields are still empty' using errcode = '22023';
  end if;

  select count(*) into v_n from public.field_values v where v.envelope_id = v_rcp.envelope_id and v.signature_id is not null;
  for f in select * from public.fields x where x.recipient_id = v_rcp.id and x.type in ('signature', 'initials') order by x.page, x.y, x.x loop
    v_n := v_n + 1;
    v_stamps := v_stamps + 1;
    insert into public.field_values as v (field_id, org_id, envelope_id, recipient_id, signature_asset_id, signature_id)
      values (f.id, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, case f.type when 'signature' then v_sig else v_ini end, v_env.public_code || '-S' || v_n)
      on conflict (field_id) do update set signature_asset_id = excluded.signature_asset_id, signature_id = excluded.signature_id, filled_at = now();
  end loop;

  perform app_private.sanction();
  update public.recipients x set status = 'signed', completed_at = now() where x.id = v_rcp.id;
  -- D-81: signing for the group: the other members still waiting are no longer needed
  if v_rcp.signing_group is not null then
    with s as (
      update public.recipients x set status = 'skipped', group_completed_by = v_rcp.id
       where x.envelope_id = v_rcp.envelope_id and x.id <> v_rcp.id and lower(x.signing_group) = lower(v_rcp.signing_group)
         and x.status in ('created', 'sent', 'viewed', 'consented')
      returning x.id)
    select array_agg(s.id order by s.id) into v_skipped from s;
  end if;
  perform set_config('easysign.sanctioned', '', true);
  perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'recipient_signed',
    jsonb_build_object('stamps', v_stamps, 'intent_text_sha256', p_intent_text_sha256, 'layout_sha256', v_env.field_layout_sha256,
      'document_sha256', (select d.sha256 from public.envelope_documents d where d.envelope_id = v_rcp.envelope_id order by d.position limit 1))
    || case when coalesce(array_length(v_hidden, 1), 0) > 0
            then jsonb_build_object('hidden_fields', (select to_jsonb(array_agg(distinct h order by h)) from unnest(v_hidden) h))
            else '{}'::jsonb end,
    p_ip, p_user_agent);

  if v_rcp.signing_group is not null then
    perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'group_completed',
      jsonb_build_object('group', v_rcp.signing_group, 'by', v_rcp.id, 'by_name', v_rcp.name, 'no_longer_needed', coalesce(to_jsonb(v_skipped), '[]'::jsonb)),
      p_ip, p_user_agent);
  end if;

  return app_private.routing_after_action(v_rcp.envelope_id, v_rcp.org_id);
end
$$;

-- ---------- declining: the same per-document lock ----------
create or replace function public.signer_decline(p_token_id uuid, p_reason text, p_ip inet, p_user_agent text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_env public.envelopes;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 1000), '');
begin
  -- D-81: one signing step per document at a time (complete and decline), taken before anyone's row is locked, so two
  -- members of a signing group finishing together are handled one after the other, never both and never deadlocked
  perform pg_advisory_xact_lock(hashtextextended('env-act:' || coalesce((select k.envelope_id::text from public.recipient_tokens k where k.id = p_token_id), ''), 0));
  v_rcp := app_private.require_signer(p_token_id);
  select * into v_env from public.envelopes e where e.id = v_rcp.envelope_id for update;
  if v_env.status not in ('sent', 'in_progress') or exists (select 1 from public.seal_jobs j where j.envelope_id = v_env.id) then
    raise exception 'ES_LINK_INVALID: this document is no longer open for signing' using errcode = '42501';
  end if;
  perform app_private.sanction();
  update public.recipients x set status = 'declined', completed_at = now(), decline_reason = v_reason where x.id = v_rcp.id;
  update public.recipients x set status = 'skipped'
   where x.envelope_id = v_env.id and x.id <> v_rcp.id and x.status in ('created', 'sent', 'viewed', 'consented');
  update public.envelopes e set status = 'declined' where e.id = v_env.id;
  perform set_config('easysign.sanctioned', '', true);
  update public.recipient_tokens k set revoked_at = now() where k.envelope_id = v_env.id and k.revoked_at is null;
  perform app_private.cancel_pending_requests(v_env.id, 'cancelled: the document was declined');

  -- the reason is kept with the recipient; the audit trail holds only its fingerprint
  perform app_private.audit_append('env:' || v_env.id::text, v_env.org_id, v_env.id, v_rcp.id, 'signer', null, 'recipient_declined',
    jsonb_build_object('role', v_rcp.role, 'reason_given', v_reason is not null,
      'reason_sha256', case when v_reason is null then null else encode(sha256(convert_to(v_reason, 'UTF8')), 'hex') end), p_ip, p_user_agent);
  perform app_private.audit_append('env:' || v_env.id::text, v_env.org_id, v_env.id, null, 'system', null, 'envelope_declined',
    jsonb_build_object('by', v_rcp.id, 'links_revoked', true));

  insert into public.notifications (org_id, user_id, kind, payload)
    values (v_env.org_id, v_env.sender_id, 'envelope_declined', jsonb_build_object('envelope_id', v_env.id, 'title', v_env.title, 'by', v_rcp.name));
  if lower(v_rcp.email) <> coalesce(app_private.user_email(v_env.sender_id), '') then
    insert into public.notification_outbox (org_id, envelope_id, recipient_id, to_user_id, sender_user_id, kind, priority, idempotency_key)
      values (v_env.org_id, v_env.id, v_rcp.id, v_env.sender_id, v_env.sender_id, 'declined_sender', 'P1', 'declined:' || v_env.id::text)
      on conflict (idempotency_key) do nothing;
  end if;
end
$$;

-- ---------- sending: group rules; names unique per person ----------
create or replace function app_private.envelopes_field_setup_check() returns trigger
language plpgsql set search_path = '' as $$
declare
  f record;
  v_problem text;
  v_dup text;
  g record;
begin
  if old.status = 'draft' and new.status <> 'draft' then
    for f in select x.type, x.page, x.options from public.fields x where x.envelope_id = new.id order by x.page, x.y, x.x loop
      v_problem := app_private.field_options_problem(f.type, f.options);
      if v_problem is not null then
        raise exception 'ES_FIELD_SETUP: a % field on page % is not ready: %', replace(f.type, '_', ' '), f.page, v_problem using errcode = '22023';
      end if;
    end loop;
    select x.options ->> 'name' into v_dup from public.fields x
     where x.envelope_id = new.id and x.options ? 'name'
     group by x.recipient_id, x.options ->> 'name' having count(*) > 1 limit 1;
    if v_dup is not null then
      raise exception 'ES_FIELD_SETUP: two fields are named "%"; each name must be different', v_dup using errcode = '22023';
    end if;
    -- D-81: a signing group has two or more signers in one place in the order, each with the same fields
    for g in select lower(x.signing_group) as k, min(x.signing_group) as label, count(*) as n, count(distinct x.routing_order) as orders
               from public.recipients x where x.envelope_id = new.id and x.signing_group is not null
              group by lower(x.signing_group) loop
      if g.n < 2 then
        raise exception 'ES_GROUP: the signing group "%" needs at least two people', g.label using errcode = '22023';
      end if;
      if g.orders > 1 then
        raise exception 'ES_GROUP: everyone in the signing group "%" must have the same place in the order', g.label using errcode = '22023';
      end if;
      if (select count(distinct q.l) from (
            select (select coalesce(string_agg(f.type || '|' || f.page || '|' || f.x || '|' || f.y || '|' || f.w || '|' || f.h || '|' || f.required || '|' || f.options::text,
                                               E'\n' order by f.page, f.y, f.x, f.type, f.options::text), '')
                      from public.fields f where f.recipient_id = x.id) as l
              from public.recipients x where x.envelope_id = new.id and lower(x.signing_group) = g.k) q) > 1 then
        raise exception 'ES_GROUP: everyone in the signing group "%" must have the same fields', g.label using errcode = '22023';
      end if;
    end loop;
  end if;
  return new;
end
$$;

-- down:
-- re-run routing_active_order (migration 20261118160949), save_recipients (20261120215259), require_signer (20261119082916),
--   signer_complete and envelopes_field_setup_check (20261121000853), signer_decline (20261118165013);
-- alter table public.recipients drop constraint recipients_group_signers, drop column group_completed_by, drop column signing_group;
-- (documents already signed by a group keep their skipped members; they are finished documents)
