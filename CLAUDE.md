# gated-knowledge (formerly gated-docs)

Local MCP server for auth-gated sources + Claude Code session archive. Credentials in OS secure storage, stdio transport (no network exposure).

## Stack

- Node.js 22+ (`--experimental-strip-types` for native TS)
- `@modelcontextprotocol/sdk` — MCP protocol
- `googleapis` — Google Drive, Sheets, Docs, BigQuery, Gmail
- `telegram` (gramjs) — Telegram Client API (MTProto)
- `@notionhq/client` — Notion API
- `@slack/web-api` — Slack API
- Cloudflare API v4 — raw fetch, no SDK dependency
- GitLab REST API v4 — raw fetch, no SDK dependency (supports self-hosted instances)
- Cross-platform credential storage (macOS Keychain / Windows DPAPI / Linux libsecret)

## Structure

```
bin/
  gated-knowledge.ts — CLI (auth, scan, search, status, setup, deauth)
  mcp-server.ts      — MCP server entry point (stdio)
src/
  types.ts           — Shared types (SourceType, Config, Structure, etc.)
  config.ts          — ~/.config/gated-knowledge/ config + structure.json
  keychain.ts        — Cross-platform credential storage (Keychain / DPAPI / libsecret)
  scanner.ts         — Scans all enabled sources → structure.json
  description.ts     — Dynamic MCP tool descriptions from scan data
  connectors/
    google.ts        — Drive/Sheets/Docs/Media (scan, search, read, transcribe, delete)
    bigquery.ts      — BigQuery (query, datasets, tables, schema, jobs)
    notion.ts        — Notion (scan, search, read page blocks)
    slack.ts         — Slack (scan channels, search messages, read history)
    telegram.ts      — Telegram (scan dialogs, search messages, read chat)
    cloudflare.ts    — Cloudflare (zones, DNS, Workers, Pages, D1, KV, R2)
    gitlab.ts        — GitLab (projects, MRs, issues, commits, files, pipelines — self-hosted or gitlab.com)
    gmail.ts         — Gmail (list/read/send emails via OAuth2 refresh tokens)
    sessions.ts      — Claude Code sessions (read MD diffs from session-snapshot archive)
  mcp/
    server.ts        — MCP tools: search, read_document, delete_document, list_sources, bigquery_query, bigquery_explore, d1_query, check_email, send_email, session_list, session_search
  transcribe.ts      — Audio/video transcription via Deepgram API (nova-2)
docs/
  google-setup.html  — Setup guide (GitHub Pages: kobzevvv.github.io/gated-docs)
  google-setup.md    — Same guide in markdown
```

## Config paths

- Config: `~/.config/gated-knowledge/config.json`
- Structure: `~/.config/gated-knowledge/structure.json`
- Credentials: OS secure storage (macOS Keychain / Windows `%APPDATA%\gated-knowledge\` DPAPI / Linux libsecret)

## Key concepts

- Credentials stored in OS secure storage, never in config files or env vars
- `structure.json` = scan output → drives dynamic MCP tool descriptions
- MCP server loads structure at startup, lazy-imports connectors on first call
- Search uses native APIs (Drive fulltext, Notion search, Slack search, Telegram global search)
- Cloudflare search is local (filter structure.json) — CF has no global search API
- No vector DB, no embeddings — each service has its own search
- BigQuery uses SA + Domain-Wide Delegation (impersonates google_impersonate email) for permanent access
- Gmail uses two OAuth2 tokens for least privilege: gmail/oauth (readonly) + gmail/oauth-send (send) — both permanent, stored as base64 in credential store
- Cloudflare uses API Token with read-only permissions (raw fetch, no SDK)
- GitLab uses Personal Access Token (read_api, read_repository scopes), raw fetch against REST API v4
- GitLab supports self-hosted instances via `gitlab_url` config field (defaults to https://gitlab.com)
- GitLab resource IDs use prefixed format with optional query params: `project:123`, `commits:123?path=src&ref=dev`
- Deepgram API key (optional) enables transcription of video/audio files from Google Drive — stored in credential store as `gated-knowledge-deepgram/default`
- Media files (video/audio) are scanned from Google Drive alongside docs/sheets; `read_document` downloads and transcribes them via Deepgram
- `delete_document` moves Google Drive files to trash (reversible)
- Sessions source reads MD diffs from `~/.config/session-snapshot/archive/` — auto-detected, no auth needed
- Sessions are always available in search/read even without explicit `init sessions` — just needs session-snapshot installed
- Session sharing: MD files → Google Drive shared folder (or Supabase for real-time). Each user writes their own folder, others read only
- User config (`init sessions`): sets display name, user ID slug, sharing driver and project filter

## Commands

```bash
gated-knowledge setup                                          # register MCP in ~/.claude.json
gated-knowledge auth google                                    # connect Google Drive (OAuth2 browser flow, default)
gated-knowledge auth google --force                            # add another Google account
gated-knowledge auth google --service-account <key.json>       # connect Google Drive (SA, for teams)
gated-knowledge auth notion --token <ntn_xxx>                  # connect Notion
gated-knowledge auth slack --token <xoxb-xxx>                  # connect Slack
gated-knowledge auth telegram --api-id <N> --api-hash <hash>   # connect Telegram
gated-knowledge auth cloudflare --token <cf-token>             # connect Cloudflare
gated-knowledge auth gitlab --token <glpat-xxx> [--url <url>]  # connect GitLab
gated-knowledge auth gmail --client-secret-file <json>         # Gmail read (OAuth2)
gated-knowledge auth gmail --send                              # Gmail send (reuses creds)
gated-knowledge auth deepgram --token <api-key>                # video/audio transcription
gated-knowledge auth langsmith --token <ls-key>                # LangSmith observability
gated-knowledge impersonate <email>                            # DWD impersonation
gated-knowledge init sessions                                  # set up session archiving
gated-knowledge scan                                           # rebuild structure.json
gated-knowledge status                                         # show connections
gated-knowledge search "query"                                 # test search from CLI
gated-knowledge deauth <source>                                # remove credentials
```

## MCP tools (16)

| Tool | Purpose |
|------|---------|
| `search` | Full-text search across all sources (query, optional source filter) |
| `read_document` | Read document/page/channel/CF resource by ID and source. For sessions: supports `extract` param ("edits", "errors", "user_messages") to get specific content without full session. For video/audio: downloads and transcribes via Deepgram |
| `delete_document` | Move a Google Drive file to trash (reversible) |
| `list_sources` | List connected sources with document counts |
| `bigquery_query` | Run SQL query against BigQuery, return tab-separated results |
| `bigquery_explore` | List BQ datasets, tables, schema, or jobs |
| `d1_query` | Run SQL query against Cloudflare D1 (SQLite syntax) |
| `check_email` | Check Gmail inbox — list/read emails, verification codes (gmail.readonly token) |
| `send_email` | Send email via Gmail — to, subject, body, optional cc/bcc (gmail.send token) |
| `write_document` | Overwrite content in a Google Doc (doc must be shared with SA) |
| `session_list` | List Claude Code sessions from local archive (project filter, date) |
| `session_search` | Search across session content (full-text in MD diffs). Supports `since`/`until` date filters and `project` filter |
| `session_stats` | Aggregated session statistics: tool usage counts, files touched, turn counts, error counts. Filter by id/project/date |
| `session_summary` | Structured session summaries: goal, files changed, key actions, outcome. Pattern extraction, no LLM |
| `auth_status` | Check credential health for all sources. `live_check=true` makes actual API calls to validate tokens |
| `auth_fix` | Step-by-step fix instructions for a specific source: what token, where to get it, scopes, CLI command |

## Credential self-service

When auth fails, Claude can diagnose and fix it:
1. Call `auth_status(live_check=true)` to identify which credentials are broken
2. Call `auth_fix(source="...")` to get step-by-step repair instructions
3. Run the suggested CLI command to re-authenticate

## Adding new tools

Need a tool that doesn't exist? Use `/request-tool <description>`. Creating a standard MCP tool takes ~2 minutes. The skill guides through connector + server registration following existing patterns.

## Cloudflare resource IDs

Cloudflare resources use prefixed IDs: `zone:abc123`, `worker:my-worker`, `pages:my-site`, `d1:uuid`, `kv:ns-id`, `r2:bucket-name`. The prefix tells `read_document` which API to call.

## GitLab resource IDs

GitLab resources use prefixed IDs for `read_document(source="gitlab")`.
Query params in the ID (`?key=val`) and/or the `range` param can filter results.

| ID format | What it reads | Query params / `range` |
|-----------|--------------|------------------------|
| `project:123` | Project overview, README, branches, sub-resource hints | — |
| `mr:123:5` | MR with diff + all discussion threads (inline + general) | — |
| `issue:123:10` | Issue with comments | — |
| `commits:123` | Recent commits (40) on default branch | `?path=dir&ref=branch&since=date&author=name` or `range` as path |
| `commit:123:abc1234` | Single commit: message + diff + discussions | — |
| `tree:123` | Repository file tree (root) | `?path=subdir&ref=branch` or `range` as path |
| `file:123:src/main.py` | File content + blame summary | `?ref=branch` |
| `pipelines:123` | Recent pipelines (20) | `?ref=branch&status=failed` or `range` as ref |
| `pipeline:123:456` | Pipeline jobs by stage + failed job logs (last 50 lines) | — |

## Session resource IDs

Sessions use directory name as ID for `read_document(source="sessions")`.
The `range` param controls which chunks to load.

| ID format | Example | What it reads |
|-----------|---------|--------------|
| `{project}-{shortId}` | `manager-9d2760a6` | All chunks concatenated |
| + `range="0"` | | First chunk only |
| + `range="0-2"` | | Chunks 000–002 |
| + `range="last"` | | Latest chunk only |

Session archive formats (connector auto-detects both):
```
~/.config/session-snapshot/archive/
  # New: single file per session (append-based, no frontmatter after first write)
  8a0f4c79-7849-48c0-9437-c98ba6a5ca00.md
  b5eebb6c-c247-42e4-8790-8dc8cf68c929.md

  # Legacy: chunked dirs (frontmatter per chunk)
  manager-9d2760a6/
    000.md    001.md    002.md
```

Deduplication: if both formats exist for same session UUID, single-file wins.
Content: `### User [L:N]`, `### Assistant [L:N]`, `### Bash — desc`, `### Read`, `### Edit` etc.
`[L:N]` = line number in original JSONL for traceability.

## Google OAuth2 "unverified app" warning

When users run `auth google`, Google shows a red "Google hasn't verified this app" screen. **This is normal** for local CLI tools with a built-in OAuth client. Claude should tell the user:
- Click **"Advanced" → "Go to gated-knowledge (unsafe)"** to proceed
- This is safe: credentials stay on the user's machine, nothing goes through any intermediary
- Only outbound HTTPS calls to Google APIs

## Current auth

- Google Drive/Sheets/Docs: OAuth2 (multi-account, permanent refresh tokens)
- BigQuery: SA + DWD impersonating vladimir@skillset.ae
- Gmail read: OAuth2 refresh token (permanent)
- Gmail send: OAuth2 refresh token (permanent)
- Cloudflare: API token
