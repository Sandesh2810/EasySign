// What the public /verify page may show for a verification code (Phase 3, AT3.2). Pure: no database, no
// network, usable in the browser. The database decides what is revealed (public.verify_lookup); this file
// only checks the shape of its answer, so an unexpected answer is never shown half-understood.
import { normalisePublicCode } from './public-code';

export type PublicStatus = 'completed' | 'in_progress' | 'declined' | 'voided' | 'expired';

export type VerifyResult =
  | { kind: 'empty' }
  | { kind: 'limited' }
  | { kind: 'not_found' }
  | {
      kind: 'found';
      code: string;
      status: PublicStatus;
      completedAt: Date | null;
      signerCount: number | null;
      finalSha256: string | null;
      presealSha256: string | null;
      sealKeyId: string | null;
    };

const HEX64 = /^[0-9a-f]{64}$/;
const STATUSES: readonly PublicStatus[] = ['completed', 'in_progress', 'declined', 'voided', 'expired'];

/** What is sent to the database: the tidied code when it can be one, otherwise the text as typed (capped). */
export function codeForLookup(input: string | null | undefined): string {
  const raw = (input ?? '').trim();
  if (!raw) return '';
  return normalisePublicCode(raw) ?? raw.slice(0, 64);
}

const hexOrNull = (v: unknown) => (typeof v === 'string' && HEX64.test(v) ? v : null);

/** Reads public.verify_lookup's answer. Anything unexpected is treated as "not found", never shown. */
export function parseVerifyResponse(data: unknown): VerifyResult {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'not_found' };
  const d = data as Record<string, unknown>;
  if (d.limited === true) return { kind: 'limited' };
  if (d.found !== true) return { kind: 'not_found' };
  const status = d.status as PublicStatus;
  if (typeof d.code !== 'string' || !STATUSES.includes(status)) return { kind: 'not_found' };
  const done = status === 'completed';
  const completedAt = done && typeof d.completed_at === 'string' ? new Date(d.completed_at) : null;
  return {
    kind: 'found',
    code: d.code,
    status,
    completedAt: completedAt && !Number.isNaN(completedAt.getTime()) ? completedAt : null,
    signerCount: done && Number.isInteger(d.signer_count) ? (d.signer_count as number) : null,
    finalSha256: done ? hexOrNull(d.final_sha256) : null,
    presealSha256: done ? hexOrNull(d.preseal_sha256) : null,
    sealKeyId: done ? hexOrNull(d.seal_key_id) : null,
  };
}

/** True only when both are SHA-256 hex strings and equal (case does not matter). */
export function sameSha256(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return HEX64.test(x) && x === y;
}
