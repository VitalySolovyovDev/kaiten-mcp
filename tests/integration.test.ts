import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';
import { KaitenClient } from '../src/kaiten.js';
import { HttpClient } from '../src/http.js';
import { createServer } from '../dist/server.js';
import { fixtures, json, listen } from './helpers.js';

const token = 'mock-secret';
let api: Awaited<ReturnType<typeof listen>>, storage: Awaited<ReturnType<typeof listen>>;
let files: Record<string, Buffer>;
const apiAuth: string[] = [], storageAuth: (string | undefined)[] = [];
let retryCount = 0, unauthorizedCount = 0, transientCount = 0;
const comments = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, uid: `comment-${i+1}`, text: `Comment ${i+1}`, type: 1, author: { id: 1, full_name: 'Tester' }, created: '2026-10-14', files: i === 100 ? [{ id: 'comment-file', name: 'note.txt', type: 11, entity_type: 'comment', comment_uid: 'comment-101' }] : [] }));
beforeAll(async () => {
  files = await fixtures();
  storage = await listen((req, res) => {
    storageAuth.push(req.headers.authorization);
    const name = req.url!.slice(1).split('?')[0];
    const file = files[name];
    if (file) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(file); }
    else { res.writeHead(404); res.end(); }
  });
  api = await listen((req, res) => {
    apiAuth.push(req.headers.authorization ?? '');
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname.endsWith('/retry')) {
      retryCount++; if (retryCount < 3) { res.writeHead(429, { 'Retry-After': '0' }); res.end(); } else json(res, { ok: true });
    } else if (url.pathname.endsWith('/transient')) {
      transientCount++; if (transientCount < 2) { res.writeHead(503); res.end(); } else json(res, { ok: true });
    } else if (url.pathname.endsWith('/unauthorized')) {
      unauthorizedCount++; json(res, { secret: token }, 401);
    } else if (url.pathname.endsWith('/forbidden')) json(res, { secret: token }, 403);
    else if (url.pathname.endsWith('/slow')) setTimeout(() => { if (!res.destroyed) json(res, {}); }, 100);
    else if (url.pathname.endsWith('/cards/123')) json(res, { id: 123, uid: 'card-uid', title: 'Test card', description: '', files: [
      { id: 'old-file', name: 'note.txt', type: 1, url: storage.url + '/note.txt' },
      { id: 'protected-file', name: 'document.pdf', type: 11, entity_type: 'card' },
      { id: 'redirect-file', name: 'note.txt', type: 11, url: api.url + '/api/latest/cards/card-uid/files/redirect-file/content' },
      { id: 'cloud-file', name: 'Cloud document', type: 2, url: 'https://drive.example/file' },
      { id: 'big-file', name: 'big.txt', type: 1, size: 21 * 1024 * 1024, url: storage.url + '/note.txt' },
      { id: 'image-file', name: 'image.png', type: 1, url: storage.url + '/image.png' },
      { id: 'missing-file', name: 'missing.txt', type: 1, url: storage.url + '/missing' },
    ] });
    else if (url.pathname.endsWith('/cards/123/comments')) json(res, comments.slice(Number(url.searchParams.get('offset')), Number(url.searchParams.get('offset')) + Number(url.searchParams.get('limit'))));
    else if (url.pathname.endsWith('/redirect-file/content')) { res.writeHead(302, { Location: storage.url + '/note.txt?signature=test' }); res.end(); }
    else if (url.pathname.endsWith('/files/protected-file')) json(res, { url: storage.url + '/document.pdf?signature=test' });
    else if (url.pathname.endsWith('/comments/comment-101/files/comment-file')) json(res, { url: storage.url + '/note.txt?signature=test' });
    else json(res, {}, 404);
  });
});
afterAll(async () => { await api?.close(); await storage?.close(); });
const config = () => loadConfig({ KAITEN_BASE_URL: api.url, KAITEN_API_TOKEN: token, KAITEN_ALLOW_HTTP: 'true', KAITEN_ATTACHMENT_ALLOWED_HOSTS: '127.0.0.1' });

describe('Kaiten API', () => {
  it('reads a card and enumerates comment attachments across all pages', async () => {
    const card = await new KaitenClient(config()).getCard(api.url + '/123');
    expect(card.title).toBe('Test card'); expect(card.description.text).toBe('');
    expect(card.attachments_complete).toBe(true);
    expect(card.attachments.find(f => f.id === 'comment-file')?.source).toBe('comment');
    expect(JSON.stringify(card)).not.toContain('signature=');
  });
  it('pages comments with authors without missing the last page', async () => {
    const client = new KaitenClient(config());
    const first = await client.getComments(api.url + '/123');
    expect(first.comments).toHaveLength(50); expect(first.next_offset).toBe(50);
    const last = await client.getComments(api.url + '/123', 100);
    expect(last.comments).toHaveLength(1); expect(last.next_offset).toBeNull();
    expect(last.comments[0].author.name).toBe('Tester');
  });
  it.each(['old-file','protected-file','comment-file','redirect-file'])('downloads %s without leaking auth to storage', async file => {
    const result = await new KaitenClient(config()).attachment(api.url + '/123', file);
    expect(result.bytes.length).toBeGreaterThan(0);
    expect(storageAuth.every(value => value === undefined)).toBe(true);
    expect(apiAuth.every(value => value === `Bearer ${token}`)).toBe(true);
  });
  it.each([['cloud-file','EXTERNAL_ATTACHMENT'],['big-file','FILE_TOO_LARGE'],['missing-file','NOT_FOUND'],['unknown','ATTACHMENT_NOT_FOUND']])('reports attachment error %s', async (id, code) => {
    await expect(new KaitenClient(config()).attachment(api.url + '/123', id)).rejects.toMatchObject({ code });
  });
  it('retries 429 and temporary server errors, but not authorization errors', async () => {
    const client = new HttpClient(config());
    expect(await client.json('retry')).toEqual({ ok: true }); expect(retryCount).toBe(3);
    expect(await client.json('transient')).toEqual({ ok: true }); expect(transientCount).toBe(2);
    await expect(client.json('unauthorized')).rejects.toMatchObject({ code: 'UNAUTHORIZED' }); expect(unauthorizedCount).toBe(1);
    await expect(client.json('forbidden')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('handles timeout and streaming size limit', async () => {
    await expect(new HttpClient({ ...config(), timeoutMs: 10 }).json('slow')).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(new HttpClient({ ...config(), maxFileBytes: 2 }).file(storage.url + '/note.txt')).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });
});

describe('MCP protocol', () => {
  it('exposes three tools, structured output, images and original resources', async () => {
    const server = createServer(config());
    const client = new Client({ name: 'test', version: '1.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    try {
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(['get_card','get_card_comments','read_attachment']);
      expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(1);
      const card = await client.callTool({ name: 'get_card', arguments: { url: api.url + '/123' } });
      expect(card.structuredContent?.title).toBe('Test card');
      const text = await client.callTool({ name: 'read_attachment', arguments: { url: api.url + '/123', attachment_id: 'old-file' } });
      expect(text.structuredContent?.text).toContain('Hello Kaiten');
      const image = await client.callTool({ name: 'read_attachment', arguments: { url: api.url + '/123', attachment_id: 'image-file' } });
      expect((image.content as any[]).some(c => c.type === 'image')).toBe(true);
      const original = await client.readResource({ uri: 'kaiten://cards/123/attachments/old-file' });
      expect(Buffer.from((original.contents[0] as any).blob, 'base64')).toEqual(files['note.txt']);
      const failure = await client.callTool({ name: 'get_card', arguments: { url: 'https://evil.example/123' } });
      expect(failure.isError).toBe(true); expect(JSON.stringify(failure)).not.toContain(token);
    } finally { await client.close(); await server.close(); }
  });
  it('runs through the real stdio transport with no stray stdout', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js'], env: { ...process.env, KAITEN_BASE_URL: api.url, KAITEN_API_TOKEN: token, KAITEN_ALLOW_HTTP: 'true', KAITEN_ATTACHMENT_ALLOWED_HOSTS: '127.0.0.1' } as Record<string,string>, stderr: 'pipe' });
    let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    const client = new Client({ name: 'stdio-test', version: '1' });
    try {
      await client.connect(transport);
      expect((await client.callTool({ name: 'get_card_comments', arguments: { url: api.url + '/123', limit: 1 } })).isError).not.toBe(true);
      expect((await client.callTool({ name: 'read_attachment', arguments: { url: api.url + '/123', attachment_id: 'protected-file' } })).isError).not.toBe(true);
      expect(stderr).not.toContain(token);
    } finally { await client.close(); }
  });
});
