import { afterAll, beforeAll, expect, it } from 'vitest';
import { HttpClient } from '../src/http.js';
import { loadConfig } from '../src/config.js';
import { listen, json } from './helpers.js';

let api:Awaited<ReturnType<typeof listen>>;const counts:Record<string,number>={};
beforeAll(async()=>{api=await listen((req,res)=>{
  const path=new URL(req.url!,'http://localhost').pathname.split('/').at(-1)!;counts[path]=(counts[path]??0)+1;
  if(path==='retry') {if(counts[path]<3)return json(res,{},429);return json(res,{ok:true});}
  if(path==='transient') {if(counts[path]<2)return json(res,{},503);return json(res,{ok:true});}
  if(path==='cooldown') {res.writeHead(429,{'Retry-After':'60'});return res.end();}
  if(path==='slow') return setTimeout(()=>{if(!res.destroyed)json(res,{});},100);
  if(path==='badjson')return res.end('{broken');
  if(path==='loop'){res.writeHead(302,{Location:api.url+'/api/latest/loop'});return res.end();}
  json(res,{token:'mock-secret'},Number(path));
});});
afterAll(async()=>{await api.close();});
const config=()=>loadConfig({KAITEN_BASE_URL:api.url,KAITEN_API_TOKEN:'mock-secret',KAITEN_ALLOW_HTTP:'true'});
it('retries only bounded transient errors',async()=>{
  const c=new HttpClient(config());expect(await c.json('retry')).toEqual({ok:true});expect(counts.retry).toBe(3);
  expect(await c.json('transient')).toEqual({ok:true});expect(counts.transient).toBe(2);
  await expect(c.json('cooldown')).rejects.toMatchObject({code:'RATE_LIMITED'});expect(counts.cooldown).toBe(1);
});
it.each([[401,'UNAUTHORIZED'],[403,'FORBIDDEN'],[404,'NOT_FOUND'],[405,'UNSUPPORTED_ROUTE'],[410,'UNSUPPORTED_ROUTE'],[501,'UNSUPPORTED_ROUTE'],[422,'FILE_REJECTED']])('distinguishes HTTP %s without retries',async(status,code)=>{
  await expect(new HttpClient(config()).json(String(status))).rejects.toMatchObject({code,status});expect(counts[status]).toBe(1);
});
it('reports corrupted JSON and bounded timeouts',async()=>{
  await expect(new HttpClient(config()).json('badjson')).rejects.toMatchObject({code:'API_RESPONSE_INVALID'});
  await expect(new HttpClient({...config(),timeoutMs:10}).json('slow')).rejects.toMatchObject({code:'TIMEOUT'});expect(counts.slow).toBe(3);
});
it('blocks private/untrusted and credential destinations, malformed protocols and redirects',async()=>{
  const c=new HttpClient(config());
  await expect(c.file('http://localhost:1/file')).rejects.toMatchObject({code:'URL_BLOCKED'});
  await expect(c.file('https://files.example/file',true)).rejects.toMatchObject({code:'URL_BLOCKED'});
  await expect(c.file('file:///secret')).rejects.toMatchObject({code:'URL_BLOCKED'});
  await expect(c.file('https://user:password@files.example/x')).rejects.toMatchObject({code:'URL_BLOCKED'});
  await expect(c.file(api.url+'/api/latest/loop',true)).rejects.toMatchObject({code:'FILE_REDIRECT_INVALID'});
});
