import type { Metadata } from 'next';
import { Suspense } from 'react';
import { APPROVE_TEXT, CONSENT_PARAGRAPHS, INTENT_TEXT } from '@/config/legal';
import type { FieldType } from '@/lib/fields';
import { maskEmail } from '@/lib/access-code';
import { lockedMessage } from '@/lib/signing/gate-text';
import { loadSignerContext } from '@/lib/signing/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { ConsentForm } from './consent-form';
import { Notice } from '@/components/ui';
import { DeclineControl } from './decline';
import { PaperCopyControl } from './paper-withdraw';
import { Finalising } from './finalising';
import { AccessCodeForm, EmailCodeForm } from './gate-form';
import { SigningRoom, type RoomField } from './signing-room';

export const metadata: Metadata = { title: 'Sign document' };

export default function SignPage() {
  return (
    <Suspense fallback={<Message title="Loading your document…" body="This takes a moment." />}>
      <Sign />
    </Suspense>
  );
}

function Message({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-2xl font-medium text-ink">{title}</h1>
      <p className="mt-3 text-base text-ink-body">{body}</p>
      {children}
    </div>
  );
}

async function Sign() {
  // allowUnverified: this page also shows the code screen. Everything below the gate check runs only
  // for a session that has passed it (or needs none).
  const ctx = await loadSignerContext({ allowUnverified: true });
  if (!ctx) {
    return <Message title="Your signing session has ended" body="For your security a signing session lasts two hours. Open the link from your email again to continue where you left off." />;
  }
  const { envelope, recipient } = ctx;
  const admin = supabaseAdmin();
  if (ctx.onHold) {
    return <Message title="This document is on hold" body="This document is on hold. YouNMeSign has suspended the account that sent it while a concern is being looked into. You cannot sign it right now. Do not send money or personal details to anyone because of this document. If you know the sender, contact them another way." />;
  }
  if (ctx.gate) {
    // Nothing about the document is shown here beyond the sender's check itself: no title, no pages.
    const { data } = await admin.rpc('signer_auth_state', { p_token_id: ctx.tokenId });
    const state = (Array.isArray(data) ? data[0] : null) as { locked_until: string | null; otp_status: 'none' | 'sending' | 'sent' | 'delayed' | 'failed' } | null;
    const lockedText = state?.locked_until ? lockedMessage(state.locked_until) : null;
    return (
      <div className="mx-auto max-w-xl px-4 py-12">
        <h1 className="text-2xl font-medium text-ink">One more step before your document opens</h1>
        <p className="mt-3 text-base text-ink-body">
          Hello {recipient.name}. The sender asked for an extra check that it is really you. This protects you if someone else gets hold of your link.
        </p>
        {ctx.gate === 'access_code' ? (
          <AccessCodeForm lockedText={lockedText} />
        ) : (
          <EmailCodeForm maskedEmail={maskEmail(recipient.email)} otpStatus={state?.otp_status ?? 'none'} lockedText={lockedText} />
        )}
        <p className="mt-8 text-sm text-ink-muted">You get five tries. After that the link is locked for a while so that nobody can guess the code.</p>
      </div>
    );
  }
  const { data: profile } = await admin.from('profiles').select('display_name').eq('id', envelope.sender_id).maybeSingle();
  const senderName = recipient.is_sender ? 'you' : (profile?.display_name as string | undefined) || 'the sender';

  if (envelope.status === 'completed') {
    return (
      <Message title="This document is complete" body={`Everyone has signed "${envelope.title}". Download your copy and keep it somewhere safe.`}>
        <p className="mt-6 flex flex-wrap gap-3">
          <a
            href="/api/sign/document?part=sealed"
            className="inline-flex min-h-11 items-center justify-center rounded-pill bg-ink px-6 text-base font-medium text-on-ink no-underline hover:opacity-90"
          >
            Download the signed PDF
          </a>
          <a
            href="/api/sign/document?part=certificate"
            className="inline-flex min-h-11 items-center justify-center rounded-pill border border-control-border bg-surface px-6 text-base font-medium text-ink no-underline hover:bg-surface-sand"
          >
            Download the certificate
          </a>
        </p>
        <dl className="mt-8 grid grid-cols-1 gap-2 text-sm">
          <dt className="text-ink-muted">Verification code</dt>
          <dd className="font-mono text-ink">{envelope.public_code}</dd>
          <dt className="mt-2 text-ink-muted">SHA-256 of the signed PDF</dt>
          <dd className="break-all font-mono text-xs text-ink">{envelope.final_sha256}</dd>
        </dl>
        <p className="mt-6 text-sm text-ink-muted">This link keeps working for downloads until {new Date(ctx.expiresAt).toISOString().slice(0, 10)}.</p>
      </Message>
    );
  }
  if (!['sent', 'in_progress', 'failed_sealing'].includes(envelope.status)) {
    return <Message title="This document is no longer open for signing" body={`Ask ${senderName === 'you' ? 'the sender' : senderName} if you think this is a mistake.`} />;
  }
  const senderLine = recipient.is_sender ? 'You are signing your own document' : `Sent by ${senderName}`;
  if (recipient.status === 'signed' || recipient.status === 'approved') {
    const { count: stillWaiting } = await admin
      .from('recipients')
      .select('id', { count: 'exact', head: true })
      .eq('envelope_id', envelope.id)
      .in('role', ['signer', 'in_person', 'approver'])
      .not('status', 'in', '(signed,approved)');
    if ((stillWaiting ?? 0) > 0) {
      return (
        <Message
          title={recipient.status === 'approved' ? 'Thank you. Your approval is recorded.' : 'Thank you. Your signature is recorded.'}
          body="Other people still need to finish this document. When everyone has, the completed document will be available through this same link, and by email if the sender is using email."
        />
      );
    }
    return (
      <Message title="Thank you. Everyone has finished." body="The final document is being prepared. This page will offer the download as soon as it is ready, usually within a minute.">
        <Finalising />
      </Message>
    );
  }
  if (recipient.role === 'viewer') {
    // a viewer reads; there is nothing to agree to or fill in
    return <SigningRoom mode="view" title={envelope.title} senderLine={senderLine} signer={{ name: recipient.name, email: recipient.email }} fields={[]} adopted={{ signature: false, initials: false }} intentText="" />;
  }
  if (recipient.status === 'sent' || recipient.status === 'viewed') {
    const [{ data: lastWithdrawn }, { data: openPaper }] = await Promise.all([
      admin.from('consents').select('withdrawn_at').eq('recipient_id', recipient.id).not('withdrawn_at', 'is', null).order('withdrawn_at', { ascending: false }).limit(1).maybeSingle(),
      admin.from('sender_tasks').select('created_at').eq('recipient_id', recipient.id).eq('kind', 'paper_copy').is('done_at', null).maybeSingle(),
    ]);
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <p className="text-sm text-ink-muted">{senderLine}</p>
        <h1 className="mt-1 text-2xl font-medium text-ink">{envelope.title}</h1>
        {lastWithdrawn?.withdrawn_at ? (
          <div className="mt-6">
            <Notice tone="info">
              You withdrew your consent to sign electronically. The sender has been told. If you change your mind, you can agree again below and start over.
            </Notice>
          </div>
        ) : null}
        {openPaper ? (
          <div className="mt-4">
            <Notice tone="info">You asked for a paper copy. The sender has been told.</Notice>
          </div>
        ) : null}
        <h2 className="mt-8 text-lg font-medium text-ink">Before you start: {recipient.role === 'approver' ? 'approving' : 'signing'} electronically</h2>
        <div className="mt-3 flex flex-col gap-3 text-base text-ink-body">
          {CONSENT_PARAGRAPHS.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
        <ConsentForm signerName={recipient.name} paperRequested={Boolean(openPaper)} />
        {/* a div, not a paragraph: the control carries its own dialog, which may not sit inside a <p> */}
        <div className="mt-6 flex flex-wrap gap-2">
          {openPaper ? null : <PaperCopyControl variant="quiet" />}
          <DeclineControl variant="quiet" label="Decline this document instead" />
        </div>
      </div>
    );
  }
  if (recipient.status !== 'consented') {
    return <Message title="Nothing is waiting for you here" body="There is no signing step left for you on this document." />;
  }
  if (recipient.role === 'approver') {
    return <SigningRoom mode="approve" title={envelope.title} senderLine={senderLine} signer={{ name: recipient.name, email: recipient.email }} fields={[]} adopted={{ signature: false, initials: false }} intentText={APPROVE_TEXT} />;
  }

  const [{ data: fields }, { data: values }, { data: assets }] = await Promise.all([
    admin.from('fields').select('id, type, page, x, y, w, h, required').eq('recipient_id', recipient.id).order('page').order('y').order('x'),
    admin.from('field_values').select('field_id, value_text').eq('recipient_id', recipient.id),
    admin.from('signature_assets').select('kind').eq('recipient_id', recipient.id),
  ]);
  const valueOf = new Map((values ?? []).map((v) => [v.field_id as string, (v.value_text as string | null) ?? '']));
  const roomFields: RoomField[] = (fields ?? []).map((f) => ({
    id: f.id as string,
    type: f.type as FieldType,
    page: f.page as number,
    x: Number(f.x),
    y: Number(f.y),
    w: Number(f.w),
    h: Number(f.h),
    required: Boolean(f.required),
    value: valueOf.get(f.id as string) ?? '',
  }));
  const kinds = new Set((assets ?? []).map((a) => a.kind as string));

  return (
    <SigningRoom
      title={envelope.title}
      mode="sign"
      senderLine={senderLine}
      signer={{ name: recipient.name, email: recipient.email }}
      fields={roomFields}
      adopted={{ signature: kinds.has('signature'), initials: kinds.has('initials') }}
      intentText={INTENT_TEXT}
    />
  );
}
