import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(root, 'dist');
if (dirname(dist) !== resolve(root) || basename(dist) !== 'dist') throw new Error('Unsafe build directory');
rmSync(dist, { recursive: true, force: true });
const result = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
