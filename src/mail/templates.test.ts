import { describe, it, expect } from 'vitest';
import { esc, verifyEmailTemplate } from './templates';

describe('email templates', () => {
  it('escapes HTML in anything a person typed', () => {
    expect(esc(`<script>alert("x")</script>&'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;');
    const t = verifyEmailTemplate({ name: '<img src=x onerror=alert(1)>', confirmUrl: 'http://localhost:3000/auth/confirm?token_hash=abc&type=signup' });
    expect(t.html).not.toContain('<img src=x');
    expect(t.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('verification email carries the link in both the HTML and the plain-text part', () => {
    const url = 'http://localhost:3000/auth/confirm?token_hash=abc123&type=signup';
    const t = verifyEmailTemplate({ name: 'Alice', confirmUrl: url });
    expect(t.subject).toBe('Confirm your email for EasySign');
    expect(t.html).toContain('href="http://localhost:3000/auth/confirm?token_hash=abc123&amp;type=signup"');
    expect(t.text).toContain(url);
    expect(t.text).toContain('Hello Alice,');
  });

  it('loads no remote images, scripts or trackers', () => {
    const t = verifyEmailTemplate({ name: 'Alice', confirmUrl: 'http://localhost:3000/x' });
    expect(t.html).not.toMatch(/<img|<script|<link|<iframe/i);
  });
});
