import { z } from 'zod';

const id = z.number().int().positive().safe();
const offset = z.number().int().nonnegative().safe();
const ids = z.array(id).max(100);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, 'Invalid calendar date');
const timestamp = z.string().datetime({ offset: true });
const text = z.string().min(1).max(1000);
const card = { url: z.string().url().optional(), card_id: id.optional() };
const common = {
  detail: z.enum(['summary', 'full']).optional(),
  text_offsets: z.record(offset).optional().describe('JSON pointer -> character offset. Reuse the same page and all returned text cursors to continue.'),
  section_offsets: z.record(offset).optional().describe('JSON pointer -> nested array offset. Reuse the same page to continue a section.'),
};
const page = { offset: offset.default(0), limit: z.number().int().min(1).max(100).default(50),
  previous_page: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Pass page_fingerprint from the preceding page to detect an API ignoring pagination.') };
const search = {
  query: text.optional(), search_fields: z.enum(['title', 'description', 'title,description']).optional(),
  space_id: id.optional(), board_id: id.optional(), column_id: id.optional(), lane_id: id.optional(),
  owner_id: id.optional(), responsible_id: id.optional(), type_id: id.optional(),
  owner_ids: ids.optional(), member_ids: ids.optional(), responsible_ids: ids.optional(),
  type_ids: ids.optional(), tag_ids: ids.optional(), column_ids: ids.optional(),
  exclude_board_ids: ids.optional(), exclude_lane_ids: ids.optional(), exclude_column_ids: ids.optional(),
  states: z.array(z.number().int().min(1).max(3)).max(3).optional(), condition: z.number().int().min(1).max(3).optional(),
  archived: z.boolean().optional(), asap: z.boolean().optional(), overdue: z.boolean().optional(),
  done_on_time: z.boolean().optional(), with_due_date: z.boolean().optional(),
  created_before: timestamp.optional(), created_after: timestamp.optional(),
  updated_before: timestamp.optional(), updated_after: timestamp.optional(),
  due_date_before: timestamp.optional(), due_date_after: timestamp.optional(),
  first_moved_in_progress_before: timestamp.optional(), first_moved_in_progress_after: timestamp.optional(),
  last_moved_to_done_at_before: timestamp.optional(), last_moved_to_done_at_after: timestamp.optional(),
  order_by: z.string().regex(/^[a-z_]+(?:,[a-z_]+)*$/).max(200).optional(),
  order_direction: z.enum(['asc', 'desc']).optional(),
};
const range = { from: date, to: date };
const optionalRange = { from: date.optional(), to: date.optional() };

export interface ToolSpec {
  name: string; description: string; input: z.AnyZodObject;
  kind: 'entity' | 'list' | 'attachments' | 'download';
  path?: (a: Record<string, any>) => string;
  queryKeys?: string[]; paging?: 'remote' | 'local'; cache?: boolean; card?: boolean;
  fixedQuery?: Record<string, string | number>;
}
const specs: ToolSpec[] = [];
function add(name: string, description: string, fields: z.ZodRawShape, options: Omit<ToolSpec, 'name' | 'description' | 'input'>) {
  specs.push({ name, description, input: z.object({ ...common, ...(options.kind === 'list' ? page : {}), ...fields }).strict(), ...options });
}
const entity = (name: string, desc: string, fields: z.ZodRawShape, path: ToolSpec['path'], cache = false) => add(name, desc, fields, { kind: 'entity', path, cache });
const list = (name: string, desc: string, fields: z.ZodRawShape, path: ToolSpec['path'], paging: 'remote' | 'local' = 'local', cache = false, queryKeys: string[] = []) => add(name, desc, fields, { kind: 'list', path, paging, cache, queryKeys });
const cardList = (name: string, desc: string, suffix: string, fields: z.ZodRawShape = {}, paging: 'remote' | 'local' = 'local', queryKeys: string[] = []) => {
  list(name, desc, { ...card, ...fields }, a => `cards/${a.card_id}/${suffix}`, paging, false, queryKeys);
  specs.at(-1)!.card = true;
};

entity('get_card', 'Read a card directly, including its description, identifiers and card attachment metadata. Does not fetch comments. Use full (default) and follow continuation.', card, a => `cards/${a.card_id}`);
specs.at(-1)!.card = true;
specs.at(-1)!.fixedQuery = { broken_api: 'false' };
list('search_cards', 'Search cards with documented filters, sorting and limit/offset. Defaults to title search. Full detail requests descriptions. Follow next_offset.', search, () => 'cards', 'remote', false, Object.keys(search));
list('list_space_cards', 'List cards in a space via the dedicated cards route, with search filters.', { ...search, space_id: id }, () => 'cards', 'remote', false, Object.keys(search));
list('list_board_cards', 'List cards on a board via the dedicated cards route, with search filters.', { ...search, board_id: id }, () => 'cards', 'remote', false, Object.keys(search));
cardList('get_card_location_history', 'Read card movement and state history, with author and dates.', 'location-history');
cardList('list_subtasks', 'Read child cards linked to this card.', 'children');
cardList('get_card_comments', 'Read a page of comments with original text, format when supplied, authors, dates, editing flags and attachment metadata. Follow pagination and text continuation.', 'comments', {}, 'remote');
entity('get_checklist', 'Read a checklist after verifying it belongs to the supplied card. Discover checklist IDs in get_card full detail.', { ...card, checklist_id: id }, a => `cards/${a.card_id}/checklists/${a.checklist_id}`);
specs.at(-1)!.card = true;
cardList('list_card_members', 'Read card participants and their roles.', 'members');
cardList('list_card_blockers', 'Read blockers of the card.', 'blockers');
cardList('list_card_external_links', 'Read external links attached to the card.', 'external-links');
cardList('list_card_tags', 'Read tags attached to the card.', 'tags');
list('list_spaces', 'List accessible spaces. Pages are fetched from Kaiten; structural metadata cached for the configured TTL.', {}, () => 'spaces', 'remote', true);
entity('get_space', 'Read detailed space metadata. Use list_boards for its boards and list_space_cards for cards.', { space_id: id }, a => `spaces/${a.space_id}`, true);
list('list_boards', 'List board metadata in a space. Does not retrieve cards.', { space_id: id }, a => `spaces/${a.space_id}/boards`, 'local', true);
entity('get_board', 'Read board metadata, columns and lanes. Cards are retrieved separately with list_board_cards.', { board_id: id }, a => `boards/${a.board_id}`, true);
list('list_columns', 'Read columns of a board.', { board_id: id }, a => `boards/${a.board_id}/columns`, 'local', true);
list('list_subcolumns', 'Read subcolumns of a column.', { column_id: id }, a => `columns/${a.column_id}/subcolumns`, 'local', true);
list('list_lanes', 'Read lanes of a board.', { board_id: id }, a => `boards/${a.board_id}/lanes`, 'local', true);
list('list_card_types', 'Read card types and their current card_properties settings.', {}, () => 'card-types', 'remote', true);
list('list_space_users', 'Read users of a space, optionally including inherited access or inactive members.', { space_id: id, include_inherited_access: z.boolean().optional(), inactive: z.boolean().optional() }, a => `spaces/${a.space_id}/users`, 'local', true, ['include_inherited_access', 'inactive']);
entity('get_current_user', 'Read the user authenticated by the API token.', {}, () => 'users/current');
list('list_users', 'Read accessible users with pagination and optional name/email search. Token permissions determine visibility.', { query: text.optional(), type: z.enum(['all','domain','shared']).optional(), include_inactive: z.boolean().optional(), access_type_permissions: z.enum(['member','guest']).optional() }, () => 'users', 'remote', true, ['query','type','include_inactive','access_type_permissions']);
list('list_company_roles', 'Read company role definitions, including system roles with negative IDs.', {}, () => 'user-roles', 'local', true);
list('list_workspace_tags', 'Read workspace tag definitions with optional text, space and ID filters.', { query: text.optional(), space_id: id.optional(), ids: ids.optional() }, () => 'tags', 'remote', true, ['query','space_id','ids']);
list('list_custom_properties', 'Read custom property definitions; option values can be read separately.', { query: text.optional(), include_values: z.boolean().optional(), include_author: z.boolean().optional(), ids: ids.optional() }, () => 'company/custom-properties', 'remote', true, ['query','include_values','include_author','ids']);
list('list_custom_property_select_values', 'Read select options of a custom property using the paginated v2 select search.', { property_id: id, query: text.optional(), ids: ids.optional(), order_by: z.enum(['value','sort_order','id']).optional() }, a => `company/custom-properties/${a.property_id}/select-values`, 'remote', true, ['query','ids','order_by']);
specs.at(-1)!.fixedQuery = { v2_select_search: 'true' };
list('list_sprints', 'Read sprints (deprecated Kaiten route). Unavailable permissions and unsupported routes are reported explicitly.', { active: z.boolean().optional() }, () => 'sprints', 'remote', false, ['active']);
entity('get_sprint', 'Read sprint summary (deprecated Kaiten route), including explicitly paged nested sections.', { sprint_id: id, exclude_deleted_cards: z.boolean().optional() }, a => `sprints/${a.sprint_id}`);
specs.at(-1)!.queryKeys = ['exclude_deleted_cards'];
list('get_user_timelogs', 'Read user time logs in an inclusive calendar date range. Dedicated route may be unavailable on older instances.', { user_id: id, ...range }, a => `users/${a.user_id}/time-logs`, 'local', false, ['from','to']);
cardList('get_card_timelogs', 'Read card time logs. Optional from/to are applied locally to for_date; for_date and personal are Kaiten filters. Missing dates cause an explicit compatibility error when range filtering.', 'time-logs', { ...optionalRange, for_date: date.optional(), personal: z.boolean().optional() }, 'local', ['for_date','personal']);
list('get_timesheet', 'Read time tracking for a date range with workspace filters and optional grouping: 0=none, 1=user, 2=card. Preserve totals and follow continuation.', { ...range,
  card_ids: ids.optional(), user_ids: ids.optional(), group_ids: ids.optional(), space_ids: ids.optional(), board_ids: ids.optional(), column_ids: ids.optional(), tag_ids: ids.optional(), visible_column_ids: ids.optional(),
  condition: z.number().int().min(1).max(3).optional(), group_by: z.number().int().min(0).max(2).optional(),
  time_precision: z.number().int().min(0).max(10).optional(), time_unit: z.number().int().nonnegative().max(10).optional(),
  with_daily_distribution: z.number().int().min(0).max(1).optional(), only_general_sum: z.number().int().min(0).max(1).optional(),
}, () => 'time-logs', 'remote', false, ['from','to','card_ids','user_ids','group_ids','space_ids','board_ids','column_ids','tag_ids','visible_column_ids','condition','group_by','time_precision','time_unit','with_daily_distribution','only_general_sum']);
add('list_attachments', 'Read card attachment metadata and one selected page of comment attachments; does not download files. Follow comments_next_offset and pass comments_page_fingerprint as comments_previous_page to inspect more comments safely. Cloud documents are links requiring separate authorization.', { ...card, ...page, include_comments: z.boolean().default(true), comments_offset: offset.default(0), comments_limit: z.number().int().min(1).max(100).default(50), comments_previous_page: page.previous_page }, { kind: 'attachments', card: true });
add('download_attachment', 'Download only a selected original attached to the supplied card or its accessible comments. Returns an absolute local path, MIME, size, SHA-256 and resource URI. Use your own file tools to read it; no format extraction occurs here.', { ...card, attachment_id: z.string().min(1).max(200) }, { kind: 'download', card: true });

export const toolSpecs: readonly ToolSpec[] = specs;
