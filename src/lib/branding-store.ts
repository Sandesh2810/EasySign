// D-88: a workspace's branding, as signer pages and emails use it. Server-only (the web app and the worker).
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { TEXT_COLOR, type TextOnBrand } from '@/lib/branding';

export interface WorkspaceBrand {
  orgId: string;
  name: string;
  color: string;
  textColor: string;
  footer: string | null;
  /** changes whenever the logo does, so the logo address changes with it (no stale cached image) */
  logoVersion: string | null;
}

/** The branding of a workspace, or null when it has none (then the plain YouNMeSign look is used). */
export async function loadBrand(orgId: string): Promise<WorkspaceBrand | null> {
  const db = supabaseAdmin();
  const [{ data: b }, { data: org }] = await Promise.all([
    db.from('org_branding').select('brand_color, text_on_brand, email_footer, logo_sha256').eq('org_id', orgId).maybeSingle(),
    db.from('organizations').select('name').eq('id', orgId).maybeSingle(),
  ]);
  if (!b) return null;
  return {
    orgId,
    name: (org?.name as string | undefined) ?? '',
    color: b.brand_color as string,
    textColor: TEXT_COLOR[b.text_on_brand as TextOnBrand],
    footer: (b.email_footer as string | null) ?? null,
    logoVersion: b.logo_sha256 ? (b.logo_sha256 as string).slice(0, 16) : null,
  };
}
