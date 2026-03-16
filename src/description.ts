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
  parts.push('Search your auth-gated sources (Google Drive, Notion, Slack, Telegram, Cloudflare, GitLab, LangSmith, Sessions).');

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

  // Cloudflare
  if (stats.cloudflare) {
    const c = stats.cloudflare;
    const typeParts = Object.entries(c.types).map(([t, n]) => `${n} ${t}s`).join(', ');
    sourceDescriptions.push(`Cloudflare: ${c.count} resources (${typeParts})`);
  }

  // GitLab
  if (stats.gitlab) {
    const gl = stats.gitlab;
    const typeParts = Object.entries(gl.types).map(([t, n]) => `${n} ${t}s`).join(', ');
    sourceDescriptions.push(`GitLab: ${gl.count} resources (${typeParts})`);
  }

  // LangSmith
  if (stats.langsmith) {
    const ls = stats.langsmith;
    const typeParts = Object.entries(ls.types).map(([t, n]) => `${n} ${t}s`).join(', ');
    sourceDescriptions.push(`LangSmith: ${ls.count} resources (${typeParts})`);
  }

  // Sessions
  if (stats.sessions) {
    const s = stats.sessions;
    sourceDescriptions.push(`Sessions: ${s.count} Claude Code sessions archived`);
  }

  if (sourceDescriptions.length === 0) {
    parts.push('No sources connected yet. Run: gated-knowledge auth google --service-account <key.json>');
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

  // Media files (video/audio) — show count and transcription availability
  const mediaFiles = docs.filter(d => d.type === 'video' || d.type === 'audio');
  if (mediaFiles.length > 0) {
    parts.push('');
    parts.push(`Media files (${mediaFiles.length} video/audio — use read_document to transcribe via Deepgram):`);
    for (const m of mediaFiles.slice(0, 10)) {
      const info = m.snippet || m.type;
      parts.push(`  "${m.name}" (${info})`);
    }
    if (mediaFiles.length > 10) parts.push(`  ... and ${mediaFiles.length - 10} more`);
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

  // Cloudflare infrastructure — compact summaries
  const cfDocs = docs.filter(d => d.source === 'cloudflare');
  if (cfDocs.length > 0) {
    parts.push('');
    parts.push('Cloudflare infrastructure (use search/read_document for details):');

    // Zones
    const zones = cfDocs.filter(d => d.type === 'zone');
    if (zones.length) {
      const zoneList = zones.map(z => {
        const dns = z.snippet ? ` (${z.snippet})` : '';
        return `${z.name}${dns}`;
      }).join(', ');
      parts.push(`  Zones: ${zoneList}`);
    }

    // Workers
    const workers = cfDocs.filter(d => d.type === 'worker');
    if (workers.length) {
      parts.push(`  Workers: ${workers.map(w => w.name).join(', ')}`);
    }

    // Pages
    const pages = cfDocs.filter(d => d.type === 'pages_project');
    if (pages.length) {
      const pageList = pages.map(p => {
        const domains = p.snippet ? ` (${p.snippet})` : '';
        return `${p.name}${domains}`;
      }).join(', ');
      parts.push(`  Pages: ${pageList}`);
    }

    // D1 databases (use d1_query for SQL)
    const d1 = cfDocs.filter(d => d.type === 'd1_database');
    if (d1.length) {
      parts.push(`  D1 databases (use d1_query for SQL):`);
      for (const db of d1) {
        const tables = db.snippet ? ` — ${db.snippet}` : '';
        parts.push(`    ${db.name}${tables}`);
      }
    }

    // KV
    const kv = cfDocs.filter(d => d.type === 'kv_namespace');
    if (kv.length) {
      parts.push(`  KV: ${kv.map(k => k.name).join(', ')}`);
    }

    // R2
    const r2 = cfDocs.filter(d => d.type === 'r2_bucket');
    if (r2.length) {
      parts.push(`  R2: ${r2.map(b => b.name).join(', ')}`);
    }
  }

  // GitLab details — projects with open MR counts + resource ID cheatsheet
  const glDocs = docs.filter(d => d.source === 'gitlab');
  if (glDocs.length > 0) {
    parts.push('');
    parts.push('GitLab (use read_document with source="gitlab"):');
    parts.push('  Resource IDs: project:PID, mr:PID:IID, issue:PID:IID,');
    parts.push('    commits:PID?path=dir&ref=branch&since=date, commit:PID:SHA,');
    parts.push('    tree:PID?path=dir&ref=branch, file:PID:path/to/file?ref=branch,');
    parts.push('    pipelines:PID?ref=branch, pipeline:PID:ID');
    const projects = glDocs.filter(d => d.type === 'project');
    const mrs = glDocs.filter(d => d.type === 'merge_request');
    const issues = glDocs.filter(d => d.type === 'issue');

    for (const p of projects) {
      const mrCount = mrs.filter(m => m.parent === p.name).length;
      const issueCount = issues.filter(i => i.parent === p.name).length;
      const extra = [
        mrCount ? `${mrCount} open MRs` : '',
        issueCount ? `${issueCount} open issues` : '',
      ].filter(Boolean).join(', ');
      parts.push(`  ${p.name}${extra ? ` (${extra})` : ''}`);
    }
  }

  // LangSmith details — projects with run counts
  const lsDocs = docs.filter(d => d.source === 'langsmith');
  if (lsDocs.length > 0) {
    parts.push('');
    parts.push('LangSmith (use search/read_document for runs, projects, datasets):');
    const projects = lsDocs.filter(d => d.type === 'project');
    const datasets = lsDocs.filter(d => d.type === 'dataset');

    for (const p of projects) {
      parts.push(`  ${p.name}${p.snippet ? ` — ${p.snippet}` : ''}`);
    }
    if (datasets.length) {
      parts.push(`  Datasets: ${datasets.map(d => d.name).join(', ')}`);
    }
  }

  // Sessions — list projects and recent sessions
  const sessionDocs = docs.filter(d => d.source === 'sessions');
  if (sessionDocs.length > 0) {
    parts.push('');
    parts.push('Sessions (use session_list, session_search, or read_document with source="sessions"):');

    const byProject = new Map<string, number>();
    for (const d of sessionDocs) {
      const project = d.parent || 'unknown';
      byProject.set(project, (byProject.get(project) || 0) + 1);
    }

    for (const [project, count] of byProject) {
      parts.push(`  ${project}: ${count} sessions`);
    }

    // Show most recent sessions
    const recent = sessionDocs
      .sort((a, b) => (b.modified_at || '').localeCompare(a.modified_at || ''))
      .slice(0, 5);

    if (recent.length > 0) {
      parts.push('  Recent:');
      for (const s of recent) {
        const date = s.modified_at ? new Date(s.modified_at).toLocaleDateString() : '';
        const snip = s.snippet ? ` — "${s.snippet.slice(0, 60)}${s.snippet.length > 60 ? '...' : ''}"` : '';
        parts.push(`    ${s.id} (${date})${snip}`);
      }
    }
  }

  parts.push('');
  parts.push('Use search for text queries. Use bigquery_query for BigQuery SQL, d1_query for D1 SQL.');
  parts.push('Use list_sources for full schemas. Specify source to narrow search.');

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

  // Show first 3 tabs with headers
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

  // Show remaining tab NAMES (without headers) so Claude knows they exist
  if (sheetParts.length > 3) {
    const extraNames = sheetParts.slice(3).map(part => {
      const match = part.match(/^(.+?)\[/);
      return match ? match[1] : part;
    });
    summaries.push(`also: ${extraNames.join(', ')}`);
  }
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
