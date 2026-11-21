// POST /api/v1/documents — D-90: a new draft from a template (needs documents:write). Accepts an Idempotency-Key.
import { apiError, apiJson, authenticate, idempotent } from '@/lib/api/http';
import { ApiFailure, createFromTemplate, createInput } from '@/lib/api/documents';

export async function POST(request: Request) {
  const auth = await authenticate(request, 'documents:write');
  if ('response' in auth) return auth.response;
  const body = await request.text();
  if (body.length > 64 * 1024) return apiError(413, 'too_large', 'The request body can be up to 64 KB.');
  return idempotent(auth.ctx, request, '/api/v1/documents', body, async () => {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return apiError(400, 'bad_request', 'The body must be JSON.');
    }
    const parsed = createInput.safeParse(json);
    if (!parsed.success) return apiError(400, 'bad_request', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ').slice(0, 500));
    try {
      return apiJson(201, await createFromTemplate(auth.ctx, parsed.data));
    } catch (e) {
      if (e instanceof ApiFailure) return apiError(e.status, e.code, e.message);
      return apiError(500, 'server_error', 'Something went wrong. Try again.');
    }
  });
}
