import { describe, it, expect } from 'vitest';
import { openApiDocument } from './openapi';
import { createInput, sendInput } from './schemas';

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
});
