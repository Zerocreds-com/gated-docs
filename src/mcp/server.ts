/**
 * gated-info MCP server — stdio transport.
 * Provides search and read tools for auth-gated sources.
 * Tool descriptions are dynamically generated from structure.json.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, loadStructure, isStructureStale } from '../config.ts';
import { generateDescription, generateReadDescription } from '../description.ts';
import { scan } from '../scanner.ts';
import type { SourceType } from '../types.ts';

const config = loadConfig();
let structure = loadStructure();

// Auto-scan in background if stale — don't block server startup
if (!structure || isStructureStale(config)) {
  process.stderr.write('[gated-info] Structure stale, will scan in background...\n');
  scan().then(s => {
    structure = s;
    process.stderr.write(`[gated-info] Background scan complete: ${s.docs.length} docs\n`);
  }).catch(e => {
    process.stderr.write(`[gated-info] Background scan failed: ${e.message}\n`);
  });
}

// Build dynamic descriptions from current structure
const searchDesc = structure?.mcp_description
  || generateDescription([], {} as any);
const readDesc = structure
  ? generateReadDescription(structure.docs)
  : 'Read a document by ID from connected sources. Run "gated-info scan" first.';

const server = new McpServer({
  name: 'gated-info',
  version: '1.0.0',
});

// ── search ──────────────────────────────────────────────

server.tool(
  'search',
  searchDesc,
  {
    query: z.string().describe('Search query (natural language or keywords)'),
    source: z.enum(['google', 'notion', 'slack', 'telegram', 'cloudflare']).optional()
      .describe('Filter to specific source'),
    limit: z.number().optional()
      .describe('Max results (default: 10)'),
  },
  async ({ query, source, limit }) => {
    const maxResults = limit || 10;
    const results: Array<{ name: string; source: string; type: string; snippet: string; url?: string; id: string }> = [];
    const errors: string[] = [];

    const sources = source ? [source] : getEnabledSources();

    for (const src of sources) {
      try {
        if (src === 'google') {
          const { searchGoogle } = await import('../connectors/google.ts');
          const r = await searchGoogle(query, maxResults);
          results.push(...r);
        } else if (src === 'notion') {
          const { searchNotion } = await import('../connectors/notion.ts');
          const r = await searchNotion(query, maxResults);
          results.push(...r);
        } else if (src === 'slack') {
          const { searchSlack } = await import('../connectors/slack.ts');
          const r = await searchSlack(query, maxResults);
          results.push(...r);
        } else if (src === 'telegram') {
          const { searchTelegram } = await import('../connectors/telegram.ts');
          const r = await searchTelegram(query, maxResults);
          results.push(...r);
        } else if (src === 'cloudflare') {
          const { searchCloudflare } = await import('../connectors/cloudflare.ts');
          const r = await searchCloudflare(query, maxResults);
          results.push(...r);
        }
      } catch (e: any) {
        errors.push(`${src}: ${e.message}`);
      }
    }

    // Supplement with local structure search (matches tab names, headers, doc names)
    const localResults = searchStructure(query, source, maxResults);
    for (const lr of localResults) {
      if (!results.find(r => r.id === lr.id)) {
        results.push(lr);
      }
    }

    if (results.length === 0 && errors.length > 0) {
      return { content: [{ type: 'text' as const, text: `Search failed:\n${errors.join('\n')}` }] };
    }

    if (results.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No results found.' }] };
    }

    const lines = results.slice(0, maxResults).map((r, i) => {
      const parts = [`${i + 1}. **${r.name}** [${r.source}/${r.type}]`];
      if (r.snippet) parts.push(`   ${r.snippet}`);
      if (r.url) parts.push(`   ${r.url}`);
      parts.push(`   ID: ${r.id}`);
      return parts.join('\n');
    });

    let text = `Found ${results.length} result(s):\n\n${lines.join('\n\n')}`;
    if (errors.length) text += `\n\nPartial errors: ${errors.join('; ')}`;

    return { content: [{ type: 'text' as const, text }] };
  },
);

// ── read_document ───────────────────────────────────────

server.tool(
  'read_document',
  readDesc,
  {
    id: z.string().describe('Document/page/channel ID'),
    source: z.enum(['google', 'notion', 'slack', 'telegram', 'cloudflare'])
      .describe('Which source this document belongs to'),
  },
  async ({ id, source }) => {
    try {
      let content: { name: string; content: string; url?: string };

      if (source === 'google') {
        const { readGoogleDoc } = await import('../connectors/google.ts');
        content = await readGoogleDoc(id);
      } else if (source === 'notion') {
        const { readNotionPage } = await import('../connectors/notion.ts');
        content = await readNotionPage(id);
      } else if (source === 'slack') {
        const { readSlackChannel } = await import('../connectors/slack.ts');
        content = await readSlackChannel(id);
      } else if (source === 'telegram') {
        const { readTelegramChat } = await import('../connectors/telegram.ts');
        content = await readTelegramChat(id);
      } else if (source === 'cloudflare') {
        const { readCloudflareResource } = await import('../connectors/cloudflare.ts');
        content = await readCloudflareResource(id);
      } else {
        return { content: [{ type: 'text' as const, text: `Unknown source: ${source}` }] };
      }

      const header = `# ${content.name}${content.url ? ` (${content.url})` : ''}\n\n`;

      // Truncate very large documents
      const maxChars = 50_000;
      const body = content.content.length > maxChars
        ? content.content.slice(0, maxChars) + `\n\n... (truncated, ${content.content.length - maxChars} chars remaining)`
        : content.content;

      return { content: [{ type: 'text' as const, text: header + body }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error reading document: ${e.message}` }] };
    }
  },
);

// ── write_document ──────────────────────────────────────

server.tool(
  'write_document',
  'Write (overwrite) content to a Google Doc. The document must be shared with the service account. Content replaces all existing text.',
  {
    id: z.string().describe('Google Doc ID'),
    content: z.string().describe('Text content to write (replaces existing content)'),
  },
  async ({ id, content }) => {
    try {
      const { writeGoogleDoc } = await import('../connectors/google.ts');
      const result = await writeGoogleDoc(id, content);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error writing document: ${e.message}` }] };
    }
  },
);

// ── list_sources ────────────────────────────────────────

server.tool(
  'list_sources',
  'List all connected sources and their document counts. Use to discover what is available before searching.',
  {},
  async () => {
    if (!structure) {
      return { content: [{ type: 'text' as const, text: 'No scan data. Run: gated-info scan' }] };
    }

    const lines: string[] = [];
    lines.push(`Last scan: ${structure.generated_at}`);
    lines.push(`Total: ${structure.docs.length} documents\n`);

    for (const [source, stat] of Object.entries(structure.stats)) {
      lines.push(`## ${source} (${stat.count})`);
      for (const [type, count] of Object.entries(stat.types)) {
        lines.push(`  ${type}: ${count}`);
      }

      // Show document names for this source
      const sourceDocs = structure.docs.filter(d => d.source === source);
      const grouped = new Map<string, typeof sourceDocs>();
      for (const d of sourceDocs) {
        const key = d.parent || '(root)';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(d);
      }

      for (const [folder, docs] of grouped) {
        if (folder !== '(root)') lines.push(`\n  ### ${folder}`);
        for (const d of docs.slice(0, 20)) {
          lines.push(`    - ${d.name} (${d.type}, ${d.id.slice(0, 12)}...)`);
        }
        if (docs.length > 20) lines.push(`    ... and ${docs.length - 20} more`);
      }
      lines.push('');
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// ── bigquery_query ──────────────────────────────────────

server.tool(
  'bigquery_query',
  'Run a BigQuery SQL query and return results. Use standard SQL syntax. Results are tab-separated.',
  {
    sql: z.string().describe('SQL query to execute (standard SQL)'),
    max_rows: z.number().optional().describe('Max rows to return (default: 100)'),
  },
  async ({ sql, max_rows }) => {
    try {
      const { runQuery } = await import('../connectors/bigquery.ts');
      const result = await runQuery(sql, max_rows || 100);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `BigQuery error: ${e.message}` }] };
    }
  },
);

// ── bigquery_explore ────────────────────────────────────

server.tool(
  'bigquery_explore',
  'Explore BigQuery: list datasets, tables, table schema, or recent jobs. Use to discover what data is available.',
  {
    action: z.enum(['datasets', 'tables', 'schema', 'jobs'])
      .describe('What to explore'),
    target: z.string().optional()
      .describe('Dataset name (for "tables"), full table ID "project.dataset.table" (for "schema"), or job state "RUNNING"/"DONE" (for "jobs")'),
  },
  async ({ action, target }) => {
    try {
      if (action === 'datasets') {
        const { listDatasets } = await import('../connectors/bigquery.ts');
        const result = await listDatasets();
        return { content: [{ type: 'text' as const, text: result }] };
      } else if (action === 'tables') {
        if (!target) return { content: [{ type: 'text' as const, text: 'Specify dataset name in target parameter' }] };
        const { listTables } = await import('../connectors/bigquery.ts');
        const result = await listTables(target);
        return { content: [{ type: 'text' as const, text: result }] };
      } else if (action === 'schema') {
        if (!target) return { content: [{ type: 'text' as const, text: 'Specify table ID as project.dataset.table in target parameter' }] };
        const { getTableSchema } = await import('../connectors/bigquery.ts');
        const result = await getTableSchema(target);
        return { content: [{ type: 'text' as const, text: result }] };
      } else if (action === 'jobs') {
        const { listJobs } = await import('../connectors/bigquery.ts');
        const result = await listJobs(target);
        return { content: [{ type: 'text' as const, text: result }] };
      }
      return { content: [{ type: 'text' as const, text: 'Unknown action' }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `BigQuery error: ${e.message}` }] };
    }
  },
);

// ── d1_query ────────────────────────────────────────────

server.tool(
  'd1_query',
  'Run a SQL query against a Cloudflare D1 database. Use SQLite syntax. Specify database by name or UUID.',
  {
    database: z.string().describe('D1 database name or UUID'),
    sql: z.string().describe('SQL query (SQLite syntax)'),
  },
  async ({ database, sql }) => {
    try {
      const { runD1Query } = await import('../connectors/cloudflare.ts');
      const result = await runD1Query(database, sql);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `D1 error: ${e.message}` }] };
    }
  },
);

// ── check_email ─────────────────────────────────────────

server.tool(
  'check_email',
  'Check Gmail inbox. Use to find verification codes, recent messages, or search emails. Uses Gmail search syntax (from:, subject:, newer_than:, is:unread, has:attachment, etc). Without query returns latest emails. Pass message_id to read the full email body.',
  {
    query: z.string().optional()
      .describe('Gmail search query (e.g. "subject:verification newer_than:1h", "from:noreply@github.com", "is:unread")'),
    message_id: z.string().optional()
      .describe('Message ID to read full body (from a previous list result)'),
    max_results: z.number().optional()
      .describe('Max emails to return (default: 5)'),
  },
  async ({ query, message_id, max_results }) => {
    try {
      if (message_id) {
        const { readEmail } = await import('../connectors/gmail.ts');
        const email = await readEmail(message_id);
        const lines = [
          `**From:** ${email.from}`,
          `**To:** ${email.to}`,
          `**Subject:** ${email.subject}`,
          `**Date:** ${email.date}`,
          '',
          email.body,
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      const { listEmails } = await import('../connectors/gmail.ts');
      const emails = await listEmails(query, max_results || 5);

      if (emails.length === 0) {
        return { content: [{ type: 'text' as const, text: `No emails found${query ? ` for: ${query}` : ''}.` }] };
      }

      const lines = emails.map((e, i) => {
        const parts = [
          `${i + 1}. **${e.subject || '(no subject)'}**`,
          `   From: ${e.from}`,
          `   Date: ${e.date}`,
          `   ${e.snippet}`,
          `   ID: ${e.id}`,
        ];
        return parts.join('\n');
      });

      return { content: [{ type: 'text' as const, text: `Found ${emails.length} email(s):\n\n${lines.join('\n\n')}` }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Gmail error: ${e.message}` }] };
    }
  },
);

// ── send_email ────────────────────────────────────────────

server.tool(
  'send_email',
  'Send an email via Gmail. Requires separate send token (auth gmail --send). Use for sending emails, replies, notifications.',
  {
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Email body (plain text)'),
    cc: z.string().optional().describe('CC recipients (comma-separated)'),
    bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
  },
  async ({ to, subject, body, cc, bcc }) => {
    try {
      const { sendEmail } = await import('../connectors/gmail.ts');
      const result = await sendEmail(to, subject, body, cc, bcc);
      return { content: [{ type: 'text' as const, text: `Email sent successfully.\nTo: ${to}\nSubject: ${subject}\nMessage ID: ${result.id}` }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Gmail send error: ${e.message}` }] };
    }
  },
);

// ── Helpers ──────────────────────────────────────────────

function getEnabledSources(): SourceType[] {
  const sources: SourceType[] = [];
  if (config.sources.google?.enabled) sources.push('google');
  if (config.sources.notion?.enabled) sources.push('notion');
  if (config.sources.slack?.enabled) sources.push('slack');
  if (config.sources.telegram?.enabled) sources.push('telegram');
  if (config.sources.cloudflare?.enabled) sources.push('cloudflare');
  return sources;
}

/**
 * Local structure search — matches query against doc names, tab names, and headers.
 * Used as supplement/fallback when API-based search misses results.
 */
function searchStructure(query: string, source?: SourceType, limit = 10) {
  if (!structure) return [];
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (terms.length === 0) return [];

  const scored = structure.docs
    .filter(d => {
      if (source && d.source !== source) return false;
      // Exclude BigQuery sharded tables (too many, not useful for text search)
      if ((d.type === 'table' || d.type === 'dataset' || d.type === 'view') && d.parent?.startsWith('BigQuery/')) return false;
      return true;
    })
    .map(d => {
      const searchable = `${d.name} ${d.snippet || ''} ${d.parent || ''}`.toLowerCase();
      const matchCount = terms.filter(t => searchable.includes(t)).length;
      return { doc: d, score: matchCount };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(x => ({
    id: x.doc.id,
    name: x.doc.name,
    source: x.doc.source as string,
    type: x.doc.type,
    snippet: x.doc.snippet?.slice(0, 200) || '',
    url: x.doc.url,
    modified_at: x.doc.modified_at,
  }));
}

// ── Start ───────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[gated-info] MCP server started (${structure?.docs.length || 0} docs indexed)\n`);
