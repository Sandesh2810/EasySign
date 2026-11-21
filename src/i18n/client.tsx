'use client';
// D-95: the signer's language in the browser. The signer layout passes the one language's messages; components read
// them with useT(). Outside a provider, English is used.
import { createContext, Fragment, useContext, useMemo, type ReactNode } from 'react';
import type { Locale } from './config';
import { makeT, type MessageKey, type Messages, type T, type Vars } from './format';
import en from './messages/en.json';

const Ctx = createContext<{ locale: Locale; t: T }>({ locale: 'en', t: makeT(en) });

export function I18nProvider({ locale, messages, children }: { locale: Locale; messages: Messages; children: ReactNode }) {
  const value = useMemo(() => ({ locale, t: makeT(messages, en) }), [locale, messages]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useT = (): T => useContext(Ctx).t;
export const useLocale = (): Locale => useContext(Ctx).locale;

/** A message with some values shown as elements (for example the email address in bold), in the message's word order. */
export function rich(t: T, key: MessageKey, nodes: Record<string, ReactNode>, vars: Vars = {}): ReactNode[] {
  // put a marker for each element, fill in the plain values, then split on the markers
  const marked = Object.fromEntries(Object.keys(nodes).map((k) => [k, `\u0000${k}\u0000`]));
  return t(key, { ...vars, ...marked })
    .split('\u0000')
    .map((part, i) => (i % 2 === 1 && Object.hasOwn(nodes, part) ? <Fragment key={i}>{nodes[part]}</Fragment> : part));
}
