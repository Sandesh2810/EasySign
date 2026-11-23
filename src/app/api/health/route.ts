// GET /api/health — for the deploy script and the reverse proxy: says only that this process answers.
// Nothing about the database, the build or the settings is revealed, and nothing is stored.
import { connection } from 'next/server';

export async function GET() {
  await connection(); // answered per request, never from a prerendered copy
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
