# gated-info

MCP server for accessing auth-gated sources from Claude Code. Credentials in macOS Keychain, stdio transport (no network exposure).

## Stack

- Node.js 22+ (`--experimental-strip-types` for native TS)
- `@modelcontextprotocol/sdk` — MCP protocol
- `googleapis` — Google Drive, Sheets, Docs, BigQuery
- `telegram` (gramjs) — Telegram Client API (MTProto)
- `@notionhq/client` — Notion API
- `@slack/web-api` — Slack API
- macOS Keychain (`security` CLI) for credential storage

## Structure

```
bin/
  gated-info.ts      — CLI (auth, scan, search, status, setup, deauth)
  mcp-server.ts      — MCP server entry point (stdio)
src/
  types.ts           — Shared types (SourceType, Config, Structure, etc.)
  config.ts          — ~/.config/gated-info/ config + structure.json
  keychain.ts        — macOS Keychain read/write (base64 for JSON creds)
  scanner.ts         — Scans all enabled sources → structure.json
  description.ts     — Dynamic MCP tool descriptions from scan data
  connectors/
    google.ts        — Drive/Sheets/Docs (scan, search, read)
    bigquery.ts      — BigQuery (query, datasets, tables, schema, jobs)
    notion.ts        — Notion (scan, search, read page blocks)
    slack.ts         — Slack (scan channels, search messages, read history)
    telegram.ts      — Telegram (scan dialogs, search messages, read chat)
  mcp/
    server.ts        — MCP tools: search, read_document, list_sources, bigquery_query, bigquery_explore
docs/
  google-setup.html  — Setup guide (GitHub Pages: kobzevvv.github.io/gated-info)
  google-setup.md    — Same guide in markdown
```

## Config paths

- Config: `~/.config/gated-info/config.json`
- Structure: `~/.config/gated-info/structure.json`
- Credentials: macOS Keychain (service prefix `gated-info-{source}`)

## Key concepts

- Credentials stored in Keychain, never in config files or env vars
- `structure.json` = scan output → drives dynamic MCP tool descriptions
- MCP server loads structure at startup, lazy-imports connectors on first call
- Search uses native APIs (Drive fulltext, Notion search, Slack search, Telegram global search)
- No vector DB, no embeddings — each service has its own search
- BigQuery uses same Google SA credentials as Drive

## Commands

```bash
node --experimental-strip-types bin/gated-info.ts setup                           # register MCP in ~/.claude.json
node --experimental-strip-types bin/gated-info.ts auth google --service-account <key.json>
node --experimental-strip-types bin/gated-info.ts auth notion --token <ntn_xxx>
node --experimental-strip-types bin/gated-info.ts auth slack --token <xoxb-xxx>
node --experimental-strip-types bin/gated-info.ts auth telegram --api-id <N> --api-hash <hash>
node --experimental-strip-types bin/gated-info.ts scan                             # rebuild structure.json
node --experimental-strip-types bin/gated-info.ts status                           # show connections
node --experimental-strip-types bin/gated-info.ts search "query"                   # test search from CLI
node --experimental-strip-types bin/gated-info.ts deauth <source>                  # remove credentials
```

## MCP tools (5)

| Tool | Purpose |
|------|---------|
| `search` | Full-text search across all sources (query, optional source filter) |
| `read_document` | Read document/page/channel by ID and source |
| `list_sources` | List connected sources with document counts |
| `bigquery_query` | Run SQL query, return tab-separated results |
| `bigquery_explore` | List datasets, tables, schema, or jobs |
