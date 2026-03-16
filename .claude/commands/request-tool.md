## /request-tool — Create a new MCP tool for gated-knowledge

You are creating a new MCP tool for the gated-knowledge server. This is a quick operation (~2 minutes).

**User's request:** $ARGUMENTS

### Steps

1. **Understand** what the user needs — what data source, what operation, what parameters
2. **Check existing tools** in `src/mcp/server.ts` — maybe an existing tool can be extended instead of creating a new one
3. **If a new connector function is needed**, add it to the appropriate file in `src/connectors/` following existing patterns:
   - Lazy-import credentials from `../keychain.ts`
   - Return structured data, throw on errors
   - Export async functions
4. **Register the tool** in `src/mcp/server.ts`:
   - Use `server.tool(name, description, schema, handler)` pattern
   - Use `z` (zod) for parameter schemas
   - Lazy-import connector functions inside the handler
   - Return `{ content: [{ type: 'text' as const, text }] }`
   - Wrap handler body in try/catch
5. **Test** that the server compiles: `node --experimental-strip-types -e "import('./src/mcp/server.ts'); setTimeout(() => process.exit(0), 2000)"`
6. **Update CLAUDE.md** if the tool adds a new capability worth documenting

### Architecture reference

```
src/mcp/server.ts     — All MCP tool registrations (server.tool calls)
src/connectors/*.ts   — Data source logic (one file per source)
src/keychain.ts       — getCredential/hasCredential for auth tokens
src/types.ts          — SourceType, Config, StructureDoc types
src/config.ts         — loadConfig() for ~/.config/gated-docs/config.json
```

### Example: adding a simple tool

```typescript
// In server.ts, before the "// ── Helpers" section:
server.tool(
  'my_tool',
  'Description of what this tool does',
  {
    param1: z.string().describe('What this param is'),
    param2: z.number().optional().describe('Optional param'),
  },
  async ({ param1, param2 }) => {
    try {
      const { myFunction } = await import('../connectors/source.ts');
      const result = await myFunction(param1, param2);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }] };
    }
  },
);
```

### Rules
- Keep tool names short and descriptive (snake_case)
- Keep descriptions concise but informative — Claude uses them to decide when to call the tool
- Always lazy-import connectors (don't add top-level imports for optional dependencies)
- Don't break existing tools — add, don't modify
- Test compilation before declaring done
