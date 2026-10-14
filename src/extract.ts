import { extname } from 'node:path';
import { unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { KaitenError } from './errors.js';

export interface ReadOptions { offset?: number; page?: number; sheet?: string; row_start?: number; row_count?: number }
export interface Extracted {
  kind: 'text' | 'image'; text?: string; image?: Uint8Array; mime_type?: string;
  offset?: number; total_chars?: number; next_offset?: number | null;
  page?: number; total_pages?: number; next_page?: number | null;
  sheet?: string; sheets?: string[]; row_start?: number; total_rows?: number; next_row?: number | null;
  warnings?: string[];
}

export function mimeForName(name: string): string {
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' } as Record<string, string>)[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

function textChunk(text: string, maxChars: number, offset = 0): Extracted {
  const end = Math.min(text.length, offset + maxChars);
  return { kind: 'text', text: text.slice(offset, end), offset, total_chars: text.length, next_offset: end < text.length ? end : null };
}

// Inspect central-directory sizes before any Office parser inflates the archive.
export function validateOfficeZip(buffer: Buffer): void {
  if (buffer.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') {
    throw new KaitenError('PASSWORD_PROTECTED', 'Encrypted Office containers cannot be extracted.');
  }
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new KaitenError('PARSE_FAILED', 'Invalid Office archive.');
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16), total = 0;
  if (count > 10_000 || count === 0xffff || cursor === 0xffffffff) throw new KaitenError('ARCHIVE_LIMIT', 'Office archive has too many entries or uses unsupported ZIP64.');
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new KaitenError('PARSE_FAILED', 'Invalid Office archive directory.');
    if (buffer.readUInt16LE(cursor + 8) & 1) throw new KaitenError('PASSWORD_PROTECTED', 'Encrypted Office files cannot be extracted.');
    const size = buffer.readUInt32LE(cursor + 24);
    total += size;
    if (size === 0xffffffff || total > 100 * 1024 * 1024) throw new KaitenError('ARCHIVE_LIMIT', 'Office archive expands beyond 100 MiB.');
    cursor += 46 + buffer.readUInt16LE(cursor + 28) + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
  }
}

function decodeEntities(text: string): string {
  return text.replace(/&#(x[0-9a-f]+|\d+);/gi, (_whole, number: string) => {
    const code = number.startsWith('x') ? parseInt(number.slice(1), 16) : Number(number);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
  }).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function officeText(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(officeText);
  const result: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'a:t') result.push(...(Array.isArray(value) ? value : [value]).map(String));
    else result.push(...officeText(value));
  }
  return result;
}

export async function extract(bytes: Buffer, name: string, maxChars: number, options: ReadOptions): Promise<Extracted> {
  const extension = extname(name).toLowerCase();
  const offset = options.offset ?? 0;
  if (['.txt', '.md', '.csv', '.json'].includes(extension)) {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : 'utf-8';
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return textChunk(text, maxChars, offset);
  }
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.tif', '.tiff'].includes(extension)) {
    const { default: sharp } = await import('sharp');
    const image = sharp(bytes, { limitInputPixels: 40_000_000, pages: 1 });
    const metadata = await image.metadata();
    const output = await image.resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    return { kind: 'image', image: output, mime_type: 'image/png', warnings: [
      ...((metadata.pages ?? 1) > 1 ? ['Only the first frame/page is shown. Read the resource for the original.'] : []),
      ...((metadata.width ?? 0) > 2048 || (metadata.height ?? 0) > 2048 ? ['Image preview resized to fit 2048px. Read the resource for the original.'] : []),
    ] };
  }
  if (extension === '.pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    let document;
    try { document = await task.promise; }
    catch (error) {
      if (error instanceof Error && error.name === 'PasswordException') throw new KaitenError('PASSWORD_PROTECTED', 'Password-protected PDFs cannot be extracted.');
      throw error;
    }
    try {
      const pageNumber = options.page ?? 1;
      if (pageNumber > document.numPages) throw new KaitenError('RANGE_INVALID', 'PDF page is outside the document.');
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
      return { ...textChunk(text, maxChars, offset), page: pageNumber, total_pages: document.numPages,
        next_page: pageNumber < document.numPages ? pageNumber + 1 : null,
        ...(!text.trim() ? { warnings: ['No extractable text on this page. Scanned PDFs require external OCR or reading the original.'] } : {}) };
    } finally { await task.destroy(); }
  }
  if (['.docx', '.xlsx', '.pptx'].includes(extension)) validateOfficeZip(bytes);
  if (extension === '.docx') {
    const { default: mammoth } = await import('mammoth');
    const result = await mammoth.convertToHtml({ buffer: bytes }, { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) });
    const text = decodeEntities(result.value.replace(/<\/(?:p|h[1-6]|tr|table)>/gi, '\n').replace(/<\/t[dh]>/gi, '\t').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ''));
    return { ...textChunk(text, maxChars, offset), warnings: ['Text and tables extracted; layout and embedded images are available in the original.'] };
  }
  if (extension === '.xlsx') {
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as any);
    const sheets = workbook.worksheets.map(sheet => sheet.name);
    const sheet = options.sheet ? workbook.getWorksheet(options.sheet) : workbook.worksheets[0];
    if (!sheet) throw new KaitenError('RANGE_INVALID', 'The requested worksheet does not exist.');
    const start = options.row_start ?? 1;
    const end = Math.min(sheet.rowCount, start + (options.row_count ?? 50) - 1);
    const rows: string[] = [];
    for (let row = start; row <= end; row++) {
      const cells: unknown[] = [];
      sheet.getRow(row).eachCell({ includeEmpty: true }, (cell, column) => {
        if (column > 100) return;
        const value = cell.value;
        cells.push({ column, value: cell.text, ...(value && typeof value === 'object' && 'formula' in value ? { formula: value.formula, cached_result: value.result ?? null } : {}) });
      });
      rows.push(JSON.stringify({ row, cells }));
    }
    return { ...textChunk(rows.join('\n'), maxChars, offset), sheet: sheet.name, sheets, row_start: start,
      total_rows: sheet.rowCount, next_row: end < sheet.rowCount ? end + 1 : null,
      warnings: ['Formulas are not recalculated; values use cached workbook results.', ...(sheet.columnCount > 100 ? ['Only the first 100 columns are included. Read the original for remaining columns.'] : [])] };
  }
  if (extension === '.pptx') {
    const zip = unzipSync(bytes, { filter: file => /^ppt\/slides\/slide\d+\.xml$/.test(file.name) });
    const slides = Object.keys(zip).sort((a, b) => Number(/slide(\d+)/.exec(a)?.[1]) - Number(/slide(\d+)/.exec(b)?.[1]));
    const page = options.page ?? 1;
    if (!slides[page - 1]) throw new KaitenError('RANGE_INVALID', 'The requested slide does not exist.');
    const xml = new TextDecoder().decode(zip[slides[page - 1]]);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new KaitenError('PARSE_FAILED', 'XML entities are not supported.');
    const parsed = new XMLParser({ ignoreAttributes: true, parseTagValue: false, processEntities: false }).parse(xml);
    const text = officeText(parsed).map(decodeEntities).join('\n');
    return { ...textChunk(text, maxChars, offset), page, total_pages: slides.length, next_page: page < slides.length ? page + 1 : null,
      warnings: ['Slide text and table cells extracted; layout and embedded images are available in the original.'] };
  }
  throw new KaitenError('UNSUPPORTED_FORMAT', 'No built-in extractor for this format. Read the MCP resource to obtain the original file.');
}
