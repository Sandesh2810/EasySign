// D-95: the database's messages that can reach a signer, in the signer's language. The database words them in English
// ("ES_CODE: text"); friendlyDbError turns that into a sentence, which is matched here exactly. Anything not listed
// (rare, or with content from the sender, such as a value check's message) stays in English. Pure.
import { friendlyDbError } from '@/lib/db-error';
import type { MessageKey, T } from './format';

const KNOWN: Record<string, MessageKey> = {
  'You have already finished this document.': 'db.alreadyDone',
  'Pass the extra identity check first.': 'db.checkNeeded',
  'Agree to use electronic records and signatures first.': 'db.consentRequired',
  'This consent wording is not on file.': 'db.consentVersion',
  'The date on your device looks wrong. Check its clock and try again.': 'db.date',
  'Some required fields are still empty.': 'db.fieldsMissing',
  'That field cannot be filled in.': 'db.fieldCannotFill',
  'That field cannot take a file.': 'db.fieldNoFile',
  'The sender filled this in and it cannot be changed.': 'db.fieldReadonly',
  'Create your initials first.': 'db.initialsMissing',
  'Write your question (up to 1000 characters).': 'db.questionInvalid',
  'The screen is locked; hand the device to the host to unlock it.': 'db.inPersonLocked',
  'This person signs in person on the host.': 'db.inPersonOnly',
  'This conversation is full. Contact the sender another way.': 'db.conversationFull',
  'This document has been handed over too many times. Contact the sender.': 'db.handedTooOftenDoc',
  'This part has been handed over too many times. Contact the sender.': 'db.handedTooOftenPart',
  'This document is no longer open.': 'db.noLongerOpen',
  'This document is no longer open for signing.': 'db.noLongerOpenSigning',
  'This in-person signing has ended.': 'db.inPersonEnded',
  'This link is no longer valid.': 'db.linkInvalid',
  'The sender has not allowed handing this document to someone else.': 'db.handoffNotAllowed',
  'There is nothing for you to sign on this document.': 'db.notAnActor',
  'It is not your turn yet. You will be told when the document is ready for you.': 'db.notYourTurn',
  'There is no code check to finish.': 'db.noCheckInProgress',
  'This link does not use an access code.': 'db.noAccessCode',
  'This link does not use an emailed code.': 'db.noEmailCode',
  'This document is on hold and cannot be opened right now.': 'db.holdOpen',
  'This document is on hold and cannot be signed right now.': 'db.holdSign',
  'Create your signature first.': 'db.signatureMissing',
  'You have changed your signature too many times. Use the one you have, or ask the sender for a new link.': 'db.signatureChanges',
  'An approver approves or declines; there is nothing to sign.': 'db.approverOnly',
  'Only an approver can approve.': 'db.onlyApprover',
  'Unknown language.': 'db.unknownLanguage',
};

const GROUP_DONE = /^(.+) has already signed for your signing group; nothing more is needed from you\.$/;

/** The database error as the signer should read it, plus its code (for decisions that must not depend on wording). */
export function signerDbError(t: T, raw: string | undefined): { code: string; message: string } {
  const { code, message } = friendlyDbError(raw);
  const key = KNOWN[message];
  if (key) return { code, message: t(key) };
  const group = GROUP_DONE.exec(message);
  if (group) return { code, message: t('db.groupDone', { name: group[1] }) };
  return { code, message };
}

export const KNOWN_DB_MESSAGES = KNOWN;
