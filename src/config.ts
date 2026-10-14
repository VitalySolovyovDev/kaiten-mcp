import { readFileSync } from 'node:fs';
import { KaitenError } from './errors.js';

export interface Config {
  baseUrl: URL;
  token: string;
  timeoutMs: number;
  maxFileBytes: number;
  maxTextChars: number;
  allowHttp: boolean;
  attachmentAllowedHosts: string[];
}

function positive(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new KaitenError('CONFIG_INVALID', `${key} must be a positive integer.`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let baseUrl: URL;
  try { baseUrl = new URL(env.KAITEN_BASE_URL ?? ''); }
  catch { throw new KaitenError('CONFIG_INVALID', 'Set KAITEN_BASE_URL to the full URL of your Kaiten instance.'); }
  const allowHttp = env.KAITEN_ALLOW_HTTP === 'true';
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash ||
      (baseUrl.protocol !== 'https:' && !(allowHttp && baseUrl.protocol === 'http:'))) {
    throw new KaitenError('CONFIG_INVALID', 'KAITEN_BASE_URL must use HTTPS without credentials, query or fragment. HTTP requires KAITEN_ALLOW_HTTP=true.');
  }
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '') + '/';
  if (env.KAITEN_API_TOKEN && env.KAITEN_API_TOKEN_FILE) {
    throw new KaitenError('CONFIG_INVALID', 'Set only one of KAITEN_API_TOKEN and KAITEN_API_TOKEN_FILE.');
  }
  let token = env.KAITEN_API_TOKEN?.trim();
  if (env.KAITEN_API_TOKEN_FILE) {
    try { token = readFileSync(env.KAITEN_API_TOKEN_FILE, 'utf8').replace(/^\uFEFF/, '').trim(); }
    catch { throw new KaitenError('CONFIG_INVALID', 'Cannot read KAITEN_API_TOKEN_FILE. Check its path and permissions.'); }
  }
  if (!token || /[\s\x00-\x1f\x7f]/.test(token)) throw new KaitenError('CONFIG_INVALID', 'Provide a non-empty API token without whitespace.');
  return {
    baseUrl, token, allowHttp,
    timeoutMs: positive(env, 'KAITEN_TIMEOUT_MS', 30_000),
    maxFileBytes: positive(env, 'KAITEN_MAX_FILE_BYTES', 20 * 1024 * 1024),
    maxTextChars: positive(env, 'KAITEN_MAX_TEXT_CHARS', 20_000),
    attachmentAllowedHosts: (env.KAITEN_ATTACHMENT_ALLOWED_HOSTS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  };
}

export function parseCardUrl(input: string, config: Config): number {
  let url: URL;
  try { url = new URL(input); } catch { throw new KaitenError('CARD_URL_INVALID', 'Provide a full Kaiten card URL.'); }
  if (url.origin !== config.baseUrl.origin || url.username || url.password || !url.pathname.startsWith(config.baseUrl.pathname)) {
    throw new KaitenError('CARD_URL_INVALID', 'The card URL must belong to the configured Kaiten instance.');
  }
  const path = url.pathname.slice(config.baseUrl.pathname.length).replace(/\/$/, '');
  const match = /^(?:space\/\d+\/(?:boards\/)?card\/|c\/)?([1-9]\d*)$/.exec(path);
  const id = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(id)) throw new KaitenError('CARD_URL_INVALID', 'Unsupported card link. Use /space/ID/boards/card/ID, /space/ID/card/ID, /c/ID or /ID.');
  return id;
}
