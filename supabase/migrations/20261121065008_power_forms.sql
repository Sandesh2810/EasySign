-- D-87 (Phase 4 slice 11, AT4.3): PowerForms. A public link on a one-person template: whoever opens it gives their name
-- and email, gets their own document made from the template, and signs it at once. Defences (no paid service, D-87):
-- the form's daily limit (counted under a row lock, so simultaneous visitors cannot pass it), 3 per email address per
-- form per day, per-IP limits and a hidden trap field in the app, the owner's own daily caps when the document is sent.
-- New objects only.

create table public.power_forms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  template_id uuid not null references public.templates (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120 and title = btrim(title)),
  slug text not null unique check (slug ~ '^[A-Za-z0-9_-]{22}$'),
  status text not null default 'active' check (status in ('active', 'paused')),
  daily_limit int not null default 50 check (daily_limit between 1 and 500),
  email_check boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index power_forms_template_idx on public.power_forms (template_id);

create table public.power_form_submissions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.power_forms (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  envelope_id uuid references public.envelopes (id) on delete set null,
  status text not null default 'started' check (status in ('started', 'sent', 'failed')),
  reason text check (char_length(reason) <= 500),
  ip_sha256 text not null check (ip_sha256 ~ '^[0-9a-f]{64}$'),
  email_sha256 text not null check (email_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index power_form_submissions_form_idx on public.power_form_submissions (form_id, created_at);
create index power_form_submissions_email_idx on public.power_form_submissions (form_id, email_sha256, created_at);

do $$
declare t text;
begin
  foreach t in array array['power_forms', 'power_form_submissions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to anon, authenticated using (false) with check (false)', t || '_deny_all', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end
$$;

-- who may pause, resume or see the numbers of a form: its maker, or the workspace's owner or an administrator.
-- Always true or false (never NULL: see D-85's bulk_access fix).
create function app_private.power_form_manage(p_actor uuid, p_form public.power_forms) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_actor is not null
    and (p_form.created_by = p_actor or app_private.member_role(p_actor, p_form.org_id) in ('owner', 'admin')), false)
$$;
revoke all on function app_private.power_form_manage(uuid, public.power_forms) from public, anon, authenticated, service_role;

-- the one role of a template a public form can fill (a signer), or null
create function app_private.power_form_role(p_template_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select case when count(*) = 1 and bool_and(r.role = 'signer') then (array_agg(r.id))[1] end
    from public.template_roles r where r.template_id = p_template_id
$$;
revoke all on function app_private.power_form_role(uuid) from public, anon, authenticated, service_role;

-- ---------- the owner ----------
create function public.create_power_form(p_actor uuid, p_template_id uuid, p_title text, p_daily_limit int, p_email_check boolean, p_slug text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t public.templates;
  v_id uuid;
begin
  select * into t from public.templates x where x.id = p_template_id;
  if not found or app_private.template_access(p_actor, p_template_id) is null then
    raise exception 'ES_NOT_FOUND: template not found' using errcode = '42501';
  end if;
  perform app_private.require_not_suspended(p_actor, t.org_id);
  if not coalesce((select c.approved from public.account_controls c where c.user_id = p_actor), false) then
    raise exception 'ES_NOT_APPROVED: your account must be approved before you can publish a public form' using errcode = '42501';
  end if;
  if app_private.power_form_role(p_template_id) is null then
    raise exception 'ES_ONE_SIGNER: a public form needs a template with exactly one person, who signs' using errcode = '22023';
  end if;
  if p_title is null or btrim(p_title) = '' or char_length(btrim(p_title)) > 120 then
    raise exception 'ES_TITLE: give the form a title of up to 120 characters' using errcode = '22023';
  end if;
  if p_daily_limit is null or p_daily_limit not between 1 and 500 then
    raise exception 'ES_LIMIT: the daily limit must be between 1 and 500' using errcode = '22023';
  end if;
  if (select count(*) from public.power_forms f where f.template_id = p_template_id) >= 20 then
    raise exception 'ES_TOO_MANY: a template can have up to 20 public forms' using errcode = '22023';
  end if;
  insert into public.power_forms (org_id, template_id, created_by, title, slug, daily_limit, email_check)
    values (t.org_id, p_template_id, p_actor, btrim(p_title), p_slug, p_daily_limit, coalesce(p_email_check, false))
    returning id into v_id;
  perform app_private.audit_append('org:' || t.org_id::text, t.org_id, null, null, 'user', p_actor, 'power_form_created',
    jsonb_build_object('form_id', v_id, 'template_id', p_template_id, 'title', btrim(p_title), 'daily_limit', p_daily_limit, 'email_check', coalesce(p_email_check, false)));
  return v_id;
end
$$;

create function public.set_power_form_status(p_actor uuid, p_form_id uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  f public.power_forms;
begin
  select * into f from public.power_forms x where x.id = p_form_id for update;
  if not found or not app_private.power_form_manage(p_actor, f) then
    raise exception 'ES_NOT_FOUND: form not found' using errcode = '42501';
  end if;
  if p_status not in ('active', 'paused') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  update public.power_forms x set status = p_status, updated_at = now() where x.id = f.id;
  perform app_private.audit_append('org:' || f.org_id::text, f.org_id, null, null, 'user', p_actor, 'power_form_' || case p_status when 'active' then 'resumed' else 'paused' end,
    jsonb_build_object('form_id', f.id));
end
$$;

-- the forms of a template this person may see (anyone who may use the template), with today's and all-time counts
create function public.power_form_list(p_actor uuid, p_template_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if app_private.template_access(p_actor, p_template_id) is null then
    raise exception 'ES_NOT_FOUND: template not found' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', f.id, 'title', f.title, 'slug', f.slug, 'status', f.status, 'daily_limit', f.daily_limit, 'email_check', f.email_check,
             'created_at', f.created_at, 'can_manage', app_private.power_form_manage(p_actor, f),
             'sent_today', (select count(*) from public.power_form_submissions s where s.form_id = f.id and s.status = 'sent'
                             and s.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'),
             'sent_total', (select count(*) from public.power_form_submissions s where s.form_id = f.id and s.status = 'sent'))
           order by f.created_at desc)
      from public.power_forms f where f.template_id = p_template_id), '[]'::jsonb);
end
$$;

-- ---------- the public ----------
-- what the public page may show about a form: only for an open form, only who it is from and what it is
create function public.power_form_public(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  f public.power_forms;
begin
  if p_slug !~ '^[A-Za-z0-9_-]{22}$' then return null; end if;
  select * into f from public.power_forms x where x.slug = p_slug;
  if not found or f.status <> 'active'
     or not exists (select 1 from public.templates t where t.id = f.template_id and t.deleted_at is null)
     or app_private.power_form_role(f.template_id) is null then
    return null;
  end if;
  return jsonb_build_object('title', f.title, 'email_check', f.email_check,
    'owner_name', coalesce((select nullif(btrim(p.display_name), '') from public.profiles p where p.id = f.created_by), 'A YouNMeSign user'),
    'org_name', (select o.name from public.organizations o where o.id = f.org_id));
end
$$;

-- a visitor submits: checks the form is open and within its limits, counted under the form's row lock so simultaneous
-- visitors cannot pass the daily limit, and records the attempt. The app then makes and sends the document.
create function public.power_form_begin(p_slug text, p_ip_sha256 text, p_email_sha256 text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f public.power_forms;
  v_role uuid;
  v_day timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_id uuid;
begin
  if p_slug !~ '^[A-Za-z0-9_-]{22}$' then
    raise exception 'ES_FORM_CLOSED: this form is not accepting submissions' using errcode = '22023';
  end if;
  select * into f from public.power_forms x where x.slug = p_slug for update;
  v_role := case when found then app_private.power_form_role(f.template_id) end;
  if f.id is null or f.status <> 'active' or v_role is null
     or not exists (select 1 from public.templates t where t.id = f.template_id and t.deleted_at is null)
     or exists (select 1 from public.account_controls c where c.user_id = f.created_by and c.trust_level = 'suspended')
     or exists (select 1 from public.org_controls o where o.org_id = f.org_id and o.status = 'suspended') then
    raise exception 'ES_FORM_CLOSED: this form is not accepting submissions' using errcode = '22023';
  end if;
  if (select count(*) from public.power_form_submissions s where s.form_id = f.id and s.status <> 'failed' and s.created_at >= v_day) >= f.daily_limit then
    raise exception 'ES_FORM_FULL: this form has reached its limit for today; try again tomorrow' using errcode = '22023';
  end if;
  if (select count(*) from public.power_form_submissions s where s.form_id = f.id and s.email_sha256 = p_email_sha256 and s.status <> 'failed' and s.created_at >= v_day) >= 3 then
    raise exception 'ES_FORM_EMAIL_LIMIT: this email address has used this form 3 times today; try again tomorrow' using errcode = '22023';
  end if;
  insert into public.power_form_submissions (form_id, org_id, ip_sha256, email_sha256) values (f.id, f.org_id, p_ip_sha256, p_email_sha256) returning id into v_id;
  return jsonb_build_object('submission_id', v_id, 'form_id', f.id, 'template_id', f.template_id, 'role_id', v_role, 'owner_id', f.created_by,
    'org_id', f.org_id, 'title', f.title, 'email_check', f.email_check);
end
$$;

-- the outcome of a submission; a sent one is also recorded in the new document's audit trail
create function public.power_form_finish(p_submission_id uuid, p_envelope_id uuid, p_ok boolean, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.power_form_submissions;
  f public.power_forms;
begin
  select * into s from public.power_form_submissions x where x.id = p_submission_id for update;
  if not found or s.status <> 'started' then return; end if;
  update public.power_form_submissions x set status = case when p_ok then 'sent' else 'failed' end, envelope_id = p_envelope_id, reason = left(p_reason, 500)
   where x.id = s.id;
  if p_ok and p_envelope_id is not null then
    select * into f from public.power_forms x where x.id = s.form_id;
    perform app_private.audit_append('env:' || p_envelope_id::text, s.org_id, p_envelope_id, null, 'system', null, 'created_from_public_form',
      jsonb_build_object('form_id', f.id, 'form_title', f.title, 'ip_sha256', s.ip_sha256));
  end if;
end
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.create_power_form(uuid, uuid, text, int, boolean, text)',
    'public.set_power_form_status(uuid, uuid, text)',
    'public.power_form_list(uuid, uuid)',
    'public.power_form_public(text)',
    'public.power_form_begin(text, text, text)',
    'public.power_form_finish(uuid, uuid, boolean, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- down:
-- drop function public.power_form_finish(uuid, uuid, boolean, text); drop function public.power_form_begin(text, text, text);
-- drop function public.power_form_public(text); drop function public.power_form_list(uuid, uuid);
-- drop function public.set_power_form_status(uuid, uuid, text); drop function public.create_power_form(uuid, uuid, text, int, boolean, text);
-- drop function app_private.power_form_role(uuid); drop function app_private.power_form_manage(uuid, public.power_forms);
-- drop table public.power_form_submissions; drop table public.power_forms;
