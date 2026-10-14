import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { zipSync, strToU8 } from 'fflate';
import { PDFDocument, StandardFonts, PDFName, PDFHexString } from 'pdf-lib';
import ExcelJS from 'exceljs';
import sharp from 'sharp';

export async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

export function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
}

export async function fixtures(): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = {
    'note.txt': Buffer.from('Hello Kaiten\nПривет'), 'note.md': Buffer.from('# Hello'),
    'table.csv': Buffer.from('name,value\nHello,42'), 'data.json': Buffer.from('{"hello":42}'),
  };
  for (const format of ['png', 'jpeg', 'webp', 'gif', 'tiff'] as const) files[`image.${format}`] = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#55aa33' } }).toFormat(format).toBuffer();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText('Hello PDF', { x: 20, y: 100, font });
  pdf.addPage().drawText('Second page', { x: 20, y: 100, font });
  pdf.addPage();
  files['document.pdf'] = Buffer.from(await pdf.save());
  const locked = await PDFDocument.create(); locked.addPage();
  const encryption = locked.context.register(locked.context.obj({ Filter: PDFName.of('Standard'), V: 1, R: 2, Length: 40, P: -4,
    O: PDFHexString.of('00'.repeat(32)), U: PDFHexString.of('00'.repeat(32)) }));
  locked.context.trailerInfo.Encrypt = encryption;
  files['locked.pdf'] = Buffer.from(await locked.save({ useObjectStreams: false }));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Tasks');
  sheet.addRow(['Hello', 42]); sheet.addRow(['Formula', { formula: 'B1+1', result: 43 }]);
  workbook.addWorksheet('Empty');
  files['table.xlsx'] = Buffer.from(await workbook.xlsx.writeBuffer());
  files['document.docx'] = Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'),
  }));
  files['slides.pptx'] = Buffer.from(zipSync({
    'ppt/slides/slide1.xml': strToU8('<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><a:p><a:r><a:t>Hello PPTX</a:t></a:r></a:p><a:tbl><a:tr><a:tc><a:p><a:r><a:t>Table cell</a:t></a:r></a:p></a:tc></a:tr></a:tbl></p:cSld></p:sld>'),
    'ppt/slides/slide2.xml': strToU8('<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>'),
  }));
  return files;
}
