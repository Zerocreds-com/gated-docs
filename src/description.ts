/**
 * Dynamic MCP tool description generator.
 * Reads structure.json and produces a concise description of available sources.
 * This description becomes the MCP tool's description — Claude sees it in system prompt.
 */
import type { StructureDoc, Structure, SourceType } from './types.ts';

export function generateDescription(
  docs: StructureDoc[],
  stats: Structure['stats']
): string {
  const parts: string[] = [];
  parts.push('Search your auth-gated sources (Google Drive, Notion, Slack, Telegram).');

  const sourceDescriptions: string[] = [];

  // Google
  if (stats.google) {
    const g = stats.google;
    const typeParts = Object.entries(g.types).map(([t, n]) => `${n} ${t}s`).join(', ');
    const googleDocs = docs.filter(d => d.source === 'google');

    // Group by parent folder for context
    const folders = new Map<string, number>();
    for (const d of googleDocs) {
      const folder = d.parent || 'root';
      folders.set(folder, (folders.get(folder) || 0) + 1);
    }

    let folderInfo = '';
    if (folders.size > 1) {
      const topFolders = [...folders.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `${name} (${count})`)
        .join(', ');
      folderInfo = ` in folders: ${topFolders}`;
    }

    sourceDescriptions.push(`Google Drive: ${g.count} docs (${typeParts})${folderInfo}`);
  }

  // Notion
  if (stats.notion) {
    const n = stats.notion;
    const typeParts = Object.entries(n.types).map(([t, count]) => `${count} ${t}s`).join(', ');
    sourceDescriptions.push(`Notion: ${n.count} items (${typeParts})`);
  }

  // Slack
  if (stats.slack) {
    const s = stats.slack;
    sourceDescriptions.push(`Slack: ${s.count} channels`);
  }

  // Telegram
  if (stats.telegram) {
    const t = stats.telegram;
    const typeParts = Object.entries(t.types).map(([type, n]) => `${n} ${type}s`).join(', ');
    sourceDescriptions.push(`Telegram: ${t.count} chats (${typeParts})`);
  }

  if (sourceDescriptions.length === 0) {
    parts.push('No sources connected yet. Run: gated-info auth google --service-account <key.json>');
  } else {
    parts.push('Connected sources:');
    for (const desc of sourceDescriptions) {
      parts.push(`  ${desc}`);
    }
  }

  // BigQuery — compact summaries (full schemas via list_sources / bigquery_explore)
  const bqTables = docs.filter(d => d.parent?.startsWith('BigQuery/') && (d.type === 'table' || d.type === 'view'));
  if (bqTables.length > 0) {
    parts.push('');
    parts.push('BigQuery (use bigquery_query for SQL, list_sources for full schemas):');

    const byDataset = new Map<string, typeof bqTables>();
    for (const t of bqTables) {
      const dataset = t.parent!.replace('BigQuery/', '');
      if (!byDataset.has(dataset)) byDataset.set(dataset, []);
      byDataset.get(dataset)!.push(t);
    }

    for (const [dataset, tables] of byDataset) {
      // Group sharded tables
      const schemaGroups = new Map<string, typeof bqTables>();
      for (const t of tables) {
        const cols = t.snippet?.split(' | ')[0] || '';
        if (!schemaGroups.has(cols)) schemaGroups.set(cols, []);
        schemaGroups.get(cols)!.push(t);
      }

      for (const [_cols, group] of schemaGroups) {
        if (group.length > 3) {
          const names = group.map(t => t.name).sort();
          const base = names[0].replace(/\d{8}$/, '*');
          const summary = summarizeTable(base, group[0].snippet || '');
          const freshness = extractFreshness(group[0].snippet);
          parts.push(`  ${dataset}.${base} (${group.length} shards) — ${summary}${freshness}`);
        } else {
          for (const t of group) {
            const summary = summarizeTable(t.name, t.snippet || '');
            const freshness = extractFreshness(t.snippet);
            parts.push(`  ${dataset}.${t.name} — ${summary}${freshness}`);
          }
        }
      }
    }
  }

  // Spreadsheets — compact summaries
  const sheets = docs.filter(d => d.type === 'spreadsheet');
  if (sheets.length > 0) {
    parts.push('');
    parts.push('Google Sheets (use search or read_document):');
    for (const s of sheets) {
      const summary = summarizeSheet(s.name, s.snippet || '');
      parts.push(`  "${s.name}" — ${summary}`);
    }
  }

  parts.push('');
  parts.push('Use search for text queries. Use bigquery_query for SQL. Use list_sources for full schemas.');
  parts.push('Specify source parameter to narrow search to google/notion/slack/telegram.');

  return parts.join('\n');
}

// ── Summarizers ─────────────────────────────────────────

function summarizeTable(name: string, snippet: string): string {
  // Extract column names from snippet
  const colsMatch = snippet.match(/^columns: (.+?)(\||$)/);
  const colNames = colsMatch
    ? colsMatch[1].split(', ').map(c => c.replace(/\([^)]+\)/, '').trim())
    : [];

  // Infer purpose from table name + columns
  const nameLower = name.toLowerCase();
  const colSet = new Set(colNames.map(c => c.toLowerCase()));

  // Row count
  const rowMatch = snippet.match(/([\d,]+) rows/);
  const rows = rowMatch ? rowMatch[1] : '';

  // Domain heuristics
  const hints: string[] = [];

  if (colSet.has('candidate_name') || colSet.has('candidate_id') || nameLower.includes('candidate'))
    hints.push('candidates');
  if (colSet.has('vacancy_id') || colSet.has('job_id') || nameLower.includes('vacanc') || nameLower.includes('job'))
    hints.push('jobs/vacancies');
  if (colSet.has('company_id') || colSet.has('company_name') || nameLower.includes('compan') || nameLower.includes('client'))
    hints.push('companies');
  if (colSet.has('recruiter_id') || nameLower.includes('recruiter'))
    hints.push('recruiters');
  if (colSet.has('event_name') || colSet.has('event_type') || colSet.has('activity') || nameLower.includes('event'))
    hints.push('events/activity');
  if (colSet.has('stage') || colSet.has('from_stage') || colSet.has('to_stage') || nameLower.includes('pipeline'))
    hints.push('pipeline stages');
  if (colSet.has('interview_id') || nameLower.includes('interview') || nameLower.includes('hireflix'))
    hints.push('interviews');
  if (colSet.has('question_title') || nameLower.includes('question'))
    hints.push('questions');
  if (colSet.has('session_id') || nameLower.includes('session') || nameLower.includes('chat'))
    hints.push('sessions');
  if (colSet.has('report_id') || nameLower.includes('report') || nameLower.includes('monitoring'))
    hints.push('reports');
  if (colSet.has('sql') || colSet.has('user_prompt'))
    hints.push('analytics queries');
  if (colSet.has('skill') || colSet.has('missing_skill') || nameLower.includes('skill'))
    hints.push('skills');
  if (colSet.has('cache_key') || nameLower.includes('cache'))
    hints.push('API cache');
  if (colSet.has('api_key') || colSet.has('token') || nameLower.includes('token'))
    hints.push('API tokens');
  if (nameLower.includes('event') && colSet.has('event_date') && colSet.has('user_pseudo_id'))
    hints.push('GA4 web analytics');
  if (nameLower.includes('pseudonymous'))
    hints.push('GA4 user profiles');

  // Build summary
  const topic = hints.length > 0 ? hints.join(', ') : colNames.slice(0, 4).join(', ');
  const rowInfo = rows ? ` (${rows} rows)` : '';
  return `${topic}${rowInfo}`;
}

function summarizeSheet(name: string, snippet: string): string {
  // snippet is: "Sheet1[col1, col2, ...] | Sheet2[col1, col2, ...]"
  if (!snippet) return name;

  const sheetParts = snippet.split(' | ');
  const summaries: string[] = [];

  for (const part of sheetParts.slice(0, 3)) {
    const match = part.match(/^(.+?)\[(.+)\]$/);
    if (match) {
      const sheetName = match[1];
      const headers = match[2].split(', ').slice(0, 5).join(', ');
      const more = match[2].split(', ').length > 5 ? '...' : '';
      summaries.push(`${sheetName}: ${headers}${more}`);
    } else {
      summaries.push(part);
    }
  }

  if (sheetParts.length > 3) summaries.push(`+${sheetParts.length - 3} more sheets`);
  return summaries.join(' | ');
}

function extractFreshness(snippet: string | undefined): string {
  if (!snippet) return '';
  const match = snippet.match(/updated \S+ ago/);
  return match ? `, ${match[0]}` : '';
}

/**
 * Generate a shorter description for the read_document tool.
 */
export function generateReadDescription(docs: StructureDoc[]): string {
  const parts: string[] = [];
  parts.push('Read a specific document by ID or name from connected sources.');

  // List a few notable docs by name for discoverability
  const named = docs
    .filter(d => d.name.length > 3)
    .sort((a, b) => (b.modified_at || '').localeCompare(a.modified_at || ''))
    .slice(0, 10);

  if (named.length) {
    parts.push('Recent docs:');
    for (const d of named) {
      parts.push(`  [${d.source}] "${d.name}" (${d.type}, id: ${d.id.slice(0, 12)}...)`);
    }
  }

  return parts.join('\n');
}
