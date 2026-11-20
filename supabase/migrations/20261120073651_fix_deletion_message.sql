-- YouNMeSign (EasySign) Phase 3 / migration 26: fix found by test T536 (slice 6).
-- envelopes.message is NOT NULL; finish_envelope_deletion set it to null, so every deletion failed at its second
-- step (nothing was half-deleted: the whole step rolled back). Now it is set to an empty string. Nothing else changes.

-- Step 2 (after the app removed the files): rows go, names go, the tombstone is written.
create or replace function public.finish_envelope_deletion(p_actor uuid, p_envelope_id uuid, p_files_removed int, p_ip inet, p_user_agent text) returns void
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
  update public.envelopes e set title = 'Deleted document', message = '', deleted_at = now() where e.id = p_envelope_id;
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

-- down (manual): re-create public.finish_envelope_deletion exactly as in 20261120073338_retention_hold_deletion.sql.
