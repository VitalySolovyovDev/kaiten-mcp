import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { KaitenClient } from '../src/kaiten.js';
import { documentItem, parseDocumentUrl } from '../src/documents.js';
import { json, listen } from './helpers.js';

const documentUid = '11111111-1111-4111-8111-111111111111';
const groupUid = '22222222-2222-4222-8222-222222222222';
const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
let api: Awaited<ReturnType<typeof listen>>, status = 0, document: any, group: any, children: any[];
const requests: { path: string; query: Record<string,string>; method: string; auth?: string }[] = [];
const config = (extra = {}) => loadConfig({ KAITEN_BASE_URL: api.url, KAITEN_ALLOW_HTTP: 'true', KAITEN_API_TOKEN: 'document-test-secret', ...extra });
beforeAll(async () => {
  api = await listen((req,res) => {
    const url = new URL(req.url!, api.url);
    requests.push({path:url.pathname,query:Object.fromEntries(url.searchParams),method:req.method!,auth:req.headers.authorization});
    if (status) return json(res,{message:'Not accessible'},status);
    if (url.pathname === `/api/latest/documents/${documentUid}`) return json(res,document);
    if (url.pathname === `/api/latest/document-groups/${groupUid}`) return json(res,group);
    if (url.pathname === '/api/latest/tree-entities') return json(res,children.slice(Number(url.searchParams.get('offset')),Number(url.searchParams.get('offset'))+Number(url.searchParams.get('limit'))));
    return json(res,{},404);
  });
});
afterAll(async () => { await api.close(); });
beforeEach(() => {
  status=0;requests.length=0;
  document={uid:documentUid,title:'Document',entity_type:'document',version:3,parent_entity_uid:groupUid,data:{type:'doc',content:[paragraph('Native document text')]}};
  group={uid:groupUid,title:'Group',entity_type:'document_group',index_document_uid:documentUid};
  children=Array.from({length:3},(_,i)=>({uid:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,title:`Child ${i}`,entity_type:i===2?'document_group':'document',parent_entity_uid:groupUid,has_children:i===2}));
});

describe('native document URLs and inputs', () => {
  it.each(['d','g'])('accepts %s URLs and corporate deployment prefixes', kind => {
    const cfg=loadConfig({KAITEN_BASE_URL:'https://tasks.example/corporate/',KAITEN_API_TOKEN:'secret'});
    expect(parseDocumentUrl(`https://tasks.example/corporate/documents/${kind}/${documentUid}/?x=1#part`,cfg)).toEqual({uid:documentUid,kind:kind==='d'?'document':'document_group'});
  });
  it.each(['https://evil.example/documents/d/'+documentUid,'https://u:p@tasks.example/documents/d/'+documentUid,'https://tasks.example/other/documents/d/'+documentUid,'https://tasks.example/corporate/documents/d/invalid','https://tasks.example/corporate/documents/d/'+documentUid+'/extra','http://tasks.example/corporate/documents/d/'+documentUid])('rejects unsafe URL %s', url => {
    const cfg=loadConfig({KAITEN_BASE_URL:'https://tasks.example/corporate/',KAITEN_API_TOKEN:'secret'});
    expect(()=>parseDocumentUrl(url,cfg)).toThrow();
  });
  it.each([
    ['get_document',{}],['get_document',{document_uid:documentUid,url:'https://evil.example'}],
    ['get_document',{document_uid:'../users/current'}],['get_document',{url:'https://evil.example/documents/d/'+documentUid}],
    ['get_document',{url:'GROUP'}],['get_document_group',{url:'DOCUMENT'}],
    ['list_document_children',{}],['list_document_children',{parent_entity_uid:groupUid,url:'GROUP'}],
    ['get_document',{document_uid:documentUid,include_content:true,detail:'summary'}],
  ])('rejects invalid %s arguments before any request',async (name,args) => {
    const input={...args};if(input.url==='GROUP') input.url=`${api.url}/documents/g/${groupUid}`;if(input.url==='DOCUMENT')input.url=`${api.url}/documents/d/${documentUid}`;
    await expect(new KaitenClient(config()).execute(name,input)).rejects.toThrow();expect(requests).toHaveLength(0);
  });
});

describe('document metadata and explicit content', () => {
  it('defaults to metadata and does not expose the body, including summary mode',async () => {
    const client=new KaitenClient(config());
    for(const detail of ['full','summary']) {
      const r=await client.execute('get_document',{url:`${api.url}/documents/d/${documentUid}`,detail});
      expect(r.item).toMatchObject({uid:documentUid,entity_type:'document',content_available:true,content_included:false});
      expect(r.item.data).toBeUndefined();expect(r.item.content).toBeUndefined();expect(JSON.stringify(r)).not.toContain('Native document text');
    }
    expect(requests).toHaveLength(2);expect(requests.every(r=>r.method==='GET'&&r.auth==='Bearer document-test-secret')).toBe(true);
  });
  it('extracts paragraphs, line breaks, lists, tables and safe references without requests to links',async () => {
    document.data.content=[paragraph('Intro'),{type:'bulletList',content:[{type:'listItem',content:[paragraph('Item')]}]},
      {type:'table',content:[{type:'tableRow',content:[{type:'tableCell',content:[paragraph('A')]},{type:'tableCell',content:[paragraph('B')]}]}]},
      {type:'paragraph',content:[{type:'text',text:'Link',marks:[{type:'link',attrs:{href:'https://reference.example'}}]},{type:'hardBreak'},{type:'image',attrs:{alt:'Picture',src:'https://image.example/file'}}]}];
    const r=await new KaitenClient(config()).execute('get_document',{document_uid:documentUid,include_content:true});
    expect(r.item.content).toContain('Intro\n- Item');expect(r.item.content).toContain('A\tB');expect(r.item.content).toContain('Link (https://reference.example)\nPicture (https://image.example/file)');
    expect(r.item.content_format).toBe('text');expect(requests).toHaveLength(1);
  });
  it('preserves original ProseMirror nodes and attributes on explicit request',async () => {
    document.data.content.push({type:'customWidget',attrs:{options:{x:1}},content:[{type:'text',text:'Custom'}]});
    const r=await new KaitenClient(config()).execute('get_document',{document_uid:documentUid,include_content:true,format:'prosemirror'});
    expect(r.item.content_format).toBe('prosemirror');expect(r.item.content).toEqual(document.data);expect(r.item.data).toBeUndefined();
  });
  it('accepts JSON-serialized ProseMirror data from deployed Kaiten versions',async () => {
    const original=document.data;document.data=JSON.stringify(original);
    document.author={id:1,full_name:'Author',avatar_initials_url:'data:image/png;base64,large'};
    const client=new KaitenClient(config());const r=await client.execute('get_document',{document_uid:documentUid,include_content:true});
    expect(r.item.content).toBe('Native document text');expect(r.item.author).toEqual({id:1,full_name:'Author'});expect(JSON.stringify(r)).not.toContain('base64');
    const p=await client.execute('get_document',{document_uid:documentUid,include_content:true,format:'prosemirror'});expect(p.item.content).toEqual(original);
  });
  it('reads long text to completion without losing Unicode',async () => {
    const original='Text 😀 '.repeat(80);document.data.content=[paragraph(original)];
    const client=new KaitenClient(config({KAITEN_MAX_TEXT_CHARS:'80'}));let text='',offsets={};
    for(let i=0;i<100;i++) {
      const r=await client.execute('get_document',{document_uid:documentUid,include_content:true,text_offsets:offsets});text+=r.item.content;
      if(!r.continuation.some((v:any)=>v.path==='/item/content'&&v.next_offset!==null))break;
      offsets=r.next_text_offsets;
    }
    expect(text).toBe(original.trimEnd());
  });
  it('pages original JSON sections without cutting JSON or dropping nodes',async () => {
    document.data.content=Array.from({length:105},(_,i)=>paragraph(String(i)));
    const client=new KaitenClient(config());const a=await client.execute('get_document',{document_uid:documentUid,include_content:true,format:'prosemirror'});
    expect(a.item.content.content).toHaveLength(100);expect(a.continuation).toContainEqual({path:'/item/content/content',kind:'section',offset:0,total:105,next_offset:100});
    const b=await client.execute('get_document',{document_uid:documentUid,include_content:true,format:'prosemirror',section_offsets:{'/item/content/content':100}});
    expect([...a.item.content.content,...b.item.content.content]).toEqual(document.data.content);
  });
  it.each([null,{},'not JSON',{type:'paragraph'}, {type:'doc',content:{}},{type:'doc',content:[null]},{type:'doc',content:[{type:'text'}]}])('reports incompatible requested content rather than fabricating text',async data => {
    document.data=data;await expect(new KaitenClient(config()).execute('get_document',{document_uid:documentUid,include_content:true})).rejects.toMatchObject({code:'API_RESPONSE_INVALID'});
  });
  it('bounds nesting and preserves empty documents', () => {
    const data:any={type:'doc',content:[]};let parent=data;for(let i=0;i<102;i++){const node={type:'paragraph',content:[]};parent.content.push(node);parent=node;}
    expect(()=>documentItem({data},{include_content:true,format:'text'})).toThrow();
    expect(documentItem({data:{type:'doc',content:[]}},{include_content:true,format:'text'}).content).toBe('');
  });
  it('redacts credentials in both metadata and content',async () => {
    document.api_token='document-test-secret';document.data.content=[paragraph('document-test-secret')];
    const r=await new KaitenClient(config()).execute('get_document',{document_uid:documentUid,include_content:true});
    expect(JSON.stringify(r)).not.toContain('document-test-secret');expect(r.item.content).toContain('[REDACTED]');
  });
});

describe('groups, children, permissions and caching', () => {
  it('reads group URLs and only one explicit level of paginated children',async () => {
    const client=new KaitenClient(config());const g=await client.execute('get_document_group',{url:`${api.url}/documents/g/${groupUid}`});expect(g.item.index_document_uid).toBe(documentUid);
    const a=await client.execute('list_document_children',{url:`${api.url}/documents/g/${groupUid}`,limit:2});expect(a.items).toHaveLength(2);expect(a.next_offset).toBe(2);
    const b=await client.execute('list_document_children',{parent_entity_uid:groupUid,limit:2,offset:a.next_offset,previous_page:a.page_fingerprint});expect(b.items).toHaveLength(1);expect(b.next_offset).toBeNull();expect(b.items[0].entity_type).toBe('document_group');
    expect(requests[1].query).toEqual({parent_entity_uid:groupUid,levels_count:'1',limit:'2',offset:'0'});expect(requests).toHaveLength(3);
  });
  it('supports document parents and empty groups without content expansion',async () => {
    children=[];const r=await new KaitenClient(config()).execute('list_document_children',{url:`${api.url}/documents/d/${documentUid}`});expect(r.items).toEqual([]);expect(r.next_offset).toBeNull();expect(requests[0].query.parent_entity_uid).toBe(documentUid);
  });
  it('omits unexpected content fields from groups and child metadata',async () => {
    group.data={type:'doc',content:[paragraph('Hidden group body')]};children[0].data=group.data;children[0].content='Hidden child body';
    const client=new KaitenClient(config());const g=await client.execute('get_document_group',{document_group_uid:groupUid});const c=await client.execute('list_document_children',{parent_entity_uid:groupUid,detail:'full'});
    expect(JSON.stringify([g,c])).not.toContain('Hidden');expect(g.item.data).toBeUndefined();expect(c.items[0].content).toBeUndefined();
  });
  it('checks response identity, type and parent before returning or caching records',async () => {
    const client=new KaitenClient(config());group.uid=documentUid;await expect(client.execute('get_document_group',{document_group_uid:groupUid})).rejects.toMatchObject({code:'API_RESPONSE_INVALID'});group.uid=groupUid;
    expect((await client.execute('get_document_group',{document_group_uid:groupUid})).item.uid).toBe(groupUid);
    children[0].parent_entity_uid=documentUid;await expect(client.execute('list_document_children',{parent_entity_uid:groupUid})).rejects.toMatchObject({code:'PARENT_MISMATCH'});
    children[0].parent_entity_uid=groupUid;children[0].entity_type='space';await expect(client.execute('list_document_children',{parent_entity_uid:groupUid})).rejects.toMatchObject({code:'API_RESPONSE_INVALID'});
    document.uid=groupUid;await expect(client.execute('get_document',{document_uid:documentUid})).rejects.toMatchObject({code:'API_RESPONSE_INVALID'});
  });
  it.each([[401,'UNAUTHORIZED'],[403,'FORBIDDEN'],[404,'NOT_FOUND'],[410,'UNSUPPORTED_ROUTE']])('preserves HTTP %s access errors and does not cache failures',async (code,error) => {
    const client=new KaitenClient(config());status=code as number;
    await expect(client.execute('get_document_group',{document_group_uid:groupUid})).rejects.toMatchObject({code:error});expect(requests).toHaveLength(1);
    status=0;expect((await client.execute('get_document_group',{document_group_uid:groupUid})).item.uid).toBe(groupUid);expect(requests).toHaveLength(2);
  });
  it('caches structural metadata, never document content or access checks',async () => {
    const client=new KaitenClient(config());for(let i=0;i<2;i++){await client.execute('get_document_group',{document_group_uid:groupUid});await client.execute('list_document_children',{parent_entity_uid:groupUid});await client.execute('get_document',{document_uid:documentUid});}
    expect(requests.filter(r=>r.path.includes('document-groups'))).toHaveLength(1);expect(requests.filter(r=>r.path.includes('tree-entities'))).toHaveLength(1);expect(requests.filter(r=>r.path.includes('/documents/'))).toHaveLength(2);
    const a=await client.execute('list_document_children',{parent_entity_uid:groupUid});await expect(client.execute('list_document_children',{parent_entity_uid:groupUid,previous_page:a.page_fingerprint})).rejects.toMatchObject({code:'PAGINATION_INVALID'});
  });
});
