import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute, basename } from 'node:path';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'kaiten-tools-package-'));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run using npm run test:package');
const run = (args, cwd) => execFileSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
try {
  const packed = run(['run','--silent','pack:release','--','--pack-destination',temporary], root);
  const manifest = JSON.parse(packed.slice(packed.indexOf('[\n')))[0];
  const archive = resolve(temporary, manifest.filename);
  const tar = gunzipSync(await readFile(archive));
  const members = new Map();
  for (let position=0;position+512<=tar.length;) {
    const header = tar.subarray(position,position+512);
    const name = header.subarray(0,100).toString().replace(/\0.*$/s,'');
    if (!name) break;
    const size = parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,'').trim(),8) || 0;
    members.set(name,tar.subarray(position+512,position+512+size));
    position += 512 + Math.ceil(size/512)*512;
  }
  assert(members.has('package/npm-shrinkwrap.json'));
  assert(members.has('package/dist/cli.js'));
  const pkg = JSON.parse(members.get('package/package.json').toString());
  const lock = JSON.parse(members.get('package/npm-shrinkwrap.json').toString());
  assert.equal(pkg.name,'kaiten-mcp-tools');assert.equal(lock.name,pkg.name);assert.equal(lock.version,pkg.version);
  assert.deepEqual(Object.keys(pkg.dependencies).sort(),['@modelcontextprotocol/sdk','zod']);
  assert(!pkg.devDependencies && !pkg.scripts, 'Release manifest includes development configuration');
  assert(!lock.packages[''].devDependencies, 'Release shrinkwrap includes development dependencies');
  assert(Object.values(lock.packages).every(entry => !entry.dev), 'Release shrinkwrap includes dev entries');
  for (const name of members.keys()) assert(!/extract|read-attachment|node_modules|\.local|(?:^|\/)\.env|\.token/.test(name),`Unexpected archive member: ${name}`);
  for (const [name,bytes] of members) if (/\.(?:js|ts|md|json)$/.test(name)) assert(!bytes.includes(Buffer.from('\r\n')),`CRLF in archive: ${name}`);
  if (process.env.KAITEN_API_TOKEN_FILE) {
    const secret=(await readFile(process.env.KAITEN_API_TOKEN_FILE,'utf8')).replace(/^\uFEFF/,'').trim();
    assert(!tar.includes(Buffer.from(secret)),'Credential found in package');
  }
  const install=join(temporary,'install');await mkdir(install);await writeFile(join(install,'package.json'),'{}\n');
  // npm's registry manifest declares _hasShrinkwrap; a local tarball install
  // omits this marker and can resolve a different transitive dependency tree.
  const archiveBytes = await readFile(archive);
  const registry = createServer((req,res) => {
    assert.equal(req.method,'GET');
    if (req.url === '/archive.tgz') {res.end(archiveBytes);return;}
    if (req.url === '/kaiten-mcp-tools') {
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({name:pkg.name,versions:{[pkg.version]:{...pkg,_hasShrinkwrap:true,dist:{tarball:`http://127.0.0.1:${registry.address().port}/archive.tgz`,integrity:manifest.integrity,shasum:manifest.shasum}}}}));return;
    }
    res.writeHead(302,{location:`https://registry.npmjs.org${req.url}`});res.end();
  });
  await new Promise(resolve => registry.listen(0,'127.0.0.1',resolve));
  try {
    await promisify(execFile)(process.execPath,[npm,'install','--ignore-scripts','--no-audit','--no-fund','--registry',`http://127.0.0.1:${registry.address().port}`,`${pkg.name}@${pkg.version}`],{cwd:install,encoding:'utf8'});
  } finally {await new Promise(resolve => registry.close(resolve));}
  const cli=join(install,'node_modules','kaiten-mcp-tools','dist','cli.js');
  assert.equal(execFileSync(process.execPath,[cli,'--version'],{encoding:'utf8'}),pkg.version+'\n');
  assert(execFileSync(process.execPath,[cli,'--help'],{encoding:'utf8'}).includes('Tools (37)'));
  const installedLock=JSON.parse(await readFile(join(install,'package-lock.json'),'utf8'));
  const development = JSON.parse(await readFile(join(root,'package.json'),'utf8')).devDependencies;
  for (const name of Object.keys(installedLock.packages)) {
    for (const dependency of Object.keys(development)) assert(!name.endsWith(`/node_modules/${dependency}`) && name !== `node_modules/${dependency}`, `Development dependency installed: ${name}`);
  }
  for (const [name,entry] of Object.entries(lock.packages)) {
    if (!name || entry.dev) continue;
    assert.equal((installedLock.packages[`node_modules/${pkg.name}/${name}`] ?? installedLock.packages[name])?.version,entry.version,`Installed version differs for ${name}`);
  }
  const transport=new StdioClientTransport({command:process.execPath,args:[cli],env:{...process.env,KAITEN_BASE_URL:'https://tasks.example',KAITEN_API_TOKEN:'package-test-secret',KAITEN_API_TOKEN_FILE:''},stderr:'pipe'});
  const client=new Client({name:'package-install-test',version:'1'});await client.connect(transport);
  try {assert.equal((await client.listTools()).tools.length,37);assert.equal((await client.listResourceTemplates()).resourceTemplates.length,1);} finally {await client.close();}
  console.log(`Package verified: ${pkg.name}@${pkg.version}; ${members.size} files; pinned installation; CLI; stdio; 37 tools`);
} finally {
  const allowed = relative(resolve(tmpdir()),resolve(temporary));
  if (!allowed || allowed.startsWith('..') || isAbsolute(allowed) || !basename(temporary).startsWith('kaiten-tools-package-')) throw new Error('Unsafe temporary cleanup path');
  await rm(temporary,{recursive:true,force:true});
}
