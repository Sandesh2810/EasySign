// POST /api/v1/documents/<id>/send — D-90: send a draft (needs documents:send). Accepts an Idempotency-Key.
import { z } from 'zod';
import { apiError, apiJson, authenticate, idempotent, readBody } from '@/lib/api/http';
import { ApiFailure, sendAnswerReplay, sendAnswerToStore, sendDocument, sendInput } from '@/lib/api/documents';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // D-98: the (capped) body is read before the key is checked: answering 401/403 while the caller is still sending
  // can reset the connection, so the caller would see a network error instead of the refusal
  const read = await readBody(request, 16 * 1024);   // refused before reading when declared too big
  if ('response' in read) return read.response;
  const auth = await authenticate(request, 'documents:send');
  if ('response' in auth) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError(404, 'not_found', 'Document not found.');
  const body = read.text;
  return idempotent(auth.ctx, request, `/api/v1/documents/${id.data}/send`, body, async () => {
    let json: unknown;
    try {
      json = body.trim() ? JSON.parse(body) : {};
    } catch {
      return apiError(400, 'bad_request', 'The body must be JSON.');
    }
    const parsed = sendInput.safeParse(json);
    if (!parsed.success) return apiError(400, 'bad_request', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ').slice(0, 500));
    try {
      return apiJson(200, await sendDocument(auth.ctx, id.data, parsed.data));
    } catch (e) {
      if (e instanceof ApiFailure) return apiError(e.status, e.code, e.message, e.headers);
      return apiError(500, 'server_error', 'Something went wrong. Try again.');
    }
  }, {
    // D-98: signing links are never stored; a replay gets them again from the database
    store: sendAnswerToStore,
    replay: (stored) => sendAnswerReplay(auth.ctx, id.data, stored),
  });
}
