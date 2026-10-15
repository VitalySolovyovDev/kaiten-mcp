import { createHash } from 'node:crypto';
import { KaitenError } from './errors.js';

export type Data = Record<string, any>;
export function record(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) throw new KaitenError('API_RESPONSE_INVALID', 'Expected a non-empty Kaiten object.');
  return value as Data;
}
export function records(value: unknown): Data[] {
  if (!Array.isArray(value)) throw new KaitenError('API_RESPONSE_INVALID', 'Expected a Kaiten list.');
  return value.map(record);
}
export function fingerprint(items: Data[]): string {
  return createHash('sha256').update(JSON.stringify(items.map(item => item.id ?? item.uid ?? item))).digest('hex');
}
const summaryKeys = new Set(['id','uid','title','name','full_name','username','email','value','color','type','state','condition','archived','created','updated','changed','due_date','board_id','space_id','column_id','lane_id','card_id','parent_id','child_id','owner_id','user_id','tag_id','role_id','author_id','time_spent','for_date','comment','text','description','description_format','text_format','author','edited','deleted','internal','url','link','checked','responsible_id','checklist_id','items','size','mime_type','source','protected','external','resource_uri','external_url','comment_id','comment_uid','property_uid','attachments','active','start_date','end_date','blocked','reason','blocker_id','user','child','card']);
export function summary(item: Data): Data {
  return Object.fromEntries(Object.entries(item).filter(([key]) => summaryKeys.has(key) || ['update','attachment_warnings','timeSpent','generalSumTimeSpent','total','sum','role','sprint','entity_type','parent_entity_uid','has_children','index_document_uid','content_available','content_included','version'].includes(key)).map(([key, value]) =>
    value && typeof value === 'object' && !Array.isArray(value) ? [key, summary(value)] : [key, value]));
}

export interface Continuation { path: string; kind: 'text' | 'section'; offset: number; total: number; next_offset: number | null }
// Bound field values, never the serialized JSON. Cursors are stable RFC6901 pointers.
export function project(value: unknown, maxChars: number, options: Data, root: string) {
  const continuation: Continuation[] = [];
  const nextTextOffsets: Record<string, number> = {};
  let remaining = maxChars;
  const visit = (v: any, path: string): any => {
    if (typeof v === 'string') {
      if (/(?:^|\/)(?:id|uid|.*_id|.*_uid|url|.*_url|resource_uri|mime_type|source|.*_format|created|updated|update|changed|for_date|due_date|path|sha256)$/.test(path)) return v;
      const start = options.text_offsets?.[path] ?? 0;
      if (start > v.length) throw new KaitenError('CURSOR_INVALID', 'Text offset exceeds the current field length.');
      const end = Math.min(v.length, start + remaining);
      // Do not split a UTF-16 surrogate pair.
      const stop = end > start && end < v.length && /[\uD800-\uDBFF]/.test(v[end - 1]) ? end - 1 : end;
      remaining -= stop - start;
      nextTextOffsets[path] = stop;
      if (start || stop < v.length) continuation.push({ path, kind: 'text', offset: start, total: v.length, next_offset: stop < v.length ? stop : null });
      return v.slice(start, stop);
    }
    if (Array.isArray(v)) {
      const start = options.section_offsets?.[path] ?? 0;
      if (start > v.length) throw new KaitenError('CURSOR_INVALID', 'Section offset exceeds the current array length.');
      const end = Math.min(v.length, start + 100);
      if (start || end < v.length) continuation.push({ path, kind: 'section', offset: start, total: v.length, next_offset: end < v.length ? end : null });
      return v.slice(start, end).map((item, index) => visit(item, `${path}/${start + index}`));
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, visit(item, `${path}/${k.replace(/~/g,'~0').replace(/\//g,'~1')}`)]));
    return v;
  };
  return { value: visit(value, root), continuation, next_text_offsets: nextTextOffsets };
}
