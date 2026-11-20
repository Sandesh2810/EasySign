-- YouNMeSign (EasySign) Phase 3 / migration 27: fix found by the regression run of rls_phase1 (T74, slice 6).
-- Migration 25 let any sanctioned (server-function) transaction change the title and message of a finished document.
-- Now, on a finished document, a sanctioned change may touch only:
--   the legal-hold columns; the deletion-start columns once (while no deletion has started); and the title, the
--   message and deleted_at only in the single step that completes a deletion already started.
-- Everything else stays frozen, as before slice 6.

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
      v_allowed := v_allowed || array['legal_hold', 'legal_hold_reason', 'legal_hold_set_at', 'legal_hold_set_by'];
      if old.deletion_started_at is null then
        v_allowed := v_allowed || array['deletion_started_at', 'deletion_started_by'];
      elsif old.deleted_at is null and new.deleted_at is not null then
        v_allowed := v_allowed || array['deleted_at', 'title', 'message'];
      end if;
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

-- down (manual): re-create app_private.envelopes_guard exactly as in 20261120073338_retention_hold_deletion.sql.
