// D-91: the OpenAPI 3.1 description of the REST API, generated from the same Zod schemas the routes and the contract
// test use. Pure: no I/O.
import { z } from 'zod';
import { API_CREATE_DAILY, API_DOWNLOAD_HOURLY, API_RATE } from './limits';
import './schemas'; // registers the named schemas (CreateDocument, Document, …) in Zod's registry

type Json = Record<string, unknown>;

/** The named schemas as OpenAPI components: requests as their input shape, responses as their output shape. */
function components(): Record<string, Json> {
  const toRefs = (io: 'input' | 'output') =>
    (z.toJSONSchema(z.globalRegistry, { io, uri: (id) => `#/components/schemas/${id}` }) as { schemas: Record<string, Json> }).schemas;
  const input = toRefs('input');
  const output = toRefs('output');
  const pick: Record<string, Json> = {};
  for (const name of ['CreateDocument', 'SendDocument']) pick[name] = input[name];
  for (const name of ['Error', 'Person', 'Document', 'TemplateList', 'SendResult', 'WebhookDocument', 'DocumentEvent', 'PersonEvent', 'TestEvent']) pick[name] = output[name];
  for (const s of Object.values(pick)) {
    delete s.id;
    delete s.$schema;
  }
  return pick;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string, description: string) => ({ description, content: { 'application/json': { schema: ref(name) } } });
const errors = (...codes: number[]) =>
  Object.fromEntries(
    codes.map((c) => [
      String(c),
      {
        ...json('Error', ({ 400: 'The request is not valid', 401: 'No key, a wrong key, or a revoked key', 403: 'The key lacks the permission named in the message', 404: 'Not found, or not visible to this key', 409: 'Not possible in the current state (or an idempotent request still running)', 413: 'The body is too large', 422: 'Refused: the message says why', 429: 'Too many requests, or a daily limit reached' } as Record<number, string>)[c] ?? 'Error'),
        ...(c === 429 ? { headers: { 'Retry-After': { description: 'Seconds to wait before trying again.', schema: { type: 'integer' } } } } : {}),
      },
    ]),
  );
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'The document id.' };
const idemHeader = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  schema: { type: 'string', minLength: 1, maxLength: 200 },
  description: 'Makes the request safe to retry: the same key and request within 24 hours returns the first answer (with "Idempotent-Replayed: true") instead of doing it again.',
};

// D-92: what YouNMeSign posts to a webhook endpoint (OpenAPI 3.1 "webhooks"), signed in the Standard Webhooks format
const webhookHeaders = [
  { name: 'webhook-id', in: 'header', required: true, schema: { type: 'string' }, description: 'Unique per delivery and the same on every retry of it: use it to ignore repeats.' },
  { name: 'webhook-timestamp', in: 'header', required: true, schema: { type: 'string' }, description: 'Seconds since 1970 (UTC) when this attempt was signed. Refuse it if it is more than 5 minutes from your clock.' },
  {
    name: 'webhook-signature',
    in: 'header',
    required: true,
    schema: { type: 'string' },
    description:
      'One or more "v1,<base64>" separated by spaces: HMAC-SHA256 of "<webhook-id>.<webhook-timestamp>.<raw body>" with the secret (the part after "whsec_", base64-decoded). Accept the request if any one matches, compared in constant time. During a secret change both the new and the previous secret sign for 24 hours.',
  },
];
const webhook = (operationId: string, schema: string, summary: string) => ({
  post: {
    operationId,
    summary,
    parameters: webhookHeaders,
    requestBody: { required: true, content: { 'application/json': { schema: ref(schema) } } },
    responses: { '2XX': { description: 'Received. Any other answer, a redirect, or no answer within 10 seconds counts as a failure and is retried after 1 min, 5 min, 30 min, 2 h, 6 h and 12 h.' } },
  },
});

export function openApiDocument(serverUrl: string): Json {
  return {
    openapi: '3.1.0',
    info: {
      title: 'YouNMeSign API',
      version: '1.0.0',
      description: `Create documents from templates, send them, follow their progress and download the signed copies. Authenticate with an API key made in Settings → API keys, sent as "Authorization: Bearer <key>". A key acts as the person who made it. On the free plan: at most ${API_RATE.limit} requests a minute per key and no monthly limit (a plan with a monthly limit answers 429 "monthly_limit" once it is reached). Also at most ${API_CREATE_DAILY.limit} new documents a day per person and ${API_DOWNLOAD_HOURLY.limit} downloads an hour per key. Signing links are never stored: repeating a send with the same Idempotency-Key fetches them again while the document is open for signing.`,
    },
    servers: [{ url: `${serverUrl}/api/v1` }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'An API key: "ynms_" followed by 43 characters.' } },
      schemas: components(),
    },
    paths: {
      '/templates': {
        get: {
          operationId: 'listTemplates',
          summary: 'List the templates you can use, with their roles',
          description: 'Needs the documents:read permission.',
          responses: { 200: json('TemplateList', 'The templates'), ...errors(401, 403, 429) },
        },
      },
      '/documents': {
        post: {
          operationId: 'createDocument',
          summary: 'Create a draft from a template',
          description: 'Needs documents:write. Each person names one of the template’s roles by id or label.',
          parameters: [idemHeader],
          requestBody: { required: true, content: { 'application/json': { schema: ref('CreateDocument') } } },
          responses: { 201: json('Document', 'The new draft'), ...errors(400, 401, 403, 404, 409, 413, 422, 429) },
        },
      },
      '/documents/{id}': {
        get: {
          operationId: 'getDocument',
          summary: 'A document’s status and its people',
          description: 'Needs documents:read. Poll this to follow progress (no more than once every few seconds).',
          parameters: [idParam],
          responses: { 200: json('Document', 'The document'), ...errors(401, 403, 404, 429) },
        },
      },
      '/documents/{id}/send': {
        post: {
          operationId: 'sendDocument',
          summary: 'Send a draft',
          description: 'Needs documents:send. With delivery "link" the answer includes each person’s signing link.',
          parameters: [idParam, idemHeader],
          requestBody: { required: false, content: { 'application/json': { schema: ref('SendDocument') } } },
          responses: { 200: json('SendResult', 'Sent'), ...errors(400, 401, 403, 404, 409, 413, 422, 429) },
        },
      },
      '/documents/{id}/download': {
        get: {
          operationId: 'downloadDocument',
          summary: 'Download the sealed PDF or its certificate',
          description: 'Needs documents:read. Only for a completed document.',
          parameters: [idParam, { name: 'part', in: 'query', required: false, schema: { type: 'string', enum: ['sealed', 'certificate'], default: 'sealed' } }],
          responses: { 200: { description: 'The PDF', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, ...errors(400, 401, 403, 404, 409, 429) },
        },
      },
    },
    webhooks: {
      documentEvent: webhook('documentEvent', 'DocumentEvent', 'A document was sent, completed, declined, voided or expired'),
      personEvent: webhook('personEvent', 'PersonEvent', 'A person signed or approved'),
      testEvent: webhook('testEvent', 'TestEvent', 'A test event from the Webhooks page'),
    },
  };
}
