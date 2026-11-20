// The audit trail as a PDF for people (Phase 3 slice 7, D-72). Built from the same rows as the JSON export, so both
// say the same thing; the JSON is the one to re-check by machine (it carries the hashed text of every event).
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { PRODUCT_NAME } from '@/config/brand';
import type { AuditRow } from '@/lib/audit-chain';

export interface AuditReportInput {
  publicCode: string;
  status: string;
  title: string;
  finalSha256: string | null;
  rows: readonly AuditRow[];
  verified: boolean;
  reason?: string;
  head: string;
  archivedParts: number;
  generatedAt: Date;
}

/** The standard PDF fonts cover Latin-1 only; anything else prints as "?" (as on the certificate). */
const latin1 = (s: string) => s.replace(/[^ -~ -ÿ]/g, '?');

const W = 595.28;
const H = 841.89;
const M = 48;

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of latin1(text).split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (font.widthOfTextAtSize(next, size) <= width || line === '') {
        // a single very long word (a hash) is cut to fit
        let w = next;
        while (font.widthOfTextAtSize(w, size) > width && w.length > 1) {
          let cut = w.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
          out.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        line = w;
      } else {
        out.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

export async function buildAuditReport(input: AuditReportInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Audit trail ${input.publicCode}`);
  pdf.setProducer(PRODUCT_NAME);
  pdf.setCreator(PRODUCT_NAME);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - M;

  const ensure = (needed: number) => {
    if (y - needed < M) {
      page = pdf.addPage([W, H]);
      y = H - M;
    }
  };
  const text = (s: string, f: PDFFont, size: number, color = rgb(0.1, 0.1, 0.1), indent = 0) => {
    for (const line of wrap(s, f, size, W - 2 * M - indent)) {
      ensure(size + 4);
      page.drawText(line, { x: M + indent, y: y - size, size, font: f, color });
      y -= size + 4;
    }
  };

  text(`${PRODUCT_NAME} audit trail`, bold, 18);
  y -= 6;
  text(`Verification code: ${input.publicCode}`, font, 10);
  text(`Document: ${input.title}`, font, 10);
  text(`Status: ${input.status}`, font, 10);
  if (input.finalSha256) text(`SHA-256 of the sealed file: ${input.finalSha256}`, mono, 8);
  text(`Events: ${input.rows.length}${input.archivedParts > 0 ? ` (${input.archivedParts} archived part${input.archivedParts === 1 ? '' : 's'} included)` : ''}`, font, 10);
  text(
    input.verified
      ? 'Chain check: every event links to the one before it and matches its stored text. Nothing was changed.'
      : `Chain check FAILED: ${input.reason ?? 'unknown reason'}`,
    bold,
    10,
    input.verified ? rgb(0.1, 0.35, 0.15) : rgb(0.6, 0.05, 0.05),
  );
  text(`Chain head (SHA-256 of the last event): ${input.head}`, mono, 8);
  text(`Generated ${input.generatedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC. The JSON export holds the exact hashed text of every event.`, font, 8, rgb(0.35, 0.35, 0.35));
  y -= 10;

  for (const r of input.rows) {
    ensure(40);
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.4, color: rgb(0.8, 0.8, 0.8) });
    y -= 4;
    text(`#${r.chain_seq}  ${r.created_at.replace('T', ' ').slice(0, 23)} UTC  ${r.event_type}`, bold, 9);
    const who = `${r.actor_type}${r.actor_id ? ` ${r.actor_id}` : ''}${r.recipient_id ? `  person ${r.recipient_id}` : ''}`;
    text(who, font, 8, rgb(0.3, 0.3, 0.3), 10);
    if (r.ip || r.user_agent) text(`${r.ip ?? '-'}  ${r.user_agent ?? ''}`.slice(0, 300), font, 8, rgb(0.3, 0.3, 0.3), 10);
    const payload = JSON.stringify(r.payload ?? {});
    if (payload !== '{}') text(payload.slice(0, 600), mono, 7, rgb(0.2, 0.2, 0.2), 10);
    text(`hash ${r.event_hash}`, mono, 7, rgb(0.45, 0.45, 0.45), 10);
  }

  const pages = pdf.getPages();
  pages.forEach((p, i) =>
    p.drawText(latin1(`${input.publicCode}  -  page ${i + 1} of ${pages.length}`), { x: M, y: 24, size: 7, font, color: rgb(0.45, 0.45, 0.45) }),
  );
  return pdf.save({ useObjectStreams: false });
}
