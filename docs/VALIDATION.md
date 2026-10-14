# Validation — 0.1.0

Validated on 2026-10-14, Windows, Node.js 22.15.0.

Local `npm run check`: 76 tests passed across four suites.

- Unit/integration checks exercise configuration, corporate domains/path prefixes, URL validation, HTTP authorization, pagination and errors.
- Generated fixtures cover UTF-8 text, Markdown, CSV, JSON, PNG, JPEG, WebP, GIF, TIFF, PDF, DOCX, XLSX and PPTX.
- Document tests check tables, cached formulas, pages/slides, continuation, empty PDF pages, malformed files and encrypted/excessive Office archive detection.
- Protocol checks use both in-memory MCP transport and a real stdio child process, including image content and original binary resources.
- A user-provided live card was read through the stdio server. Its title, all 3,204 description characters and both comments (including authors) matched direct API responses. No attachment was present, so live attachment download/extraction has **not** been verified against that instance; attachment verification uses mock API and generated fixtures.

Client examples are documented configurations. This validation does not claim GUI testing in Codex, Claude Desktop or Cursor.

File parser execution is isolated and bounded. The production and full dependency audits report no high/critical vulnerabilities. Three moderate entries remain in the `mammoth` → auxiliary CLI `argparse` → `sprintf-js` chain (GHSA-hp3w-g68c-fv3c); `mammoth/lib` does not import these CLI packages and this server does not invoke that CLI. The underlying `sprintf-js` release has no published patched version as of validation. CI fails on new high/critical production findings. ExcelJS's UUID dependency is overridden to the compatible v11 API to avoid its older advisory; formula fixtures exercise the overridden package.

A successful functional test does not establish that every third-party parser or every existing Kaiten deployment is compatible. PDF password rejection was tested using a generated Standard-encryption dictionary; Office encryption detection was tested on an OLE-container signature and an encrypted ZIP flag. These are parser-path fixtures, not a collection of real encrypted customer documents.
