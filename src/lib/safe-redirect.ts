// Open-redirect protection: a "next" value from the URL may only be a path inside this app.
const DEFAULT = '/app';

export function safeNext(next: string | null | undefined, fallback: string = DEFAULT): string {
  if (typeof next !== 'string' || next.length === 0 || next.length > 512) return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  try {
    const u = new URL(next, 'http://internal.invalid');
    if (u.origin !== 'http://internal.invalid') return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}
