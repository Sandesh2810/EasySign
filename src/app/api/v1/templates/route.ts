// GET /api/v1/templates — D-90: the templates this key's creator may use, with their roles (needs documents:read).
import { apiError, apiJson, authenticate } from '@/lib/api/http';
import { ApiFailure, listTemplates } from '@/lib/api/documents';

export async function GET(request: Request) {
  const auth = await authenticate(request, 'documents:read');
  if ('response' in auth) return auth.response;
  try {
    return apiJson(200, { templates: await listTemplates(auth.ctx) });
  } catch (e) {
    if (e instanceof ApiFailure) return apiError(e.status, e.code, e.message);
    return apiError(500, 'server_error', 'Something went wrong. Try again.');
  }
}
