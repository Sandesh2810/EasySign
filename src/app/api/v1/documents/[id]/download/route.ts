// GET /api/v1/documents/<id>/download?part=sealed|certificate — D-90: the completed document (needs documents:read).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, authenticate } from '@/lib/api/http';
import { ApiFailure, downloadDocument } from '@/lib/api/documents';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, 'documents:read');
  if ('response' in auth) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError(404, 'not_found', 'Document not found.');
  const part = new URL(request.url).searchParams.get('part') ?? 'sealed';
  if (part !== 'sealed' && part !== 'certificate') return apiError(400, 'bad_request', 'part must be "sealed" or "certificate".');
  try {
    const file = await downloadDocument(auth.ctx, id.data, part);
    return new NextResponse(Buffer.from(file.bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    if (e instanceof ApiFailure) return apiError(e.status, e.code, e.message);
    return apiError(500, 'server_error', 'Something went wrong. Try again.');
  }
}
