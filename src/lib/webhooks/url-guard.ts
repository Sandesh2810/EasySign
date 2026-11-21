// D-92: where a webhook may be sent. Only https, only public internet addresses: never this computer (loopback), the
// local network, link-local (cloud metadata lives at 169.254.169.254), carrier-grade NAT, multicast, documentation or
// other reserved ranges. Names are checked when the endpoint is saved and again, address by address, at the moment
// of each delivery (the delivery connects only to an address that passed). D-98: only the usual https ports (443 and
// 8443), and never an address on the server's own deny list (WEBHOOK_DENY_IPS: its own public addresses). Pure: no I/O.
import { BlockList, isIP } from 'node:net';

export interface GuardOptions {
  /** Development only (see loopbackAllowed): also allow http and this computer, so a local test receiver can be used. */
  allowLoopback?: boolean;
  /** D-98: exact addresses that are never allowed (the server's own public addresses; see denyAddresses). */
  deny?: readonly string[];
}

const blocked4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked4.addSubnet(net, prefix, 'ipv4');

// IPv6: only global unicast (2000::/3) can be public, minus the reserved parts inside it
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const blocked6 = new BlockList();
for (const [net, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked6.addSubnet(net, prefix, 'ipv6');

const loop4 = new BlockList();
loop4.addSubnet('127.0.0.0', 8, 'ipv4');

/** True only for an address on the public internet (or, with allowLoopback, this computer). */
export function isAllowedAddress(address: string, opts: GuardOptions = {}): boolean {
  const ip = address.replace(/^\[|\]$/g, '');
  const v = isIP(ip);
  if (v && opts.deny?.some((d) => sameAddress(d, ip))) return false;
  if (v === 4) return (opts.allowLoopback === true && loop4.check(ip, 'ipv4')) || !blocked4.check(ip, 'ipv4');
  if (v === 6) {
    if (opts.allowLoopback === true && ip === '::1') return true;
    return global6.check(ip, 'ipv6') && !blocked6.check(ip, 'ipv6');
  }
  return false;
}

/** The same address however it is written (IPv6 has several spellings). IPv4-mapped IPv6 is refused anyway (not 2000::/3). */
function sameAddress(a: string, b: string): boolean {
  const va = isIP(a);
  if (!va || va !== isIP(b)) return false;
  const family = va === 4 ? 'ipv4' : 'ipv6';
  const list = new BlockList();
  list.addAddress(a, family);
  return list.check(b, family);
}

/** D-98: the server's own addresses from WEBHOOK_DENY_IPS (comma-separated); anything that is not an address is ignored. */
export function denyAddresses(vars: Record<string, string | undefined>): string[] {
  return (vars.WEBHOOK_DENY_IPS ?? '').split(',').map((s) => s.trim().replace(/^\[|\]$/g, '')).filter((s) => isIP(s) !== 0);
}

const LOCAL_NAME = /(^|\.)(localhost|local|internal|home\.arpa|lan|intranet|corp)$/i;
const LOOPBACK_NAME = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** The address a person typed, checked before it is saved (and again before each delivery). */
export function checkWebhookUrl(raw: string, opts: GuardOptions = {}): UrlCheck {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, reason: 'Enter the address that should receive the events.' };
  if (text.length > 2000) return { ok: false, reason: 'The address is too long (2,000 characters at most).' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: 'That is not a web address. It should start with https://' };
  }
  const loopbackHost = LOOPBACK_NAME.test(url.hostname);
  const devLoopback = opts.allowLoopback === true && loopbackHost;
  if (url.protocol !== 'https:' && !(devLoopback && url.protocol === 'http:')) return { ok: false, reason: 'The address must start with https:// (events are only sent encrypted).' };
  if (url.username || url.password) return { ok: false, reason: 'Do not put a user name or password in the address.' };
  if (url.hash) return { ok: false, reason: 'Remove the part after # from the address.' };
  if (devLoopback) return { ok: true, url };
  // D-98: only the usual https ports, so the feature cannot be used to probe other services
  if (url.port !== '' && url.port !== '8443') return { ok: false, reason: 'Use the standard https port (443) or 8443.' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    return isAllowedAddress(host, opts) ? { ok: true, url } : { ok: false, reason: 'That address is on a private or reserved network. Events can only be sent to the public internet.' };
  }
  if (!host.includes('.') || LOCAL_NAME.test(host)) return { ok: false, reason: 'That name only works inside a private network. Events can only be sent to the public internet.' };
  return { ok: true, url };
}

/**
 * The development allowance: WEBHOOK_ALLOW_LOOPBACK=1 is honoured only while the app itself runs on this computer
 * (APP_URL is http://localhost…, set explicitly: D-98, a missing APP_URL does not count). On any real server the guard is
 * always strict.
 */
export function loopbackAllowed(vars: Record<string, string | undefined>): boolean {
  return vars.WEBHOOK_ALLOW_LOOPBACK === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(vars.APP_URL ?? '') && vars.NODE_ENV !== 'production';
}
