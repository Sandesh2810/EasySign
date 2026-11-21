import type { Metadata } from 'next';
import { PRODUCT_NAME } from '@/config/brand';
import { signerI18n } from '@/i18n/server';
import { Text } from '../text';
import { Suspense } from 'react';
import { APPROVE_TEXT, CONSENT_PARAGRAPHS, INTENT_TEXT } from '@/config/legal';
import type { FieldOptions, FieldType } from '@/lib/fields';
import { maskEmail } from '@/lib/access-code';
import { lockedMessage } from '@/lib/signing/gate-text';
import { loadSignerContext } from '@/lib/signing/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { ConsentForm } from './consent-form';
import { Notice } from '@/components/ui';
import { DeclineControl } from './decline';
import { HandOffControl } from './handoff';
import { QuestionsPanel, type ThreadItem } from './questions';
import { PaperCopyControl } from './paper-withdraw';
import { Finalising } from './finalising';
import { AccessCodeForm, EmailCodeForm } from './gate-form';
import { SigningRoom, type RoomField } from './signing-room';
import { HostPinForm, InPersonGuard } from './in-person';
import { BrandBand } from '@/components/brand-band';
import { loadBrand } from '@/lib/branding-store';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await signerI18n();
  return { title: t('page.title') };
}

export default function SignPage() {
  return (
    <Suspense fallback={<Message title={<Text k="page.loadingTitle" />} body={<Text k="page.loadingBody" />} />}>
      <SessionBrand />
      <Sign />
    </Suspense>
  );
}

/** D-88: the sending workspace's branding above every signer view (not on the identity-check screen). */
async function SessionBrand() {
  const ctx = await loadSignerContext({ allowUnverified: true, allowLocked: true });
  if (!ctx || ctx.gate) return null;
  const brand = await loadBrand(ctx.envelope.org_id);
  return brand ? <BrandBand brand={brand} /> : null;
}

function Message({ title, body, children }: { title: React.ReactNode; body: React.ReactNode; children?: React.ReactNode }) {
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
  const ctx = await loadSignerContext({ allowUnverified: true, allowLocked: true });
  const { t, locale } = await signerI18n();
  if (!ctx) {
    return <Message title={t('page.endedTitle')} body={t('page.endedBody')} />;
  }
  const { envelope, recipient } = ctx;
  // D-95: later emails to this person use the language they read the page in
  if (recipient.locale !== locale) await supabaseAdmin().rpc('signer_set_locale', { p_token_id: ctx.tokenId, p_locale: locale });
  // D-86: in-person signing on the host's device
  const host = ctx.inPerson;
  if (host?.state === 'ended') {
    return <Message title={t('page.ipEndedTitle')} body={t('page.ipEndedBody', { host: host.hostName })} />;
  }
  if (host?.state === 'locked') {
    return (
      <Message title={t('page.ipLockedTitle')} body={t('page.ipLockedBody', { host: host.hostName })}>
        <HostPinForm mode="unlock" hostName={host.hostName} />
      </Message>
    );
  }
  if (host && (recipient.status === 'signed' || recipient.status === 'approved')) {
    return (
      <Message title={t('page.ipThanksTitle', { name: recipient.name })} body={t('page.ipThanksBody', { host: host.hostName })}>
        <HostPinForm mode="handback" hostName={host.hostName} />
      </Message>
    );
  }
  const guard = (node: React.ReactNode) => (host ? <InPersonGuard hostName={host.hostName} signerName={recipient.name}>{node}</InPersonGuard> : node);
  const admin = supabaseAdmin();
  if (ctx.onHold) {
    return <Message title={t('page.holdTitle')} body={t('page.holdBody', { product: PRODUCT_NAME })} />;
  }
  if (ctx.gate) {
    // Nothing about the document is shown here beyond the sender's check itself: no title, no pages.
    const { data } = await admin.rpc('signer_auth_state', { p_token_id: ctx.tokenId });
    const state = (Array.isArray(data) ? data[0] : null) as { locked_until: string | null; otp_status: 'none' | 'sending' | 'sent' | 'delayed' | 'failed' } | null;
    const lockedText = state?.locked_until ? lockedMessage(t, state.locked_until) : null;
    return (
      <div className="mx-auto max-w-xl px-4 py-12">
        <h1 className="text-2xl font-medium text-ink">{t('page.gateTitle')}</h1>
        <p className="mt-3 text-base text-ink-body">{t('page.gateBody', { name: recipient.name })}</p>
        {ctx.gate === 'access_code' ? (
          <AccessCodeForm lockedText={lockedText} />
        ) : (
          <EmailCodeForm maskedEmail={maskEmail(recipient.email)} otpStatus={state?.otp_status ?? 'none'} lockedText={lockedText} />
        )}
        <p className="mt-8 text-sm text-ink-muted">{t('page.gateTries')}</p>
      </div>
    );
  }
  if (recipient.status === 'skipped') {
    // D-81 (AT4.5): another member of this person's signing group signed for the group
    const { data: me } = await admin.from('recipients').select('signing_group, group_completed_by').eq('id', recipient.id).maybeSingle();
    if (me?.group_completed_by) {
      const { data: by } = await admin.from('recipients').select('name, completed_at').eq('id', me.group_completed_by as string).maybeSingle();
      const when = by?.completed_at ? new Date(by.completed_at as string).toISOString().slice(0, 10) : null;
      return (
        <Message
          title={t('page.groupTitle')}
          body={t(when ? 'page.groupBody' : 'page.groupBodyNoDate', { by: (by?.name as string | undefined) ?? t('page.anotherMember'), title: envelope.title, group: me.signing_group as string, date: when ?? '' })}
        />
      );
    }
  }
  const { data: profile } = await admin.from('profiles').select('display_name').eq('id', envelope.sender_id).maybeSingle();
  const senderName = (profile?.display_name as string | undefined) || t('page.theSender');

  if (envelope.status === 'completed') {
    return (
      <Message title={t('page.completeTitle')} body={t('page.completeBody', { title: envelope.title })}>
        <p className="mt-6 flex flex-wrap gap-3">
          <a
            href="/api/sign/document?part=sealed"
            className="inline-flex min-h-11 items-center justify-center rounded-pill bg-ink px-6 text-base font-medium text-on-ink no-underline hover:opacity-90"
          >
            {t('page.downloadPdf')}
          </a>
          <a
            href="/api/sign/document?part=certificate"
            className="inline-flex min-h-11 items-center justify-center rounded-pill border border-control-border bg-surface px-6 text-base font-medium text-ink no-underline hover:bg-surface-sand"
          >
            {t('page.downloadCertificate')}
          </a>
        </p>
        <dl className="mt-8 grid grid-cols-1 gap-2 text-sm">
          <dt className="text-ink-muted">{t('page.verificationCode')}</dt>
          <dd className="font-mono text-ink">{envelope.public_code}</dd>
          <dt className="mt-2 text-ink-muted">{t('page.sha')}</dt>
          <dd className="break-all font-mono text-xs text-ink">{envelope.final_sha256}</dd>
        </dl>
        <p className="mt-6 text-sm text-ink-muted">{t('page.downloadUntil', { date: new Date(ctx.expiresAt).toISOString().slice(0, 10) })}</p>
      </Message>
    );
  }
  if (!['sent', 'in_progress', 'failed_sealing'].includes(envelope.status)) {
    return <Message title={t('page.closedTitle')} body={t('page.closedBody', { sender: recipient.is_sender ? t('page.theSender') : senderName })} />;
  }
  const senderLine = recipient.is_sender ? t('page.senderOwn') : t('page.senderBy', { sender: senderName });
  // D-84: this person's private conversation with the sender (not shown to someone signing their own document)
  const questions = async () => {
    if (recipient.is_sender || host) return null;
    const { data } = await admin.from('envelope_comments').select('id, author_kind, body, created_at').eq('recipient_id', recipient.id).order('created_at');
    const thread: ThreadItem[] = (data ?? []).map((c) => ({ id: c.id as string, mine: c.author_kind === 'signer', body: c.body as string, at: c.created_at as string }));
    return <QuestionsPanel thread={thread} senderName={senderName} />;
  };
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
          title={recipient.status === 'approved' ? t('page.recordedApproval') : t('page.recordedSignature')}
          body={t('page.recordedBody')}
        />
      );
    }
    return (
      <Message title={t('page.allDoneTitle')} body={t('page.allDoneBody')}>
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
    return guard(
      <div className="mx-auto max-w-2xl px-4 py-10">
        <p className="text-sm text-ink-muted">{senderLine}</p>
        <h1 className="mt-1 text-2xl font-medium text-ink">{envelope.title}</h1>
        {lastWithdrawn?.withdrawn_at ? (
          <div className="mt-6">
            <Notice tone="info">{t('page.withdrawn')}</Notice>
          </div>
        ) : null}
        {openPaper ? (
          <div className="mt-4">
            <Notice tone="info">{t('page.paperAsked')}</Notice>
          </div>
        ) : null}
        <h2 className="mt-8 text-lg font-medium text-ink">{recipient.role === 'approver' ? t('page.beforeApproving') : t('page.beforeSigning')}</h2>
        {/* D-95: the legal text stays in reviewed English in every language, and says so */}
        {locale !== 'en' ? (
          <div className="mt-3">
            <Notice tone="info">{t('common.legalInEnglish')}</Notice>
          </div>
        ) : null}
        <div lang="en" dir="ltr" className="mt-3 flex flex-col gap-3 text-base text-ink-body">
          {CONSENT_PARAGRAPHS.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
        <ConsentForm signerName={recipient.name} paperRequested={Boolean(openPaper)} />
        {recipient.role !== 'viewer' ? <div className="mt-8">{await questions()}</div> : null}
        {/* a div, not a paragraph: the control carries its own dialog, which may not sit inside a <p> */}
        <div className="mt-6 flex flex-wrap gap-2">
          {openPaper ? null : <PaperCopyControl variant="quiet" />}
          {envelope.allow_delegation && recipient.role !== 'viewer' && !host ? <HandOffControl /> : null}
          <DeclineControl variant="quiet" label={t('page.declineInstead')} />
        </div>
      </div>
    );
  }
  if (recipient.status !== 'consented') {
    return <Message title={t('page.nothingTitle')} body={t('page.nothingBody')} />;
  }
  if (recipient.role === 'approver') {
    return guard(<SigningRoom mode="approve" title={envelope.title} senderLine={senderLine} signer={{ name: recipient.name, email: recipient.email }} fields={[]} adopted={{ signature: false, initials: false }} intentText={APPROVE_TEXT} allowHandOff={envelope.allow_delegation && !host} questions={await questions()} />);
  }

  const [{ data: fields }, { data: values }, { data: assets }] = await Promise.all([
    admin.from('fields').select('id, type, page, x, y, w, h, required, options').eq('recipient_id', recipient.id).order('page').order('y').order('x'),
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
    options: (f.options ?? {}) as FieldOptions,
  }));
  const kinds = new Set((assets ?? []).map((a) => a.kind as string));

  return guard(
    <SigningRoom
      title={envelope.title}
      mode="sign"
      senderLine={senderLine}
      signer={{ name: recipient.name, email: recipient.email }}
      fields={roomFields}
      adopted={{ signature: kinds.has('signature'), initials: kinds.has('initials') }}
      intentText={INTENT_TEXT}
      allowHandOff={envelope.allow_delegation && !host}
      questions={await questions()}
    />,
  );
}
