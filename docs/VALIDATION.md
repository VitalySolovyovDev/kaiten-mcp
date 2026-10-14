# Validation — 0.1.0

Validated on 2026-10-14, Windows, Node.js 22.15.0.

Local `npm run check`: 76 tests passed across four suites.

- Unit/integration checks exercise configuration, corporate domains/path prefixes, URL validation, HTTP authorization, pagination and errors.
- Generated fixtures cover UTF-8 text, Markdown, CSV, JSON, PNG, JPEG, WebP, GIF, TIFF, PDF, DOCX, XLSX and PPTX.
- Document tests check tables, cached formulas, pages/slides, continuation, empty PDF pages, malformed files and encrypted/excessive Office archive detection.
- Protocol checks use both in-memory MCP transport and a real stdio child process, including image content and original binary resources.
- A user-provided live card was read through the stdio server. Its title, all 3,204 description characters and both comments (including authors) matched direct API responses. No attachment was present, so live attachment download/extraction has **not** been verified against that instance; attachment verification uses mock API and generated fixtures.

Client examples are documented configurations. This validation does not claim GUI testing in Codex, Claude Desktop or Cursor.

The installed npm archive was exercised through an actual stdio process: 13 file formats were extracted, 14 original resources matched their source bytes, encrypted PDF rejection worked and storage requests contained no Kaiten credentials.

File parser execution is isolated and bounded. Dependency audits report no high/critical vulnerabilities. Moderate entries remain in the `mammoth` → auxiliary CLI `argparse` → `sprintf-js` chain (GHSA-hp3w-g68c-fv3c) and ExcelJS's UUID dependency (GHSA-w5hq-g745-h8pq). `mammoth/lib` does not import the CLI packages and this server does not invoke that CLI. ExcelJS imports UUID v4; the UUID advisory concerns buffer bounds in v3/v5/v6. Upstream ExcelJS/Mammoth dependency updates are still needed to remove these audit entries. Root-only npm overrides were removed because they do not protect consumers installing the published package. Source and published dependencies use the same locked versions. CI fails on new high/critical production findings.

A successful functional test does not establish that every third-party parser or every existing Kaiten deployment is compatible. PDF password rejection was tested using a generated Standard-encryption dictionary; Office encryption detection was tested on an OLE-container signature and an encrypted ZIP flag. These are parser-path fixtures, not a collection of real encrypted customer documents.
