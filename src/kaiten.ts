import { parseCardUrl, type Config } from './config.js';
import { HttpClient } from './http.js';
import { AttachmentClient } from './attachments.js';
import { MetadataCache } from './cache.js';
import { KaitenError } from './errors.js';
import { record, records, fingerprint, project, summary, type Data } from './data.js';
import { toolSpecs, type ToolSpec } from './tools.js';

export class KaitenClient {
  readonly files: AttachmentClient;
  private readonly cache: MetadataCache;
  constructor(readonly config: Config, readonly http = new HttpClient(config), now: () => number = Date.now) {
    this.files = new AttachmentClient(config, http);
    this.cache = new MetadataCache(config.cacheTtlMs, now);
  }

  private args(spec: ToolSpec, input: unknown): Data {
    const parsed = spec.input.safeParse(input);
    if (!parsed.success) throw new KaitenError('INPUT_INVALID', 'Invalid arguments. Check the tool input schema.');
    const a: Data = parsed.data;
    if (spec.card) {
      if ((a.url !== undefined) === (a.card_id !== undefined)) throw new KaitenError('INPUT_INVALID', 'Provide exactly one of url and card_id.');
      if (a.url !== undefined) a.card_id = parseCardUrl(a.url, this.config);
    }
    if (a.from !== undefined || a.to !== undefined) {
      if (a.from === undefined || a.to === undefined || a.from > a.to) throw new KaitenError('INPUT_INVALID', 'Provide both from and to, with from no later than to.');
    }
    for (const prefix of ['created','updated','due_date','first_moved_in_progress','last_moved_to_done_at']) {
      if (a[`${prefix}_after`] && a[`${prefix}_before`] && Date.parse(a[`${prefix}_after`]) > Date.parse(a[`${prefix}_before`])) throw new KaitenError('INPUT_INVALID', 'Date filter start must not exceed its end.');
    }
    if (a.search_fields && !a.query) throw new KaitenError('INPUT_INVALID', 'search_fields requires a non-empty query.');
    a.detail ??= spec.kind === 'list' ? 'summary' : 'full';
    return a;
  }

  private clean(value: unknown): any {
    if (typeof value === 'string') return value.split(this.config.token).join('[REDACTED]');
    if (Array.isArray(value)) return value.map(v => this.clean(v));
    if (value && typeof value === 'object') {
      const object = value as Data;
      return Object.fromEntries(Object.entries(object).filter(([key]) => !/^(?:password|api_token|access_token|token|authorization)$/i.test(key)).map(([k,v]) =>
        k === 'files' && object.id !== undefined && Array.isArray(v)
          ? ['attachments', this.files.files({ id: object.card_id ?? object.id, files: v }).map(f => this.clean(f.attachment))]
          : [k, this.clean(v)]));
    }
    return value;
  }

  private normalize(value: Data, cardId?: number, comment = false): Data {
    const result = { ...value };
    if (cardId !== undefined && (comment ? result.card_id !== undefined && String(result.card_id) !== String(cardId) : result.id !== undefined && String(result.id) !== String(cardId))) throw new KaitenError('PARENT_MISMATCH', 'Kaiten returned data belonging to another card.');
    if (typeof result.description === 'string') result.description_format = result.description_type === 2 || result.description_type === 'html' ? 'html' : result.description_type === 1 || result.description_type === 'markdown' ? 'markdown' : 'unknown';
    if (comment && typeof result.text === 'string' && [1,2].includes(result.type)) result.text_format = result.type === 2 ? 'html' : 'markdown';
    if (cardId !== undefined && 'files' in result) {
      const attachments = [], failures = [];
      const files = Array.isArray(result.files) ? result.files : [];
      if (!Array.isArray(result.files)) failures.push({ code: 'API_RESPONSE_INVALID', message: 'Expected an attachment list.' });
      for (const file of files) {
        try { attachments.push(...(comment ? this.files.files({ id: cardId }, [{ ...result, files: [file] }]) : this.files.files({ ...result, files: [file] })).map(v => v.attachment)); }
        catch (error) { if (!(error instanceof KaitenError)) throw error; failures.push({ code: error.code, message: error.message }); }
      }
      result.attachments = attachments;
      if (failures.length) result.attachment_warnings = failures;
      delete result.files;
    }
    return this.clean(result);
  }

  private bounded(data: Data, a: Data): Data {
    const fields = Object.fromEntries(Object.entries(data).filter(([key]) => ['item','items','metadata'].includes(key)));
    const result = project(fields, this.config.maxTextChars, a, '');
    return { ...data, ...result.value, continuation: result.continuation, next_text_offsets: result.next_text_offsets, warnings: data.warnings ?? [] };
  }

  async execute(name: string, input: unknown): Promise<Data> {
    const spec = toolSpecs.find(t => t.name === name);
    if (!spec) throw new KaitenError('TOOL_NOT_FOUND', 'Unknown Kaiten tool.');
    const a = this.args(spec, input);
    if (spec.kind === 'download') return this.clean({ item: await this.files.download(a.card_id, a.attachment_id), continuation: [], warnings: [] });
    if (spec.kind === 'attachments') return this.listAttachments(a);
    const path = spec.path!(a);
    const query: Record<string, string | number> = { ...spec.fixedQuery };
    for (const key of spec.queryKeys ?? []) {
      const value = a[key];
      if (value !== undefined && !(Array.isArray(value) && !value.length)) query[key] = Array.isArray(value) ? value.join(',') : String(value);
    }
    if (path === 'cards' && a.detail === 'full') query.additional_card_fields = 'description';
    if (name === 'list_custom_properties' && a.ids?.length) query.load_by_ids = 'true';
    if (spec.paging === 'remote') { query.limit = a.limit; query.offset = a.offset; }
    if (spec.card && spec.kind === 'list') {
      const parent = record(await this.http.json(`cards/${a.card_id}`, { broken_api: 'false' }));
      if (String(parent.id) !== String(a.card_id)) throw new KaitenError('API_RESPONSE_INVALID', 'Card response has an invalid identifier.');
    }
    if (name === 'get_checklist') {
      const card = record(await this.http.json(`cards/${a.card_id}`));
      if (String(card.id) !== String(a.card_id)) throw new KaitenError('API_RESPONSE_INVALID', 'Card response has an invalid identifier.');
      if (!Array.isArray(card.checklists)) throw new KaitenError('API_RESPONSE_INVALID', 'Kaiten did not expose the authoritative card checklist list; ownership cannot be verified.');
      if (!records(card.checklists).some(c => String(c.id) === String(a.checklist_id) && (c.card_id === undefined || String(c.card_id) === String(a.card_id)))) throw new KaitenError('PARENT_MISMATCH', 'The checklist does not belong to this card.');
    }
    const validate = (value: unknown) => {
      if (spec.kind === 'entity') {
        const entity = record(value);
        if (name === 'get_card' && (typeof entity.title !== 'string' || entity.description !== undefined && entity.description !== null && typeof entity.description !== 'string')) throw new KaitenError('API_RESPONSE_INVALID', 'Card title or description has an incompatible type.');
        const id = name === 'get_sprint' ? entity.id ?? entity.sprint?.id : entity.id;
        if (id === undefined) throw new KaitenError('API_RESPONSE_INVALID', 'Entity response is missing its identifier.');
        const expected = name === 'get_checklist' ? a.checklist_id : a.card_id ?? a.space_id ?? a.board_id ?? a.sprint_id;
        if (expected !== undefined && String(id) !== String(expected)) throw new KaitenError('API_RESPONSE_INVALID', 'Entity response does not match the requested identifier.');
      } else this.listData(value, name, a);
    };
    const fetch = () => this.http.json(path, query);
    const raw = spec.cache ? await this.cache.get(`${path}?${JSON.stringify(Object.entries(query).sort())}`, fetch, validate) : await fetch();
    validate(raw);
    const warnings = name.includes('sprint') ? ['Kaiten marks sprint routes as deprecated; availability depends on the instance.'] : [];
    if (spec.kind === 'entity') {
      let item = this.normalize(record(raw), name === 'get_card' ? a.card_id : undefined);
      if (name === 'get_checklist' && item.card_id !== undefined && String(item.card_id) !== String(a.card_id)) throw new KaitenError('PARENT_MISMATCH', 'Checklist belongs to another card.');
      if (item.attachment_warnings) warnings.push('Some attachment metadata is unavailable; inspect item.attachment_warnings.');
      if (name === 'get_board' || name === 'get_space') { delete item.cards; warnings.push('Cards must be read using list_board_cards or list_space_cards.'); }
      if (a.detail === 'summary') item = summary(item);
      return this.bounded({ item, warnings }, a);
    }
    let { items, metadata } = this.listData(raw, name, a);
    if (name === 'get_card_timelogs' && a.from) items = items.filter(item => {
      if (typeof item.for_date !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(item.for_date)) throw new KaitenError('API_RESPONSE_INVALID', 'Cannot filter time logs without valid for_date.');
      return item.for_date.slice(0,10) >= a.from && item.for_date.slice(0,10) <= a.to;
    });
    const total = items.length;
    if (spec.paging === 'local') items = items.slice(a.offset, a.offset + a.limit);
    else if (items.length > a.limit) throw new KaitenError('PAGINATION_INVALID', 'Kaiten returned more items than requested.');
    const pageFingerprint = fingerprint(items);
    if (items.length && a.previous_page === pageFingerprint) throw new KaitenError('PAGINATION_INVALID', 'Kaiten repeated the previous page. The result is incomplete.');
    const next = spec.paging === 'local' ? a.offset + items.length < total ? a.offset + items.length : null : items.length === a.limit ? a.offset + items.length : null;
    const cards = ['search_cards','list_space_cards','list_board_cards','list_subtasks'].includes(name);
    items = items.map(item => this.normalize(item, name === 'get_card_comments' ? a.card_id : cards && item.id !== undefined ? item.id : undefined, name === 'get_card_comments'));
    if (items.some(item => item.attachment_warnings)) warnings.push('Some attachment metadata is unavailable; inspect items[].attachment_warnings.');
    if (a.detail === 'summary') items = items.map(summary);
    return this.bounded({ items, offset: a.offset, limit: a.limit, next_offset: next, page_fingerprint: pageFingerprint,
      pagination: spec.paging, ...(spec.paging === 'local' ? { total } : {}), ...(metadata ? { metadata: this.clean(metadata) } : {}), warnings }, a);
  }

  private listData(raw: unknown, name: string, a: Data): { items: Data[]; metadata?: Data } {
    const checked = (value: unknown): Data[] => records(value).map(item => {
      const identifier = item.id ?? item.uid;
      const groupedTime = name === 'get_timesheet' && ('time_spent' in item || 'timeSpent' in item || 'generalSumTimeSpent' in item);
      if (!groupedTime && !(typeof identifier === 'string' && identifier.length > 0 || typeof identifier === 'number' && Number.isSafeInteger(identifier))) throw new KaitenError('API_RESPONSE_INVALID', 'List record is missing a valid identifier.');
      return item;
    });
    if (Array.isArray(raw)) return { items: checked(raw) };
    if (name !== 'get_timesheet') throw new KaitenError('API_RESPONSE_INVALID', 'Expected a Kaiten list.');
    const object = record(raw);
    const key = ['items','data','time_logs','logs','result'].find(k => Array.isArray(object[k]));
    if (key) { const { [key]: items, ...metadata } = object; return { items: checked(items), metadata }; }
    if (a.only_general_sum === 1 && ['total','time_spent','general_sum','generalSumTimeSpent'].some(k => k in object)) return { items: [], metadata: object };
    throw new KaitenError('API_RESPONSE_INVALID', 'Unsupported timesheet response structure; no known record collection or requested total.');
  }

  private async listAttachments(a: Data): Promise<Data> {
    const card = await this.files.rawCard(a.card_id);
    if (String(card.id) !== String(a.card_id)) throw new KaitenError('API_RESPONSE_INVALID', 'Card response has an invalid identifier.');
    if (!Array.isArray(card.files)) throw new KaitenError('API_RESPONSE_INVALID', 'Kaiten did not expose the card attachment list.');
    const comments = a.include_comments ? await this.files.rawComments(a.card_id, a.comments_offset, a.comments_limit) : [];
    const all = this.files.files(card, comments).map(f => f.attachment);
    return this.clean({ items: all.slice(a.offset, a.offset + a.limit), offset: a.offset, limit: a.limit,
      next_offset: a.offset + a.limit < all.length ? a.offset + a.limit : null,
      comments_offset: a.comments_offset, comments_limit: a.comments_limit,
      comments_next_offset: a.include_comments && comments.length === a.comments_limit ? a.comments_offset + comments.length : null,
      comments_included: a.include_comments, total_in_selected_pages: all.length, continuation: [], warnings: [] });
  }
}
