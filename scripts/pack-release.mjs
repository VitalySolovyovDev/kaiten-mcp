import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run using npm run pack:release');
const args = process.argv.slice(2);
let destination = root;
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--pack-destination' && args[i + 1]) destination = resolve(args[++i]);
  else throw new Error(`Unsupported packaging argument: ${args[i]}`);
}
execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
const staging = await mkdtemp(join(tmpdir(), 'kaiten-tools-release-'));
try {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'npm-shrinkwrap.json'), 'utf8'));
  for (const file of pkg.files) {
    const path = relative(root, resolve(root, file));
    if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error('Unsafe package file path');
    await cp(join(root, file), join(staging, file), { recursive: true });
  }
  // A dependency's shrinkwrap can install its dev tree as nested dependencies.
  // Keep the development lock unchanged and publish only the production tree.
  delete pkg.devDependencies;
  delete pkg.scripts;
  delete lock.packages[''].devDependencies;
  lock.packages = Object.fromEntries(Object.entries(lock.packages).filter(([, entry]) => !entry.dev));
  await writeFile(join(staging, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  await writeFile(join(staging, 'npm-shrinkwrap.json'), JSON.stringify(lock, null, 2) + '\n');
  await mkdir(destination, { recursive: true });
  const result = execFileSync(process.execPath, [npm, 'pack', '--silent', '--json', '--pack-destination', destination, ...(dryRun ? ['--dry-run'] : [])], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(result);
} finally {
  const path = relative(resolve(tmpdir()), resolve(staging));
  if (!path || path.startsWith('..') || isAbsolute(path) || !basename(staging).startsWith('kaiten-tools-release-')) throw new Error('Unsafe staging cleanup path');
  await rm(staging, { recursive: true, force: true });
}
