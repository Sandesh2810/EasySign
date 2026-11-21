// D-95: filling in a message. Pure, and safe to use in the browser (it holds no catalog).
import type en from './messages/en.json';

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
export type Vars = Record<string, string | number>;
export type T = (key: MessageKey, vars?: Vars) => string;

/** "Hello {name}" + { name: 'Ana' } -> "Hello Ana". A missing value is left visible as {name} so it is noticed. */
export function format(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all));
}

export function makeT(messages: Messages, fallback?: Messages): T {
  return (key, vars) => format(messages[key] ?? fallback?.[key] ?? key, vars);
}
