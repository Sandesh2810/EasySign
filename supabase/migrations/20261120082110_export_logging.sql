-- YouNMeSign (EasySign) Phase 3 / migration 29: exports are recorded (slice 7, D-72).
-- An audit-trail export (any member of the workspace, any document that is not a draft) adds "audit_exported" to the
-- document's trail; a workspace export (owner only) adds "workspace_exported" to the workspace trail. The event is
-- added after the export is built, so an export never contains itself and can be rebuilt from the database.
-- Server-only (service role).

create function public.record_audit_export(p_actor uuid, p_envelope_id uuid, p_format text, p_ip inet, p_user_agent text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
begin
  if p_format not in ('json', 'pdf') then
    raise exception 'ES_INVALID: unknown format' using errcode = '22023';
  end if;
  select * into v_env from public.envelopes e where e.id = p_envelope_id;
  if not found or v_env.status = 'draft' or p_actor is null or not app_private.is_member_of(p_actor, v_env.org_id, 'viewer') then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'user', p_actor, 'audit_exported',
    jsonb_build_object('format', p_format), p_ip, left(p_user_agent, 500));
end
$$;

create function public.record_workspace_export(p_actor uuid, p_org uuid, p_documents int, p_ip inet, p_user_agent text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_owner(p_actor, p_org);
  perform app_private.audit_append('org:' || p_org::text, p_org, null, null, 'user', p_actor, 'workspace_exported',
    jsonb_build_object('documents', greatest(coalesce(p_documents, 0), 0)), p_ip, left(p_user_agent, 500));
end
$$;

revoke all on function public.record_audit_export(uuid, uuid, text, inet, text), public.record_workspace_export(uuid, uuid, int, inet, text)
  from public, anon, authenticated;
grant execute on function public.record_audit_export(uuid, uuid, text, inet, text), public.record_workspace_export(uuid, uuid, int, inet, text)
  to service_role;

-- down (manual): drop function public.record_workspace_export(uuid, uuid, int, inet, text); drop function public.record_audit_export(uuid, uuid, text, inet, text);
