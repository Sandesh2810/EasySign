// GET /api/v1/documents/<id> — D-90: a document's status and its people (needs documents:read).
import { z } from 'zod';
import { apiError, apiJson, authenticate } from '@/lib/api/http';
import { ApiFailure, viewDocument } from '@/lib/api/documents';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, 'documents:read');
  if ('response' in auth) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError(404, 'not_found', 'Document not found.');
  try {
    return apiJson(200, await viewDocument(auth.ctx, id.data));
  } catch (e) {
    if (e instanceof ApiFailure) return apiError(e.status, e.code, e.message);
    return apiError(500, 'server_error', 'Something went wrong. Try again.');
  }
}
