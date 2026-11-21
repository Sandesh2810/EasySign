// D-92: one webhook POST. The address is checked again here; the name is resolved by our own lookup, which refuses it
// if any of its addresses is private or reserved and hands the socket only an address that passed (so a name cannot
// switch to a private address between the check and the connection). No redirects are followed; the answer's body is
// read only up to 4 KB and never stored; everything stops after 10 seconds.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { checkWebhookUrl, isAllowedAddress, type GuardOptions } from './url-guard';

export interface DeliveryResult {
  ok: boolean;
  statusCode: number | null;
  /** A short sentence for the delivery log (never the receiver's answer body). */
  error: string | null;
  durationMs: number;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function guardedLookup(opts: GuardOptions) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, '');
      const list = addresses as LookupAddress[];
      if (list.length === 0 || list.some((a) => !isAllowedAddress(a.address, opts))) {
        return callback(Object.assign(new Error('blocked'), { code: 'ES_BLOCKED' }), '');
      }
      if (options?.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

function describe(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code ?? '';
  if (code === 'ES_BLOCKED') return 'Not sent: the name points to a private or reserved address';
  if (code === 'ES_TIMEOUT') return 'No answer within 10 seconds';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The name could not be found';
  if (code === 'ECONNREFUSED') return 'Connection refused';
  if (code === 'ECONNRESET') return 'The connection was closed by the receiver';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'The connection timed out';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return `The receiver's certificate is not valid (${code})`;
  return code ? `Connection failed (${code})` : 'Connection failed';
}

export function postWebhook(rawUrl: string, body: string, headers: Record<string, string>, opts: GuardOptions & { timeoutMs?: number } = {}): Promise<DeliveryResult> {
  const started = Date.now();
  const done = (ok: boolean, statusCode: number | null, error: string | null): DeliveryResult => ({ ok, statusCode, error, durationMs: Date.now() - started });
  const check = checkWebhookUrl(rawUrl, opts);
  if (!check.ok) return Promise.resolve(done(false, null, `Not sent: ${check.reason}`));
  const url = check.url;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise<DeliveryResult>((resolve) => {
    let settled = false;
    const finish = (r: DeliveryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const request = (url.protocol === 'https:' ? https : http).request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        lookup: guardedLookup(opts) as never,
        agent: false,
      },
      (res) => {
        const code = res.statusCode ?? 0;
        let seen = 0;
        const close = () => {
          res.destroy();
          if (code >= 200 && code < 300) finish(done(true, code, null));
          else if (code >= 300 && code < 400) finish(done(false, code, `Redirects are not followed (HTTP ${code})`));
          else finish(done(false, code, `HTTP ${code}`));
        };
        res.on('data', (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > 4096) close();
        });
        res.on('end', close);
        res.on('error', close);
        res.on('close', close);   // D-98: a connection dropped mid-answer still finishes the attempt
      },
    );
    const timer = setTimeout(() => request.destroy(Object.assign(new Error('timeout'), { code: 'ES_TIMEOUT' })), timeoutMs);
    request.on('error', (e) => finish(done(false, null, describe(e))));
    request.end(body);
  });
}
