import type { Metadata } from 'next';
import Link from 'next/link';
import { PRODUCT_NAME } from '@/config/brand';
import { env } from '@/lib/env';
import { openApiDocument } from '@/lib/api/openapi';
import { API_RATE } from '@/lib/api/limits';

export const metadata: Metadata = { title: 'API for developers' };

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; enum?: unknown[]; description?: string; $ref?: string; items?: Schema; anyOf?: Schema[]; default?: unknown; format?: string };
type Op = { operationId: string; summary: string; description: string; parameters?: { name: string; in: string; required?: boolean; description?: string }[]; requestBody?: { content: Record<string, { schema: Schema }> }; responses: Record<string, { description: string }> };

// D-91: the API documentation, rendered from the same OpenAPI document as /api/v1/openapi.json.
export default function DevelopersPage() {
  const base = env.appUrl();
  const doc = openApiDocument(base) as { paths: Record<string, Record<string, Op>>; components: { schemas: Record<string, Schema> } };
  const schemas = doc.components.schemas;
  const typeOf = (s: Schema): string => {
    if (s.$ref) return s.$ref.split('/').pop() ?? 'object';
    if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
    if (s.anyOf) return s.anyOf.map(typeOf).join(' | ');
    if (s.type === 'array' && s.items) return `${typeOf(s.items)}[]`;
    return [Array.isArray(s.type) ? s.type.join(' | ') : s.type, s.format].filter(Boolean).join(', ') || 'value';
  };
  const fields = (name: string) => {
    const s = schemas[name];
    return Object.entries(s.properties ?? {}).map(([k, v]) => ({ name: k, type: typeOf(v), required: (s.required ?? []).includes(k), note: [v.description, v.default !== undefined ? `default ${JSON.stringify(v.default)}` : ''].filter(Boolean).join(' ') }));
  };
  return (
    <div className="min-h-dvh bg-surface-sand">
      <header className="px-6 py-5">
        <Link href="/" className="text-lg font-medium text-ink no-underline">
          {PRODUCT_NAME}
        </Link>
      </header>
      <main id="main" className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pb-16">
        <h1 className="text-2xl font-medium text-ink">API for developers</h1>
        <section className="rounded-lg bg-surface p-6 shadow-soft">
          <h2 className="mb-2 text-base font-medium text-ink">The basics</h2>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-base text-ink-body">
            <li>
              Base address: <code className="font-mono text-sm">{base}/api/v1</code>. Machine-readable description:{' '}
              <a href="/api/v1/openapi.json">openapi.json</a> (OpenAPI 3.1).
            </li>
            <li>
              Make a key in <strong>Settings → API keys</strong> (workspace owners and administrators), choose what it may do, and send it as <code className="font-mono text-sm">Authorization: Bearer ynms_…</code>. A key acts as the person who made it.
            </li>
            <li>At most {API_RATE.limit} requests a minute per key; above that the answer is 429 with a Retry-After header in seconds. The person&apos;s daily sending limits apply too.</li>
            <li>
              Writes accept an <code className="font-mono text-sm">Idempotency-Key</code> header: a retry with the same key and body within 24 hours gets the first answer, never a second document.
            </li>
            <li>
              Errors are <code className="font-mono text-sm">{'{ "error": { "code": "…", "message": "…" } }'}</code>. Anything the key may not see answers 404.
            </li>
          </ul>
        </section>
        {Object.entries(doc.paths).flatMap(([p, methods]) =>
          Object.entries(methods).map(([method, op]) => {
            const body = op.requestBody?.content['application/json']?.schema.$ref?.split('/').pop();
            const ok = Object.entries(op.responses).find(([c]) => c.startsWith('2'));
            return (
              <section key={op.operationId} className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby={`op-${op.operationId}`}>
                <h2 id={`op-${op.operationId}`} className="text-base font-medium text-ink">
                  <code className="font-mono">
                    {method.toUpperCase()} {p}
                  </code>
                </h2>
                <p className="mt-1 text-base text-ink">{op.summary}</p>
                <p className="mt-1 text-sm text-ink-body">{op.description}</p>
                {op.parameters?.length ? (
                  <dl className="mt-3 grid grid-cols-1 gap-1 text-sm">
                    {op.parameters.map((x) => (
                      <div key={x.name}>
                        <dt className="inline font-mono text-ink">{x.name}</dt>
                        <dd className="inline text-ink-body">
                          {' '}
                          ({x.in}{x.required ? ', required' : ''}) {x.description ?? ''}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {body ? (
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <caption className="mb-1 text-left text-sm font-medium text-ink">Request body ({body})</caption>
                      <thead>
                        <tr className="text-ink-muted">
                          <th className="py-1 pr-3 font-medium">Field</th>
                          <th className="py-1 pr-3 font-medium">Type</th>
                          <th className="py-1 font-medium">Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fields(body).map((f) => (
                          <tr key={f.name} className="border-t border-hairline align-top">
                            <td className="py-1 pr-3 font-mono text-ink">
                              {f.name}
                              {f.required ? ' *' : ''}
                            </td>
                            <td className="py-1 pr-3 text-ink-body [overflow-wrap:anywhere]">{f.type}</td>
                            <td className="py-1 text-ink-body">{f.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                <p className="mt-3 text-sm text-ink-body">
                  Answers: {ok ? `${ok[0]} ${ok[1].description}` : ''}
                  {Object.keys(op.responses).filter((c) => !c.startsWith('2')).length ? `; errors ${Object.keys(op.responses).filter((c) => !c.startsWith('2')).join(', ')}` : ''}.
                </p>
              </section>
            );
          }),
        )}
      </main>
    </div>
  );
}
