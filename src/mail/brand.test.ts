import { describe, it, expect } from 'vitest';
import { brandEmail, signatureRequestTemplate } from './templates';

const base = () =>
  signatureRequestTemplate({ signerName: 'Rita', senderName: 'Sam', title: 'Lease', signUrl: 'https://x.test/s#abc', expiresOn: '2026-12-31' });

describe('branded emails (D-88)', () => {
  it('without branding the email is unchanged', () => {
    const e = base();
    expect(brandEmail(e, null)).toEqual(e);
    expect(brandEmail(e, { name: 'Acme', color: 'red', textColor: '#FFFFFF', footer: null })).toEqual(e);
  });

  it('puts the workspace name on a band in its colours, colours the button, and adds the footer to HTML and text', () => {
    const e = brandEmail(base(), { name: 'Acme <Lettings>', color: '#2F5D50', textColor: '#FFFFFF', footer: 'Acme Lettings Ltd\n1 High Street & Co' });
    expect(e.html).toContain('background:#2F5D50;color:#FFFFFF;padding:12px 16px');
    expect(e.html).toContain('Acme &lt;Lettings&gt;');
    expect(e.html).not.toContain('<Lettings>');
    expect(e.html).toContain('Sent with YouNMeSign');
    // the button carries the brand colours instead of the default ink
    expect(e.html).not.toContain('background:#1a1818;color:#fffcf4;');
    expect(e.html).toMatch(/<a href="[^"]+" style="display:inline-block;background:#2F5D50;color:#FFFFFF;/);
    expect(e.html).toContain('Acme Lettings Ltd\n1 High Street &amp; Co');
    expect(e.text.startsWith('Acme <Lettings> (sent with YouNMeSign)')).toBe(true);
    expect(e.text.endsWith('--\nAcme Lettings Ltd\n1 High Street & Co')).toBe(true);
    expect(e.subject).toBe(base().subject);
  });

  it('a footer made of HTML is shown as text, never run', () => {
    const e = brandEmail(base(), { name: 'X', color: '#2F5D50', textColor: '#FFFFFF', footer: '<img src=x onerror=alert(1)>' });
    expect(e.html).not.toContain('<img src=x');
    expect(e.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
