// Wording the signer agrees to. DRAFT TEMPLATE - to be reviewed by counsel before any public launch
// (docs/LEGAL_NOTES.md). Changing any text here requires a new version string: the version and the
// SHA-256 of the exact text are stored with every consent and printed on the certificate.
import { PRODUCT_NAME } from './brand';

// v2 (2026-11-19): the product is now called YouNMeSign; the wording is otherwise unchanged.
export const CONSENT_VERSION = 'esign-consent-2026-11-v2';

export const CONSENT_PARAGRAPHS: readonly string[] = [
  `You have been asked to review and sign a document electronically using ${PRODUCT_NAME}.`,
  'By agreeing, you consent to use electronic records and electronic signatures for this document instead of paper. Your electronic signature will have the same effect as a signature written by hand.',
  'You do not have to agree. If you would rather sign on paper, close this page and ask the sender for a paper copy. Asking for paper is free on our side; the sender decides how to provide it.',
  'You can withdraw your consent at any time before you finish signing by closing this page and telling the sender. Withdrawing after you have finished does not undo a completed signature.',
  'To read and keep the document you need a current web browser and a way to open and save PDF files. When everyone has signed you can download a copy of the completed document and its certificate.',
  'To keep a record of the signing, we log the time, your internet address (IP) and your browser type for each step you take.',
];

export const CONSENT_TEXT = CONSENT_PARAGRAPHS.join('\n\n');

export const APPROVE_TEXT = 'By selecting Approve, I confirm that I have read the document and that I approve it going ahead.';

export const INTENT_TEXT =
  'By selecting Adopt and Sign, I confirm that the signature and initials shown are mine, that I have read the document, and that I intend to sign it electronically.';
