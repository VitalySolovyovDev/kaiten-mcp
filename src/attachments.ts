import type { Config } from './config.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, open, rename, unlink } from 'node:fs/promises';
import { resolve, relative, basename, isAbsolute } from 'node:path';
import { HttpClient } from './http.js';
import { KaitenError } from './errors.js';

type RecordData = Record<string, any>;
export interface Attachment {
  id: string; name: string; size: number | null; mime_type: string | null;
  source: 'card' | 'comment' | 'custom_property';
  comment_id: string | null; comment_uid: string | null; property_uid: string | null;
  protected: boolean; external: boolean; resource_uri: string;
  external_url?: string;
}
interface FileData { attachment: Attachment; raw: RecordData }

function record(value: unknown): RecordData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KaitenError('API_RESPONSE_INVALID', 'Expected a Kaiten object.');
  return value;
}
function records(value: unknown): RecordData[] {
  if (!Array.isArray(value)) throw new KaitenError('API_RESPONSE_INVALID', 'Expected a Kaiten list.');
  return value.map(record);
}

export class AttachmentClient {
  readonly http: HttpClient;
  constructor(readonly config: Config, http: HttpClient) { this.http = http; }

  cardUrl(id: number): string { return new URL(`c/${id}`, this.config.baseUrl).href; }
  async rawCard(id: number): Promise<RecordData> {
    const card = record(await this.http.json(`cards/${id}`, { broken_api: 'false' }));
    if (String(card.id) !== String(id)) throw new KaitenError('API_RESPONSE_INVALID', 'Card response does not match the requested identifier.');
    return card;
  }

  files(card: RecordData, comments: RecordData[] = []): FileData[] {
    const map = new Map<string, FileData>();
    const add = (raw: RecordData, comment?: RecordData) => {
      const id = String(raw.id ?? raw.uid ?? '');
      if (!id) throw new KaitenError('API_RESPONSE_INVALID', 'Attachment metadata is missing its identifier.');
      if (raw.card_id !== undefined && String(raw.card_id) !== String(card.id)) throw new KaitenError('PARENT_MISMATCH', 'Attachment belongs to another card.');
      comment ??= comments.find(item => raw.comment_id != null && String(item.id) === String(raw.comment_id));
      const commentId = raw.comment_id ?? comment?.id ?? null;
      const commentUid = raw.comment_uid ?? comment?.uid ?? null;
      const propertyUid = raw.custom_property_uid ?? null;
      const source = commentId !== null || commentUid !== null ? 'comment' : propertyUid ? 'custom_property' : 'card';
      const size = raw.size === null || raw.size === undefined ? null : Number(raw.size);
      if (size !== null && (!Number.isSafeInteger(size) || size < 0)) throw new KaitenError('API_RESPONSE_INVALID', 'Attachment size is invalid.');
      const external = [2, 3, 4, 5, 6].includes(Number(raw.type));
      const attachment: Attachment = {
        id, name: String(raw.name ?? `file-${id}`), size: Number.isFinite(size) ? size : null,
        mime_type: typeof raw.mime_type === 'string' ? raw.mime_type : null,
        source, comment_id: commentId === null ? null : String(commentId),
        comment_uid: commentUid === null ? null : String(commentUid), property_uid: propertyUid,
        protected: Number(raw.type) === 11 || Boolean(raw.entity_type), external,
        resource_uri: `kaiten://cards/${card.id}/attachments/${encodeURIComponent(id)}`,
        ...(external && typeof raw.url === 'string' ? { external_url: raw.url } : {}),
      };
      const previous = map.get(id);
      map.set(id, { attachment: previous ? { ...previous.attachment, ...attachment } : attachment, raw: { ...previous?.raw, ...raw } });
    };
    if (card.files !== undefined && !Array.isArray(card.files)) throw new KaitenError('API_RESPONSE_INVALID', 'Expected a card attachment list.');
    for (const raw of card.files ?? []) add(record(raw));
    for (const comment of comments) {
      if (comment.card_id !== undefined && String(comment.card_id) !== String(card.id)) throw new KaitenError('PARENT_MISMATCH', 'Comment belongs to another card.');
      if (comment.files !== undefined && !Array.isArray(comment.files)) throw new KaitenError('API_RESPONSE_INVALID', 'Expected a comment attachment list.');
      for (const raw of comment.files ?? []) add(record(raw), comment);
    }
    return [...map.values()];
  }

  async rawComments(id: number, offset: number, limit: number): Promise<RecordData[]> {
    const page = records(await this.http.json(`cards/${id}/comments`, { offset, limit }));
    if (page.length > limit) throw new KaitenError('PAGINATION_INVALID', 'Kaiten ignored the requested comment page limit.');
    return page;
  }

  private async allComments(id: number): Promise<RecordData[]> {
    const result: RecordData[] = [];
    const seen = new Set<string>();
    for (let offset = 0; offset < 100_000; offset += 100) {
      const page = await this.rawComments(id, offset, 100);
      for (const item of page) {
        const key = String(item.id ?? item.uid);
        if (seen.has(key)) throw new KaitenError('PAGINATION_INVALID', 'Kaiten repeated comments while paging. The attachment list may be incomplete.');
        seen.add(key); result.push(item);
      }
      if (page.length < 100) return result;
    }
    throw new KaitenError('PAGINATION_LIMIT', 'Too many comments to enumerate attachments safely.');
  }

  async attachment(id: number, fileId: string): Promise<{ attachment: Attachment; bytes: Buffer; mimeType: string }> {
    const card = await this.rawCard(id);
    let file = this.files(card).find(f => f.attachment.id === fileId || String(f.raw.uid) === fileId);
    if (!file || (file.attachment.source === 'comment' && !file.attachment.comment_uid)) {
      const comments = await this.allComments(id);
      file = this.files(card, comments).find(f => f.attachment.id === fileId || String(f.raw.uid) === fileId);
    }
    if (!file) throw new KaitenError('ATTACHMENT_NOT_FOUND', 'The file is not attached to this card or its accessible comments.');
    const { attachment, raw } = file;
    if (attachment.external) throw new KaitenError('EXTERNAL_ATTACHMENT', 'This cloud attachment requires separate authorization. Open its external_url.');
    if (attachment.size !== null && attachment.size > this.config.maxFileBytes) throw new KaitenError('FILE_TOO_LARGE', 'Attachment exceeds KAITEN_MAX_FILE_BYTES.');
    let downloadUrl: string | undefined;
    let authenticate = false;
    if (attachment.protected) {
      // Existing type-11 files can expose an authenticated /content route directly.
      if (typeof raw.url === 'string') {
        const target = new URL(raw.url, this.config.baseUrl);
        if (target.origin === this.config.baseUrl.origin && target.pathname.startsWith(this.config.baseUrl.pathname + 'api/') && target.pathname.endsWith('/content')) {
          downloadUrl = target.href; authenticate = true;
        }
      }
      if (!downloadUrl) {
        if (!card.uid) throw new KaitenError('API_RESPONSE_INVALID', 'Protected attachment requires the card UID.');
        const uid = encodeURIComponent(String(raw.uid ?? raw.id));
        let path = `cards/${encodeURIComponent(card.uid)}/files/${uid}`;
        if (attachment.source === 'comment') {
          if (!attachment.comment_uid) throw new KaitenError('API_RESPONSE_INVALID', 'Protected comment attachment requires the comment UID.');
          path = `cards/${encodeURIComponent(card.uid)}/comments/${encodeURIComponent(attachment.comment_uid)}/files/${uid}`;
        } else if (attachment.source === 'custom_property') {
          path = `cards/${encodeURIComponent(card.uid)}/custom-properties/${encodeURIComponent(attachment.property_uid!)}/files/${uid}`;
        }
        const metadata = record(await this.http.json(path));
        if (typeof metadata.url !== 'string') throw new KaitenError('API_RESPONSE_INVALID', 'Kaiten did not provide a file URL.');
        downloadUrl = metadata.url;
      }
    } else if (typeof raw.url === 'string') downloadUrl = raw.url;
    if (!downloadUrl) throw new KaitenError('ATTACHMENT_UNAVAILABLE', 'Kaiten did not provide a downloadable attachment.');
    const result = await this.http.file(downloadUrl, authenticate);
    return { attachment, ...result };
  }

  async download(id: number, fileId: string) {
    const file = await this.attachment(id, fileId);
    let temporary: string | undefined;
    try {
      await mkdir(this.config.downloadDir, { recursive: true, mode: 0o700 });
      const directory = await realpath(this.config.downloadDir);
      const safeName = basename(file.attachment.name.replace(/\\/g, '/')).normalize('NFKC')
        .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || 'attachment';
      const target = resolve(directory, `${randomUUID()}-${safeName}`);
      const child = relative(directory, target);
      if (!child || child.startsWith('..') || isAbsolute(child)) throw new KaitenError('DOWNLOAD_PATH_INVALID', 'Download destination is outside its configured directory.');
      temporary = `${target}.part`;
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(file.bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, target);
      temporary = undefined;
      return { path: target, name: file.attachment.name, mime_type: file.mimeType, size: file.bytes.length,
        sha256: createHash('sha256').update(file.bytes).digest('hex'), resource_uri: file.attachment.resource_uri };
    } catch (error) {
      if (temporary) await unlink(temporary).catch(() => {});
      if (error instanceof KaitenError) throw error;
      throw new KaitenError('DOWNLOAD_FAILED', 'Unable to save the attachment. Check KAITEN_DOWNLOAD_DIR and available disk space.');
    }
  }
}
