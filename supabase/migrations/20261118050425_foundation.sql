-- EasySign Phase 1 / migration 1: schemas, deny-by-default privileges, tables, indexes.
-- Down script is at the bottom of this file (commented).

create schema if not exists app_private;
revoke all on schema app_private from public, anon;
grant usage on schema app_private to authenticated, service_role;

-- Deny by default. Supabase grants ALL on new public tables/functions to anon, authenticated and
-- service_role; remove that so every privilege in this project is an explicit decision.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated, service_role;
-- EXECUTE-to-PUBLIC is a global default and can only be removed globally.
alter default privileges for role postgres revoke execute on functions from public;

-- ---------- tenancy ----------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now()
);

-- service-only: org status must not be editable by org members
create table public.org_controls (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 120),
  locale text not null default 'en',
  timezone text not null default 'America/Chicago',
  onboarded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- service-only: everything a user must not be able to change about themselves (D-24)
create table public.account_controls (
  user_id uuid primary key references auth.users (id) on delete cascade,
  trust_level text not null default 'restricted' check (trust_level in ('restricted', 'trusted', 'suspended')),
  approved boolean not null default false,
  admin_trusted boolean not null default false,
  is_platform_admin boolean not null default false,
  daily_envelope_cap int not null default 3 check (daily_envelope_cap >= 0),
  daily_recipient_cap int not null default 5 check (daily_recipient_cap >= 0),
  storage_quota_bytes bigint not null default 52428800 check (storage_quota_bytes >= 0),
  created_at timestamptz not null default now()
);

create table public.memberships (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

create table public.org_settings (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  retention_years int not null default 7 check (retention_years between 1 and 30),
  branding jsonb not null default '{}'::jsonb,
  filing_rules jsonb not null default '[]'::jsonb,
  kill_switch boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.folders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  parent_id uuid references public.folders (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 120),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index folders_unique_name on public.folders (org_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create index folders_parent_idx on public.folders (parent_id);
create index folders_created_by_idx on public.folders (created_by);

-- ---------- envelopes ----------
create table public.envelopes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete restrict,
  sender_id uuid not null references auth.users (id) on delete restrict,
  folder_id uuid references public.folders (id) on delete set null,
  public_code text not null unique check (public_code ~ '^ES-[0-9]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}-[0-9A-HJKMNP-TV-Z]{2}$'),
  title text not null check (char_length(title) between 1 and 200),
  message text not null default '' check (char_length(message) <= 2000),
  status text not null default 'draft' check (status in ('draft', 'sent', 'in_progress', 'completed', 'declined', 'voided', 'expired', 'failed_sealing')),
  routing_mode text not null default 'sequential' check (routing_mode in ('sequential', 'parallel', 'mixed')),
  self_sign boolean not null default false,
  expires_at timestamptz,
  sent_at timestamptz,
  completed_at timestamptz,
  preseal_sha256 text check (preseal_sha256 ~ '^[0-9a-f]{64}$'),
  final_sha256 text check (final_sha256 ~ '^[0-9a-f]{64}$'),
  sealed_at timestamptz,
  sealed_storage_backend text check (sealed_storage_backend in ('supabase', 'disk')),
  sealed_storage_path text,
  certificate_storage_path text,
  audit_seal_seq int,
  audit_seal_hash text check (audit_seal_hash ~ '^[0-9a-f]{64}$'),
  field_layout_sha256 text check (field_layout_sha256 ~ '^[0-9a-f]{64}$'),
  legal_hold boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- "completed" is impossible without a sealed file and its hash
  constraint completed_requires_seal check (status <> 'completed' or (final_sha256 is not null and sealed_at is not null and sealed_storage_path is not null and audit_seal_hash is not null))
);
create index envelopes_org_status_idx on public.envelopes (org_id, status, created_at desc);
create index envelopes_sender_idx on public.envelopes (sender_id);
create index envelopes_folder_idx on public.envelopes (folder_id);

create table public.envelope_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete restrict,
  envelope_id uuid not null references public.envelopes (id) on delete cascade,
  position int not null default 1 check (position >= 1),
  filename text not null check (char_length(filename) between 1 and 255),
  storage_backend text not null default 'supabase' check (storage_backend in ('supabase', 'disk')),
  storage_path text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  page_count int not null check (page_count between 1 and 100),
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  page_boxes jsonb not null,
  created_at timestamptz not null default now(),
  unique (envelope_id, position)
);
create index envelope_documents_org_idx on public.envelope_documents (org_id);

create table public.recipients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete restrict,
  envelope_id uuid not null references public.envelopes (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  email text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 254),
  role text not null default 'signer' check (role in ('signer', 'approver', 'cc', 'viewer', 'in_person')),
  routing_order int not null default 1 check (routing_order >= 1),
  is_sender boolean not null default false,
  status text not null default 'created' check (status in ('created', 'sent', 'viewed', 'consented', 'signed', 'approved', 'declined', 'expired', 'skipped')),
  auth_method text not null default 'link' check (auth_method in ('link', 'access_code', 'email_otp')),
  access_code_hash text,
  decline_reason text check (char_length(decline_reason) <= 1000),
  sent_at timestamptz,
  viewed_at timestamptz,
  consented_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index recipients_envelope_idx on public.recipients (envelope_id, routing_order);
create index recipients_org_idx on public.recipients (org_id);
create unique index recipients_unique_email on public.recipients (envelope_id, lower(email), role);

-- service-only. The token itself is never stored (D-21): only id + nonce + SHA-256(token).
create table public.recipient_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete restrict,
  envelope_id uuid not null references public.envelopes (id) on delete cascade,
  recipient_id uuid not null references public.recipients (id) on delete cascade,
  nonce bytea not null check (octet_length(nonce) = 16),
  token_sha256 bytea not null unique check (octet_length(token_sha256) = 32),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index recipient_tokens_one_active on public.recipient_tokens (recipient_id) where revoked_at is null;
create index recipient_tokens_envelope_idx on public.recipient_tokens (envelope_id);
create index recipient_tokens_org_idx on public.recipient_tokens (org_id);

create table public.fields (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete restrict,
  envelope_id uuid not null references public.envelopes (id) on delete cascade,
  document_id uuid not null references public.envelope_documents (id) on delete cascade,
  recipient_id uuid not null references public.recipients (id) on delete cascade,
  type text not null check (type in ('signature', 'initials', 'date_signed', 'name', 'email', 'company', 'title', 'text')),
  page int not null check (page >= 1),
  x numeric(9, 8) not null check (x >= 0 and x <= 1),
  y numeric(9, 8) not null check (y >= 0 and y <= 1),
  w numeric(9, 8) not null check (w > 0 and w <= 1),
  h numeric(9, 8) not null check (h > 0 and h <= 1),
  required boolean not null default true,
  options jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (x + w <= 1.000001 and y + h <= 1.000001)
);
create index fields_envelope_idx on public.fields (envelope_id);
create index fields_document_idx on public.fields (document_id);
create index fields_recipient_idx on public.fields (recipient_id);
create index fields_org_idx on public.fields (org_id);

create table public.signature_assets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations (id) on delete restrict,
  owner_user_id uuid references auth.users (id) on delete cascade,
  recipient_id uuid references public.recipients (id) on delete cascade,
  kind text not null check (kind in ('signature', 'initials')),
  method text not null check (method in ('drawn', 'typed', 'uploaded')),
  storage_backend text not null default 'supabase' check (storage_backend in ('supabase', 'disk')),
  storage_path text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  typed_text text check (char_length(typed_text) <= 120),
  typed_font text,
  created_at timestamptz not null default now(),
  check (owner_user_id is not null or recipient_id is not null)
);
create index signature_assets_owner_idx on public.signature_assets (owner_user_id);
create index signature_assets_recipient_idx on public.signature_assets (recipient_id);
create index signature_assets_org_idx on public.signature_assets (org_id);

create table public.field_values (
  field_id uuid primary key references public.fields (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete restrict,
  envelope_id uuid not null references public.envelopes (id) on delete cascade,
  recipient_id uuid not null references public.recipients (id) on delete cascade,
  value_text text check (char_length(value_text) <= 2000),
  signature_asset_id uuid references public.signature_assets (id) on delete restrict,
  signature_id text,
  filled_at timestamptz not null default now()
);
create index field_values_envelope_idx on public.field_values (envelope_id);
create index field_values_recipient_idx on public.field_values (recipient_id);
create index field_values_org_idx on public.field_values (org_id);
create index field_values_asset_idx on public.field_values (signature_asset_id);

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete restrict,
  envelope_id uuid not null references public.envelopes (id) on delete cascade,
  recipient_id uuid not null references public.recipients (id) on delete cascade,
  disclosure_version text not null,
  disclosure_sha256 text not null check (disclosure_sha256 ~ '^[0-9a-f]{64}$'),
  ip inet,
  user_agent text check (char_length(user_agent) <= 500),
  given_at timestamptz not null default now(),
  withdrawn_at timestamptz
);
create unique index consents_one_active on public.consents (recipient_id) where withdrawn_at is null;
create index consents_envelope_idx on public.consents (envelope_id);
create index consents_org_idx on public.consents (org_id);

-- ---------- audit (append-only hash chain, D-25) ----------
create table public.audit_events (
  seq bigint generated always as identity primary key,
  id uuid not null unique,
  chain_key text not null,
  chain_seq int not null check (chain_seq >= 1),
  org_id uuid,
  envelope_id uuid,
  recipient_id uuid,
  actor_type text not null check (actor_type in ('user', 'signer', 'system', 'admin')),
  actor_id uuid,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  ip inet,
  user_agent text,
  created_at timestamptz not null,
  canonical text not null,
  prev_hash bytea not null check (octet_length(prev_hash) = 32),
  event_hash bytea not null check (octet_length(event_hash) = 32),
  unique (chain_key, chain_seq)
);
create index audit_events_envelope_idx on public.audit_events (envelope_id, chain_seq);
create index audit_events_org_idx on public.audit_events (org_id, created_at desc);

-- ---------- background work ----------
create table public.seal_jobs (
  envelope_id uuid primary key references public.envelopes (id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempt_id uuid,
  attempts int not null default 0,
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- service-only. Rows never contain a link, token or code (D-21).
create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations (id) on delete cascade,
  envelope_id uuid references public.envelopes (id) on delete cascade,
  recipient_id uuid references public.recipients (id) on delete cascade,
  to_user_id uuid references auth.users (id) on delete cascade,
  sender_user_id uuid references auth.users (id) on delete set null,
  kind text not null,
  priority text not null check (priority in ('P0_AUTH', 'P0_REQUEST', 'P1', 'P2', 'P3')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'deferred', 'failed', 'dead')),
  attempts int not null default 0,
  not_before timestamptz not null default now(),
  locked_until timestamptz,
  idempotency_key text not null unique,
  last_error text,
  provider_message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  check (recipient_id is not null or to_user_id is not null)
);
create index outbox_due_idx on public.notification_outbox (status, not_before) where status in ('queued', 'deferred');
create index outbox_envelope_idx on public.notification_outbox (envelope_id);
create index outbox_recipient_idx on public.notification_outbox (recipient_id);
create index outbox_org_idx on public.notification_outbox (org_id);
create index outbox_to_user_idx on public.notification_outbox (to_user_id);
create index outbox_sender_idx on public.notification_outbox (sender_user_id);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_org_idx on public.notifications (org_id);

create table public.abuse_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  envelope_id uuid not null references public.envelopes (id) on delete cascade,
  reporter_email text,
  reason text not null check (char_length(reason) <= 2000),
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  created_at timestamptz not null default now()
);
create index abuse_reports_envelope_idx on public.abuse_reports (envelope_id);
create index abuse_reports_org_idx on public.abuse_reports (org_id);

-- ---------- platform-level, service-only (no org_id by design, D-33) ----------
create table public.platform_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.registration_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users (id) on delete cascade,
  email text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'invited')),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index registration_requests_email_idx on public.registration_requests (lower(email));
create index registration_requests_decided_by_idx on public.registration_requests (decided_by);

create table public.email_budget (
  day date primary key,
  sent_auth int not null default 0,
  sent_shared int not null default 0,
  restricted_sent int not null default 0,
  provider_closed boolean not null default false
);

create table public.email_budget_user (
  day date not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  sent int not null default 0,
  primary key (day, user_id)
);
create index email_budget_user_user_idx on public.email_budget_user (user_id);

create table public.usage_counters (
  day date not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  envelopes_sent int not null default 0,
  primary key (day, user_id)
);
create index usage_counters_user_idx on public.usage_counters (user_id);

create table public.usage_recipients (
  day date not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  email_hash bytea not null,
  primary key (day, user_id, email_hash)
);
create index usage_recipients_user_idx on public.usage_recipients (user_id);

create table public.rate_limits (
  bucket text not null,
  key_hash bytea not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (bucket, key_hash, window_start)
);
create index rate_limits_window_idx on public.rate_limits (window_start);

create table public.system_health (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.disposable_email_domains (
  domain text primary key check (domain = lower(domain))
);

insert into public.platform_settings (key, value) values
  ('registration_mode', '"approval"'::jsonb),
  ('limits', '{"storage_warn_pct":70,"storage_block_pct":90}'::jsonb)
on conflict (key) do nothing;

-- down (manual, destroys all EasySign data; dev project only):
-- drop table if exists public.disposable_email_domains, public.system_health, public.rate_limits, public.usage_recipients,
--   public.usage_counters, public.email_budget_user, public.email_budget, public.registration_requests, public.platform_settings,
--   public.abuse_reports, public.notifications, public.notification_outbox, public.seal_jobs, public.audit_events, public.consents,
--   public.field_values, public.signature_assets, public.fields, public.recipient_tokens, public.recipients, public.envelope_documents,
--   public.envelopes, public.folders, public.org_settings, public.memberships, public.account_controls, public.profiles,
--   public.org_controls, public.organizations cascade;
-- drop schema if exists app_private cascade;
