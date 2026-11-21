// GET /api/v1/openapi.json — D-91: the API's OpenAPI 3.1 description (public; no key needed).
import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { openApiDocument } from '@/lib/api/openapi';

export function GET() {
  return NextResponse.json(openApiDocument(env.appUrl()), { headers: { 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } });
}
