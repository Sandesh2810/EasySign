-- EasySign Phase 1 / migration 3: row-level security, explicit grants, storage buckets and immutability.
-- Model: anon gets nothing. Logged-in users read their own workspace through RLS and write only
-- folders, their own profile and their notification read-state directly; every other write goes
-- through functions. The service role (server and worker) bypasses RLS but is still bound by the
-- guard triggers and cannot modify audit_events. Down script at the bottom (commented).

-- ---------- RLS on every table ----------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end
$$;

-- ---------- start from zero, then grant explicitly ----------
revoke all on all tables in schema public from anon, authenticated, service_role;
revoke all on all sequences in schema public from anon, authenticated, service_role;
revoke all on all functions in schema public from public, anon, authenticated, service_role;
revoke all on all functions in schema app_private from public, anon, authenticated, service_role;

-- service role: data access for the server and worker; audit_events is read-only for it
grant select, insert, update, delete on all tables in schema public to service_role;
revoke insert, update, delete on public.audit_events from service_role;

-- logged-in users: read access (RLS decides which rows)
grant select on public.organizations, public.profiles, public.account_controls, public.memberships, public.org_settings,
  public.folders, public.envelopes, public.envelope_documents, public.fields, public.field_values, public.signature_assets,
  public.consents, public.audit_events, public.seal_jobs, public.notifications to authenticated;
-- recipients: every column except the access-code hash
grant select (id, org_id, envelope_id, name, email, role, routing_order, is_sender, status, auth_method, decline_reason,
  sent_at, viewed_at, consented_at, completed_at, created_at) on public.recipients to authenticated;

-- logged-in users: the only direct writes
grant insert (org_id, parent_id, name, created_by), update (parent_id, name), delete on public.folders to authenticated;
grant update (display_name, locale, timezone, onboarded_at) on public.profiles to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- functions
grant execute on function app_private.is_org_member(uuid, text) to authenticated, service_role;
grant execute on function app_private.is_sanctioned() to authenticated, service_role;
grant execute on function public.create_envelope(uuid, text, uuid) to authenticated;

-- ---------- policies (authenticated only; anon has none) ----------
create policy organizations_select on public.organizations for select to authenticated
  using (app_private.is_org_member(id));

create policy profiles_select_own on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy account_controls_select_own on public.account_controls for select to authenticated
  using (user_id = (select auth.uid()));

create policy memberships_select on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or app_private.is_org_member(org_id, 'admin'));

create policy org_settings_select on public.org_settings for select to authenticated
  using (app_private.is_org_member(org_id));

create policy folders_select on public.folders for select to authenticated
  using (app_private.is_org_member(org_id));
create policy folders_insert on public.folders for insert to authenticated
  with check (app_private.is_org_member(org_id, 'member') and created_by = (select auth.uid()));
create policy folders_update on public.folders for update to authenticated
  using (app_private.is_org_member(org_id, 'member')) with check (app_private.is_org_member(org_id, 'member'));
create policy folders_delete on public.folders for delete to authenticated
  using (app_private.is_org_member(org_id, 'member'));

create policy envelopes_select on public.envelopes for select to authenticated
  using (app_private.is_org_member(org_id));
create policy envelope_documents_select on public.envelope_documents for select to authenticated
  using (app_private.is_org_member(org_id));
create policy recipients_select on public.recipients for select to authenticated
  using (app_private.is_org_member(org_id));
create policy fields_select on public.fields for select to authenticated
  using (app_private.is_org_member(org_id));
create policy field_values_select on public.field_values for select to authenticated
  using (app_private.is_org_member(org_id));
create policy consents_select on public.consents for select to authenticated
  using (app_private.is_org_member(org_id));
create policy audit_events_select on public.audit_events for select to authenticated
  using (org_id is not null and app_private.is_org_member(org_id));
create policy seal_jobs_select on public.seal_jobs for select to authenticated
  using (exists (select 1 from public.envelopes e where e.id = envelope_id and app_private.is_org_member(e.org_id)));
create policy signature_assets_select on public.signature_assets for select to authenticated
  using (owner_user_id = (select auth.uid()) or (org_id is not null and app_private.is_org_member(org_id)));

create policy notifications_select_own on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy notifications_update_own on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- No policies at all on: org_controls, recipient_tokens, notification_outbox, abuse_reports, platform_settings,
-- registration_requests, email_budget, email_budget_user, usage_counters, usage_recipients, rate_limits,
-- system_health, disposable_email_domains. RLS is on, so they are unreachable except by the service role.

-- ---------- folders: keep the tree inside one workspace ----------
create function app_private.folders_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.org_id <> old.org_id then
    raise exception 'folders cannot move between workspaces' using errcode = '42501';
  end if;
  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'a folder cannot contain itself' using errcode = '23514';
    end if;
    if not exists (select 1 from public.folders p where p.id = new.parent_id and p.org_id = new.org_id) then
      raise exception 'parent folder is not in this workspace' using errcode = '23503';
    end if;
  end if;
  return new;
end
$$;
create trigger folders_guard before insert or update on public.folders
  for each row execute function app_private.folders_guard();

-- An envelope may only be filed in a folder of its own workspace.
create function app_private.envelope_folder_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.folder_id is not null and (tg_op = 'INSERT' or new.folder_id is distinct from old.folder_id) then
    if not exists (select 1 from public.folders f where f.id = new.folder_id and f.org_id = new.org_id) then
      raise exception 'folder is not in this workspace' using errcode = '23503';
    end if;
  end if;
  return new;
end
$$;
create trigger envelope_folder_guard before insert or update on public.envelopes
  for each row execute function app_private.envelope_folder_guard();

-- ---------- storage: private buckets, no client policies ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('originals', 'originals', false, 10485760, array['application/pdf']),
  ('sealed', 'sealed', false, 26214400, array['application/pdf']),
  ('signatures', 'signatures', false, 1048576, array['image/png']),
  ('attachments', 'attachments', false, 10485760, null),
  ('branding', 'branding', false, 2097152, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;
-- No policies are created on storage.objects: browsers can never read or write storage directly.
-- The server authorises each request, then streams the file or issues a short-lived signed URL.

-- Originals are insert-only. An object can never be overwritten; it can be deleted only while it
-- belongs to no envelope or to a draft. This binds the service role too (AT1.10).
create function app_private.originals_immutable() returns trigger
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
    -- the storage service fills in metadata once, right after the upload; any later content change is an overwrite
    if old.metadata is not null and (new.metadata is distinct from old.metadata or new.version is distinct from old.version) then
      raise exception 'original documents cannot be overwritten' using errcode = '42501';
    end if;
    return new;
  end if;
  if exists (
    select 1 from public.envelope_documents d join public.envelopes e on e.id = d.envelope_id
    where d.storage_backend = 'supabase' and d.storage_path = old.name and e.status <> 'draft'
  ) then
    raise exception 'original documents of sent envelopes cannot be deleted' using errcode = '42501';
  end if;
  return old;
end
$$;
create trigger originals_immutable before update or delete on storage.objects
  for each row execute function app_private.originals_immutable();

-- down (manual):
-- drop trigger if exists originals_immutable on storage.objects;
-- drop trigger if exists envelope_folder_guard on public.envelopes;
-- drop trigger if exists folders_guard on public.folders;
-- drop function if exists app_private.originals_immutable(), app_private.envelope_folder_guard(), app_private.folders_guard();
-- delete from storage.buckets where id in ('originals', 'sealed', 'signatures', 'attachments', 'branding');
-- drop policy ... (every policy created above), then: alter table public.<each> disable row level security;
