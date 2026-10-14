import { beforeAll, describe, expect, it } from 'vitest';
import { fixtures } from './helpers.js';
import { extract, validateOfficeZip } from '../src/extract.js';
import { readAttachment } from '../dist/read-attachment.js';

let files: Record<string, Buffer>;
beforeAll(async () => { files = await fixtures(); });
describe('file extractors', () => {
  it.each(['note.txt','note.md','table.csv','data.json','document.docx','table.xlsx','slides.pptx','document.pdf'])('extracts %s through an isolated worker', async name => {
    const result = await readAttachment(files[name], name, 20_000, {});
    expect(result.kind).toBe('text'); expect(result.text?.length).toBeGreaterThan(0);
    if (name.endsWith('.docx') || name.endsWith('.pptx')) expect(result.text).toContain('Table cell');
  });
  it.each(['png','jpeg','webp','gif','tiff'])('returns image content for %s', async type => {
    const result = await readAttachment(files[`image.${type}`], `image.${type}`, 20_000, {});
    expect(result.kind).toBe('image'); expect(result.mime_type).toBe('image/png');
    expect(Buffer.from(result.image!).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
  it('provides exact continuation for long text', async () => {
    const first = await extract(files['note.txt'], 'note.txt', 5, {});
    const second = await extract(files['note.txt'], 'note.txt', 5, { offset: first.next_offset! });
    expect(first.text).toBe('Hello'); expect(second.text).toBe(' Kait');
  });
  it('reads PDF pages and reports scanned/empty pages', async () => {
    const second = await readAttachment(files['document.pdf'], 'document.pdf', 20_000, { page: 2 });
    expect(second.text).toContain('Second page'); expect(second.total_pages).toBe(3);
    const third = await readAttachment(files['document.pdf'], 'document.pdf', 20_000, { page: 3 });
    expect(third.warnings?.[0]).toContain('No extractable text');
    await expect(readAttachment(files['document.pdf'], 'document.pdf', 20_000, { page: 4 })).rejects.toMatchObject({ code: 'RANGE_INVALID' });
  });
  it('reads selected sheets, rows and cached formulas', async () => {
    const result = await readAttachment(files['table.xlsx'], 'table.xlsx', 20_000, { row_start: 2, row_count: 1 });
    expect(result.text).toContain('B1+1'); expect(result.text).toContain('43'); expect(result.sheets).toEqual(['Tasks','Empty']);
    await expect(readAttachment(files['table.xlsx'], 'table.xlsx', 20_000, { sheet: 'Missing' })).rejects.toMatchObject({ code: 'RANGE_INVALID' });
  });
  it('reads the second presentation slide', async () => {
    expect((await readAttachment(files['slides.pptx'], 'slides.pptx', 20_000, { page: 2 })).text).toContain('Second slide');
  });
  it.each(['broken.docx','broken.xlsx','broken.pptx','broken.pdf','broken.png'])('reports damaged %s without leaking contents', async name => {
    await expect(readAttachment(Buffer.from('mock-secret'), name, 20_000, {})).rejects.not.toHaveProperty('message', 'mock-secret');
  });
  it('reports unsupported formats', async () => {
    await expect(readAttachment(Buffer.from('legacy'), 'legacy.doc', 20_000, {})).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });
  it('reports a password-protected PDF and an encrypted Office container', async () => {
    await expect(readAttachment(files['locked.pdf'], 'locked.pdf', 20_000, {})).rejects.toMatchObject({ code: 'PASSWORD_PROTECTED' });
    await expect(readAttachment(Buffer.from('d0cf11e0a1b11ae10000','hex'), 'locked.docx', 20_000, {})).rejects.toMatchObject({ code: 'PASSWORD_PROTECTED' });
  });
  it('rejects excessive archive expansion and encryption before parsing', () => {
    const huge = Buffer.from(files['document.docx']);
    const entry = huge.indexOf(Buffer.from('504b0102','hex')); huge.writeUInt32LE(101 * 1024 * 1024, entry + 24);
    expect(() => validateOfficeZip(huge)).toThrow(/100 MiB/);
    const encrypted = Buffer.from(files['document.docx']); encrypted.writeUInt16LE(1, entry + 8);
    expect(() => validateOfficeZip(encrypted)).toThrow(/Encrypted/);
  });
});
