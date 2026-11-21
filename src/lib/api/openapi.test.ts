import { describe, it, expect } from 'vitest';
import { openApiDocument } from './openapi';
import { createInput, DOCUMENT_EVENTS, sendInput, webhookEvent } from './schemas';
import { WEBHOOK_EVENTS } from '@/lib/webhooks/events';

const doc = openApiDocument('https://example.test') as {
  openapi: string;
  servers: { url: string }[];
  paths: Record<string, Record<string, { operationId: string; responses: Record<string, unknown> }>>;
  components: { schemas: Record<string, Record<string, unknown>> };
};

function refs(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => refs(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === '$ref' && typeof x === 'string') out.push(x);
      else refs(x, out);
    }
  }
  return out;
}

describe('OpenAPI document (D-91)', () => {
  it('describes every operation of the API', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers[0].url).toBe('https://example.test/api/v1');
    const ops = Object.entries(doc.paths).flatMap(([p, methods]) => Object.entries(methods).map(([m, o]) => `${m.toUpperCase()} ${p} ${o.operationId}`));
    expect(ops.sort()).toEqual(
      ['GET /documents/{id} getDocument', 'GET /documents/{id}/download downloadDocument', 'GET /templates listTemplates', 'POST /documents createDocument', 'POST /documents/{id}/send sendDocument'].sort(),
    );
    for (const methods of Object.values(doc.paths)) for (const o of Object.values(methods)) expect(Object.keys(o.responses)).toContain('401');
  });

  it('every reference points at a schema that exists, and none keeps Zod-only fields', () => {
    const all = refs(doc);
    expect(all.length).toBeGreaterThan(10);
    for (const r of all) {
      expect(r).toMatch(/^#\/components\/schemas\/[A-Za-z]+$/);
      expect(doc.components.schemas[r.split('/').pop()!]).toBeTruthy();
    }
    for (const s of Object.values(doc.components.schemas)) {
      expect(s.id).toBeUndefined();
      expect(s.$schema).toBeUndefined();
    }
  });

  it('request schemas say what the code accepts', () => {
    const create = doc.components.schemas.CreateDocument as { required: string[]; properties: Record<string, unknown> };
    expect(create.required.sort()).toEqual(['people', 'template_id']);
    expect(Object.keys(create.properties).sort()).toEqual(['people', 'template_id', 'title']);
    const send = doc.components.schemas.SendDocument as { required: string[] };
    expect(send.required).toEqual(['delivery']); // expires_in_days has a default, so it is optional to send
    expect(createInput.safeParse({ template_id: '6f1c3c9e-6f3b-4c55-9a52-2c8c9e1b2a10', people: [{ role: 'Tenant', name: 'A', email: 'a@example.test' }] }).success).toBe(true);
    expect(sendInput.parse({ delivery: 'link' })).toEqual({ delivery: 'link', expires_in_days: 30 });
  });

  it('responses are strict: a field the code does not send would be a contract failure', () => {
    for (const name of ['Document', 'Person', 'TemplateList', 'SendResult', 'Error']) {
      expect((doc.components.schemas[name] as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    }
  });

  it('describes the webhooks (D-92): three payloads, the signature headers, strict schemas, the same events as the code', () => {
    const hooks = (doc as unknown as { webhooks: Record<string, { post: { parameters: { name: string }[]; requestBody: { content: Record<string, { schema: { $ref: string } }> } } }> }).webhooks;
    expect(Object.keys(hooks).sort()).toEqual(['documentEvent', 'personEvent', 'testEvent']);
    for (const h of Object.values(hooks)) {
      expect(h.post.parameters.map((p) => p.name)).toEqual(['webhook-id', 'webhook-timestamp', 'webhook-signature']);
      expect(doc.components.schemas[h.post.requestBody.content['application/json'].schema.$ref.split('/').pop()!]).toBeTruthy();
    }
    for (const name of ['DocumentEvent', 'PersonEvent', 'TestEvent', 'WebhookDocument']) expect((doc.components.schemas[name] as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    expect([...DOCUMENT_EVENTS, 'person.completed'].sort()).toEqual([...WEBHOOK_EVENTS].sort());
    const ok = webhookEvent.safeParse({ type: 'document.completed', timestamp: '2026-11-21T03:40:12.123456+00:00', data: { document: { id: '6f1c3c9e-6f3b-4c55-9a52-2c8c9e1b2a10', title: 'T', status: 'completed', verification_code: 'ES-2611-AAAA-BBBB-CCCC-DD', sent_at: null, completed_at: null, sealed: true } } });
    expect(ok.success).toBe(true);
    expect(webhookEvent.safeParse({ type: 'document.deleted', timestamp: 'x', data: {} }).success).toBe(false);
  });
});
