// Upload gate for PDFs (docs/SECURITY.md section 2, DECISIONS D-30, D-33).
// Decides whether a file may be stored and signed, and returns the page geometry the editor needs.
// Server-only. Never modifies the bytes it is given.
import { createHash } from 'node:crypto';
import { PDFDocument, PDFDict, PDFArray, PDFName, PDFStream, PDFRef, type PDFObject } from 'pdf-lib';
import { LIMITS } from '@/config/brand';
import { normaliseBox, type PageBox } from '@/lib/geometry';

export type InspectCode =
  | 'NOT_PDF'
  | 'FILE_TOO_LARGE'
  | 'UNREADABLE'
  | 'ENCRYPTED'
  | 'TOO_MANY_PAGES'
  | 'ACTIVE_CONTENT'
  | 'EMBEDDED_FILES'
  | 'ALREADY_SIGNED'
  | 'FORM_FIELDS';

export type InspectResult =
  | { ok: true; pageCount: number; sizeBytes: number; sha256: string; pages: PageBox[]; linkCount: number }
  | { ok: false; code: InspectCode; message: string };

const MESSAGES: Record<InspectCode, string> = {
  NOT_PDF: 'This file is not a PDF. Upload a PDF, PNG or JPG.',
  FILE_TOO_LARGE: `This file is larger than ${Math.round(LIMITS.maxDocumentBytes / (1024 * 1024))} MB. Reduce its size and try again.`,
  UNREADABLE: 'This PDF appears to be damaged and could not be read. Re-export it from the original program and try again.',
  ENCRYPTED: 'This PDF is password-protected or encrypted. Remove the protection and upload it again.',
  TOO_MANY_PAGES: `This PDF has more than ${LIMITS.maxDocumentPages} pages. Split it into smaller documents.`,
  ACTIVE_CONTENT: 'This PDF contains scripts or automatic actions, which are not allowed. Print it to a new PDF and upload that.',
  EMBEDDED_FILES: 'This PDF has other files attached inside it, which is not allowed. Remove the attachments and upload it again.',
  ALREADY_SIGNED: 'This PDF already carries a digital signature. Stamping it would invalidate that signature, so it cannot be used here.',
  FORM_FIELDS: 'This PDF contains fillable form fields, which are not supported yet. Print it to a new PDF (flatten it) and upload that.',
};

const fail = (code: InspectCode): InspectResult => ({ ok: false, code, message: MESSAGES[code] });

const BANNED_ACTIONS = new Set(['JavaScript', 'Launch', 'ImportData', 'SubmitForm', 'ResetForm', 'GoToR', 'GoToE', 'Rendition', 'Movie', 'Sound', 'Hide', 'SetOCGState', 'Trans', 'GoTo3DView', 'RichMediaExecute']);

const nameOf = (o: PDFObject | undefined): string | null => (o instanceof PDFName ? o.decodeText() : null);

function hasPdfHeader(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

export interface InspectOptions {
  /** Allow a signature dictionary: used when re-reading our own sealed output (Phase 3). */
  allowSealed?: boolean;
}

export async function inspectPdf(bytes: Uint8Array, opts: InspectOptions = {}): Promise<InspectResult> {
  if (!bytes || bytes.length < 8 || !hasPdfHeader(bytes)) return fail('NOT_PDF');
  if (bytes.length > LIMITS.maxDocumentBytes) return fail('FILE_TOO_LARGE');

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
    return fail(/encrypt/i.test(msg) ? 'ENCRYPTED' : 'UNREADABLE');
  }

  try {
    const pageCount = doc.getPageCount();
    if (pageCount < 1) return fail('UNREADABLE');
    if (pageCount > LIMITS.maxDocumentPages) return fail('TOO_MANY_PAGES');

    const ctx = doc.context;
    const resolve = (o: PDFObject | undefined): PDFObject | undefined => (o instanceof PDFRef ? ctx.lookup(o) : o);
    const found = { active: false, embedded: false, signed: false };
    let linkCount = 0;

    /** An action that only moves the view inside this document. */
    const isNavigationOnly = (o: PDFObject | undefined): boolean => {
      const v = resolve(o);
      if (v === undefined) return true;
      if (v instanceof PDFArray) return true; // explicit destination
      if (v instanceof PDFName) return true; // named destination
      if (v instanceof PDFDict) return nameOf(resolve(v.get(PDFName.of('S')))) === 'GoTo' && isNavigationOnly(v.get(PDFName.of('Next')));
      return false;
    };

    const visit = (o: PDFObject | undefined, depth: number): void => {
      if (depth > 12 || o === undefined) return;
      if (o instanceof PDFArray) {
        for (let i = 0; i < o.size(); i++) {
          const child = o.get(i);
          if (!(child instanceof PDFRef)) visit(child, depth + 1);
        }
        return;
      }
      const dict = o instanceof PDFDict ? o : o instanceof PDFStream ? o.dict : null;
      if (!dict) return;

      if (dict.has(PDFName.of('JS')) || dict.has(PDFName.of('JavaScript'))) found.active = true;
      const action = nameOf(resolve(dict.get(PDFName.of('S'))));
      if (action && BANNED_ACTIONS.has(action)) found.active = true;

      if (dict.has(PDFName.of('OpenAction')) && !isNavigationOnly(dict.get(PDFName.of('OpenAction')))) found.active = true;
      const aa = resolve(dict.get(PDFName.of('AA')));
      if (aa instanceof PDFDict) {
        for (const [, v] of aa.entries()) if (!isNavigationOnly(v)) found.active = true;
      } else if (aa !== undefined) {
        found.active = true;
      }

      const type = nameOf(resolve(dict.get(PDFName.of('Type'))));
      const subtype = nameOf(resolve(dict.get(PDFName.of('Subtype'))));
      if (type === 'EmbeddedFile' || type === 'Filespec' || subtype === 'FileAttachment' || dict.has(PDFName.of('EmbeddedFiles')) || dict.has(PDFName.of('EF'))) found.embedded = true;
      if (type === 'Sig' || type === 'DocTimeStamp' || nameOf(resolve(dict.get(PDFName.of('FT')))) === 'Sig' || dict.has(PDFName.of('ByteRange'))) found.signed = true;

      if (subtype === 'Link') {
        const a = resolve(dict.get(PDFName.of('A')));
        if (a instanceof PDFDict && nameOf(resolve(a.get(PDFName.of('S')))) === 'URI') linkCount++;
      }

      for (const [, v] of dict.entries()) if (!(v instanceof PDFRef)) visit(v, depth + 1);
    };

    for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj, 0);

    if (found.active) return fail('ACTIVE_CONTENT');
    if (found.embedded) return fail('EMBEDDED_FILES');
    if (found.signed && !opts.allowSealed) return fail('ALREADY_SIGNED');

    const acro = resolve(doc.catalog.get(PDFName.of('AcroForm')));
    if (acro instanceof PDFDict && !opts.allowSealed) {
      const fields = resolve(acro.get(PDFName.of('Fields')));
      if ((fields instanceof PDFArray && fields.size() > 0) || acro.has(PDFName.of('XFA'))) return fail('FORM_FIELDS');
    }

    const pages: PageBox[] = doc.getPages().map((p) => {
      const m = p.getMediaBox();
      const c = p.getCropBox();
      return normaliseBox([m.x, m.y, m.x + m.width, m.y + m.height], [c.x, c.y, c.x + c.width, c.y + c.height], p.getRotation().angle);
    });

    return { ok: true, pageCount, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), pages, linkCount };
  } catch {
    return fail('UNREADABLE');
  }
}
