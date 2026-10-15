import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';
import { KaitenClient } from '../src/kaiten.js';
import { HttpClient } from '../src/http.js';
import { createServer } from '../dist/server.js';
import { toolSpecs } from '../src/tools.js';
import { metadata } from '../src/metadata.js';
import { contracts } from './contracts.js';
import { json, listen, original } from './helpers.js';

let api: Awaited<ReturnType<typeof listen>>, storage: Awaited<ReturnType<typeof listen>>, directory: string;
const traffic: { method: string; path: string; query: Record<string,string>; auth?: string }[] = [];
const storageAuth: (string | undefined)[] = [];
const token = 'mock-secret-unlikely';
let failure = 0, incompatible = false;
const entity = (path: string) => ({ id: path.endsWith('/14') ? 14 : path.endsWith('/7') ? 7 : path.endsWith('/8') ? 8 : path.endsWith('/16') ? 16 : 123,
  title:'Title', description:'Description', description_type:1, extra_field:'full detail', uid:'card-uid',
  files:[{id:'legacy',name:'../../CON: unsafe?.bin',type:1,url:storage.url+'/original'}, {id:'protected',name:'protected.bin',type:11,uid:'protected'}, {id:'redirect',name:'redirect.bin',type:11,url:api.url+'/api/latest/redirect/content'}, {id:'cloud',name:'Cloud',type:2,url:'https://drive.example/doc'}, {id:'huge',name:'huge',type:1,size:21*1024*1024,url:storage.url+'/original'}],
  checklists:[{id:14,card_id:123,name:'List',items:[{id:1,text:'Do it',checked:false}]}] });
const entries = Array.from({length:101},(_,i)=>({ id:i+1,title:`Item ${i+1}`,text:`Comment ${i+1}`,type:1,card_id:123,extra_field:'full detail',for_date:'2026-10-02',time_spent:60,author:{id:1,full_name:'Tester'},created:'2026-10-02',edited:i===0,
  uid:`comment-${i+1}`,files:i===100?[{id:'comment-file',uid:'comment-file',name:'comment.bin',type:11,comment_id:101}]:[] }));
beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),'kaiten-tools-test-'));
  storage=await listen((req,res)=>{
    storageAuth.push(req.headers.authorization);
    if(req.url==='/cut') { res.writeHead(200,{'Content-Length':100});res.write('short'); setImmediate(()=>res.destroy()); }
    else if(req.url==='/large') { res.writeHead(200,{'Content-Length':21*1024*1024});res.end(); }
    else if(req.url==='/streamlarge') res.end(Buffer.alloc(1024));
    else if(req.url==='/missing') { res.writeHead(404); res.end(); }
    else {res.writeHead(200,{'Content-Type':'application/octet-stream'});res.end(original);}
  });
  api=await listen((req,res)=>{
    const url=new URL(req.url!,'http://localhost');
    const path=url.pathname.replace('/api/latest/','');
    traffic.push({method:req.method!,path,query:Object.fromEntries(url.searchParams),auth:req.headers.authorization});
    if(failure) return json(res,{token},failure);
    if(incompatible) return json(res,{unexpected:true});
    if(path==='redirect/content') {res.writeHead(302,{Location:storage.url+'/original'});return res.end();}
    if(path==='cards/card-uid/files/protected'||path==='cards/card-uid/comments/comment-101/files/comment-file') return json(res,{url:storage.url+'/original?signature=temporary'});
    if(/^cards\/\d+$/.test(path)||/^(?:spaces|boards|sprints)\/\d+$/.test(path)||path==='users/current'||path==='cards/123/checklists/14') return json(res,entity(path));
    const remote=['cards','spaces','card-types','users','tags','company/custom-properties','company/custom-properties/15/select-values','sprints','time-logs','cards/123/comments'].includes(path);
    if(contracts.some(c=>c[2]===path)) return json(res,remote?entries.slice(Number(url.searchParams.get('offset')??0),Number(url.searchParams.get('offset')??0)+Number(url.searchParams.get('limit')??50)):entries);
    json(res,{},404);
  });
});
afterAll(async()=>{await api?.close();await storage?.close();await rm(directory,{recursive:true,force:true});});
const config=()=>loadConfig({KAITEN_BASE_URL:api.url,KAITEN_API_TOKEN:token,KAITEN_ALLOW_HTTP:'true',KAITEN_ATTACHMENT_ALLOWED_HOSTS:'127.0.0.1',KAITEN_DOWNLOAD_DIR:directory});

describe('every public tool contract',()=>{
  it('declares the exact 34 read tools without a generic HTTP or write tool',()=>{
    expect(toolSpecs.map(t=>t.name)).toEqual(contracts.map(c=>c[0])); expect(toolSpecs).toHaveLength(34);
  });
  for(const [name,args,path,kind,filters] of contracts) {
    it(`${name}: GET route, filters, normalization, default page and detail`,async()=>{
      traffic.length=0;
      const result=await new KaitenClient(config()).execute(name,args);
      const request=traffic.find(r=>r.path===path)!;
      expect(request).toBeDefined();expect(traffic.every(r=>r.method==='GET')).toBe(true);
      expect(request.query).toMatchObject(filters);
      expect(traffic.every(r=>r.auth===`Bearer ${token}`)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(token);expect(JSON.stringify(result)).not.toContain('signature=');
      if(kind==='remote') { expect(request.query).toMatchObject({limit:'50',offset:'0'});expect(result.items).toHaveLength(50);expect(result.next_offset).toBe(50); }
      if(kind==='local') {expect(request.query.limit).toBeUndefined();expect(request.query.offset).toBeUndefined();expect(result.items).toHaveLength(50);expect(result.next_offset).toBe(50);}
      if(kind==='local'||kind==='remote') {expect(result.items[0].id).toBe(1);expect(result.items[0].extra_field).toBeUndefined();}
      if(kind==='entity') {expect(result.item.extra_field).toBe('full detail');}
      if(name==='get_card') {expect(result.item.description_format).toBe('markdown');expect(result.item.attachments).toHaveLength(5);expect(traffic).toHaveLength(1);}
      if(name==='get_card_comments') {expect(result.items[0].text_format).toBe('markdown');expect(result.items[0].author.full_name).toBe('Tester');expect(result.items[0].edited).toBe(true);}
      if(kind==='download') {expect(isAbsolute(result.item.path)).toBe(true);expect(await readFile(result.item.path)).toEqual(original);expect(result.item.sha256).toBe(createHash('sha256').update(original).digest('hex'));expect(result.item.size).toBe(original.length);}
    });
    it(`${name}: invalid arguments cause no network request`,async()=>{
      traffic.length=0;
      await expect(new KaitenClient(config()).execute(name,{...args,method:'POST'})).rejects.toMatchObject({code:'INPUT_INVALID'});expect(traffic).toHaveLength(0);
    });
    it(`${name}: forbidden and incompatible responses never become empty lists`,async()=>{
      try {
        failure=403;await expect(new KaitenClient(config()).execute(name,args)).rejects.toMatchObject({code:'FORBIDDEN'});
        failure=0;incompatible=true;await expect(new KaitenClient(config()).execute(name,args)).rejects.toMatchObject({code:'API_RESPONSE_INVALID'});
      } finally { failure=0;incompatible=false; }
    });
  }
  it('all card tools accept URL xor ID and reject mismatched instances and invalid IDs',async()=>{
    for(const spec of toolSpecs.filter(t=>t.card)) {
      const args=contracts.find(c=>c[0]===spec.name)![1]; const {card_id,...rest}=args as any;
      const c=new KaitenClient(config());
      await expect(c.execute(spec.name,{...args,url:api.url+'/123'})).rejects.toMatchObject({code:'INPUT_INVALID'});
      await expect(c.execute(spec.name,rest)).rejects.toMatchObject({code:'INPUT_INVALID'});
      await expect(c.execute(spec.name,{...rest,url:'https://evil.example/123'})).rejects.toMatchObject({code:'CARD_URL_INVALID'});
      await expect(c.execute(spec.name,{...rest,card_id:0})).rejects.toMatchObject({code:'INPUT_INVALID'});
      const result=await c.execute(spec.name,{...rest,url:api.url+'/space/1/boards/card/123'});expect(result.error).toBeUndefined();
    }
  });
  it('supports full detail and preserves missing fields instead of inventing defaults',async()=>{
    const result=await new KaitenClient(config()).execute('search_cards',{detail:'full'});
    expect(result.items[0].extra_field).toBe('full detail');expect(traffic.at(-1)?.query.additional_card_fields).toBe('description');
  });
});

describe('original attachments',()=>{
  it.each(['legacy','protected','redirect','comment-file'])('downloads %s byte-for-byte without sending auth to storage',async attachment_id=>{
    const result=await new KaitenClient(config()).execute('download_attachment',{card_id:123,attachment_id});
    expect(await readFile(result.item.path)).toEqual(original);expect(storageAuth.every(v=>v===undefined)).toBe(true);
  });
  it('lists selected comment pages without fetching files',async()=>{
    const before=storageAuth.length;
    const result=await new KaitenClient(config()).execute('list_attachments',{card_id:123,comments_offset:100});
    expect(result.items.find((f:any)=>f.id==='comment-file').source).toBe('comment');expect(result.comments_next_offset).toBeNull();expect(storageAuth).toHaveLength(before);
    const cardOnly=await new KaitenClient(config()).execute('list_attachments',{card_id:123,include_comments:false});expect(cardOnly.items).toHaveLength(5);expect(cardOnly.comments_included).toBe(false);
  });
  it.each([['cloud','EXTERNAL_ATTACHMENT'],['huge','FILE_TOO_LARGE'],['unrelated','ATTACHMENT_NOT_FOUND']])('reports %s',async(attachment_id,code)=>{
    await expect(new KaitenClient(config()).execute('download_attachment',{card_id:123,attachment_id})).rejects.toMatchObject({code});
  });
  it('saves safely with unique filenames and no partial files',async()=>{
    const c=new KaitenClient(config());
    const a=await c.execute('download_attachment',{card_id:123,attachment_id:'legacy'}),b=await c.execute('download_attachment',{card_id:123,attachment_id:'legacy'});
    expect(a.item.path).not.toBe(b.item.path);expect(await realpath(dirname(a.item.path))).toBe(await realpath(directory));expect(a.item.path).not.toContain('CON:');
    expect((await readdir(directory)).some(f=>f.endsWith('.part'))).toBe(false);
  });
  it('rejects interrupted and oversized transfers without writing a result',async()=>{
    const http=new HttpClient(config());
    await expect(http.file(storage.url+'/cut')).rejects.toMatchObject({code:'NETWORK_ERROR'});
    await expect(http.file(storage.url+'/large')).rejects.toMatchObject({code:'FILE_TOO_LARGE'});
    await expect(new HttpClient({...config(),maxFileBytes:512}).file(storage.url+'/streamlarge')).rejects.toMatchObject({code:'FILE_TOO_LARGE'});
  });
});

describe('MCP protocol and CLI',()=>{
  async function verify(client: Client) {
    const tools=(await client.listTools()).tools;
    expect(tools.map(t=>t.name)).toEqual(contracts.map(c=>c[0]));expect(tools.every(t=>t.outputSchema&&t.annotations?.readOnlyHint)).toBe(true);
    expect(client.getServerVersion()).toEqual(metadata);
    let downloadedPath='';
    for(const [name,args] of contracts) {const result=await client.callTool({name,arguments:args});expect(result.isError, name).not.toBe(true);expect(result.structuredContent,name).toBeDefined();if(name==='download_attachment')downloadedPath=(result.structuredContent!.item as any).path;}
    const wrong=await client.callTool({name:'get_card',arguments:{card_id:123,url:api.url+'/123'}});expect(wrong.isError).toBe(true);
    const resource=await client.readResource({uri:'kaiten://cards/123/attachments/legacy'});
    expect(Buffer.from((resource.contents[0] as any).blob,'base64')).toEqual(original);
    expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(1);
    return downloadedPath;
  }
  it('exercises every tool, output schema and original resource through MCP',async()=>{
    const server=createServer(config()),client=new Client({name:'test',version:'1'});
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
    try {await verify(client);} finally {await client.close();await server.close();}
  });
  it('starts an actual stdio process and keeps diagnostics off stdout',async()=>{
    const transport=new StdioClientTransport({command:process.execPath,args:['dist/cli.js'],env:{...process.env,KAITEN_BASE_URL:api.url,KAITEN_API_TOKEN:token,KAITEN_API_TOKEN_FILE:'',KAITEN_ALLOW_HTTP:'true',KAITEN_ATTACHMENT_ALLOWED_HOSTS:'127.0.0.1',KAITEN_DOWNLOAD_DIR:directory} as Record<string,string>,stderr:'pipe'});
    let errors='';transport.stderr?.on('data',chunk=>{errors+=chunk;});
    const client=new Client({name:'stdio-test',version:'1'});await client.connect(transport);
    let path='';try {path=await verify(client);expect(errors).toBe('');} finally {await client.close();}
    expect(await readFile(path)).toEqual(original);
  });
  it('help and version work with no credentials',()=>{
    expect(execFileSync(process.execPath,['dist/cli.js','--help'],{encoding:'utf8'})).toContain('kaiten-mcp-tools');
    expect(execFileSync(process.execPath,['dist/cli.js','--version'],{encoding:'utf8'})).toBe(metadata.version+'\n');
  });
});
