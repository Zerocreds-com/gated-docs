/**
 * gated-knowledge MCP server — stdio transport.
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
  process.stderr.write('[gated-knowledge] Structure stale, will scan in background...\n');
  scan().then(s => {
    structure = s;
    process.stderr.write(`[gated-knowledge] Background scan complete: ${s.docs.length} docs\n`);
  }).catch(e => {
    process.stderr.write(`[gated-knowledge] Background scan failed: ${e.message}\n`);
  });
}

// Build dynamic descriptions from current structure
const searchDesc = structure?.mcp_description
  || generateDescription([], {} as any);
const readDesc = structure
  ? generateReadDescription(structure.docs)
  : 'Read a document by ID from connected sources. Run "gated-knowledge scan" first.';

const server = new McpServer({
  name: 'gated-knowledge',
  version: '2.0.0',
});

// ── search ──────────────────────────────────────────────

server.tool(
  'search',
  searchDesc,
  {
    query: z.string().describe('Search query (natural language or keywords)'),
    source: z.enum(['google', 'notion', 'slack', 'telegram', 'cloudflare', 'gitlab', 'langsmith', 'sessions']).optional()
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
        } else if (src === 'gitlab') {
          const { searchGitLab } = await import('../connectors/gitlab.ts');
          const r = await searchGitLab(query, maxResults);
          results.push(...r);
        } else if (src === 'langsmith') {
          const { searchLangSmith } = await import('../connectors/langsmith.ts');
          const r = await searchLangSmith(query, maxResults);
          results.push(...r);
        } else if (src === 'sessions') {
          const { searchSessions } = await import('../connectors/sessions.ts');
          const r = await searchSessions(query, maxResults);
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
    source: z.enum(['google', 'notion', 'slack', 'telegram', 'cloudflare', 'gitlab', 'langsmith', 'sessions'])
      .describe('Which source this document belongs to'),
    range: z.string().optional()
      .describe('For Google Sheets: A1 range (e.g. "\'Sheet1\'!A1:E100"). For GitLab commits/tree: path filter (e.g. "src/api"). For GitLab pipelines: branch ref filter.'),
    extract: z.enum(['edits', 'errors', 'user_messages']).optional()
      .describe('Sessions only: extract specific content type instead of full session'),
  },
  async ({ id, source, range, extract }) => {
    try {
      let content: { name: string; content: string; url?: string };

      if (source === 'google') {
        const { readGoogleDoc } = await import('../connectors/google.ts');
        content = await readGoogleDoc(id, range);
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
      } else if (source === 'gitlab') {
        const { readGitLabResource } = await import('../connectors/gitlab.ts');
        content = await readGitLabResource(id, range);
      } else if (source === 'langsmith') {
        const { readLangSmithResource } = await import('../connectors/langsmith.ts');
        content = await readLangSmithResource(id);
      } else if (source === 'sessions') {
        if (extract) {
          const { readSessionExtracted } = await import('../connectors/sessions.ts');
          content = await readSessionExtracted(id, extract, range);
        } else {
          const { readSessionResource } = await import('../connectors/sessions.ts');
          content = await readSessionResource(id, range);
        }
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

// ── delete_document ─────────────────────────────────────

server.tool(
  'delete_document',
  'Move a Google Drive file to trash (reversible — can be recovered from trash). Use after reading/transcribing a file that is no longer needed.',
  {
    id: z.string().describe('Google Drive file ID'),
  },
  async ({ id }) => {
    try {
      const { deleteGoogleFile } = await import('../connectors/google.ts');
      const result = await deleteGoogleFile(id);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error deleting file: ${e.message}` }] };
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
      return { content: [{ type: 'text' as const, text: 'No scan data. Run: gated-knowledge scan' }] };
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

// ── session_list ─────────────────────────────────────────

server.tool(
  'session_list',
  'List Claude Code sessions from the local archive. Shows project, chunks count, date, and first user message. Use to discover sessions before reading them.',
  {
    project: z.string().optional()
      .describe('Filter by project name (e.g. "session-snapshot", "manager")'),
    limit: z.number().optional()
      .describe('Max sessions to return (default: 20)'),
  },
  async ({ project, limit }) => {
    try {
      const { getSessionList } = await import('../connectors/sessions.ts');
      const sessions = await getSessionList({ project, limit: limit || 20 });

      if (sessions.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No sessions found. Make sure session-snapshot is installed and has generated MD diffs.' }] };
      }

      const lines = sessions.map((s, i) => {
        const parts = [
          `${i + 1}. **${s.project}** (${s.chunks} chunks${s.totalLines ? `, ${s.totalLines} JSONL lines` : ''})`,
          `   ${s.modifiedAt ? new Date(s.modifiedAt).toLocaleString() : 'unknown date'}`,
        ];
        if (s.snippet) parts.push(`   "${s.snippet.slice(0, 120)}${s.snippet.length > 120 ? '...' : ''}"`);
        parts.push(`   ID: ${s.id}`);
        return parts.join('\n');
      });

      // Show unique projects
      const projects = [...new Set(sessions.map(s => s.project))];

      let text = `Found ${sessions.length} session(s) across projects: ${projects.join(', ')}\n\n${lines.join('\n\n')}`;
      text += `\n\nUse read_document(id, source="sessions") to read a session. Use range="0-2" for first 3 chunks, "last" for latest.`;
      return { content: [{ type: 'text' as const, text }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error listing sessions: ${e.message}` }] };
    }
  },
);

// ── session_search ───────────────────────────────────────

server.tool(
  'session_search',
  'Search through Claude Code session content. Searches full text of MD diffs across all sessions. Supports date filtering. More targeted than general search — use when looking for specific code, decisions, or conversations from past sessions.',
  {
    query: z.string().describe('Search query (keywords)'),
    project: z.string().optional()
      .describe('Filter to a specific project'),
    since: z.string().optional()
      .describe('Only sessions modified after this date (ISO date, e.g. "2026-03-10")'),
    until: z.string().optional()
      .describe('Only sessions modified before this date (ISO date, e.g. "2026-03-16")'),
    limit: z.number().optional()
      .describe('Max results (default: 10)'),
  },
  async ({ query, project, since, until, limit }) => {
    try {
      const { searchSessions } = await import('../connectors/sessions.ts');
      const results = await searchSessions(query, limit || 10, { project, since, until });

      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: `No sessions found matching "${query}".` }] };
      }

      const lines = results.map((r, i) => {
        const parts = [`${i + 1}. **${r.name}**`];
        if (r.modified_at) parts.push(`   ${new Date(r.modified_at).toLocaleString()}`);
        if (r.snippet) parts.push(`   ${r.snippet.slice(0, 200)}`);
        parts.push(`   ID: ${r.id}`);
        return parts.join('\n');
      });

      let text = `Found ${results.length} session(s) matching "${query}":\n\n${lines.join('\n\n')}`;
      text += `\n\nUse read_document(id, source="sessions") to read the full session.`;
      return { content: [{ type: 'text' as const, text }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error searching sessions: ${e.message}` }] };
    }
  },
);

// ── session_stats ───────────────────────────────────────

server.tool(
  'session_stats',
  'Get aggregated statistics from Claude Code sessions: tool usage counts, files touched, turn counts, error counts. Works on one session or across sessions filtered by project/date.',
  {
    id: z.string().optional()
      .describe('Single session ID to analyze. If omitted, aggregates across all matching sessions.'),
    project: z.string().optional()
      .describe('Filter by project name'),
    since: z.string().optional()
      .describe('Only sessions after this date (ISO, e.g. "2026-03-10")'),
    until: z.string().optional()
      .describe('Only sessions before this date (ISO, e.g. "2026-03-16")'),
  },
  async ({ id, project, since, until }) => {
    try {
      const { getSessionStats } = await import('../connectors/sessions.ts');
      const stats = await getSessionStats({ id, project, since, until });

      const lines: string[] = [];
      lines.push(`## Session Statistics`);
      lines.push(`Sessions: ${stats.sessionCount}`);
      lines.push(`Projects: ${stats.projects.join(', ') || 'none'}`);
      if (stats.dateRange.first) {
        lines.push(`Date range: ${stats.dateRange.first.slice(0, 10)} → ${stats.dateRange.last.slice(0, 10)}`);
      }
      lines.push(`Total size: ${stats.totalSizeKB}KB`);
      lines.push(`User turns: ${stats.totalUserTurns}, Assistant turns: ${stats.totalAssistantTurns}`);
      lines.push(`Errors encountered: ${stats.errorCount}`);

      lines.push(`\n### Tool Usage`);
      const sortedTools = Object.entries(stats.toolUsage).sort((a, b) => b[1] - a[1]);
      for (const [tool, count] of sortedTools) {
        lines.push(`  ${tool}: ${count}`);
      }

      if (stats.filesTouched.length > 0) {
        lines.push(`\n### Files Touched (${stats.filesTouched.length})`);
        for (const f of stats.filesTouched.slice(0, 50)) {
          lines.push(`  ${f}`);
        }
        if (stats.filesTouched.length > 50) lines.push(`  ... and ${stats.filesTouched.length - 50} more`);
      }

      if (stats.bashCommands.length > 0) {
        lines.push(`\n### Bash Commands (${stats.bashCommands.length})`);
        for (const cmd of stats.bashCommands.slice(0, 30)) {
          lines.push(`  ${cmd}`);
        }
        if (stats.bashCommands.length > 30) lines.push(`  ... and ${stats.bashCommands.length - 30} more`);
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error getting session stats: ${e.message}` }] };
    }
  },
);

// ── session_summary ─────────────────────────────────────

server.tool(
  'session_summary',
  'Get a structured summary of Claude Code sessions without reading full content. Extracts: goal, files changed, key actions, user requests, outcome. Pattern-based extraction, no LLM.',
  {
    id: z.string().optional()
      .describe('Single session ID to summarize'),
    project: z.string().optional()
      .describe('Summarize all sessions for a project'),
    since: z.string().optional()
      .describe('Only sessions after this date (ISO)'),
    until: z.string().optional()
      .describe('Only sessions before this date (ISO)'),
    limit: z.number().optional()
      .describe('Max sessions to summarize (default: 10)'),
  },
  async ({ id, project, since, until, limit }) => {
    try {
      const { getSessionSummary } = await import('../connectors/sessions.ts');
      const summaries = await getSessionSummary({ id, project, since, until, limit });

      if (summaries.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No sessions found matching criteria.' }] };
      }

      const blocks = summaries.map(s => {
        const lines: string[] = [];
        lines.push(`## ${s.project} (${s.sizeKB}KB, ${s.turnCount} turns)`);
        lines.push(`ID: ${s.id}`);
        lines.push(`Date: ${s.modifiedAt ? new Date(s.modifiedAt).toLocaleString() : 'unknown'}`);
        lines.push(`\n**Goal:** ${s.goal.slice(0, 200)}`);
        if (s.outcome) lines.push(`**Outcome:** ${s.outcome.slice(0, 200)}`);
        if (s.errorCount > 0) lines.push(`**Errors:** ${s.errorCount}`);

        if (s.filesChanged.length > 0) {
          lines.push(`\n**Files changed (${s.filesChanged.length}):**`);
          for (const f of s.filesChanged.slice(0, 15)) lines.push(`  - ${f}`);
          if (s.filesChanged.length > 15) lines.push(`  ... and ${s.filesChanged.length - 15} more`);
        }

        if (s.keyActions.length > 0) {
          lines.push(`\n**Key actions:**`);
          for (const a of s.keyActions.slice(0, 15)) lines.push(`  - ${a}`);
          if (s.keyActions.length > 15) lines.push(`  ... and ${s.keyActions.length - 15} more`);
        }

        if (s.userRequests.length > 1) {
          lines.push(`\n**User requests (${s.userRequests.length}):**`);
          for (const r of s.userRequests.slice(0, 10)) lines.push(`  - ${r}`);
          if (s.userRequests.length > 10) lines.push(`  ... and ${s.userRequests.length - 10} more`);
        }

        return lines.join('\n');
      });

      return { content: [{ type: 'text' as const, text: blocks.join('\n\n---\n\n') }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error summarizing sessions: ${e.message}` }] };
    }
  },
);

// ── auth_status ─────────────────────────────────────────

interface CredCheck {
  source: string;
  credential: string;
  status: 'ok' | 'missing' | 'error';
  detail?: string;
  fix_command?: string;
}

async function checkCredentials(liveCheck: boolean): Promise<CredCheck[]> {
  const { hasCredential, getCredential } = await import('../keychain.ts');
  const results: CredCheck[] = [];

  // Google (SA or OAuth multi-account)
  if (config.sources.google?.enabled) {
    const googleAccount = config.sources.google?.account;
    const googleAccounts = config.google_accounts as string[] | undefined;
    const isOAuth = googleAccount === 'oauth' || (googleAccounts && googleAccounts.length > 0);

    if (isOAuth) {
      // OAuth multi-account: check each account's token
      const accounts = googleAccounts?.length ? googleAccounts : ['default'];
      for (const email of accounts) {
        const keychainKey = email === 'default' ? 'oauth' : `oauth-${email}`;
        const hasCred = hasCredential('google', keychainKey);
        if (!hasCred) {
          results.push({ source: 'google', credential: `oauth-${email}`, status: 'missing', detail: `OAuth token for ${email} not in keychain`, fix_command: 'gated-knowledge auth google' });
        } else if (liveCheck) {
          try {
            const { google } = await import('googleapis');
            const token = getCredential('google', keychainKey);
            const decoded = JSON.parse(Buffer.from(token!, 'base64').toString('utf-8'));
            const oauth2 = new google.auth.OAuth2(decoded.client_id, decoded.client_secret);
            oauth2.setCredentials({ refresh_token: decoded.refresh_token });
            const drive = google.drive({ version: 'v3', auth: oauth2 });
            await drive.files.list({ pageSize: 1 });
            results.push({ source: 'google', credential: `oauth-${email}`, status: 'ok', detail: `OAuth: ${email}` });
          } catch (e: any) {
            results.push({ source: 'google', credential: `oauth-${email}`, status: 'error', detail: e.message, fix_command: 'gated-knowledge auth google' });
          }
        } else {
          results.push({ source: 'google', credential: `oauth-${email}`, status: 'ok', detail: `OAuth: ${email} (exists, not live-checked)` });
        }
      }
    } else if (!googleAccount) {
      results.push({ source: 'google', credential: 'service-account', status: 'missing', detail: 'No SA account configured', fix_command: 'gated-knowledge auth google --service-account <key.json>' });
    } else {
      // Service Account path
      const hasCred = hasCredential('google', googleAccount);
      if (!hasCred) {
        results.push({ source: 'google', credential: 'service-account', status: 'missing', detail: `SA ${googleAccount} not in keychain`, fix_command: 'gated-knowledge auth google --service-account <key.json>' });
      } else if (liveCheck) {
        try {
          const { getServiceAccountCredentials } = await import('../keychain.ts');
          const creds = getServiceAccountCredentials(googleAccount);
          if (!creds) throw new Error('Failed to decode SA JSON');
          const { google } = await import('googleapis');
          const auth = new google.auth.GoogleAuth({ credentials: creds as any, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
          const drive = google.drive({ version: 'v3', auth });
          await drive.files.list({ pageSize: 1 });
          results.push({ source: 'google', credential: 'service-account', status: 'ok', detail: `SA: ${googleAccount}` });
        } catch (e: any) {
          results.push({ source: 'google', credential: 'service-account', status: 'error', detail: e.message, fix_command: 'gated-knowledge auth google --service-account <key.json>' });
        }
      } else {
        results.push({ source: 'google', credential: 'service-account', status: 'ok', detail: `SA: ${googleAccount} (exists, not live-checked)` });
      }
    }
  }

  // Simple token-based sources
  const tokenSources: Array<{ name: string; key: string; account: string; authCmd: string }> = [
    { name: 'notion', key: 'notion', account: 'default', authCmd: 'gated-knowledge auth notion --token <ntn_xxx>' },
    { name: 'slack', key: 'slack', account: 'default', authCmd: 'gated-knowledge auth slack --token <xoxb-xxx>' },
    { name: 'cloudflare', key: 'cloudflare', account: 'default', authCmd: 'gated-knowledge auth cloudflare --token <cf-token>' },
    { name: 'gitlab', key: 'gitlab', account: 'default', authCmd: 'gated-knowledge auth gitlab --token <glpat-xxx>' },
    { name: 'langsmith', key: 'langsmith', account: 'default', authCmd: 'gated-knowledge auth langsmith --token <ls-key>' },
    { name: 'deepgram', key: 'deepgram', account: 'default', authCmd: 'gated-knowledge auth deepgram --token <api-key>' },
  ];

  for (const ts of tokenSources) {
    const srcConfig = config.sources[ts.name as SourceType];
    if (!srcConfig?.enabled && ts.name !== 'deepgram') continue;
    // Deepgram is optional, check anyway if credential exists
    if (ts.name === 'deepgram' && !hasCredential(ts.key, ts.account)) continue;

    const hasCred = hasCredential(ts.key, ts.account);
    if (!hasCred) {
      results.push({ source: ts.name, credential: 'token', status: 'missing', fix_command: ts.authCmd });
    } else if (liveCheck) {
      try {
        if (ts.name === 'notion') {
          const { Client } = await import('@notionhq/client');
          const token = getCredential('notion', 'default');
          const client = new Client({ auth: token! });
          await client.search({ page_size: 1 });
        } else if (ts.name === 'slack') {
          const { WebClient } = await import('@slack/web-api');
          const token = getCredential('slack', 'default');
          const client = new WebClient(token!);
          await client.auth.test();
        } else if (ts.name === 'cloudflare') {
          const { probeCloudflarePermissions } = await import('../connectors/cloudflare.ts');
          const probe = await probeCloudflarePermissions();
          if (!probe.valid) throw new Error(`Token ${probe.status || 'invalid'}`);
          const granted = Object.entries(probe.permissions).filter(([, v]) => v).map(([k]) => k);
          const denied = Object.entries(probe.permissions).filter(([, v]) => !v).map(([k]) => k);
          results.push({ source: 'cloudflare', credential: 'token', status: 'ok',
            detail: `Active. Access: ${granted.join(', ') || 'none'}${denied.length ? `. No access: ${denied.join(', ')}` : ''}` });
          continue; // skip the generic push below
        } else if (ts.name === 'gitlab') {
          const token = getCredential('gitlab', 'default');
          const url = config.gitlab_url || 'https://gitlab.com';
          const resp = await fetch(`${url}/api/v4/projects?per_page=1`, { headers: { 'PRIVATE-TOKEN': token! } });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        }
        results.push({ source: ts.name, credential: 'token', status: 'ok', detail: 'Live check passed' });
      } catch (e: any) {
        results.push({ source: ts.name, credential: 'token', status: 'error', detail: e.message, fix_command: ts.authCmd });
      }
    } else {
      results.push({ source: ts.name, credential: 'token', status: 'ok', detail: 'Token exists (not live-checked)' });
    }
  }

  // Telegram (special: JSON blob with api_id, api_hash, session)
  if (config.sources.telegram?.enabled) {
    const hasCred = hasCredential('telegram', 'default');
    if (!hasCred) {
      results.push({ source: 'telegram', credential: 'session', status: 'missing', fix_command: 'gated-knowledge auth telegram --api-id <N> --api-hash <hash>' });
    } else {
      results.push({ source: 'telegram', credential: 'session', status: 'ok', detail: 'Session exists (live check not supported for Telegram)' });
    }
  }

  // Gmail (OAuth2)
  const gmailRead = hasCredential('gmail', 'oauth');
  const gmailSend = hasCredential('gmail', 'oauth-send');
  if (gmailRead || config.sources.google?.enabled) {
    if (!gmailRead) {
      results.push({ source: 'gmail', credential: 'oauth-read', status: 'missing', fix_command: 'gated-knowledge auth gmail --client-secret-file <json>' });
    } else {
      results.push({ source: 'gmail', credential: 'oauth-read', status: 'ok', detail: 'OAuth token exists' });
    }
    if (!gmailSend) {
      results.push({ source: 'gmail', credential: 'oauth-send', status: 'missing', fix_command: 'gated-knowledge auth gmail --send' });
    } else {
      results.push({ source: 'gmail', credential: 'oauth-send', status: 'ok', detail: 'OAuth send token exists' });
    }
  }

  // Sessions (always available, no auth)
  results.push({ source: 'sessions', credential: 'none', status: 'ok', detail: 'Local files, no auth needed' });

  return results;
}

server.tool(
  'auth_status',
  'Check health of all credentials. Shows which sources have valid tokens and which need fixing. Use live_check=true for actual API validation (slower).',
  {
    live_check: z.boolean().optional()
      .describe('If true, makes lightweight API calls to verify tokens actually work (default: false, just checks existence)'),
    source: z.string().optional()
      .describe('Check specific source only (e.g. "google", "slack", "gmail")'),
  },
  async ({ live_check, source }) => {
    try {
      let checks = await checkCredentials(live_check || false);

      if (source) {
        checks = checks.filter(c => c.source === source);
      }

      if (checks.length === 0) {
        return { content: [{ type: 'text' as const, text: source ? `Source "${source}" is not configured.` : 'No sources configured.' }] };
      }

      const lines: string[] = ['## Credential Status\n'];
      const icons = { ok: '[OK]', missing: '[MISSING]', error: '[ERROR]' };

      for (const c of checks) {
        const icon = icons[c.status];
        let line = `${icon} **${c.source}** (${c.credential})`;
        if (c.detail) line += ` — ${c.detail}`;
        lines.push(line);
        if (c.status !== 'ok' && c.fix_command) {
          lines.push(`     Fix: \`${c.fix_command}\``);
        }
      }

      const ok = checks.filter(c => c.status === 'ok').length;
      const total = checks.length;
      lines.push(`\n${ok}/${total} credentials healthy.`);

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error checking auth: ${e.message}` }] };
    }
  },
);

// ── auth_fix ────────────────────────────────────────────

const AUTH_FIX_GUIDES: Record<string, string> = {
  google: `## Fix Google Drive/Sheets/Docs credentials

**What's needed:** Service Account JSON key file

**Steps:**
1. Go to Google Cloud Console → IAM & Admin → Service Accounts
2. Create or find existing SA (e.g. gated-knowledge@PROJECT.iam.gserviceaccount.com)
3. Create a key (JSON format), download it
4. Run: \`gated-knowledge auth google --service-account <path-to-key.json>\`
5. Share your Google Drive folders with the SA email

**Scopes used:** drive.readonly, spreadsheets.readonly, documents.readonly
**Storage:** Base64-encoded SA JSON in OS keychain under "gated-docs-google/{sa-email}"`,

  notion: `## Fix Notion credentials

**What's needed:** Internal integration token (ntn_xxx)

**Steps:**
1. Go to https://www.notion.so/my-integrations
2. Create or find existing integration
3. Copy the token (starts with ntn_)
4. Run: \`gated-knowledge auth notion --token <ntn_xxx>\`
5. Share your Notion pages/databases with the integration

**Storage:** Token in OS keychain under "gated-docs-notion/default"`,

  slack: `## Fix Slack credentials

**What's needed:** Bot User OAuth Token (xoxb-xxx)

**Steps:**
1. Go to https://api.slack.com/apps → your app
2. OAuth & Permissions → Bot User OAuth Token
3. Required scopes: channels:read, channels:history, search:read
4. Run: \`gated-knowledge auth slack --token <xoxb-xxx>\`

**Storage:** Token in OS keychain under "gated-docs-slack/default"`,

  telegram: `## Fix Telegram credentials

**What's needed:** Telegram API credentials (api_id + api_hash)

**Steps:**
1. Go to https://my.telegram.org → API development tools
2. Get api_id (number) and api_hash (string)
3. Run: \`gated-knowledge auth telegram --api-id <N> --api-hash <hash>\`
4. Complete phone verification when prompted

**Storage:** JSON blob (api_id, api_hash, session string) in OS keychain under "gated-docs-telegram/default"`,

  cloudflare: `## Fix Cloudflare credentials

**What's needed:** API Token with read permissions

**Steps:**
1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Create token with: Zone:Read, DNS:Read, Workers:Read, Pages:Read, D1:Read
3. Run: \`gated-knowledge auth cloudflare --token <cf-token>\`

**Storage:** Token in OS keychain under "gated-docs-cloudflare/default"`,

  gitlab: `## Fix GitLab credentials

**What's needed:** Personal Access Token (glpat-xxx)

**Steps:**
1. Go to GitLab → User Settings → Access Tokens
2. Create token with scopes: read_api, read_repository
3. Run: \`gated-knowledge auth gitlab --token <glpat-xxx>\`
4. For self-hosted: \`gated-knowledge auth gitlab --token <token> --url https://gitlab.example.com\`

**Storage:** Token in OS keychain under "gated-docs-gitlab/default"`,

  gmail: `## Fix Gmail credentials

**What's needed:** OAuth2 client secret JSON + browser auth flow

**For reading emails:**
1. Get OAuth2 client secret JSON from Google Cloud Console → APIs & Services → Credentials
2. Run: \`gated-knowledge auth gmail --client-secret-file <path-to-client-secret.json>\`
3. Complete browser auth flow (grants gmail.readonly scope)

**For sending emails:**
1. Run: \`gated-knowledge auth gmail --send\` (reuses existing client credentials)
2. Complete browser auth flow (grants gmail.send scope)

**Storage:** OAuth2 refresh tokens (base64 JSON) in keychain:
  - Read: "gated-docs-gmail/oauth"
  - Send: "gated-docs-gmail/oauth-send"`,

  deepgram: `## Fix Deepgram credentials

**What's needed:** Deepgram API key for audio/video transcription

**Steps:**
1. Go to https://console.deepgram.com → API Keys
2. Create a key
3. Run: \`gated-knowledge auth deepgram --token <api-key>\`

**Storage:** Token in OS keychain under "gated-docs-deepgram/default"`,

  langsmith: `## Fix LangSmith credentials

**What's needed:** LangSmith API key

**Steps:**
1. Go to https://smith.langchain.com → Settings → API Keys
2. Create or copy an API key
3. Run: \`gated-knowledge auth langsmith --token <ls-key>\`

**Storage:** Token in OS keychain under "gated-docs-langsmith/default"`,
};

server.tool(
  'auth_fix',
  'Get step-by-step instructions to fix credentials for a specific source. Shows what token is needed, where to get it, what scopes are required, and the exact CLI command to run.',
  {
    source: z.string()
      .describe('Source to fix: google, notion, slack, telegram, cloudflare, gitlab, gmail, deepgram, langsmith'),
  },
  async ({ source }) => {
    const guide = AUTH_FIX_GUIDES[source];
    if (!guide) {
      const available = Object.keys(AUTH_FIX_GUIDES).join(', ');
      return { content: [{ type: 'text' as const, text: `Unknown source "${source}". Available: ${available}` }] };
    }

    // Also show current status for this source
    const checks = await checkCredentials(false);
    const relevant = checks.filter(c => c.source === source);
    let status = '';
    if (relevant.length > 0) {
      const icons = { ok: '[OK]', missing: '[MISSING]', error: '[ERROR]' };
      status = '\n\n## Current Status\n' + relevant.map(c => `${icons[c.status]} ${c.credential} — ${c.detail || c.status}`).join('\n');
    }

    return { content: [{ type: 'text' as const, text: guide + status }] };
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
  if (config.sources.gitlab?.enabled) sources.push('gitlab');
  if (config.sources.langsmith?.enabled) sources.push('langsmith');
  // Sessions are always available (local files, no auth needed)
  sources.push('sessions');
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
process.stderr.write(`[gated-knowledge] MCP server started (${structure?.docs.length || 0} docs indexed)\n`);
