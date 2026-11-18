// Server-side environment access. Values are read lazily so a missing secret produces a clear
// message at the moment it is needed instead of breaking the build.
import 'server-only';

const HELP = 'Run "npm run setup:env" in the app folder.';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. ${HELP}`);
  return v;
}

export const env = {
  supabaseUrl: () => required('NEXT_PUBLIC_SUPABASE_URL'),
  supabasePublishableKey: () => required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
  supabaseSecretKey: () => required('SUPABASE_SECRET_KEY'),
  signerTokenKey: () => required('SIGNER_TOKEN_KEY'),
  sessionCookieKey: () => required('SESSION_COOKIE_KEY'),
  storageKey: () => required('STORAGE_KEY'),
  appUrl: () => (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  hasSecretKey: () => Boolean(process.env.SUPABASE_SECRET_KEY),
};
