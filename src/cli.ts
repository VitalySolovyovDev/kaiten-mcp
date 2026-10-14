#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { publicError } from './errors.js';

if (process.argv.includes('--help')) {
  process.stdout.write('kaiten-card-mcp: read-only Kaiten MCP server (stdio)\n\nSet KAITEN_BASE_URL and KAITEN_API_TOKEN or KAITEN_API_TOKEN_FILE.\nOptional: NODE_EXTRA_CA_CERTS, KAITEN_ALLOW_HTTP, KAITEN_TIMEOUT_MS,\nKAITEN_MAX_FILE_BYTES, KAITEN_MAX_TEXT_CHARS, KAITEN_ATTACHMENT_ALLOWED_HOSTS.\n\nTools: get_card, get_card_comments, read_attachment.\nOriginals: kaiten://cards/{card_id}/attachments/{attachment_id}.\n');
} else if (process.argv.includes('--version')) {
  process.stdout.write('0.1.0\n');
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
