// Turns a database error message into words for people. Pure, no Next.js imports, so the background
// worker can use it too (it is bundled outside Next; see scripts/build-worker.mjs).

/** Database functions raise messages that start with a code such as "ES_QUOTA: ...". */
export function friendlyDbError(message: string | undefined): { code: string; message: string } {
  const m = /^(ES_[A-Z_]+):\s*(.*)$/.exec(message ?? '');
  if (m) return { code: m[1], message: m[2].charAt(0).toUpperCase() + m[2].slice(1) + '.' };
  return { code: 'ES_ERROR', message: 'Something went wrong. Nothing was changed. Try again.' };
}
