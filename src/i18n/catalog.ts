// D-95: every language's messages (server side: the browser only receives the one language it needs). Pure.
import type { Locale } from './config';
import { makeT, type Messages, type T } from './format';
import ar from './messages/ar.json';
import en from './messages/en.json';
import es from './messages/es.json';
import hi from './messages/hi.json';

export const MESSAGES: Record<Locale, Messages> = { en, es: es as Messages, hi: hi as Messages, ar: ar as Messages };

/** A translator for one language; anything missing falls back to English (a unit test keeps every language complete). */
export const translator = (locale: Locale): T => makeT(MESSAGES[locale], MESSAGES.en);
export const EN: T = translator('en');
