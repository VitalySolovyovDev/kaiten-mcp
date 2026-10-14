import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const files = execFileSync('git', ['ls-files','-z','--cached','--others','--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const bad = files.filter(file => existsSync(file) && /\.(?:ts|mjs|json|md|yml|yaml)$|(?:^|\/)(?:LICENSE|\.gitignore|\.gitattributes)$/.test(file) && readFileSync(file).includes(Buffer.from('\r\n')));
if (bad.length) { console.error('CRLF:', bad.join(', ')); process.exitCode = 1; }
else console.log('LF: all tracked/source text files');
