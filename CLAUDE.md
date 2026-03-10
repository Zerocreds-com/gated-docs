# gated-info

MCP server for accessing auth-gated sources from Claude Code. Credentials in macOS Keychain, stdio transport (no network exposure).

## Stack

- Node.js 22+ (`--experimental-strip-types` for native TS)
- `@modelcontextprotocol/sdk` — MCP protocol
- `googleapis` — Google Drive, Sheets, Docs, BigQuery, Gmail
- `telegram` (gramjs) — Telegram Client API (MTProto)
- `@notionhq/client` — Notion API
- `@slack/web-api` — Slack API
- Cloudflare API v4 — raw fetch, no SDK dependency
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
    cloudflare.ts    — Cloudflare (zones, DNS, Workers, Pages, D1, KV, R2)
    gmail.ts         — Gmail (list/read/send emails via OAuth2 refresh tokens)
  mcp/
    server.ts        — MCP tools: search, read_document, list_sources, bigquery_query, bigquery_explore, d1_query, check_email, send_email
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
- Cloudflare search is local (filter structure.json) — CF has no global search API
- No vector DB, no embeddings — each service has its own search
- BigQuery uses SA + Domain-Wide Delegation (impersonates google_impersonate email) for permanent access
- Gmail uses two OAuth2 tokens for least privilege: gmail/oauth (readonly) + gmail/oauth-send (send) — both permanent, stored as base64 in Keychain
- Cloudflare uses API Token with read-only permissions (raw fetch, no SDK)

## Commands

```bash
node --experimental-strip-types bin/gated-info.ts setup                           # register MCP in ~/.claude.json
node --experimental-strip-types bin/gated-info.ts auth google --service-account <key.json>
node --experimental-strip-types bin/gated-info.ts auth notion --token <ntn_xxx>
node --experimental-strip-types bin/gated-info.ts auth slack --token <xoxb-xxx>
node --experimental-strip-types bin/gated-info.ts auth telegram --api-id <N> --api-hash <hash>
node --experimental-strip-types bin/gated-info.ts auth cloudflare --token <cf-token>
node --experimental-strip-types bin/gated-info.ts auth gmail --client-secret-file <client_secret.json>  # Gmail read (OAuth2)
node --experimental-strip-types bin/gated-info.ts auth gmail --send                                    # Gmail send (reuses client creds)
node --experimental-strip-types bin/gated-info.ts impersonate <email>                                   # DWD impersonation (BigQuery/Gmail)
node --experimental-strip-types bin/gated-info.ts scan                             # rebuild structure.json
node --experimental-strip-types bin/gated-info.ts status                           # show connections
node --experimental-strip-types bin/gated-info.ts search "query"                   # test search from CLI
node --experimental-strip-types bin/gated-info.ts deauth <source>                  # remove credentials
```

## MCP tools (8)

| Tool | Purpose |
|------|---------|
| `search` | Full-text search across all sources (query, optional source filter) |
| `read_document` | Read document/page/channel/CF resource by ID and source |
| `list_sources` | List connected sources with document counts |
| `bigquery_query` | Run SQL query against BigQuery, return tab-separated results |
| `bigquery_explore` | List BQ datasets, tables, schema, or jobs |
| `d1_query` | Run SQL query against Cloudflare D1 (SQLite syntax) |
| `check_email` | Check Gmail inbox — list/read emails, verification codes (gmail.readonly token) |
| `send_email` | Send email via Gmail — to, subject, body, optional cc/bcc (gmail.send token) |
| `write_document` | Overwrite content in a Google Doc (doc must be shared with SA) |

## Cloudflare resource IDs

Cloudflare resources use prefixed IDs: `zone:abc123`, `worker:my-worker`, `pages:my-site`, `d1:uuid`, `kv:ns-id`, `r2:bucket-name`. The prefix tells `read_document` which API to call.

## Current auth

- Google Drive/Sheets/Docs: SA (gated-info@gated-info-mcp.iam.gserviceaccount.com)
- BigQuery: SA + DWD impersonating vladimir@skillset.ae
- Gmail: OAuth2 refresh token (permanent)
- Cloudflare: API token
