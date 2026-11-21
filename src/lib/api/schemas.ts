// D-91: the REST API's request and response shapes, in one place. The routes validate requests with them, the OpenAPI
// document is generated from them, and the contract test checks real responses against them, so the three cannot
// drift apart. Pure: no I/O.
import { z } from 'zod';

const uuid = z.uuid();
const when = z.string().meta({ format: 'date-time' });

// ---------- requests ----------
export const createInput = z
  .object({
    template_id: uuid.meta({ description: 'A template of the key’s workspace (GET /templates).' }),
    title: z.string().trim().min(1).max(200).optional().meta({ description: 'Defaults to the template’s name.' }),
    people: z
      .array(
        z.object({
          role: z.string().trim().min(1).max(120).meta({ description: 'The role’s id or its label, e.g. "Tenant".' }),
          name: z.string().trim().min(1).max(120),
          email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
        }),
      )
      .min(1)
      .max(50),
  })
  .meta({ id: 'CreateDocument' });

export const sendInput = z
  .object({
    delivery: z.enum(['email', 'link']).meta({ description: '"email": each person is emailed their link. "link": the answer includes the links for you to pass on.' }),
    expires_in_days: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(60)]).default(30),
  })
  .meta({ id: 'SendDocument' });

// ---------- responses ----------
export const errorBody = z
  .strictObject({ error: z.strictObject({ code: z.string(), message: z.string() }) })
  .meta({ id: 'Error', description: 'Every error has a stable code and a sentence for people.' });

export const person = z
  .strictObject({
    id: uuid,
    name: z.string(),
    email: z.string(),
    role: z.enum(['signer', 'approver', 'cc', 'viewer', 'in_person']),
    order: z.int(),
    status: z.enum(['created', 'sent', 'viewed', 'consented', 'signed', 'approved', 'declined', 'expired', 'skipped']),
    completed_at: when.nullable(),
  })
  .meta({ id: 'Person' });

export const documentBody = z
  .strictObject({
    id: uuid,
    title: z.string(),
    status: z.enum(['draft', 'sent', 'in_progress', 'completed', 'declined', 'voided', 'expired', 'failed_sealing']),
    delivery: z.enum(['email', 'link']).nullable(),
    verification_code: z.string().nullable(),
    created_at: when,
    sent_at: when.nullable(),
    completed_at: when.nullable(),
    expires_at: when.nullable(),
    sealed: z.boolean(),
    people: z.array(person),
  })
  .meta({ id: 'Document' });

export const templatesBody = z
  .strictObject({
    templates: z.array(
      z.strictObject({
        id: uuid,
        name: z.string(),
        roles: z.array(z.strictObject({ id: uuid, label: z.string(), role: z.string(), order: z.int() })),
      }),
    ),
  })
  .meta({ id: 'TemplateList' });

export const sendBody = z
  .strictObject({
    document: documentBody,
    signing_links: z
      .array(z.strictObject({ name: z.string(), role: z.string(), order: z.int(), url: z.url() }))
      .optional()
      .meta({ description: 'Only with delivery "link". Each link works like a key: share it only with that person.' }),
  })
  .meta({ id: 'SendResult' });

// ---------- webhook payloads (D-92): what YouNMeSign posts to a webhook endpoint ----------
/** Same list as WEBHOOK_EVENTS in src/lib/webhooks/events.ts (a unit test checks they agree). */
export const DOCUMENT_EVENTS = ['document.sent', 'document.completed', 'document.declined', 'document.voided', 'document.expired'] as const;

const webhookDocument = z
  .strictObject({
    id: uuid,
    title: z.string(),
    status: documentBody.shape.status,
    verification_code: z.string().nullable(),
    sent_at: when.nullable(),
    completed_at: when.nullable(),
    sealed: z.boolean().meta({ description: 'True once the signed PDF can be downloaded (GET /documents/{id}/download).' }),
  })
  .meta({ id: 'WebhookDocument' });

export const documentEvent = z
  .strictObject({ type: z.enum(DOCUMENT_EVENTS), timestamp: when.meta({ description: 'When the event happened.' }), data: z.strictObject({ document: webhookDocument }) })
  .meta({ id: 'DocumentEvent', description: 'A document was sent, completed (and sealed), declined, voided or expired.' });

export const personEvent = z
  .strictObject({
    type: z.literal('person.completed'),
    timestamp: when,
    data: z.strictObject({
      document: webhookDocument,
      person: z.strictObject({ id: uuid, name: z.string(), email: z.string(), role: person.shape.role, status: z.enum(['signed', 'approved']), completed_at: when.nullable() }),
    }),
  })
  .meta({ id: 'PersonEvent', description: 'A person signed or approved.' });

export const testEvent = z
  .strictObject({ type: z.literal('webhook.test'), timestamp: when, data: z.strictObject({ message: z.string() }) })
  .meta({ id: 'TestEvent', description: 'Sent by "Send a test event" on the Webhooks page.' });

export const webhookEvent = z.discriminatedUnion('type', [documentEvent, personEvent, testEvent]);
