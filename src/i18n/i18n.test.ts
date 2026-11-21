// D-95 (AT5.6, automated part): every language is complete, placeholders match English, language choice, right to
// left, database messages and field checks worded in the signer's language, emails in every language.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MESSAGES, translator } from './catalog';
import { dirOf, LOCALES, negotiate } from './config';
import { KNOWN_DB_MESSAGES, signerDbError } from './db-messages';
import { format, type MessageKey } from './format';
import en from './messages/en.json';
import { FIELD_CHECK_EN } from '@/lib/fields';
import { completionTemplate, otpTemplate, signatureRequestTemplate, voidedTemplate, commentReplyTemplate } from '@/mail/templates';

const keys = Object.keys(en).sort();
const placeholders = (s: string) => [...s.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();

describe('the message files', () => {
  it.each(LOCALES)('%s has exactly the English keys, none empty, the same placeholders', (l) => {
    const m = MESSAGES[l] as Record<string, string>;
    expect(Object.keys(m).sort()).toEqual(keys);
    for (const k of keys) {
      expect(m[k].trim(), `${l} ${k}`).not.toBe('');
      expect(placeholders(m[k]), `${l} ${k}`).toEqual(placeholders((en as Record<string, string>)[k]));
    }
  });
  it('the translations are translations (not English copied over)', () => {
    for (const l of ['es', 'hi', 'ar'] as const) {
      const same = keys.filter((k) => (MESSAGES[l] as Record<string, string>)[k] === (en as Record<string, string>)[k] && !/^\{[a-z]+\}: \{[a-z]+\}$|^\{|SHA-256/.test((en as Record<string, string>)[k]));
      expect(same.length, `${l}: ${same.slice(0, 5).join(', ')}`).toBeLessThan(5);
    }
  });
  it('Hindi is in Devanagari and Arabic in Arabic script', () => {
    expect(MESSAGES.hi['consent.submit']).toMatch(/[ऀ-ॿ]/);
    expect(MESSAGES.ar['consent.submit']).toMatch(/[؀-ۿ]/);
  });
});

describe('choosing the language', () => {
  it('follows the browser, best match first, else English', () => {
    expect(negotiate('es-MX,es;q=0.9,en;q=0.8')).toBe('es');
    expect(negotiate('fr-FR,fr;q=0.9,ar;q=0.5,en;q=0.3')).toBe('ar');
    expect(negotiate('hi-IN')).toBe('hi');
    expect(negotiate('en;q=0.2,es;q=0.9')).toBe('es');
    expect(negotiate('de-DE,fr;q=0.8')).toBe('en');
    expect(negotiate('es;q=0')).toBe('en');
    expect(negotiate('')).toBe('en');
    expect(negotiate(null)).toBe('en');
    expect(negotiate('*')).toBe('en');
  });
  it('Arabic reads right to left, the others left to right', () => {
    expect(dirOf('ar')).toBe('rtl');
    for (const l of ['en', 'es', 'hi'] as const) expect(dirOf(l)).toBe('ltr');
  });
  it('fills in values and leaves a missing one visible', () => {
    expect(format('Hello {name}, {x}', { name: 'Ana' })).toBe('Hello Ana, {x}');
    expect(translator('es')('room.progress', { done: 2, total: 5 })).toBe('2 de 5 hechos');
  });
});

describe('database messages reach the signer in their language', () => {
  it('every listed sentence is the English catalog wording', () => {
    for (const [sentence, key] of Object.entries(KNOWN_DB_MESSAGES)) expect(translator('en')(key), sentence).toBe(sentence);
  });
  it('every message the signer functions can raise is listed (or carries the sender’s or a person’s words)', () => {
    const dir = path.join(process.cwd(), 'supabase', 'migrations');
    const latest = new Map<string, string>();
    for (const f of readdirSync(dir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
      const s = readFileSync(path.join(dir, f), 'utf8');
      for (const m of s.matchAll(/create (?:or replace )?function (?:public|app_private)\.([a-z_]+)\(/g)) {
        latest.set(m[1], s.slice(m.index, s.indexOf('\n$$;', m.index)));
      }
    }
    const missing: string[] = [];
    for (const [name, body] of latest) {
      if (!name.includes('signer') && !name.startsWith('in_person')) continue;
      for (const x of body.matchAll(/'(ES_[A-Z_]+): ([^']*)'/g)) {
        if (x[2].includes('%')) continue; // a name or the sender's own message is inside
        const sentence = x[2].charAt(0).toUpperCase() + x[2].slice(1) + '.';
        if (!(sentence in KNOWN_DB_MESSAGES)) missing.push(`${x[1]}: ${sentence}`);
      }
    }
    expect(missing).toEqual([]);
  });
  it('translates by wording, keeps the code, and passes unknown messages through', () => {
    const t = translator('ar');
    expect(signerDbError(t, 'ES_SIGNATURE_MISSING: create your signature first')).toEqual({ code: 'ES_SIGNATURE_MISSING', message: MESSAGES.ar['db.signatureMissing'] });
    expect(signerDbError(t, 'ES_GROUP_DONE: Bo Smith has already signed for your signing group; nothing more is needed from you').message).toContain('Bo Smith');
    expect(signerDbError(t, 'ES_VALUE_INVALID: use the format AB-123')).toEqual({ code: 'ES_VALUE_INVALID', message: 'Use the format AB-123.' });
  });
});

describe('field checks', () => {
  it('the English catalog says exactly what the field checks say', () => {
    for (const [k, sentence] of Object.entries(FIELD_CHECK_EN)) expect(translator('en')(`check.${k}` as MessageKey, { n: '{n}' }), k).toBe(sentence);
  });
});

describe('emails to signers', () => {
  const v = { signerName: 'Ana', senderName: 'Bo', title: 'Lease', signUrl: 'https://example.test/s#x', expiresOn: '2026-12-31' };
  it.each(LOCALES)('%s: every signer email is complete (no placeholder left) and marked with its language', (l) => {
    const mails = [
      signatureRequestTemplate({ ...v, locale: l }),
      signatureRequestTemplate({ ...v, locale: l, reminder: true, purpose: 'approve' }),
      otpTemplate({ name: 'Ana', title: 'Lease', code: '123456', minutes: 10, locale: l }),
      voidedTemplate({ name: 'Ana', senderName: 'Bo', title: 'Lease', locale: l }),
      completionTemplate({ name: 'Ana', title: 'Lease', code: 'ES-1', finalSha256: 'ab', locale: l }),
      commentReplyTemplate({ name: 'Ana', senderName: 'Bo', title: 'Lease', answer: 'Yes', signUrl: v.signUrl, expiresOn: v.expiresOn, locale: l }),
    ];
    for (const m of mails) {
      for (const part of [m.subject, m.html, m.text]) expect(part).not.toMatch(/\{[a-z]+\}/);
      expect(m.html).toContain(`<html lang="${l}"`);
      expect(m.text).toContain('Ana');
    }
    if (l === 'ar') expect(mails[0].html).toContain('dir="rtl"');
    else expect(mails[0].html).not.toContain('dir="rtl"');
  });
  it('a Spanish request is in Spanish, with the title and the link', () => {
    const m = signatureRequestTemplate({ ...v, locale: 'es' });
    expect(m.subject).toBe('Bo le ha enviado "Lease" para firmar');
    expect(m.text).toContain('Abra este enlace:');
    expect(m.text).toContain(v.signUrl);
  });
});
