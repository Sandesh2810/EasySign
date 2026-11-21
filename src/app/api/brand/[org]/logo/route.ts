// GET /api/brand/<workspace id>/logo — D-88: a workspace's logo, shown on its signer pages. Logos are not secret, but
// only a logo the workspace has set is served, from the server-generated path recorded in the database, with the type
// the server checked on upload (PNG or JPEG), never anything else.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getStorageFor } from '@/storage';

export async function GET(_request: Request, { params }: { params: Promise<{ org: string }> }) {
  const org = z.uuid().safeParse((await params).org);
  if (!org.success) return new NextResponse('Not found', { status: 404 });
  const { data } = await supabaseAdmin().from('org_branding').select('logo_storage_path, logo_content_type').eq('org_id', org.data).maybeSingle();
  if (!data?.logo_storage_path || !data.logo_content_type) return new NextResponse('Not found', { status: 404 });
  try {
    const bytes = await getStorageFor('supabase').get('branding', data.logo_storage_path as string);
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        'Content-Type': data.logo_content_type as string,
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      },
    });
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
