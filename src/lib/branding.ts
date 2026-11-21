// Workspace branding (D-88): a brand colour with light or dark text on it, an optional logo, an email footer.
// No I/O. The contrast rule (WCAG 2.x relative luminance and contrast ratio) is the same one the database enforces.

export type TextOnBrand = 'light' | 'dark';
/** The two text colours allowed on a brand colour (AlterMe surface white and ink). */
export const TEXT_COLOR: Record<TextOnBrand, string> = { light: '#FFFFFF', dark: '#1A1818' };
/** WCAG AA for normal-size text. */
export const MIN_CONTRAST = 4.5;
export const MAX_FOOTER = 500;
export const MAX_LOGO_BYTES = 200 * 1024;

const HEX = /^#[0-9A-Fa-f]{6}$/;

export function normaliseColor(v: string): string | null {
  const s = String(v ?? '').trim();
  return HEX.test(s) ? s.toUpperCase() : null;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** The contrast ratio between two colours, from 1 (none) to 21 (black on white), rounded down to 2 decimals. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.floor(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** Why a colour choice is refused, or null when text on it is readable. */
export function brandProblem(color: string, text: TextOnBrand): string | null {
  const c = normaliseColor(color);
  if (!c) return 'Choose a colour as six hexadecimal digits, like #2F5D50.';
  const ratio = contrastRatio(c, TEXT_COLOR[text]);
  if (ratio < MIN_CONTRAST) {
    const other: TextOnBrand = text === 'light' ? 'dark' : 'light';
    const better = contrastRatio(c, TEXT_COLOR[other]) >= MIN_CONTRAST ? ` ${other === 'light' ? 'Light' : 'Dark'} text would work on it.` : ' Choose a darker or lighter colour.';
    return `${text === 'light' ? 'Light' : 'Dark'} text on ${c} would be hard to read (contrast ${ratio.toFixed(2)}:1; at least ${MIN_CONTRAST}:1 is needed).${better}`;
  }
  return null;
}

/** The text colour that reads best on a colour (used to suggest one). */
export function bestText(color: string): TextOnBrand {
  return contrastRatio(color, TEXT_COLOR.light) >= contrastRatio(color, TEXT_COLOR.dark) ? 'light' : 'dark';
}

/** Footer text as stored: plain text, control characters other than line breaks removed, at most MAX_FOOTER. */
export function cleanFooter(v: string): string {
  return String(v ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, '')
    .replace(/[ ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_FOOTER);
}

/** PNG or JPEG by its first bytes (never by the name the browser gives); null for anything else. */
export function logoType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}
