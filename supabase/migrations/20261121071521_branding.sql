-- D-88 (Phase 4 slice 12, AT4.8): workspace branding. A brand colour with light or dark text on it (the pair must reach
-- WCAG AA contrast, 4.5:1, checked here as well as on the page), an optional PNG or JPEG logo (stored in the private
-- "branding" bucket), and an email footer. Shown on signer pages and in emails for that workspace's documents; the
-- signing surface itself stays neutral. Only the workspace's owner or an administrator can change it. New objects only.

create table public.org_branding (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  brand_color text not null check (brand_color ~ '^#[0-9A-F]{6}$'),
  text_on_brand text not null check (text_on_brand in ('light', 'dark')),
  email_footer text check (char_length(email_footer) <= 500),
  logo_storage_path text check (logo_storage_path is null or logo_storage_path ~ '^[0-9a-f-]{36}/logo/[0-9a-f-]{36}\.(png|jpg)$'),
  logo_sha256 text check (logo_sha256 is null or logo_sha256 ~ '^[0-9a-f]{64}$'),
  logo_content_type text check (logo_content_type is null or logo_content_type in ('image/png', 'image/jpeg')),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  check ((logo_storage_path is null) = (logo_sha256 is null) and (logo_storage_path is null) = (logo_content_type is null))
);
alter table public.org_branding enable row level security;
create policy org_branding_deny_all on public.org_branding for all to anon, authenticated using (false) with check (false);
revoke all on public.org_branding from anon, authenticated;
grant select, insert, update, delete on public.org_branding to service_role;

-- WCAG 2.x contrast ratio of two "#RRGGBB" colours, rounded down to 2 decimals (the same rule as src/lib/branding.ts)
create function app_private.wcag_contrast(p_a text, p_b text) returns numeric
language plpgsql immutable set search_path = '' as $$
declare
  la float8;
  lb float8;
  ch float8;
  n int;
  i int;
  lum float8[] := array[0, 0];
  hex text[] := array[p_a, p_b];
begin
  for i in 1..2 loop
    n := ('x' || lpad(substr(hex[i], 2, 6), 8, '0'))::bit(32)::int;
    lum[i] := 0;
    for ch, la in select v, w from (values (((n >> 16) & 255) / 255.0, 0.2126), (((n >> 8) & 255) / 255.0, 0.7152), ((n & 255) / 255.0, 0.0722)) as t(v, w) loop
      lum[i] := lum[i] + la * case when ch <= 0.03928 then ch / 12.92 else power((ch + 0.055) / 1.055, 2.4) end;
    end loop;
  end loop;
  la := greatest(lum[1], lum[2]);
  lb := least(lum[1], lum[2]);
  return floor(((la + 0.05) / (lb + 0.05) * 100)::numeric) / 100;
end
$$;
revoke all on function app_private.wcag_contrast(text, text) from public, anon, authenticated, service_role;

create function app_private.branding_admin(p_actor uuid, p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_actor is not null and app_private.member_role(p_actor, p_org) in ('owner', 'admin'), false)
$$;
revoke all on function app_private.branding_admin(uuid, uuid) from public, anon, authenticated, service_role;

create function public.set_org_branding(p_actor uuid, p_org uuid, p_color text, p_text text, p_footer text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_color text := upper(btrim(coalesce(p_color, '')));
  v_ratio numeric;
begin
  if not app_private.branding_admin(p_actor, p_org) then
    raise exception 'ES_NOT_FOUND: workspace not found' using errcode = '42501';
  end if;
  perform app_private.require_not_suspended(p_actor, p_org);
  if v_color !~ '^#[0-9A-F]{6}$' or p_text not in ('light', 'dark') then
    raise exception 'ES_COLOR: choose a colour as six hexadecimal digits and light or dark text' using errcode = '22023';
  end if;
  v_ratio := app_private.wcag_contrast(v_color, case p_text when 'light' then '#FFFFFF' else '#1A1818' end);
  if v_ratio < 4.5 then
    raise exception 'ES_CONTRAST: % text on % would be hard to read (contrast %:1; at least 4.5:1 is needed)',
      case p_text when 'light' then 'light' else 'dark' end, v_color, v_ratio using errcode = '22023';
  end if;
  if p_footer is not null and (char_length(p_footer) > 500 or p_footer ~ '[\x01-\x09\x0b-\x1f\x7f]') then
    raise exception 'ES_FOOTER: the email footer is plain text of up to 500 characters' using errcode = '22023';
  end if;
  insert into public.org_branding (org_id, brand_color, text_on_brand, email_footer, updated_by)
    values (p_org, v_color, p_text, nullif(btrim(p_footer), ''), p_actor)
    on conflict (org_id) do update set brand_color = excluded.brand_color, text_on_brand = excluded.text_on_brand,
      email_footer = excluded.email_footer, updated_at = now(), updated_by = p_actor;
  perform app_private.audit_append('org:' || p_org::text, p_org, null, null, 'user', p_actor, 'branding_changed',
    jsonb_build_object('brand_color', v_color, 'text_on_brand', p_text, 'contrast', v_ratio, 'footer_chars', char_length(coalesce(btrim(p_footer), ''))));
end
$$;

-- a new logo (path, fingerprint, type); returns the old logo's path so the app can remove the file
create function public.set_org_logo(p_actor uuid, p_org uuid, p_path text, p_sha256 text, p_type text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  b public.org_branding;
begin
  if not app_private.branding_admin(p_actor, p_org) then
    raise exception 'ES_NOT_FOUND: workspace not found' using errcode = '42501';
  end if;
  perform app_private.require_not_suspended(p_actor, p_org);
  select * into b from public.org_branding x where x.org_id = p_org for update;
  if not found then
    raise exception 'ES_NO_BRANDING: save a brand colour first' using errcode = '22023';
  end if;
  if p_path is not null and (split_part(p_path, '/', 1) <> p_org::text) then
    raise exception 'invalid logo path' using errcode = '22023';
  end if;
  update public.org_branding x set logo_storage_path = p_path, logo_sha256 = p_sha256, logo_content_type = p_type, updated_at = now(), updated_by = p_actor
   where x.org_id = p_org;
  perform app_private.audit_append('org:' || p_org::text, p_org, null, null, 'user', p_actor, case when p_path is null then 'branding_logo_removed' else 'branding_logo_changed' end,
    jsonb_build_object('logo_sha256', p_sha256));
  return b.logo_storage_path;
end
$$;

-- branding switched off; returns the logo's path so the app can remove the file
create function public.clear_org_branding(p_actor uuid, p_org uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  b public.org_branding;
begin
  if not app_private.branding_admin(p_actor, p_org) then
    raise exception 'ES_NOT_FOUND: workspace not found' using errcode = '42501';
  end if;
  delete from public.org_branding x where x.org_id = p_org returning * into b;
  if b.org_id is not null then
    perform app_private.audit_append('org:' || p_org::text, p_org, null, null, 'user', p_actor, 'branding_removed', '{}'::jsonb);
  end if;
  return b.logo_storage_path;
end
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.set_org_branding(uuid, uuid, text, text, text)',
    'public.set_org_logo(uuid, uuid, text, text, text)',
    'public.clear_org_branding(uuid, uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- down:
-- drop function public.clear_org_branding(uuid, uuid); drop function public.set_org_logo(uuid, uuid, text, text, text);
-- drop function public.set_org_branding(uuid, uuid, text, text, text); drop function app_private.branding_admin(uuid, uuid);
-- drop function app_private.wcag_contrast(text, text); drop table public.org_branding;
