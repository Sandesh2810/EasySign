'use server';
// Accepting a team invitation (Phase 4 slice 1, D-75). The link is /join#<secret>; the page hands the secret over in a
// POST (it never appears in a server log or a Referer header). The database accepts it only for the email address the
// invitation names, once, within 7 days.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getUser, mfaStatus } from '@/lib/auth/session';
import { allow } from '@/lib/rate-limit';
import { friendlyDbError } from '@/lib/request-guard';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { rememberWorkspace } from '@/lib/workspace';

export type JoinResult = { kind: 'signed_out' } | { kind: 'needs_code' } | { kind: 'joined' } | { kind: 'error'; message: string };

export async function acceptInviteAction(token: string): Promise<JoinResult> {
  const parsed = z.string().regex(/^[A-Za-z0-9_-]{43}$/).safeParse(token);
  if (!parsed.success) return { kind: 'error', message: 'This invitation link is incomplete. Copy the whole link from the message you were sent.' };
  const user = await getUser();
  if (!user) return { kind: 'signed_out' };
  // someone with two-step sign-in must have entered their code in this session before joining a team
  if (user.aal !== 'aal2' && (await mfaStatus(user.id)).enrolled) return { kind: 'needs_code' };
  if (!(await allow({ bucket: 'team_join', limit: 10, windowSeconds: 3600 }, user.id))) {
    return { kind: 'error', message: 'Too many tries. Wait an hour and open the link again.' };
  }
  const hash = createHash('sha256').update(parsed.data).digest('hex');
  const { data, error } = await supabaseAdmin().rpc('team_accept', { p_actor: user.id, p_token_sha256: `\\x${hash}` });
  if (error || !data) return { kind: 'error', message: friendlyDbError(error?.message).message };
  await rememberWorkspace(data as string);
  return { kind: 'joined' };
}
