-- YouNMeSign (EasySign) Phase 3 / migration 25: retention, legal hold, deletion (slice 6, AT3.6, D-71).
-- 1. Retention period per workspace (org_controls.retention_years, default 7, 0-30), changed only by an owner.
-- 2. Legal hold on a finished document (owner or platform admin), with reason; blocks deletion.
-- 3. Deletion of a finished document, in two database steps around the storage step so files and rows go together:
--    begin_envelope_deletion (owner, not on hold, retention period over) marks it and returns every stored file;
--    the app removes the files (the originals trigger now allows that only for a marked document);
--    finish_envelope_deletion removes typed values, signatures, consents, tasks and codes, replaces names, emails,
--    title and file names, and writes a tombstone event. The audit chain and the fingerprints stay (they cannot be
--    deleted by design, and /verify keeps answering). A fresh two-step code is checked by the app (the database
--    cannot see the session). Nothing is ever deleted automatically.
-- All functions are server-only (service role).

alter table public.org_controls add column retention_years int not null default 7 check (retention_years between 0 and 30);

alter table public.envelopes
  add column legal_hold_reason text check (char_length(legal_hold_reason) <= 500),
  add column legal_hold_set_at timestamptz,
  add column legal_hold_set_by uuid references auth.users (id) on delete set null,
  add column deletion_started_at timestamptz,
  add column deletion_started_by uuid references auth.users (id) on delete set null,
  add column deleted_at timestamptz,
  add constraint deleted_after_start check (deleted_at is null or deletion_started_at is not null),
  add constraint no_deletion_under_hold check (not (legal_hold and deletion_started_at is not null));
create index envelopes_legal_hold_by_idx on public.envelopes (legal_hold_set_by);
create index envelopes_deletion_by_idx on public.envelopes (deletion_started_by);

-- Finished documents stay frozen, except what the sanctioned hold and deletion functions change.
create or replace function app_private.envelopes_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_allowed text[];
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and not app_private.is_sanctioned() then
      raise exception 'only draft envelopes can be deleted' using errcode = '42501';
    end if;
    return old;
  end if;

  if new.id <> old.id or new.org_id <> old.org_id or new.sender_id <> old.sender_id
     or new.public_code <> old.public_code or new.created_at <> old.created_at then
    raise exception 'immutable envelope column' using errcode = '42501';
  end if;

  if old.status in ('completed', 'declined', 'voided', 'expired') then
    v_allowed := array['folder_id', 'updated_at'];   -- terminal: nothing else, ever
    if app_private.is_sanctioned() then
      v_allowed := v_allowed || array['legal_hold', 'legal_hold_reason', 'legal_hold_set_at', 'legal_hold_set_by',
                                      'deletion_started_at', 'deletion_started_by', 'deleted_at', 'title', 'message'];
    end if;
  elsif app_private.is_sanctioned() then
    new.updated_at := now();
    return new;
  elsif old.status = 'draft' then
    v_allowed := array['title', 'message', 'folder_id', 'expires_at', 'routing_mode', 'updated_at'];
  else
    v_allowed := array['folder_id', 'updated_at'];
  end if;

  if (to_jsonb(new) - v_allowed) is distinct from (to_jsonb(old) - v_allowed) then
    raise exception 'envelope is % and that change is not allowed', old.status using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end
$$;

-- Originals of sent documents stay undeletable, except for a document whose deletion the owner has started.
create or replace function app_private.originals_immutable() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.bucket_id <> 'originals' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.bucket_id is distinct from old.bucket_id or new.name is distinct from old.name then
      raise exception 'original documents cannot be moved or renamed' using errcode = '42501';
    end if;
    if old.metadata is not null and (new.metadata is distinct from old.metadata or new.version is distinct from old.version) then
      raise exception 'original documents cannot be overwritten' using errcode = '42501';
    end if;
    return new;
  end if;
  if exists (
    select 1 from public.envelope_documents d join public.envelopes e on e.id = d.envelope_id
    where d.storage_backend = 'supabase' and d.storage_path = old.name and e.status <> 'draft' and e.deletion_started_at is null
  ) then
    raise exception 'original documents of sent envelopes cannot be deleted' using errcode = '42501';
  end if;
  return old;
end
$$;

create function app_private.require_owner(p_actor uuid, p_org uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_actor is null or not app_private.is_member_of(p_actor, p_org, 'owner') then
    raise exception 'ES_OWNER_ONLY: only the workspace owner can do this' using errcode = '42501';
  end if;
  if exists (select 1 from public.account_controls c where c.user_id = p_actor and c.trust_level = 'suspended') then
    raise exception 'ES_SUSPENDED: account suspended' using errcode = '42501';
  end if;
end
$$;

-- When the retention period of a finished document ends.
create function app_private.retained_until(p_env public.envelopes) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select coalesce(p_env.completed_at, p_env.expired_at, p_env.updated_at)
         + make_interval(years => coalesce((select o.retention_years from public.org_controls o where o.org_id = p_env.org_id), 7))
$$;

create function public.set_retention_years(p_actor uuid, p_org uuid, p_years int) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_old int;
begin
  perform app_private.require_owner(p_actor, p_org);
  if p_years is null or p_years not between 0 and 30 then
    raise exception 'ES_INVALID: choose between 0 and 30 years' using errcode = '22023';
  end if;
  select o.retention_years into v_old from public.org_controls o where o.org_id = p_org for update;
  if not found then
    insert into public.org_controls (org_id, retention_years) values (p_org, p_years);
  else
    update public.org_controls o set retention_years = p_years where o.org_id = p_org;
  end if;
  perform app_private.audit_append('org:' || p_org::text, p_org, null, null, 'user', p_actor, 'retention_changed',
    jsonb_build_object('from_years', coalesce(v_old, 7), 'to_years', p_years));
end
$$;

create function public.set_legal_hold(p_actor uuid, p_envelope_id uuid, p_on boolean, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 500), '');
  v_admin boolean;
begin
  select * into v_env from public.envelopes e where e.id = p_envelope_id for update;
  if not found then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  v_admin := exists (select 1 from public.account_controls c where c.user_id = p_actor and c.is_platform_admin and c.trust_level <> 'suspended');
  if not v_admin then
    perform app_private.require_owner(p_actor, v_env.org_id);
  end if;
  if v_env.status not in ('completed', 'declined', 'voided', 'expired') then
    raise exception 'ES_NOT_FINISHED: a legal hold applies to finished documents' using errcode = '42501';
  end if;
  if v_env.deletion_started_at is not null then
    raise exception 'ES_DELETED: this document has been deleted' using errcode = '42501';
  end if;
  if p_on and v_reason is null then
    raise exception 'ES_INVALID: give a reason for the legal hold' using errcode = '22023';
  end if;
  if coalesce(p_on, false) = v_env.legal_hold then
    return;
  end if;
  perform app_private.sanction();
  update public.envelopes e
     set legal_hold = p_on,
         legal_hold_reason = case when p_on then v_reason else null end,
         legal_hold_set_at = case when p_on then now() else null end,
         legal_hold_set_by = case when p_on then p_actor else null end
   where e.id = p_envelope_id;
  perform set_config('easysign.sanctioned', '', true);
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, case when v_admin then 'admin' else 'user' end, p_actor,
    case when p_on then 'legal_hold_set' else 'legal_hold_released' end,
    jsonb_build_object('reason_sha256', case when v_reason is null then null else encode(sha256(convert_to(v_reason, 'UTF8')), 'hex') end));
end
$$;

-- Step 1 of deletion. Returns the stored files to remove: [{bucket, backend, path}]. Repeatable until finished.
create function public.begin_envelope_deletion(p_actor uuid, p_envelope_id uuid, p_ip inet, p_user_agent text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_until timestamptz;
  v_files jsonb;
begin
  select * into v_env from public.envelopes e where e.id = p_envelope_id for update;
  if not found then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  perform app_private.require_owner(p_actor, v_env.org_id);
  if v_env.deleted_at is not null then
    raise exception 'ES_DELETED: this document has already been deleted' using errcode = '42501';
  end if;
  if v_env.status not in ('completed', 'declined', 'voided', 'expired') then
    raise exception 'ES_NOT_FINISHED: only finished documents can be deleted (cancel it first, or delete the draft)' using errcode = '42501';
  end if;
  if v_env.legal_hold then
    raise exception 'ES_LEGAL_HOLD: this document is under a legal hold and cannot be deleted' using errcode = '42501';
  end if;
  v_until := app_private.retained_until(v_env);
  if v_until > now() then
    raise exception 'ES_RETENTION: this document must be kept until % (the workspace retention period)', to_char(v_until at time zone 'utc', 'YYYY-MM-DD')
      using errcode = '42501';
  end if;
  if exists (select 1 from public.seal_jobs j where j.envelope_id = p_envelope_id and j.status in ('queued', 'running')) then
    raise exception 'ES_SEALING: the final document is still being prepared' using errcode = '42501';
  end if;

  if v_env.deletion_started_at is null then
    perform app_private.sanction();
    update public.envelopes e set deletion_started_at = now(), deletion_started_by = p_actor where e.id = p_envelope_id;
    perform set_config('easysign.sanctioned', '', true);
    perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'user', p_actor, 'deletion_started', '{}'::jsonb, p_ip, p_user_agent);
  end if;

  select coalesce(jsonb_agg(f), '[]'::jsonb) into v_files from (
    select jsonb_build_object('bucket', 'originals', 'backend', d.storage_backend, 'path', d.storage_path) f
      from public.envelope_documents d where d.envelope_id = p_envelope_id
    union all
    select jsonb_build_object('bucket', 'sealed', 'backend', v_env.sealed_storage_backend, 'path', p) from unnest(array[v_env.sealed_storage_path, v_env.certificate_storage_path]) p where p is not null
    union all
    select jsonb_build_object('bucket', 'signatures', 'backend', a.storage_backend, 'path', a.storage_path)
      from public.signature_assets a where a.recipient_id in (select x.id from public.recipients x where x.envelope_id = p_envelope_id)
  ) q;
  return v_files;
end
$$;

-- Step 2 (after the app removed the files): rows go, names go, the tombstone is written.
create function public.finish_envelope_deletion(p_actor uuid, p_envelope_id uuid, p_files_removed int, p_ip inet, p_user_agent text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_values int; v_sigs int; v_consents int; v_people int;
begin
  select * into v_env from public.envelopes e where e.id = p_envelope_id for update;
  if not found then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  perform app_private.require_owner(p_actor, v_env.org_id);
  if v_env.deletion_started_at is null then
    raise exception 'ES_INVALID: start the deletion first' using errcode = '42501';
  end if;
  if v_env.deleted_at is not null then
    return;
  end if;
  perform app_private.sanction();
  delete from public.field_values v where v.envelope_id = p_envelope_id;
  get diagnostics v_values = row_count;
  delete from public.signature_assets a where a.recipient_id in (select x.id from public.recipients x where x.envelope_id = p_envelope_id);
  get diagnostics v_sigs = row_count;
  delete from public.consents c where c.envelope_id = p_envelope_id;
  get diagnostics v_consents = row_count;
  delete from public.sender_tasks t where t.envelope_id = p_envelope_id;
  delete from public.recipient_auth a where a.recipient_id in (select x.id from public.recipients x where x.envelope_id = p_envelope_id);
  update public.recipient_tokens k set revoked_at = coalesce(k.revoked_at, now()) where k.envelope_id = p_envelope_id;
  update public.recipients x
     set name = 'Removed', email = 'removed-' || replace(x.id::text, '-', '') || '@deleted.invalid', decline_reason = null
   where x.envelope_id = p_envelope_id;
  get diagnostics v_people = row_count;
  update public.envelope_documents d set filename = 'deleted.pdf' where d.envelope_id = p_envelope_id;
  update public.envelopes e set title = 'Deleted document', message = null, deleted_at = now() where e.id = p_envelope_id;
  update public.notifications n set payload = n.payload || '{"title": "Deleted document", "by": "Removed"}'::jsonb
   where n.payload ->> 'envelope_id' = p_envelope_id::text;
  perform set_config('easysign.sanctioned', '', true);
  -- the tombstone: what was removed and the fingerprints that remain
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'user', p_actor, 'envelope_deleted',
    jsonb_build_object('files_removed', greatest(coalesce(p_files_removed, 0), 0), 'values_removed', v_values, 'signatures_removed', v_sigs,
      'consents_removed', v_consents, 'people_anonymised', v_people, 'final_sha256', v_env.final_sha256, 'status_at_deletion', v_env.status),
    p_ip, p_user_agent);
end
$$;

revoke all on function app_private.require_owner(uuid, uuid), app_private.retained_until(public.envelopes) from public, anon, authenticated, service_role;
revoke all on function public.set_retention_years(uuid, uuid, int), public.set_legal_hold(uuid, uuid, boolean, text),
  public.begin_envelope_deletion(uuid, uuid, inet, text), public.finish_envelope_deletion(uuid, uuid, int, inet, text) from public, anon, authenticated;
grant execute on function public.set_retention_years(uuid, uuid, int), public.set_legal_hold(uuid, uuid, boolean, text),
  public.begin_envelope_deletion(uuid, uuid, inet, text), public.finish_envelope_deletion(uuid, uuid, int, inet, text) to service_role;

-- down (manual): drop the four public functions and app_private.require_owner / retained_until; re-create
-- app_private.envelopes_guard as in 20261118050720_functions.sql and app_private.originals_immutable as in
-- 20261118050740_security.sql; alter table public.envelopes drop constraint no_deletion_under_hold, drop constraint
-- deleted_after_start, drop column deleted_at, deletion_started_by, deletion_started_at, legal_hold_set_by,
-- legal_hold_set_at, legal_hold_reason; alter table public.org_controls drop column retention_years.
