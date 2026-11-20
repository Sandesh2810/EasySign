// The Content-Security-Policy (Phase 3 slice 5, AT3.5, D-70). Pure: no I/O, usable from proxy.ts.
// Sent as Content-Security-Policy-Report-Only first: browsers report what it would block to /api/csp-report and
// block nothing. It is switched to enforcing only after 48 hours of end-to-end runs with no reports (brief AT3.5).
// The small enforced policy in next.config.ts (frame-ancestors, base-uri, form-action, object-src) stays meanwhile.

export interface CspOptions {
  nonce: string;
  /** development needs 'unsafe-eval' (React's debugging); production does not. */
  dev: boolean;
  /** https sites also ask browsers to upgrade any http sub-request. */
  https: boolean;
}

export const CSP_REPORT_PATH = '/api/csp-report';

export function buildCsp({ nonce, dev, https }: CspOptions): string {
  const d: [string, string][] = [
    ['default-src', "'self'"],
    // 'strict-dynamic': scripts loaded by a nonced script are trusted; nothing else runs
    ['script-src', `'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`],
    ['style-src', `'self' 'nonce-${nonce}'`],
    // field boxes on the document page are positioned with style attributes
    ['style-src-attr', "'unsafe-inline'"],
    // QR codes and drawn signatures are data: or blob: images
    ['img-src', "'self' blob: data:"],
    ['font-src', "'self'"],
    // the PDF viewer's worker file is served by the app
    ['worker-src', "'self' blob:"],
    ['connect-src', "'self'"],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
    ['frame-ancestors', "'none'"],
    ['report-uri', CSP_REPORT_PATH],
  ];
  if (https) d.push(['upgrade-insecure-requests', '']);
  return d.map(([k, v]) => (v ? `${k} ${v}` : k)).join('; ');
}

/** A fresh, unguessable nonce for one response (128 bits, base64). */
export function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b));
}

export interface CspReport {
  directive: string;
  blocked: string;
  documentPath: string;
  sample: string;
}

const EXTENSION = /^(chrome|moz|safari-web|ms-browser)-extension:/i;

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, n) : '');

/** Keeps only the origin (or a keyword such as "inline") of a blocked address: no paths, no query strings. */
function originOnly(v: unknown): string {
  const s = clip(v, 500);
  if (!s) return '';
  try {
    return new URL(s).origin;
  } catch {
    return s.slice(0, 40);
  }
}

function pathOnly(v: unknown): string {
  try {
    return new URL(clip(v, 2000)).pathname.slice(0, 200);
  } catch {
    return '';
  }
}

/**
 * Reads both report formats browsers send: the older {"csp-report": {...}} and the Reporting API's
 * [{type: "csp-violation", body: {...}}]. Signing-link tokens live after "#", which browsers never report;
 * only the path of the page is kept anyway. At most 10 reports per request.
 */
export function parseCspReports(json: unknown): CspReport[] {
  const out: CspReport[] = [];
  const add = (r: Record<string, unknown>) => {
    const directive = clip(r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive'] ?? r.violatedDirective, 60);
    if (!directive) return;
    // Browser extensions run their own scripts inside our pages; their reports say nothing about the app.
    const source = clip(r['source-file'] ?? r.sourceFile, 200);
    const blockedRaw = clip(r['blocked-uri'] ?? r.blockedURL, 200);
    if (EXTENSION.test(source) || EXTENSION.test(blockedRaw)) return;
    out.push({
      directive,
      blocked: originOnly(r['blocked-uri'] ?? r.blockedURL),
      documentPath: pathOnly(r['document-uri'] ?? r.documentURL),
      sample: clip(r['script-sample'] ?? r.sample, 80),
    });
  };
  if (json && typeof json === 'object' && !Array.isArray(json) && typeof (json as Record<string, unknown>)['csp-report'] === 'object') {
    add((json as Record<string, Record<string, unknown>>)['csp-report']);
  } else if (Array.isArray(json)) {
    for (const item of json.slice(0, 10)) {
      if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'csp-violation' && typeof (item as { body?: unknown }).body === 'object') {
        add((item as { body: Record<string, unknown> }).body);
      }
    }
  }
  return out.slice(0, 10);
}
