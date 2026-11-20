// Wording the signer agrees to. DRAFT TEMPLATE - to be reviewed by counsel before any public launch
// (docs/LEGAL_NOTES.md). Changing any text here requires a new version string: the version and the
// SHA-256 of the exact text are stored with every consent and printed on the certificate.
import { PRODUCT_NAME } from './brand';

// v2 (2026-11-19): the product is now called YouNMeSign; the wording is otherwise unchanged.
// v3 (2026-11-19, Phase 3 slice 3): asking for a paper copy and withdrawing are now buttons on the page.
// Every version is kept word for word in the database (consent_versions); a version name means one exact text.
export const CONSENT_VERSION = 'esign-consent-2026-11-v3';

export const CONSENT_PARAGRAPHS: readonly string[] = [
  `You have been asked to review and sign a document electronically using ${PRODUCT_NAME}.`,
  'By agreeing, you consent to use electronic records and electronic signatures for this document instead of paper. Your electronic signature will have the same effect as a signature written by hand.',
  'You do not have to agree. If you would rather have the document on paper, select "Ask for a paper copy" on this page, or contact the sender. You can ask at any time before you finish. Asking costs nothing on our side; the sender decides how to provide the paper copy.',
  'You can withdraw your consent at any time before you finish by selecting "Withdraw consent" on the signing page. The sender is told straight away. Anything you have filled in or signed so far is cleared, and you cannot sign until you agree again. Withdrawing after you have finished does not undo a completed signature.',
  'To read and keep the document you need a current web browser and a way to open and save PDF files. When everyone has signed you can download a copy of the completed document and its certificate.',
  'To keep a record of the signing, we log the time, your internet address (IP) and your browser type for each step you take.',
];

export const CONSENT_TEXT = CONSENT_PARAGRAPHS.join('\n\n');

/** SHA-256 of CONSENT_TEXT. Pinned so that a change to the wording without a new version fails the tests. */
export const CONSENT_SHA256 = '943e4ae5d5978ff5a57c1f24d405410e92fa02ed0b50f335589595ba54440f2a';

/**
 * Documents that should not be signed through this service. DRAFT, not reviewed by counsel
 * (docs/LEGAL_NOTES.md item 2): ESIGN and state laws exclude some document types, and the exact list differs by
 * law and by state. Shown to senders before they send.
 */
export const EXCLUDED_DOCUMENTS: readonly string[] = [
  'wills, codicils and testamentary trusts',
  'adoption, divorce and other family-law documents',
  'court orders, notices and official court documents',
  'notices that utility services (water, heat, power) will be cut off',
  'default, foreclosure, eviction or repossession notices for a home someone lives in',
  'notices cancelling health or life insurance',
  'product recall or safety notices',
  'documents that must travel with hazardous materials',
  'health or medical records of any kind (not supported in this version)',
];

export const APPROVE_TEXT = 'By selecting Approve, I confirm that I have read the document and that I approve it going ahead.';

export const INTENT_TEXT =
  'By selecting Adopt and Sign, I confirm that the signature and initials shown are mine, that I have read the document, and that I intend to sign it electronically.';
