# gated-info

MCP server for accessing auth-gated sources (Google Drive, Notion, Slack) from Claude Code.

## Stack

- Node.js 22+ (--experimental-strip-types for TypeScript)
- MCP SDK (@modelcontextprotocol/sdk)
- googleapis (Google Drive/Sheets/Docs)
- macOS Keychain for credential storage

## Structure

```
bin/
  gated-info.ts    — CLI entry point
  mcp-server.ts    — MCP server entry point
src/
  types.ts         — Shared types
  config.ts        — Config + structure file management
  keychain.ts      — macOS Keychain / Linux secret-tool
  scanner.ts       — Scans all sources, builds structure.json
  description.ts   — Generates dynamic MCP tool descriptions
  connectors/
    google.ts      — Google Drive/Sheets/Docs connector
    notion.ts      — Notion connector
    slack.ts       — Slack connector
  mcp/
    server.ts      — MCP stdio server (search, read_document, list_sources)
```

## Key concepts

- Credentials in Keychain, never in config files
- structure.json = scan output, used to generate dynamic MCP tool descriptions
- MCP server reads structure.json at startup for tool descriptions
- Search uses native APIs (Google Drive fulltext, Notion search, Slack search)
- No vector DB, no embeddings — services have their own search

## Commands

```bash
node --experimental-strip-types bin/gated-info.ts setup    # register MCP
node --experimental-strip-types bin/gated-info.ts auth google --service-account <key.json>
node --experimental-strip-types bin/gated-info.ts scan     # update structure
node --experimental-strip-types bin/gated-info.ts status   # show status
node --experimental-strip-types bin/gated-info.ts search "query"  # test search
```
