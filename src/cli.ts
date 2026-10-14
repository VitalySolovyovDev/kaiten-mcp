#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { publicError } from './errors.js';
import { metadata } from './metadata.js';
import { toolSpecs } from './tools.js';

if (process.argv.includes('--help')) {
  process.stdout.write(`${metadata.name}: read-only Kaiten MCP server (stdio)\n\nSet KAITEN_BASE_URL and exactly one of KAITEN_API_TOKEN / KAITEN_API_TOKEN_FILE.\nOptional: NODE_EXTRA_CA_CERTS, KAITEN_ALLOW_HTTP, KAITEN_TIMEOUT_MS,\nKAITEN_MAX_FILE_BYTES, KAITEN_MAX_TEXT_CHARS, KAITEN_ATTACHMENT_ALLOWED_HOSTS,\nKAITEN_CACHE_TTL_MS, KAITEN_DOWNLOAD_DIR.\n\nTools (${toolSpecs.length}): ${toolSpecs.map(t => t.name).join(', ')}.\nOriginals: kaiten://cards/{card_id}/attachments/{attachment_id}.\n`);
} else if (process.argv.includes('--version')) {
  process.stdout.write(`${metadata.version}\n`);
} else {
  try {
    const server = createServer(loadConfig());
    await server.connect(new StdioServerTransport());
    const shutdown = async () => { await server.close(); process.exit(0); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  } catch (error) {
    const safe = publicError(error);
    process.stderr.write(`${safe.code}: ${safe.message}\n`);
    process.exitCode = 1;
  }
}
