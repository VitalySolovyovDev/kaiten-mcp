import type { Config } from './config.js';
import { KaitenError } from './errors.js';
import type { Data } from './data.js';

const uidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type DocumentKind = 'document' | 'document_group' | 'children';

export function parseDocumentUrl(input: string, config: Config): { uid: string; kind: Exclude<DocumentKind, 'children'> } {
  let url: URL;
  try { url = new URL(input); } catch { throw new KaitenError('DOCUMENT_URL_INVALID', 'Provide a full Kaiten document or document group URL.'); }
  if (url.origin !== config.baseUrl.origin || url.username || url.password || !url.pathname.startsWith(config.baseUrl.pathname)) throw new KaitenError('DOCUMENT_URL_INVALID', 'The document URL must belong to the configured Kaiten instance.');
  const match = /^documents\/([dg])\/([^/]+)$/.exec(url.pathname.slice(config.baseUrl.pathname.length).replace(/\/$/, ''));
  if (!match || !uidPattern.test(match[2])) throw new KaitenError('DOCUMENT_URL_INVALID', 'Use /documents/d/UID or /documents/g/UID.');
  return { uid: match[2].toLowerCase(), kind: match[1] === 'd' ? 'document' : 'document_group' };
}

export function validateDocument(value: Data, kind: Exclude<DocumentKind, 'children'>, uid: string): void {
  if (typeof value.uid !== 'string' || !uidPattern.test(value.uid) || value.uid.toLowerCase() !== uid || value.entity_type !== kind || typeof value.title !== 'string') throw new KaitenError('API_RESPONSE_INVALID', 'Document response does not match the requested entity or schema.');
}

function validateContent(data: unknown): asserts data is Data {
  if (!data || typeof data !== 'object' || Array.isArray(data) || (data as Data).type !== 'doc') throw new KaitenError('API_RESPONSE_INVALID', 'Expected document content in ProseMirror doc format.');
  const pending: { value: any; depth: number; node: boolean }[] = [{ value: data, depth: 0, node: true }];
  let count = 0;
  while (pending.length) {
    const { value, depth, node } = pending.pop()!;
    if (++count > 100_000 || depth > 100) throw new KaitenError('API_RESPONSE_INVALID', 'Document structure exceeds safe processing limits.');
    if (node && (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string' || (value.type === 'text' || value.text !== undefined) && typeof value.text !== 'string' || value.content !== undefined && !Array.isArray(value.content))) throw new KaitenError('API_RESPONSE_INVALID', 'Incompatible ProseMirror node.');
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (node && key === 'content') for (const item of child as unknown[]) pending.push({ value: item, depth: depth + 1, node: true });
      else pending.push({ value: child, depth: depth + 1, node: false });
    }
  }
}

const link = (value: unknown): string => typeof value === 'string' && /^(?:https?:\/\/|\/(?!\/)|file:)/i.test(value) ? value : '';
function textContent(node: Data): string {
  const children: Data[] = node.content ?? [];
  if (node.type === 'text') {
    const href = Array.isArray(node.marks) ? node.marks.find((mark: any) => mark?.type === 'link')?.attrs?.href : undefined;
    return node.text + (link(href) ? ` (${href})` : '');
  }
  if (['hardBreak', 'hard_break'].includes(node.type)) return '\n';
  if (['tableRow', 'table_row'].includes(node.type)) return children.map(child => textContent(child).trim()).join('\t') + '\n';
  if (['bulletList', 'bullet_list', 'orderedList', 'ordered_list'].includes(node.type)) return children.map((child, index) => `${node.type.startsWith('ordered') ? `${index + 1}.` : '-'} ${textContent(child).trim()}\n`).join('');
  const text = children.map(textContent).join('');
  if (['paragraph','heading','blockquote','codeBlock','code_block','listItem','list_item'].includes(node.type)) return text + '\n';
  if (!children.length && node.attrs) {
    const href = link(node.attrs.href ?? node.attrs.src ?? node.attrs.url);
    const name = node.attrs.alt ?? node.attrs.title ?? node.attrs.name;
    return `${typeof name === 'string' ? name : ''}${href ? ` (${href})` : ''}`;
  }
  return text;
}

export function documentItem(raw: Data, options: Data): Data {
  const { data, content: ignoredContent, ...metadata } = raw;
  for (const key of ['author','updater','documentGroup']) if (metadata[key] && typeof metadata[key] === 'object') {
    const fields = key === 'documentGroup' ? ['id','uid','title','entity_type','parent_entity_uid'] : ['id','uid','full_name','username','email'];
    metadata[key] = Object.fromEntries(fields.filter(field => field in metadata[key]).map(field => [field, metadata[key][field]]));
  }
  const item: Data = { ...metadata, content_available: data !== undefined && data !== null, content_included: options.include_content };
  if (options.include_content) {
    let content = data;
    if (typeof content === 'string') {
      try { content = JSON.parse(content); } catch { throw new KaitenError('API_RESPONSE_INVALID', 'Document data is not valid serialized ProseMirror JSON.'); }
    }
    validateContent(content);
    item.content_format = options.format;
    item.content = options.format === 'prosemirror' ? content : textContent(content).trimEnd();
  }
  return item;
}
