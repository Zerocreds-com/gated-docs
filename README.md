# gated-docs

A fully local bridge between your AI agent and your documents — wherever they live. Google Drive, Sheets, Docs, BigQuery, Gmail, Notion, Slack, Telegram, Cloudflare, GitLab.

Tells [Claude Code](https://docs.anthropic.com/en/docs/claude-code) where to find your data and how to access it, without exposing anything to the network. **No hosted service, no open ports, no HTTP server.** Just a local process talking to Claude over stdio, with credentials locked in macOS Keychain.

## Why

Claude Code can't see your private data — Drive files, Notion pages, Slack messages, BigQuery tables. Existing solutions often involve hosted proxies or browser extensions. This is different:

- **Fully local** — stdio transport, no listening ports, no server to expose
- **Credentials in Keychain** — encrypted at rest, locked when your Mac is locked, never in config files or env vars
- **Direct API calls** — your machine talks to Google/Notion/Slack directly, no middleman
- **Read-only by default** — service accounts and tokens use minimal permissions

What it does:

- **Search** across all connected sources with one tool call
- **Read** any document, spreadsheet, page, or chat by ID
- **Query** BigQuery and Cloudflare D1 with SQL
- **Check & send email** via Gmail

## Supported Sources

| Source | Auth method | What you get |
|--------|------------|--------------|
| **Google Drive** | Service Account | Search files, read Docs & Sheets |
| **Google Sheets** | Service Account | All tabs with headers and data |
| **BigQuery** | Service Account | SQL queries, explore datasets/tables/schemas |
| **Gmail** | OAuth2 refresh tokens | Search inbox, read emails, send emails |
| **Notion** | Integration token | Search pages, read page content |
| **Slack** | Bot/User token | Search messages, read channel history |
| **Telegram** | Client API (MTProto) | Search messages, read chats |
| **Cloudflare** | API token | Zones, Workers, Pages, D1, KV, R2 |
| **GitLab** | Personal Access Token | Projects, merge requests, issues, diffs |

## Quick Start

### 1. Install

```bash
git clone https://github.com/Chill-AI-Space/gated-docs.git
cd gated-docs
npm install
```

Requires **Node.js 22+** (uses native TypeScript via `--experimental-strip-types`).

### 2. Register MCP server

```bash
node --experimental-strip-types bin/gated-docs.ts setup
```

This writes the MCP config to `~/.claude.json`. Restart Claude Code to pick it up.

### 3. Connect a source

Pick any source below and run the `auth` command. You can connect as many as you need.

### 4. Scan

```bash
node --experimental-strip-types bin/gated-docs.ts scan
```

Builds `structure.json` — an index of all your documents, tables, and channels. This powers the dynamic tool descriptions so Claude knows what data is available.

The server also auto-scans on startup if the structure is stale.

### 5. Use

Restart Claude Code. The MCP tools are now available — Claude will call them automatically when you ask about your data.

## Connecting Sources

### Google Drive / Sheets / Docs

**What you need:** A Google Cloud service account key (JSON file).

<details>
<summary>Step-by-step setup</summary>

1. Create a [Google Cloud project](https://console.cloud.google.com/projectcreate) (free)
2. Enable APIs: Drive, Sheets, Docs — via [API Library](https://console.cloud.google.com/apis/library)
3. Create a [Service Account](https://console.cloud.google.com/iam-admin/serviceaccounts) → Keys tab → Create new key → JSON
4. Share your Google Drive folders with the service account email (Viewer access)

Detailed walkthrough: **[docs/google-setup.md](docs/google-setup.md)**
</details>

```bash
node --experimental-strip-types bin/gated-docs.ts auth google --service-account ~/Downloads/key.json
```

After auth, you can delete the key file — it's stored in Keychain.

### BigQuery

Uses the same Google service account. Grant it IAM roles:

```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT \
  --member="serviceAccount:SA_EMAIL" \
  --role="roles/bigquery.user"

gcloud projects add-iam-policy-binding YOUR_PROJECT \
  --member="serviceAccount:SA_EMAIL" \
  --role="roles/bigquery.dataViewer"
```

Enable the API: [BigQuery API](https://console.cloud.google.com/apis/api/bigquery.googleapis.com)

### Gmail

Gmail uses **OAuth2 with refresh tokens** — one-time browser consent, then permanent access. No admin needed, works with personal Gmail and Workspace.

Two separate tokens for least privilege: read-only and send.

1. Enable [Gmail API](https://console.cloud.google.com/apis/api/gmail.googleapis.com)
2. Create [OAuth Client ID](https://console.cloud.google.com/apis/credentials) → Desktop app → download JSON
3. Connect read access:

```bash
node --experimental-strip-types bin/gated-docs.ts auth gmail --client-secret-file ~/Downloads/client_secret_*.json
```

4. (Optional) Connect send access — reuses the same client credentials:

```bash
node --experimental-strip-types bin/gated-docs.ts auth gmail --send
```

Each step opens a browser for one-time consent. Refresh tokens stored permanently in Keychain.

### Notion

1. Create an [integration](https://www.notion.so/my-integrations) → copy the token (`ntn_...`)
2. In Notion, share databases/pages with the integration

```bash
node --experimental-strip-types bin/gated-docs.ts auth notion --token ntn_xxxx
```

### Slack

1. Create a [Slack app](https://api.slack.com/apps) → From scratch
2. OAuth & Permissions → add scopes:
   - Bot: `channels:read`, `channels:history`
   - User (for search): `search:read`
3. Install to workspace → copy the token

```bash
node --experimental-strip-types bin/gated-docs.ts auth slack --token xoxb-xxxx
```

### Telegram

1. Get `api_id` and `api_hash` from [my.telegram.org](https://my.telegram.org/) → API development tools
2. Run auth (interactive — you'll receive a code via Telegram):

```bash
node --experimental-strip-types bin/gated-docs.ts auth telegram --api-id 12345 --api-hash abc123
```

### Cloudflare

1. Create an [API token](https://dash.cloudflare.com/profile/api-tokens) with Custom template
2. Permissions (all Read): Zone, DNS, Workers Scripts, Pages, D1, Workers KV Storage, R2

```bash
node --experimental-strip-types bin/gated-docs.ts auth cloudflare --token cf-xxxx
```

### GitLab

Works with **gitlab.com** and **self-hosted** GitLab instances.

1. Go to your GitLab → User Settings → Access Tokens (or `/-/user_settings/personal_access_tokens`)
2. Create a token with scopes: `read_api`, `read_repository`

```bash
# gitlab.com
node --experimental-strip-types bin/gated-docs.ts auth gitlab --token glpat-xxxx

# Self-hosted
node --experimental-strip-types bin/gated-docs.ts auth gitlab --token glpat-xxxx --url https://gitlab.example.com
```

Claude can then search and read your projects, merge requests (with full diffs and comments), and issues.

## MCP Tools

Once connected, Claude Code gets these 8 tools:

| Tool | Description |
|------|-------------|
| `search` | Full-text search across all sources, or filter by source |
| `read_document` | Read a document, spreadsheet, page, channel, or resource by ID |
| `list_sources` | Show connected sources and all indexed documents |
| `bigquery_query` | Run SQL against BigQuery, get tab-separated results |
| `bigquery_explore` | List datasets, tables, schemas, or running jobs |
| `d1_query` | Run SQL against Cloudflare D1 (SQLite syntax) |
| `check_email` | Search Gmail inbox, read full emails, find verification codes |
| `send_email` | Send an email via Gmail (requires `auth gmail --send`) |

Tool descriptions are **dynamically generated** from your scan data — Claude sees exactly what documents, tables, and schemas are available.

### Example Prompts

Once the MCP is connected, just ask Claude in natural language:

```
"Find the Q1 marketing report in Drive and summarize it"
"What tables do we have in BigQuery? Show me the schema for the events table"
"Check my email for the verification code from GitHub"
"Search Slack for messages about the deploy issue yesterday"
"Read the project roadmap from Notion"
"Show me the DNS records for example.com on Cloudflare"
"Read my last merge request on GitLab and prepare responses to the review comments"
"Send an email to john@example.com about the meeting tomorrow"
```

Claude will call the right MCP tools automatically.

## CLI Reference

All commands:

```bash
gated-docs setup                                        # Register MCP in ~/.claude.json
gated-docs auth google --service-account <key.json>     # Connect Google Drive/Sheets/Docs
gated-docs auth notion --token <ntn_xxx>                # Connect Notion
gated-docs auth slack --token <xoxb-xxx>                # Connect Slack
gated-docs auth telegram --api-id <N> --api-hash <hash> # Connect Telegram
gated-docs auth cloudflare --token <cf-token>           # Connect Cloudflare
gated-docs auth gitlab --token <pat> [--url <url>]      # Connect GitLab (self-hosted or gitlab.com)
gated-docs auth gmail --client-secret-file <json>       # Connect Gmail read (OAuth2)
gated-docs auth gmail --send                            # Connect Gmail send (reuses client creds)
gated-docs scan                                         # Rebuild document index
gated-docs status                                       # Show connections & stats
gated-docs search "query"                               # Test search from terminal
gated-docs check-email [query]                          # Test email from terminal
gated-docs deauth <source>                              # Remove credentials
```

Run via:
```bash
node --experimental-strip-types bin/gated-docs.ts <command>
```

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  Your machine (everything runs here)                    │
│                                                         │
│  Claude Code ──stdio──> gated-docs (local process)      │
│                              │                          │
│                       structure.json  (doc index)       │
│                       macOS Keychain  (credentials)     │
│                              │                          │
└──────────────────────────────┼──────────────────────────┘
                               │ HTTPS (outbound only)
                               ▼
           Google · Notion · Slack · Telegram · Cloudflare · GitLab
```

1. **Auth** stores credentials in macOS Keychain (base64-encoded for JSON values)
2. **Scan** calls each connector to index documents → saves `structure.json`
3. **MCP server** loads the structure at startup, generates dynamic tool descriptions
4. **Search** uses native APIs per source (Drive fulltext, Notion search, Slack search, Telegram global search)
5. **Read** fetches full content via the appropriate API
6. Connectors are lazy-imported on first call — fast startup even with many sources

No inbound connections. The only network traffic is outbound HTTPS to the services you've connected.

## Config & Storage

| Path | Purpose |
|------|---------|
| `~/.config/gated-docs/config.json` | Enabled sources and settings |
| `~/.config/gated-docs/structure.json` | Scan output (document index, schemas) |
| macOS Keychain (`gated-docs-*`) | All credentials |
| `~/.claude.json` | MCP server registration |

## Security Model

The entire security story is: **local process + OS-level credential storage**.

- **stdio transport** — the server is a child process of Claude Code, communicating over stdin/stdout. There is no HTTP server, no open port, nothing reachable from the network
- **macOS Keychain** — all credentials (service account keys, OAuth tokens, API tokens) are stored encrypted in Keychain. They're locked when your Mac is locked and never written to config files, env vars, or disk
- **Minimal permissions** — service accounts use read-only access, Gmail uses separate tokens for read vs. send (least privilege)
- **No intermediaries** — API calls go directly from your machine to Google/Notion/Slack/etc. No proxy, no hosted backend, no telemetry
- **No vector DB, no embeddings** — search uses native APIs per service (Drive fulltext, Notion search, Slack search). Nothing is indexed locally beyond a lightweight `structure.json` with document names and schemas

## Requirements

- **macOS** (uses Keychain for credential storage)
- **Node.js 22+** (native TypeScript support)
- **Claude Code** (MCP client)

## Troubleshooting

**"403 Forbidden"** — API not enabled or SA doesn't have access:
1. Check API is enabled: [APIs & Services](https://console.cloud.google.com/apis/enabled)
2. Check file/folder is shared with the service account email
3. For BigQuery: check IAM roles are granted

**"Key creation is not allowed"** — Org policy blocks SA key creation:
```bash
gcloud resource-manager org-policies delete iam.disableServiceAccountKeyCreation --project=YOUR_PROJECT
```

**"Token expired" for Gmail** — Re-auth with OAuth2:
```bash
node --experimental-strip-types bin/gated-docs.ts auth gmail --client-secret-file ~/Downloads/client_secret_*.json
```

**BigQuery "Access Denied"** — SA needs project-level roles. See [BigQuery setup](#bigquery).

More details: **[docs/google-setup.md](docs/google-setup.md)**

## License

MIT
