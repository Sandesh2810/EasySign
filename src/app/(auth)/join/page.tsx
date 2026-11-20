import type { Metadata } from 'next';
import { JoinClient } from './join-client';

export const metadata: Metadata = { title: 'Join a team' };

// /join#<secret>: accept a team invitation (Phase 4 slice 1, D-75).
export default function JoinPage() {
  return (
    <>
      <h1 className="mb-4 text-xl font-medium text-ink">Join a team</h1>
      <JoinClient />
    </>
  );
}
