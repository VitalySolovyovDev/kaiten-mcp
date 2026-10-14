import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { KaitenClient } from '../src/kaiten.js';
import { HttpClient } from '../src/http.js';
import { MetadataCache } from '../src/cache.js';
import { KaitenError } from '../src/errors.js';
import { project } from '../src/data.js';

const config = (extra: Record<string,string> = {}) => loadConfig({ KAITEN_BASE_URL:'https://tasks.example',KAITEN_API_TOKEN:'mock-secret-unlikely',...extra });
function mocked(extra: Record<string,string> = {}, now?: ()=>number) {
  const c = new KaitenClient(config(extra),undefined,now);
  const get = vi.spyOn(c.http,'json');
  return { c, get };
}
describe('pagination and text continuation',()=>{
  it('reconstructs every long field with a shared budget, without losing comments or splitting unicode',async()=>{
    const {c,get}=mocked({KAITEN_MAX_TEXT_CHARS:'8'});
    const rows=[{id:1,text:'1234😀56789'.repeat(4),author:{id:2,full_name:'Very long author name'}},{id:2,text:'Other long text'.repeat(5)}];
    get.mockImplementation(async path=>path==='cards/1'?{id:1,title:'Card'}:rows);
    const joined=['',''];let text_offsets: Record<string,number>={};
    for(let step=0;step<100;step++) {
      const response=await c.execute('get_card_comments',{card_id:1,detail:'full',text_offsets});
      response.items.forEach((item:any,index:number)=>{joined[index]+=item.text;});
      expect(response.items.map((v:any)=>v.text.length).reduce((a:number,b:number)=>a+b,0)).toBeLessThanOrEqual(8);
      expect(response.next_offset).toBeNull();
      text_offsets=response.next_text_offsets;
      if(!response.continuation.some((v:any)=>v.kind==='text'&&v.next_offset!==null)) break;
      if(step===99) throw new Error('Text continuation made no progress');
    }
    expect(joined).toEqual(rows.map(r=>r.text));
  });
  it('returns nested collections in explicit sections with no loss',()=>{
    const raw={item:{id:1,items:Array.from({length:205},(_,i)=>({id:i+1,text:'x'}))}};
    const first=project(raw,20000,{},'');expect(first.value.item.items).toHaveLength(100);
    expect(first.continuation).toContainEqual({path:'/item/items',kind:'section',offset:0,total:205,next_offset:100});
    const second=project(raw,20000,{section_offsets:{'/item/items':100}},'');
    const last=project(raw,20000,{section_offsets:{'/item/items':200}},'');
    expect([...first.value.item.items,...second.value.item.items,...last.value.item.items].map(v=>v.id)).toEqual(raw.item.items.map(v=>v.id));
    expect(last.continuation[0].next_offset).toBeNull();
  });
  it('protects IDs and URLs from text truncation and rejects stale cursors',()=>{
    const p=project({item:{id:'uuid-long-string',resource_uri:'kaiten://cards/1/attachments/2',description:'abcdef'}},2,{},'');
    expect(p.value.item.resource_uri).toBe('kaiten://cards/1/attachments/2');expect(p.value.item.id).toBe('uuid-long-string');expect(p.value.item.description).toBe('ab');
    expect(()=>project({item:{text:'x'}},20,{text_offsets:{'/item/text':2}},'')).toThrow();
  });
  it.each(['search_cards','list_spaces','list_users','list_workspace_tags','list_card_types'])('%s handles exact final page, empty page, max limit and repetition',async name=>{
    const {c,get}=mocked();const rows=Array.from({length:100},(_,i)=>({id:i+1,title:'x'}));
    get.mockImplementation(async(_path,q)=>rows.slice(Number(q?.offset),Number(q?.offset)+Number(q?.limit)));
    const first=await c.execute(name,{limit:100});expect(first.next_offset).toBe(100);
    const last=await c.execute(name,{limit:100,offset:100,previous_page:first.page_fingerprint});expect(last.items).toEqual([]);expect(last.next_offset).toBeNull();
    get.mockResolvedValue(rows);
    await expect(new KaitenClient(c.config,c.http).execute(name,{limit:100,offset:100,previous_page:first.page_fingerprint})).rejects.toMatchObject({code:'PAGINATION_INVALID'});
    await expect(c.execute(name,{limit:101})).rejects.toMatchObject({code:'INPUT_INVALID'});
  });
  it('locally pages unpaginated collections through their final record',async()=>{
    const {c,get}=mocked();get.mockResolvedValue(Array.from({length:101},(_,i)=>({id:i+1})));
    const a=await c.execute('list_columns',{board_id:1,limit:100}),b=await c.execute('list_columns',{board_id:1,offset:a.next_offset,limit:100});
    expect(a.items).toHaveLength(100);expect(b.items).toEqual([{id:101}]);expect(b.next_offset).toBeNull();expect(get.mock.calls[0][1]).toEqual({});
  });
  it('detects repeated selected comment pages when listing attachments',async()=>{
    const {c,get}=mocked();get.mockImplementation(async p=>p==='cards/1'?{id:1,files:[]}:[{id:2,text:'Comment',files:[]}]);
    const first=await c.execute('list_attachments',{card_id:1,comments_limit:1});expect(first.comments_next_offset).toBe(1);
    await expect(c.execute('list_attachments',{card_id:1,comments_limit:1,comments_offset:1,comments_previous_page:first.comments_page_fingerprint})).rejects.toMatchObject({code:'PAGINATION_INVALID'});
  });
  it('does not read or cache comments when getting a card',async()=>{
    const {c,get}=mocked();get.mockResolvedValue({id:1,title:'Card',description:'abcdefghij',files:[]});
    await c.execute('get_card',{card_id:1});await c.execute('get_card',{card_id:1});expect(get).toHaveBeenCalledTimes(2);expect(get.mock.calls.every(call=>call[0]==='cards/1')).toBe(true);
  });
});

describe('cache',()=>{
  it('uses keys and TTL with copies; caches only metadata, no failures',async()=>{
    let now=0;const {c,get}=mocked({KAITEN_CACHE_TTL_MS:'60'},()=>now);
    get.mockResolvedValue([{id:1,title:'Space'}]);
    const a=await c.execute('list_spaces',{});a.items[0].title='mutated';expect((await c.execute('list_spaces',{})).items[0].title).toBe('Space');expect(get).toHaveBeenCalledTimes(1);
    await c.execute('list_spaces',{offset:50});expect(get).toHaveBeenCalledTimes(2);
    now=60;await c.execute('list_spaces',{});expect(get).toHaveBeenCalledTimes(3);
    get.mockRejectedValueOnce(new KaitenError('FORBIDDEN','Denied'));now=120;
    await expect(c.execute('list_spaces',{})).rejects.toMatchObject({code:'FORBIDDEN'});await c.execute('list_spaces',{});expect(get).toHaveBeenCalledTimes(5);
    get.mockResolvedValueOnce({unexpected:true});now=180;
    await expect(c.execute('list_spaces',{})).rejects.toMatchObject({code:'API_RESPONSE_INVALID'});await c.execute('list_spaces',{});expect(get).toHaveBeenCalledTimes(7);
  });
  it('can be disabled and distinguishes filter keys',async()=>{
    const {c,get}=mocked({KAITEN_CACHE_TTL_MS:'0'});get.mockResolvedValue([{id:1,name:'Tag'}]);await c.execute('list_workspace_tags',{});await c.execute('list_workspace_tags',{});expect(get).toHaveBeenCalledTimes(2);
    const other=mocked();other.get.mockResolvedValue([]);await other.c.execute('list_workspace_tags',{query:'a'});await other.c.execute('list_workspace_tags',{query:'b'});expect(other.get).toHaveBeenCalledTimes(2);
  });
  it('does not cache a schema validation failure',async()=>{
    const cache=new MetadataCache(100);const fetch=vi.fn().mockResolvedValue({wrong:true}),validate=()=>{throw new Error('invalid');};
    await expect(cache.get('key',fetch,validate)).rejects.toThrow();await expect(cache.get('key',fetch,validate)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('filters, ownership and API variants',()=>{
  it('maps all search filters, dates, sorting and arrays to documented parameters and omits empty arrays',async()=>{
    const {c,get}=mocked();get.mockResolvedValue([]);
    const fields={space_id:1,board_id:2,column_id:3,lane_id:4,owner_id:5,responsible_id:6,type_id:7,owner_ids:[5],member_ids:[8],responsible_ids:[6],tag_ids:[9],type_ids:[7],column_ids:[3],exclude_board_ids:[10],exclude_lane_ids:[11],exclude_column_ids:[12],states:[1,3],condition:2,archived:true,asap:false,overdue:true,done_on_time:false,with_due_date:true,query:'text',search_fields:'title,description',created_after:'2026-10-01T00:00:00Z',created_before:'2026-10-14T00:00:00Z',updated_after:'2026-10-01T00:00:00Z',updated_before:'2026-10-14T00:00:00Z',due_date_after:'2026-10-01T00:00:00Z',due_date_before:'2026-10-14T00:00:00Z',order_by:'created,updated',order_direction:'desc'};
    await c.execute('search_cards',fields);const q=get.mock.calls.at(-1)![1];
    for(const [k,v] of Object.entries(fields)) expect(q?.[k],k).toBe(Array.isArray(v)?v.join(','):String(v));
    await c.execute('search_cards',{tag_ids:[]});expect(get.mock.calls.at(-1)![1]?.tag_ids).toBeUndefined();
    await expect(c.execute('search_cards',{search_fields:'title'})).rejects.toMatchObject({code:'INPUT_INVALID'});
    await expect(c.execute('search_cards',{created_before:fields.created_after,created_after:fields.created_before})).rejects.toMatchObject({code:'INPUT_INVALID'});
  });
  it.each([0,1,2])('preserves grouped timesheet variant %s with totals',async group_by=>{
    const {c,get}=mocked();get.mockResolvedValue({data:[{id:1,user_id:3,time_spent:120}],total:120});
    const result=await c.execute('get_timesheet',{from:'2026-10-01',to:'2026-10-14',group_by});expect(result.items[0].time_spent).toBe(120);expect(result.metadata.total).toBe(120);expect(get.mock.calls[0][1]?.group_by).toBe(String(group_by));
  });
  it('supports requested general totals but rejects unknown wrappers',async()=>{
    const {c,get}=mocked();get.mockResolvedValue({generalSumTimeSpent:120});const input={from:'2026-10-01',to:'2026-10-14',only_general_sum:1};
    expect((await c.execute('get_timesheet',input)).metadata.generalSumTimeSpent).toBe(120);
    get.mockResolvedValue({unknown:[]});await expect(c.execute('get_timesheet',input)).rejects.toMatchObject({code:'API_RESPONSE_INVALID'});
  });
  it.each([{from:'2026-10-14',to:'2026-10-01'},{from:'2026-02-30',to:'2026-10-01'},{from:'2026-10-01'}])('rejects invalid date ranges',async input=>{
    const {c}=mocked();await expect(c.execute('get_timesheet',input)).rejects.toMatchObject({code:'INPUT_INVALID'});
    await expect(c.execute('get_card_timelogs',{card_id:1,...input})).rejects.toMatchObject({code:'INPUT_INVALID'});
  });
  it('applies inclusive card timelog ranges locally and does not invent missing dates',async()=>{
    const {c,get}=mocked();const input={card_id:1,from:'2026-10-01',to:'2026-10-02'};
    get.mockImplementation(async p=>p==='cards/1'?{id:1}:[{id:1,for_date:'2026-09-30'},{id:2,for_date:'2026-10-01'},{id:3,for_date:'2026-10-02'},{id:4,for_date:'2026-10-03'}]);
    expect((await c.execute('get_card_timelogs',input)).items.map((v:any)=>v.id)).toEqual([2,3]);
    get.mockImplementation(async p=>p==='cards/1'?{id:1}:[{id:1}]);await expect(c.execute('get_card_timelogs',input)).rejects.toMatchObject({code:'API_RESPONSE_INVALID'});
  });
  it('checks checklist ownership before fetching an ID route and verifies returned parent',async()=>{
    const {c,get}=mocked();get.mockResolvedValue({id:1,checklists:[{id:5,card_id:1}]});
    await expect(c.execute('get_checklist',{card_id:1,checklist_id:6})).rejects.toMatchObject({code:'PARENT_MISMATCH'});expect(get).toHaveBeenCalledTimes(1);
    get.mockResolvedValueOnce({id:1,checklists:[{id:5,card_id:1}]}).mockResolvedValueOnce({id:5,card_id:2});
    await expect(c.execute('get_checklist',{card_id:1,checklist_id:5})).rejects.toMatchObject({code:'PARENT_MISMATCH'});
  });
  it('rejects parent mismatch for attachment metadata and comments',async()=>{
    const {c,get}=mocked();get.mockResolvedValue({id:1,files:[{id:2,card_id:9,name:'x'}]});
    await expect(c.execute('list_attachments',{card_id:1,include_comments:false})).rejects.toMatchObject({code:'PARENT_MISMATCH'});
    get.mockImplementation(async p=>p==='cards/1'?{id:1}:[{id:2,card_id:9,text:'x'}]);await expect(c.execute('get_card_comments',{card_id:1})).rejects.toMatchObject({code:'PARENT_MISMATCH'});
  });
  it('does not leak tokens or signed attachment URLs in full output',async()=>{
    const {c,get}=mocked();get.mockResolvedValue({id:1,title:'mock-secret-unlikely',api_token:'mock-secret-unlikely',files:[{id:2,url:'https://files.example/x?signature=private',name:'x',type:1}]});
    const output=JSON.stringify(await c.execute('get_card',{card_id:1}));expect(output).not.toContain('mock-secret-unlikely');expect(output).not.toContain('signature=private');
  });
  it('an individual invalid file does not block card text and is reported explicitly',async()=>{
    const {c,get}=mocked();get.mockResolvedValue({id:1,title:'Card',description:'Text',files:[{name:'bad'}, {id:2,name:'good',type:1}]});
    const result=await c.execute('get_card',{card_id:1});expect(result.item.description).toBe('Text');expect(result.item.attachments).toHaveLength(1);expect(result.item.attachment_warnings[0].code).toBe('API_RESPONSE_INVALID');expect(result.warnings).toHaveLength(1);
  });
  it('rejects changed list schemas, preserving the distinction from an empty list',async()=>{
    const {c,get}=mocked();get.mockResolvedValue([{unexpected:true}]);await expect(c.execute('list_users',{})).rejects.toMatchObject({code:'API_RESPONSE_INVALID'});
  });
  it('redacts protected URLs from nested entity files and leaves originals opaque',async()=>{
    const {c,get}=mocked();get.mockResolvedValue([{id:1,time_spent:1,card:{id:2,title:'nested',files:[{id:3,name:'archive.zip',url:'https://files.example/?signature=hidden'}]}}]);
    const result=await c.execute('get_timesheet',{from:'2026-10-01',to:'2026-10-14',detail:'full'});expect(JSON.stringify(result)).not.toContain('signature=hidden');expect(result.items[0].card.attachments[0].resource_uri).toBe('kaiten://cards/2/attachments/3');
  });
  it.each(['png','jpg','gif','tiff','pdf','docx','xlsx','pptx','txt','zip','encrypted','corrupted'])('passes %s originals unchanged without format detection',async ext=>{
    const {c,get}=mocked();get.mockResolvedValue({id:1,files:[{id:'f',name:`original.${ext}`,type:1,url:'https://files.example/f'}]});
    const bytes=Buffer.from([0,255,10,13,50,0,1]);vi.spyOn(c.http,'file').mockResolvedValue({bytes,mimeType:'application/octet-stream'});
    expect((await c.files.attachment(1,'f')).bytes).toEqual(bytes);
  });
  it('resolves a protected file parent UID from its comment',async()=>{
    const {c,get}=mocked();get.mockImplementation(async p=>p==='cards/1'?{id:1,uid:'card',files:[{id:'file',type:11,comment_id:2}]}:p==='cards/1/comments'?[{id:2,uid:'comment',files:[]}]:{url:'https://files.example/x'});
    vi.spyOn(c.http,'file').mockResolvedValue({bytes:Buffer.from('original'),mimeType:'text/plain'});
    await c.files.attachment(1,'file');expect(get).toHaveBeenCalledWith('cards/card/comments/comment/files/file');
  });
});
