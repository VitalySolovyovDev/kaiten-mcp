import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Config } from './config.js';
import { KaitenError } from './errors.js';
import { metadata } from './metadata.js';

export function isPrivateAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice(7);
    if (mapped.includes('.')) return isPrivateAddress(mapped);
    const groups = mapped.split(':');
    if (groups.length === 2) {
      const high = parseInt(groups[0], 16), low = parseInt(groups[1], 16);
      return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return true;
  }
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return lower === '::' || lower === '::1' || /^(?:fc|fd|fe[89ab])/.test(lower);
}

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }

export class HttpClient {
  constructor(readonly config: Config) {}

  private async request(url: URL, auth: boolean, maxBytes: number): Promise<Reply> {
    if (url.username || url.password || !['https:', 'http:'].includes(url.protocol) ||
        (url.protocol === 'http:' && !this.config.allowHttp)) {
      throw new KaitenError('URL_BLOCKED', 'The attachment URL is not allowed.');
    }
    const sameOrigin = url.origin === this.config.baseUrl.origin;
    if (auth && (!sameOrigin || !url.pathname.startsWith(this.config.baseUrl.pathname + 'api/'))) {
      throw new KaitenError('URL_BLOCKED', 'Credentials can only be sent to the configured Kaiten API.');
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: { address: string; family: number }[];
    try { addresses = await lookup(hostname, { all: true }); }
    catch { throw new KaitenError('NETWORK_ERROR', 'Unable to resolve the server address.'); }
    const trusted = sameOrigin || this.config.attachmentAllowedHosts.includes(hostname.toLowerCase());
    if (!addresses.length || (!trusted && addresses.some(a => isPrivateAddress(a.address)))) {
      throw new KaitenError('URL_BLOCKED', 'Private attachment hosts require KAITEN_ATTACHMENT_ALLOWED_HOSTS.');
    }
    // Pin the validated DNS result to the connection, avoiding a second DNS lookup.
    const target = addresses[0];
    return new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'GET',
        headers: { Accept: auth ? 'application/json' : '*/*', 'User-Agent': `${metadata.name}/${metadata.version}`,
          ...(auth ? { Authorization: `Bearer ${this.config.token}` } : {}) },
        lookup: (_hostname, options, callback) => {
          if (typeof options === 'object' && options.all) callback(null, [target]);
          else callback(null, target.address, target.family);
        },
      }, response => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          resolve({ status, headers: response.headers, body: Buffer.alloc(0) });
          return;
        }
        if (Number(response.headers['content-length'] ?? 0) > maxBytes) {
          reject(new KaitenError('FILE_TOO_LARGE', 'Response exceeds the configured size limit.'));
          req.destroy();
          return;
        }
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            reject(new KaitenError('FILE_TOO_LARGE', 'Response exceeds the configured size limit.'));
            req.destroy();
          }
          else chunks.push(chunk);
        });
        response.on('end', () => resolve({ status, headers: response.headers, body: Buffer.concat(chunks) }));
        response.on('error', () => reject(new KaitenError('NETWORK_ERROR', 'Connection interrupted while reading data.')));
      });
      const timer = setTimeout(() => {
        reject(new KaitenError('TIMEOUT', 'Request timed out.'));
        req.destroy();
      }, this.config.timeoutMs);
      req.on('close', () => clearTimeout(timer));
      req.on('error', error => reject(error instanceof KaitenError ? error : new KaitenError('NETWORK_ERROR', 'Unable to connect to the server.')));
      req.end();
    });
  }

  private async getWithRetries(url: URL, auth: boolean, maxBytes: number): Promise<Reply> {
    for (let attempt = 0; ; attempt++) {
      let reply: Reply;
      try { reply = await this.request(url, auth, maxBytes); }
      catch (error) {
        if (attempt >= 2 || !(error instanceof KaitenError) || !['NETWORK_ERROR', 'TIMEOUT'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 150 * 2 ** attempt));
        continue;
      }
      if (attempt >= 2 || !(reply.status === 429 || [500, 502, 503, 504].includes(reply.status))) return reply;
      const retryAfter = String(reply.headers['retry-after'] ?? '');
      const reset = Number(reply.headers['x-ratelimit-reset']);
      let delay = /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
      if (!Number.isFinite(delay)) delay = Number.isFinite(reset) ? reset * 1000 - Date.now() : 150 * 2 ** attempt;
      // Do not retry before a long requested cooldown; return an actionable 429 instead.
      if (delay > 5000) return reply;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, delay)));
    }
  }

  private checkStatus(status: number): void {
    if (status >= 200 && status < 300) return;
    const codes: Record<number, [string, string]> = {
      401: ['UNAUTHORIZED', 'The API token is invalid or expired.'],
      403: ['FORBIDDEN', 'Access denied by Kaiten or the file server.'],
      404: ['NOT_FOUND', 'The requested card or file was not found.'],
      405: ['UNSUPPORTED_ROUTE', 'This Kaiten instance does not support the requested read route.'],
      410: ['UNSUPPORTED_ROUTE', 'This Kaiten read route is no longer available.'],
      501: ['UNSUPPORTED_ROUTE', 'This Kaiten instance does not implement the requested route.'],
      422: ['FILE_REJECTED', 'Kaiten rejected the file. It may be marked as malicious.'],
      429: ['RATE_LIMITED', 'Rate limit reached. Retry later.'],
    };
    const [code, message] = codes[status] ?? ['HTTP_ERROR', `Server returned HTTP ${status}.`];
    throw new KaitenError(code, message, status);
  }

  async json(path: string, query: Record<string, string | number> = {}): Promise<unknown> {
    const url = new URL(`api/latest/${path}`, this.config.baseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const reply = await this.getWithRetries(url, true, this.config.maxFileBytes);
    this.checkStatus(reply.status);
    try { return JSON.parse(reply.body.toString('utf8')); }
    catch { throw new KaitenError('API_RESPONSE_INVALID', 'Kaiten returned an invalid JSON response.'); }
  }

  async file(input: string, authenticate = false): Promise<{ bytes: Buffer; mimeType: string }> {
    let url: URL;
    try { url = new URL(input, this.config.baseUrl); }
    catch { throw new KaitenError('URL_BLOCKED', 'The attachment URL is invalid.'); }
    for (let redirects = 0; redirects <= 5; redirects++) {
      const reply = await this.getWithRetries(url, authenticate, this.config.maxFileBytes);
      if ([301, 302, 303, 307, 308].includes(reply.status)) {
        const location = reply.headers.location;
        if (typeof location !== 'string') throw new KaitenError('FILE_REDIRECT_INVALID', 'Missing file redirect destination.');
        try { url = new URL(location, url); } catch { throw new KaitenError('FILE_REDIRECT_INVALID', 'Invalid file redirect destination.'); }
        authenticate = false; // Credentials are never forwarded across redirects, including same-origin ones.
        continue;
      }
      this.checkStatus(reply.status);
      return { bytes: reply.body, mimeType: String(reply.headers['content-type'] ?? 'application/octet-stream').split(';')[0] };
    }
    throw new KaitenError('FILE_REDIRECT_INVALID', 'Too many file redirects.');
  }
}
