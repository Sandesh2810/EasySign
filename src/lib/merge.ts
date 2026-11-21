// Merge text (Phase 4 slice 5, D-80): {{name}}-style placeholders in prefilled values and notes, filled in from the
// person the field belongs to, the sender and the document when the document is sent. The database does the actual
// filling (app_private.merge_text) so the stored values never depend on a browser; this file holds the same rules for
// the editor's checks and its previews. No browser or Node imports.

export const MERGE_FIELDS = ['name', 'first_name', 'email', 'sender_name', 'sender_email', 'document_title'] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];
export const MERGE_LABEL: Record<MergeField, string> = {
  name: "the person's full name",
  first_name: "the person's first name",
  email: "the person's email address",
  sender_name: 'your name',
  sender_email: 'your email address',
  document_title: "the document's title",
};

export interface MergeData {
  name: string;
  email: string;
  senderName: string;
  senderEmail: string;
  documentTitle: string;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_]+)\s*\}\}/g;

/** The placeholder names in a text, lower-cased, in order (repeats included). */
export function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1].toLowerCase());
}

/** Why a text cannot be merged (an unknown placeholder), or null. */
export function mergeProblem(text: string): string | null {
  const unknown = placeholders(text).find((p) => !(MERGE_FIELDS as readonly string[]).includes(p));
  return unknown ? `"{{${unknown}}}" is not a merge field. Use ${MERGE_FIELDS.map((f) => `{{${f}}}`).join(', ')}.` : null;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';

/** Fill the placeholders in one pass (a filled-in value is never read again as a placeholder). Unknown ones stay as typed. */
export function mergeText(text: string, d: MergeData): string {
  const value: Record<MergeField, string> = {
    name: d.name.trim(),
    first_name: firstName(d.name),
    email: d.email,
    sender_name: d.senderName,
    sender_email: d.senderEmail,
    document_title: d.documentTitle,
  };
  return text.replace(PLACEHOLDER, (whole, n: string) => {
    const k = n.toLowerCase() as MergeField;
    return (MERGE_FIELDS as readonly string[]).includes(k) ? value[k] : whole;
  });
}
