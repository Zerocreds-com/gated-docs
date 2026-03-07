# gated-info

MCP server that gives Claude Code access to your auth-gated sources — Google Drive, Notion, Slack. Data Claude can't reach on its own because it's behind authentication.

Credentials stay in macOS Keychain. No config files with secrets. No network ports. Pure stdio MCP.

## How it works

```
Claude Code ──stdin/stdout──> gated-info MCP ──> Keychain ──> Google/Notion/Slack API
                                    │
                                    └── No port. No HTTP. Not reachable from network.
```

Claude sees a `search` tool with a description of what's available:

```
Tool: search
Description: Search your auth-gated sources.
  Connected sources:
    Google Drive: 47 docs (12 spreadsheets, 35 documents) in folders: Recruiting (20), Marketing (15)
    Notion: 83 pages (12 databases, 71 pages)
  Use when you need data from Google Sheets, Docs, Notion pages, or Slack messages.
```

Claude decides when to call it — no auto-injection, no wasted tokens.

## Quick start

```bash
cd ~/Documents/GitHub/gated-info
npm install

# Register MCP server in Claude Code
node --experimental-strip-types bin/gated-info.ts setup

# Add Google service account (see below for how to get one)
node --experimental-strip-types bin/gated-info.ts auth google --service-account ~/Downloads/your-key.json

# Scan what's available
node --experimental-strip-types bin/gated-info.ts scan

# Restart Claude Code — MCP is now active
```

## Google Service Account setup

### Step 1: Create a service account

1. Go to [Google Cloud Console — Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
2. Select your project (or create one — any project works, it's free)
3. Click **"Create Service Account"**
   - Name: `gated-info` (or anything)
   - Click **Create and Continue**
   - Skip the optional roles — click **Done**

### Step 2: Create a JSON key

1. Click on the service account you just created
2. Go to **"Keys"** tab
3. **"Add Key"** → **"Create new key"** → **JSON**
4. A `.json` file downloads — this is your key

### Step 3: Enable APIs

In [APIs & Services](https://console.cloud.google.com/apis/library):
- Enable **Google Drive API**
- Enable **Google Sheets API**
- Enable **Google Docs API**

### Step 4: Share your data

The service account has an email like `gated-info@your-project.iam.gserviceaccount.com`.

**Share Google Drive folders** with this email (Viewer access):
1. In Google Drive, right-click a folder → **Share**
2. Paste the service account email
3. Set permission to **Viewer**
4. All files inside the folder are now accessible

**Tip:** Share one top-level folder (e.g., "Work Documents") and everything inside it becomes accessible.

### Step 5: Connect

```bash
node --experimental-strip-types bin/gated-info.ts auth google --service-account ~/Downloads/your-project-abc123.json
node --experimental-strip-types bin/gated-info.ts scan
```

The JSON key file is encoded and stored in macOS Keychain. You can delete the downloaded file after this step.

## Notion setup

1. Go to [Notion Integrations](https://www.notion.so/my-integrations)
2. **"New integration"** → name it `gated-info`
3. Copy the **Internal Integration Token** (starts with `ntn_`)
4. In Notion, open each database/page you want accessible → **Share** → **Invite** → select your integration

```bash
node --experimental-strip-types bin/gated-info.ts auth notion --token ntn_xxxxxxxxxxxx
node --experimental-strip-types bin/gated-info.ts scan
```

## Slack setup

1. Go to [Slack API Apps](https://api.slack.com/apps) → **"Create New App"** → **"From scratch"**
2. **OAuth & Permissions** → add Bot Token Scopes:
   - `channels:read` — list channels
   - `channels:history` — read messages
   - For search: add User Token Scope `search:read`
3. **Install to Workspace** → copy the Bot/User token

```bash
node --experimental-strip-types bin/gated-info.ts auth slack --token xoxb-xxxxxxxxxxxx
node --experimental-strip-types bin/gated-info.ts scan
```

## CLI commands

```bash
gated-info auth google --service-account <key.json>   # Connect Google
gated-info auth notion --token <ntn_xxx>               # Connect Notion
gated-info auth slack  --token <xoxb-xxx>              # Connect Slack
gated-info scan                                        # Scan all sources
gated-info search <query>                              # Test search from CLI
gated-info status                                      # Show connection status
gated-info setup                                       # Register MCP in ~/.claude.json
gated-info deauth <source>                             # Disconnect a source
```

## MCP tools

When Claude Code starts, the MCP server provides 3 tools:

| Tool | Description |
|------|-------------|
| `search` | Full-text search across all connected sources. Uses Google Drive API search, Notion API search, Slack search. |
| `read_document` | Read full content of a specific document by ID. Spreadsheets return all sheets as tab-separated text. |
| `list_sources` | Show all connected sources and their documents. Useful for discovering what's available. |

Tool descriptions are **dynamically generated** from the last scan — Claude knows exactly what's available.

## Security

- **Credentials**: Stored in macOS Keychain (encrypted, locked when Mac is locked). Not in config files. Not in environment variables.
- **Transport**: stdio pipe between Claude Code and MCP process. No network port, no HTTP listener, nothing reachable from the internet.
- **Access**: Read-only scopes only. The service account/tokens cannot modify your data.
- **Isolation**: Each MCP server is a separate process. No shared state with other MCP servers.

## Architecture

```
~/.config/gated-info/
├── config.json          # Which sources are enabled (no secrets)
└── structure.json       # Last scan output (doc names, IDs, types)

macOS Keychain:
├── gated-info-google    # Service account JSON (base64)
├── gated-info-notion    # API token
└── gated-info-slack     # Bot token

MCP Server (stdio):
├── search               # Dynamic description from structure.json
├── read_document        # Read specific doc by ID
└── list_sources         # List all available docs
```

## Keeping structure fresh

Run `gated-info scan` periodically to update the document list. The MCP tool description updates on next Claude Code restart.

```bash
# Manual
gated-info scan

# Cron (every 6 hours)
crontab -e
0 */6 * * * cd ~/Documents/GitHub/gated-info && node --experimental-strip-types bin/gated-info.ts scan 2>/dev/null
```
