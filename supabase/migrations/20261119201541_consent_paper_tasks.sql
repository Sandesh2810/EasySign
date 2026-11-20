-- YouNMeSign (EasySign) Phase 3 / migration 21: consent polish (slice 3, AT3.3, D-68).
-- 1. consent_versions: every consent wording ever shown, kept word for word. The SHA-256 is computed here from
--    the text itself, so a stored fingerprint always matches stored words. Rows can never change or be removed.
--    The two wordings already used by real records (v1, v2) are put on file below; their fingerprints were
--    recomputed from git history and match the stored consent records.
-- 2. register_consent_version: the app puts its current wording on file before it records a consent. The same
--    version with different words is refused, so a version name always means one exact text.
-- 3. signer_consent now refuses a version/fingerprint pair that is not on file.
-- 4. sender_tasks: things a signer asked the sender to do (a paper copy) or must know (consent withdrawn).
-- 5. signer_withdraw_consent: before finishing, a signer can withdraw. Their consent is marked withdrawn, what
--    they filled in or adopted is cleared, they cannot sign until they agree again, and the sender is told.
-- 6. signer_request_paper_copy: creates a task for the sender and tells them.
-- 7. complete_sender_task: a member of the sender's organisation marks a task done.
-- All functions are server-only (service role). Signers' notes are kept on the task; the audit trail holds
-- only their fingerprint, as for decline reasons.

-- ---------- 1. consent wording registry ----------
create table public.consent_versions (
  version text primary key check (version ~ '^[a-z0-9][a-z0-9.-]{1,63}$'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  body text not null check (char_length(body) between 1 and 20000),
  registered_at timestamptz not null default now()
);
alter table public.consent_versions enable row level security;
grant select on public.consent_versions to service_role;

create function app_private.consent_versions_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.sha256 := encode(sha256(convert_to(new.body, 'UTF8')), 'hex');
    return new;
  end if;
  raise exception 'ES_PERMANENT: consent wordings on file can never be changed or removed' using errcode = '42501';
end
$$;
create trigger consent_versions_guard before insert or update or delete on public.consent_versions
  for each row execute function app_private.consent_versions_guard();
revoke all on function app_private.consent_versions_guard() from public, anon, authenticated, service_role;

-- esign-consent-2026-11-v1: sha256 ad236c6a7805f9f3ca7f71bd184be15fb66364a65449387895194f918d18ae03
-- esign-consent-2026-11-v2: sha256 3575f0d05370b2d0ace22553c5e64fda07e169d0cbe22a79e716b634fa783f6c
insert into public.consent_versions (version, body, registered_at) values ('esign-consent-2026-11-v1', E'You have been asked to review and sign a document electronically using EasySign.\n\nBy agreeing, you consent to use electronic records and electronic signatures for this document instead of paper. Your electronic signature will have the same effect as a signature written by hand.\n\nYou do not have to agree. If you would rather sign on paper, close this page and ask the sender for a paper copy. Asking for paper is free on our side; the sender decides how to provide it.\n\nYou can withdraw your consent at any time before you finish signing by closing this page and telling the sender. Withdrawing after you have finished does not undo a completed signature.\n\nTo read and keep the document you need a current web browser and a way to open and save PDF files. When everyone has signed you can download a copy of the completed document and its certificate.\n\nTo keep a record of the signing, we log the time, your internet address (IP) and your browser type for each step you take.', '2026-11-18 00:00:00+00');
insert into public.consent_versions (version, body, registered_at) values ('esign-consent-2026-11-v2', E'You have been asked to review and sign a document electronically using YouNMeSign.\n\nBy agreeing, you consent to use electronic records and electronic signatures for this document instead of paper. Your electronic signature will have the same effect as a signature written by hand.\n\nYou do not have to agree. If you would rather sign on paper, close this page and ask the sender for a paper copy. Asking for paper is free on our side; the sender decides how to provide it.\n\nYou can withdraw your consent at any time before you finish signing by closing this page and telling the sender. Withdrawing after you have finished does not undo a completed signature.\n\nTo read and keep the document you need a current web browser and a way to open and save PDF files. When everyone has signed you can download a copy of the completed document and its certificate.\n\nTo keep a record of the signing, we log the time, your internet address (IP) and your browser type for each step you take.', '2026-11-19 00:00:00+00');

create function public.register_consent_version(p_version text, p_body text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_sha text;
  v_on_file text;
begin
  if p_version is null or p_version !~ '^[a-z0-9][a-z0-9.-]{1,63}$' then
    raise exception 'ES_INVALID: a consent version is lower-case letters, digits, dots and dashes' using errcode = '22023';
  end if;
  if p_body is null or char_length(p_body) not between 1 and 20000 then
    raise exception 'ES_INVALID: the consent wording is empty or too long' using errcode = '22023';
  end if;
  v_sha := encode(sha256(convert_to(p_body, 'UTF8')), 'hex');
  insert into public.consent_versions (version, sha256, body) values (p_version, v_sha, p_body)
    on conflict (version) do nothing;
  select v.sha256 into v_on_file from public.consent_versions v where v.version = p_version;
  if v_on_file <> v_sha then
    raise exception 'ES_CONSENT_VERSION: version % is already on file with different wording. Give the new wording a new version', p_version
      using errcode = '22023';
  end if;
  return v_sha;
end
$$;

-- ---------- 3. consent must name a wording on file ----------
create or replace function public.signer_consent(p_token_id uuid, p_version text, p_disclosure_sha256 text, p_ip inet, p_user_agent text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_env public.envelopes;
begin
  v_rcp := app_private.require_signer(p_token_id);
  if not exists (select 1 from public.consent_versions v where v.version = p_version and v.sha256 = p_disclosure_sha256) then
    raise exception 'ES_CONSENT_VERSION: this consent wording is not on file' using errcode = '22023';
  end if;
  select * into v_env from public.envelopes e where e.id = v_rcp.envelope_id;
  if v_rcp.status = 'consented' then
    return;
  end if;
  insert into public.consents (org_id, envelope_id, recipient_id, disclosure_version, disclosure_sha256, ip, user_agent)
    values (v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, p_version, p_disclosure_sha256, p_ip, left(p_user_agent, 500));
  perform app_private.sanction();
  update public.recipients x set status = 'consented', consented_at = now() where x.id = v_rcp.id;
  perform set_config('easysign.sanctioned', '', true);
  perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'consent_given',
    jsonb_build_object('version', p_version, 'disclosure_sha256', p_disclosure_sha256, 'layout_sha256', v_env.field_layout_sha256,
      'document_sha256', (select d.sha256 from public.envelope_documents d where d.envelope_id = v_rcp.envelope_id order by d.position limit 1)),
    p_ip, p_user_agent);
end
$$;

-- ---------- 4. tasks for the sender ----------
create table public.sender_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete restrict,
  envelope_id uuid not null references public.envelopes (id) on delete cascade,
  recipient_id uuid not null references public.recipients (id) on delete cascade,
  kind text not null check (kind in ('paper_copy', 'consent_withdrawn')),
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  done_at timestamptz,
  done_by uuid references auth.users (id) on delete set null,
  check (done_by is null or done_at is not null)
);
create unique index sender_tasks_one_open on public.sender_tasks (recipient_id, kind) where done_at is null;
create index sender_tasks_envelope_idx on public.sender_tasks (envelope_id);
create index sender_tasks_org_open_idx on public.sender_tasks (org_id) where done_at is null;
create index sender_tasks_done_by_idx on public.sender_tasks (done_by);
alter table public.sender_tasks enable row level security;
grant select on public.sender_tasks to authenticated, service_role;
create policy sender_tasks_select on public.sender_tasks for select to authenticated
  using (app_private.is_org_member(org_id));

-- Opens a task (or returns the one already open, keeping its first note) and tells the sender once per task.
create function app_private.open_sender_task(p_rcp public.recipients, p_kind text, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_id uuid;
begin
  select * into v_env from public.envelopes e where e.id = p_rcp.envelope_id;
  insert into public.sender_tasks (org_id, envelope_id, recipient_id, kind, note)
    values (p_rcp.org_id, p_rcp.envelope_id, p_rcp.id, p_kind, p_note)
    on conflict (recipient_id, kind) where done_at is null do nothing
    returning id into v_id;
  if v_id is null then
    select t.id into v_id from public.sender_tasks t where t.recipient_id = p_rcp.id and t.kind = p_kind and t.done_at is null;
    return v_id;
  end if;
  insert into public.notifications (org_id, user_id, kind, payload)
    values (v_env.org_id, v_env.sender_id, case p_kind when 'paper_copy' then 'paper_copy_requested' else 'consent_withdrawn' end,
            jsonb_build_object('envelope_id', v_env.id, 'title', v_env.title, 'by', p_rcp.name));
  if not p_rcp.is_sender then
    insert into public.notification_outbox (org_id, envelope_id, recipient_id, to_user_id, sender_user_id, kind, priority, payload, idempotency_key)
      values (v_env.org_id, v_env.id, p_rcp.id, v_env.sender_id, v_env.sender_id,
              case p_kind when 'paper_copy' then 'paper_copy_sender' else 'withdrawn_sender' end, 'P1',
              jsonb_build_object('task_id', v_id), 'task:' || v_id::text)
      on conflict (idempotency_key) do nothing;
  end if;
  return v_id;
end
$$;

-- ---------- 5. withdraw consent ----------
create function public.signer_withdraw_consent(p_token_id uuid, p_reason text, p_want_paper boolean, p_ip inet, p_user_agent text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 500), '');
  v_version text;
  v_values int;
  v_sigs int;
begin
  v_rcp := app_private.require_signer(p_token_id);
  if v_rcp.status <> 'consented' then
    return 'not_consented';
  end if;
  if not public.rate_limit_hit('signer_withdraw', v_rcp.id::text, 5, 3600) then
    return 'limited';
  end if;
  update public.consents c set withdrawn_at = now() where c.recipient_id = v_rcp.id and c.withdrawn_at is null
    returning c.disclosure_version into v_version;
  -- nothing done under a withdrawn consent may reach the final document
  delete from public.field_values v where v.recipient_id = v_rcp.id;
  get diagnostics v_values = row_count;
  delete from public.signature_assets a where a.recipient_id = v_rcp.id;
  get diagnostics v_sigs = row_count;
  perform app_private.sanction();
  update public.recipients x set status = 'viewed', consented_at = null where x.id = v_rcp.id;
  perform set_config('easysign.sanctioned', '', true);
  perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'consent_withdrawn',
    jsonb_build_object('version', v_version, 'values_cleared', v_values, 'signatures_cleared', v_sigs,
      'reason_given', v_reason is not null,
      'reason_sha256', case when v_reason is null then null else encode(sha256(convert_to(v_reason, 'UTF8')), 'hex') end,
      'paper_copy_requested', coalesce(p_want_paper, false)),
    p_ip, p_user_agent);
  perform app_private.open_sender_task(v_rcp, 'consent_withdrawn', v_reason);
  if coalesce(p_want_paper, false) then
    perform app_private.open_sender_task(v_rcp, 'paper_copy', null);
    perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'paper_copy_requested',
      jsonb_build_object('note_given', false, 'note_sha256', null), p_ip, p_user_agent);
  end if;
  return 'withdrawn';
end
$$;

-- ---------- 6. ask for a paper copy ----------
create function public.signer_request_paper_copy(p_token_id uuid, p_note text, p_ip inet, p_user_agent text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
begin
  v_rcp := app_private.require_signer(p_token_id);
  if exists (select 1 from public.sender_tasks t where t.recipient_id = v_rcp.id and t.kind = 'paper_copy' and t.done_at is null) then
    return 'already_requested';
  end if;
  if not public.rate_limit_hit('signer_paper', v_rcp.id::text, 5, 3600) then
    return 'limited';
  end if;
  perform app_private.open_sender_task(v_rcp, 'paper_copy', v_note);
  perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'paper_copy_requested',
    jsonb_build_object('note_given', v_note is not null,
      'note_sha256', case when v_note is null then null else encode(sha256(convert_to(v_note, 'UTF8')), 'hex') end),
    p_ip, p_user_agent);
  return 'requested';
end
$$;

-- ---------- 7. the sender marks a task done ----------
create function public.complete_sender_task(p_actor uuid, p_task_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.sender_tasks;
begin
  if p_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  select * into v_task from public.sender_tasks t where t.id = p_task_id for update;
  if not found or not app_private.is_member_of(p_actor, v_task.org_id, 'member') then
    raise exception 'ES_NOT_FOUND: task not found' using errcode = '42501';
  end if;
  if exists (select 1 from public.account_controls c where c.user_id = p_actor and c.trust_level = 'suspended') then
    raise exception 'ES_SUSPENDED: account suspended' using errcode = '42501';
  end if;
  if v_task.done_at is not null then
    return 'already_done';
  end if;
  update public.sender_tasks t set done_at = now(), done_by = p_actor where t.id = p_task_id;
  perform app_private.audit_append('env:' || v_task.envelope_id::text, v_task.org_id, v_task.envelope_id, v_task.recipient_id, 'user', p_actor,
    'sender_task_done', jsonb_build_object('task_id', v_task.id, 'kind', v_task.kind));
  return 'done';
end
$$;

revoke all on function public.register_consent_version(text, text), public.signer_withdraw_consent(uuid, text, boolean, inet, text),
  public.signer_request_paper_copy(uuid, text, inet, text), public.complete_sender_task(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.register_consent_version(text, text), public.signer_withdraw_consent(uuid, text, boolean, inet, text),
  public.signer_request_paper_copy(uuid, text, inet, text), public.complete_sender_task(uuid, uuid)
  to service_role;
revoke all on function app_private.open_sender_task(public.recipients, text, text) from public, anon, authenticated, service_role;

-- down (manual):
-- drop function public.complete_sender_task(uuid, uuid);
-- drop function public.signer_request_paper_copy(uuid, text, inet, text);
-- drop function public.signer_withdraw_consent(uuid, text, boolean, inet, text);
-- drop function app_private.open_sender_task(public.recipients, text, text);
-- drop table public.sender_tasks;
--   then re-create public.signer_consent exactly as in 20261118073919_send_sign_seal.sql (same grants);
-- drop function public.register_consent_version(text, text);
-- drop table public.consent_versions;  (drops its trigger)
-- drop function app_private.consent_versions_guard();
