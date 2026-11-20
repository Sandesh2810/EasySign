// GET /api/workspace/export -> everything in the owner's workspace as one ZIP (Phase 3 slice 7, D-72):
// workspace.json (folders, documents, people), and per document its audit trail (JSON, archived parts included) and,
// when completed, the signed PDF and the certificate. Owner only, with an authenticator code from the last 10
// minutes (the same rule as deleting). Recorded in the workspace's audit trail before anything is sent.
import { isIP } from 'node:net';
import { NextResponse, type NextRequest } from 'next/server';
import { DANGEROUS_ACTION_FRESH_SECONDS, usedAuthenticatorWithin } from '@/lib/auth/mfa-policy';
import { mfaStatus } from '@/lib/auth/session';
import { loadAuditTrail } from '@/lib/audit-read';
import { allow, clientIp, TOO_MANY, userAgent } from '@/lib/rate-limit';
import { json, requireApiUser } from '@/lib/request-guard';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { safeZipName, zipStream, ZIP_MAX_FILES, type ZipSource } from '@/lib/zip-stream';
import { getStorageFor } from '@/storage';
import type { Backend } from '@/storage/types';

const MAX_DOCUMENTS = 2000;
const back = (request: NextRequest, path: string) => NextResponse.redirect(new URL(path, request.nextUrl.origin), 303);

export async function GET(request: NextRequest) {
  const auth = await requireApiUser(request, { mutation: false });
  if ('response' in auth) return auth.response;
  const user = auth.user;
  const supabase = await createSupabaseServerClient();
  const { data: m } = await supabase.from('memberships').select('org_id, role, organizations(name)').eq('user_id', user.id).eq('role', 'owner').order('created_at').limit(1).maybeSingle();
  if (!m) return json(403, { error: 'Only the workspace owner can export the workspace.' });
  if (!(await mfaStatus(user.id)).enrolled) return back(request, '/app/settings?export=needs-mfa');
  if (!usedAuthenticatorWithin({ aal: user.aal, amr: user.amr, nowSeconds: Date.now() / 1000, seconds: DANGEROUS_ACTION_FRESH_SECONDS })) {
    return back(request, `/mfa?next=${encodeURIComponent('/app/settings?export=ready')}&fresh=1`);
  }
  if (!(await allow({ bucket: 'workspace_export', limit: 5, windowSeconds: 3600 }, user.id))) return json(429, { error: TOO_MANY });

  const orgId = m.org_id as string;
  const admin = supabaseAdmin();
  const [{ data: folders }, { data: docs }] = await Promise.all([
    admin.from('folders').select('id, name, parent_id').eq('org_id', orgId).order('name'),
    admin
      .from('envelopes')
      .select('id, title, status, public_code, created_at, completed_at, folder_id, final_sha256, deleted_at, sealed_storage_backend, sealed_storage_path, certificate_storage_path')
      .eq('org_id', orgId)
      .order('created_at')
      .limit(MAX_DOCUMENTS + 1),
  ]);
  const list = docs ?? [];
  if (list.length > MAX_DOCUMENTS || list.length * 3 + 1 > ZIP_MAX_FILES) return json(413, { error: `A workspace with more than ${MAX_DOCUMENTS} documents cannot be exported in one file yet.` });
  const { data: people } = list.length
    ? await admin.from('recipients').select('envelope_id, name, email, role, status, routing_order').in('envelope_id', list.map((d) => d.id as string)).order('routing_order')
    : { data: [] };

  const ip = await clientIp();
  const logged = await admin.rpc('record_workspace_export', { p_actor: user.id, p_org: orgId, p_documents: list.length, p_ip: isIP(ip) ? ip : null, p_user_agent: await userAgent() });
  if (logged.error) return json(502, { error: 'The export could not be recorded, so it was not given out. Try again.' });

  const org = Array.isArray(m.organizations) ? m.organizations[0] : m.organizations;
  const dirOf = (d: { public_code: unknown }) => `documents/${String(d.public_code)}`;
  const manifest = {
    format: 'younmesign-workspace-export',
    v: 1,
    generated_at: new Date().toISOString(),
    workspace: { id: orgId, name: (org as { name?: string } | null)?.name ?? null },
    folders: folders ?? [],
    documents: list.map((d) => ({
      id: d.id,
      public_code: d.public_code,
      title: d.title,
      status: d.status,
      created_at: d.created_at,
      completed_at: d.completed_at,
      deleted_at: d.deleted_at,
      folder_id: d.folder_id,
      final_sha256: d.final_sha256,
      people: (people ?? []).filter((p) => p.envelope_id === d.id).map((p) => ({ name: p.name, email: p.email, role: p.role, status: p.status, routing_order: p.routing_order })),
      files: d.status === 'draft' ? [] : [`${dirOf(d)}/audit.json`, ...(d.status === 'completed' && !d.deleted_at ? [`${dirOf(d)}/signed.pdf`, `${dirOf(d)}/certificate.pdf`] : [])],
    })),
  };

  async function* sources(): AsyncGenerator<ZipSource> {
    yield { name: 'workspace.json', load: async () => new TextEncoder().encode(JSON.stringify(manifest, null, 2)) };
    for (const d of list) {
      if (d.status === 'draft') continue;
      const dir = safeZipName(dirOf(d));
      yield {
        name: `${dir}/audit.json`,
        load: async () => {
          const trail = await loadAuditTrail(d.id as string);
          return new TextEncoder().encode(
            JSON.stringify({ chain: { key: trail.chainKey, events: trail.rows.length, head: trail.verify.head, verified: trail.verify.ok }, events: trail.rows }, null, 2),
          );
        },
      };
      if (d.status === 'completed' && !d.deleted_at && d.sealed_storage_path && d.certificate_storage_path) {
        const storage = getStorageFor(d.sealed_storage_backend as Backend);
        yield { name: `${dir}/signed.pdf`, load: () => storage.get('sealed', d.sealed_storage_path as string) };
        yield { name: `${dir}/certificate.pdf`, load: () => storage.get('sealed', d.certificate_storage_path as string) };
      }
    }
  }

  const stream = zipStream(sources(), (e) => console.error(`workspace export stopped: ${e instanceof Error ? e.message : 'unknown error'}`));
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="workspace export ${new Date().toISOString().slice(0, 10)}.zip"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
