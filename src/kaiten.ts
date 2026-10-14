import { parseCardUrl, type Config } from './config.js';
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

export class KaitenClient {
  readonly http: HttpClient;
  constructor(readonly config: Config) { this.http = new HttpClient(config); }

  cardId(url: string): number { return parseCardUrl(url, this.config); }
  cardUrl(id: number): string { return new URL(`c/${id}`, this.config.baseUrl).href; }
  async rawCard(id: number): Promise<RecordData> { return record(await this.http.json(`cards/${id}`, { broken_api: 'false' })); }

  private files(card: RecordData, comments: RecordData[] = []): FileData[] {
    const map = new Map<string, FileData>();
    const add = (raw: RecordData, comment?: RecordData) => {
      const id = String(raw.id ?? raw.uid ?? '');
      if (!id) return;
      comment ??= comments.find(item => raw.comment_id != null && String(item.id) === String(raw.comment_id));
      const commentId = raw.comment_id ?? comment?.id ?? null;
      const commentUid = raw.comment_uid ?? comment?.uid ?? null;
      const propertyUid = raw.custom_property_uid ?? null;
      const source = commentId !== null || commentUid !== null ? 'comment' : propertyUid ? 'custom_property' : 'card';
      const size = raw.size === null || raw.size === undefined ? null : Number(raw.size);
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
    for (const raw of card.files ?? []) add(record(raw));
    for (const comment of comments) for (const raw of comment.files ?? []) add(record(raw), comment);
    return [...map.values()];
  }

  async rawComments(id: number, offset: number, limit: number): Promise<RecordData[]> {
    return records(await this.http.json(`cards/${id}/comments`, { offset, limit }));
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

  async getCard(url: string, descriptionOffset = 0) {
    const id = this.cardId(url);
    const card = await this.rawCard(id);
    let comments: RecordData[] = [];
    let warning: string | undefined;
    try { comments = await this.allComments(id); }
    catch (error) {
      if (!(error instanceof KaitenError)) throw error;
      warning = `Comment attachments may be incomplete (${error.code}). Use get_card_comments to retry.`;
    }
    const description = String(card.description ?? '');
    const next = Math.min(description.length, descriptionOffset + this.config.maxTextChars);
    return {
      id, uid: card.uid ?? null, url: this.cardUrl(id), title: String(card.title ?? ''),
      description: { text: description.slice(descriptionOffset, next), format: card.description_type === 2 ? 'html' : 'markdown',
        offset: descriptionOffset, total_chars: description.length, next_offset: next < description.length ? next : null },
      attachments: this.files(card, comments).map(f => f.attachment),
      attachments_complete: !warning,
      ...(warning ? { warnings: [warning] } : {}),
    };
  }

  async getComments(url: string, offset = 0, limit = 50, textOffset = 0) {
    const id = this.cardId(url);
    const page = await this.rawComments(id, offset, limit);
    const comments = [];
    let remainingChars = this.config.maxTextChars;
    for (const comment of page) {
      if (comments.length && remainingChars === 0) break;
      const text = comment.deleted ? '' : String(comment.text ?? '');
      const next = Math.min(text.length, textOffset + remainingChars);
      const chunk = text.slice(textOffset, next);
      remainingChars -= chunk.length;
      comments.push({
        id: comment.id, uid: comment.uid ?? null, text: chunk,
        format: comment.type === 2 ? 'html' : 'markdown', text_offset: textOffset,
        total_chars: text.length, next_text_offset: next < text.length ? next : null,
        author: comment.author ? { id: comment.author.id, name: comment.author.full_name ?? comment.author.username ?? null } : { id: comment.author_id ?? null, name: null },
        created: comment.created ?? null, updated: comment.updated ?? comment.update ?? null,
        edited: Boolean(comment.edited), deleted: Boolean(comment.deleted), internal: Boolean(comment.internal),
        attachments: this.files({ id, files: [] }, [comment]).map(f => f.attachment),
      });
    }
    return { card_id: id, comments, offset, limit, next_offset: page.length === limit || comments.length < page.length ? offset + comments.length : null };
  }

  async attachment(url: string, fileId: string): Promise<{ attachment: Attachment; bytes: Buffer; mimeType: string }> {
    const id = this.cardId(url);
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
}
