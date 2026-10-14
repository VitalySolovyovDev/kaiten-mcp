import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseCardUrl } from '../src/config.js';
import { publicError } from '../src/errors.js';
import { isPrivateAddress } from '../src/http.js';

const env = { KAITEN_BASE_URL: 'https://tasks.corporate.example', KAITEN_API_TOKEN: 'mock-secret' };
describe('configuration and URLs', () => {
  it.each(['/space/1/boards/card/123', '/space/1/card/123', '/c/123', '/123', '/123/?tab=comments#part'])('accepts %s', path => {
    expect(parseCardUrl(env.KAITEN_BASE_URL + path, loadConfig(env))).toBe(123);
  });
  it.each(['https://evil.example/123', 'https://tasks.corporate.example.evil/123', 'http://tasks.corporate.example/123', 'https://name:secret@tasks.corporate.example/123', 'https://tasks.corporate.example/0', 'https://tasks.corporate.example/abc', 'https://tasks.corporate.example/9007199254740992'])('rejects unsafe URL %s', url => {
    expect(() => parseCardUrl(url, loadConfig(env))).toThrow();
  });
  it('supports an installation path prefix', () => {
    const config = loadConfig({ ...env, KAITEN_BASE_URL: env.KAITEN_BASE_URL + '/kaiten' });
    expect(parseCardUrl(env.KAITEN_BASE_URL + '/kaiten/123', config)).toBe(123);
    expect(() => parseCardUrl(env.KAITEN_BASE_URL + '/123', config)).toThrow();
  });
  it('configures a single download directory and supports disabling cache', () => {
    expect(loadConfig({ ...env, KAITEN_CACHE_TTL_MS: '0', KAITEN_DOWNLOAD_DIR: 'C:/Work/downloads' }).cacheTtlMs).toBe(0);
    expect(loadConfig(env).cacheTtlMs).toBe(60000);
    expect(loadConfig(env).downloadDir).toContain('kaiten-mcp-tools');
  });
  it.each([{ KAITEN_CACHE_TTL_MS: '-1' }, { KAITEN_CACHE_TTL_MS: 'NaN' }, { KAITEN_CACHE_TTL_MS: '1.5' }, { KAITEN_DOWNLOAD_DIR: '' }, { KAITEN_MAX_TEXT_CHARS: '1' }])('rejects invalid optional limits/directories', extra => {
    expect(() => loadConfig({ ...env, ...extra })).toThrow();
  });
  it.each([{}, { ...env, KAITEN_API_TOKEN: '' }, { ...env, KAITEN_API_TOKEN: 'a\nb' }, { ...env, KAITEN_TIMEOUT_MS: '-1' }, { ...env, KAITEN_BASE_URL: 'https://x.example?q=1' }, { ...env, KAITEN_API_TOKEN_FILE: 'file' }, { ...env, KAITEN_BASE_URL: 'http://x.example' }])('rejects invalid configuration', value => {
    expect(() => loadConfig(value)).toThrow();
  });
  it('reads a token file with a BOM and newline without exposing its path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kaiten-test-'));
    try {
      const file = join(dir, 'secret.token'); writeFileSync(file, '\ufeffmock-secret\n');
      expect(loadConfig({ KAITEN_BASE_URL: env.KAITEN_BASE_URL, KAITEN_API_TOKEN_FILE: file }).token).toBe('mock-secret');
      expect(JSON.stringify(publicError(new Error('mock-secret')))).not.toContain('mock-secret');
    } finally { rmSync(dir, { recursive: true }); }
  });
  it.each(['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','172.16.0.1','::1','fd00::1','::ffff:127.0.0.1','::ffff:7f00:1'])('blocks private IP %s', ip => expect(isPrivateAddress(ip)).toBe(true));
  it.each(['8.8.8.8','172.32.0.1','2606:4700:4700::1111'])('accepts public IP %s', ip => expect(isPrivateAddress(ip)).toBe(false));
});
