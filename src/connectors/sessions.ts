/**
 * Sessions connector — reads MD diffs from session-snapshot.
 * Supports two formats:
 *   1. Single file: archive/{sessionId}.md (new, append-based)
 *   2. Chunked dirs: archive/{project}-{shortId}/NNN.md (legacy)
 *
 * No auth required — reads local files only.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../config.ts';
import type { StructureDoc, SearchResult } from '../types.ts';

const DEFAULT_ARCHIVE_DIR = join(homedir(), '.config', 'session-snapshot', 'archive');

function getArchiveDir(): string {
  const config = loadConfig();
  return config.sessions?.archive_dir || DEFAULT_ARCHIVE_DIR;
}

interface SessionMeta {
  id: string;            // key used in read/search (filename or dirname)
  sessionId?: string;    // full UUID
  project: string;
  format: 'single' | 'chunked';
  filePaths: string[];   // absolute paths to all MD files for this session
  totalLines?: number;
  modifiedAt: string;
  snippet: string;
  sizeBytes: number;
}

/**
 * Parse YAML frontmatter from MD content.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return meta;
}

/**
 * Extract the first user message as a snippet.
 */
function extractSnippet(content: string): string {
  const match = content.match(/### User \[L:\d+\]\n([\s\S]*?)(?=\n###|\n---|$)/);
  if (!match) return '';
  let text = match[1].replace(/<context>[\s\S]*?<\/context>/g, '').trim();
  return text.slice(0, 200);
}

/**
 * Extract project name from frontmatter or content heuristics.
 */
function extractProject(content: string, filename: string): string {
  // Try frontmatter
  const meta = parseFrontmatter(content);
  if (meta.project) return meta.project;

  // Try to extract from file paths mentioned in content
  const pathMatch = content.match(/`\/Users\/\w+\/Documents\/GitHub\/([^/]+)\//);
  if (pathMatch) return pathMatch[1];

  // Fallback: UUID-like filename → "unknown"
  if (filename.match(/^[0-9a-f]{8}-/)) return 'unknown';

  // Legacy format: {project}-{shortId}
  const lastDash = filename.lastIndexOf('-');
  return lastDash > 0 ? filename.slice(0, lastDash) : filename;
}

/**
 * Discover all sessions from the archive directory.
 */
function listSessions(): SessionMeta[] {
  const archiveDir = getArchiveDir();
  if (!existsSync(archiveDir)) return [];

  const sessions: SessionMeta[] = [];
  const entries = readdirSync(archiveDir);

  for (const entry of entries) {
    const fullPath = join(archiveDir, entry);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }

    if (stat.isFile() && entry.endsWith('.md')) {
      // Single-file format: {sessionId}.md
      const sessionId = entry.replace('.md', '');
      let content = '';
      try { content = readFileSync(fullPath, 'utf-8'); } catch { continue; }

      // Skip very small files (< 100 bytes)
      if (stat.size < 100) continue;

      const project = extractProject(content, entry);
      const snippet = extractSnippet(content);

      sessions.push({
        id: sessionId,
        sessionId,
        project,
        format: 'single',
        filePaths: [fullPath],
        totalLines: undefined,
        modifiedAt: stat.mtime.toISOString(),
        snippet,
        sizeBytes: stat.size,
      });

    } else if (stat.isDirectory()) {
      // Chunked format: {project}-{shortId}/NNN.md
      const files = readdirSync(fullPath)
        .filter(f => f.endsWith('.md'))
        .sort()
        .map(f => join(fullPath, f));

      if (files.length === 0) continue;

      const lastDash = entry.lastIndexOf('-');
      let project = lastDash > 0 ? entry.slice(0, lastDash) : entry;
      const shortId = lastDash > 0 ? entry.slice(lastDash + 1) : '';

      // Read first chunk for metadata
      let sessionId: string | undefined;
      let totalLines: number | undefined;
      let snippet = '';

      try {
        const firstContent = readFileSync(files[0], 'utf-8');
        const meta = parseFrontmatter(firstContent);
        sessionId = meta.session;
        totalLines = parseInt(meta.total_lines) || undefined;
        if (meta.project) project = meta.project;
        snippet = extractSnippet(firstContent);
      } catch {}

      // Get total_lines from last chunk
      if (files.length > 1) {
        try {
          const lastContent = readFileSync(files[files.length - 1], 'utf-8');
          const meta = parseFrontmatter(lastContent);
          if (meta.total_lines) totalLines = parseInt(meta.total_lines);
        } catch {}
      }

      let modifiedAt = '';
      let totalSize = 0;
      try {
        const lastStat = statSync(files[files.length - 1]);
        modifiedAt = lastStat.mtime.toISOString();
        for (const f of files) {
          try { totalSize += statSync(f).size; } catch {}
        }
      } catch {}

      sessions.push({
        id: entry,
        sessionId,
        project,
        format: 'chunked',
        filePaths: files,
        totalLines,
        modifiedAt,
        snippet,
        sizeBytes: totalSize,
      });
    }
  }

  // Deduplicate: if both single-file and chunked exist for same session, prefer single
  const bySessionId = new Map<string, SessionMeta>();
  const noId: SessionMeta[] = [];

  for (const s of sessions) {
    if (s.sessionId) {
      const existing = bySessionId.get(s.sessionId);
      if (!existing || s.format === 'single') {
        bySessionId.set(s.sessionId, s);
      }
    } else {
      noId.push(s);
    }
  }

  return [...bySessionId.values(), ...noId]
    .sort((a, b) => (b.modifiedAt || '').localeCompare(a.modifiedAt || ''));
}

// ── Parsing helpers ──────────────────────────────────────

type ExtractMode = 'edits' | 'errors' | 'user_messages';

/** Split MD content into sections by ### headings */
function parseSections(content: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = [];
  const re = /^### (.+)$/gm;
  let match: RegExpExecArray | null;
  let lastIdx = 0;
  let lastHeading = '';

  while ((match = re.exec(content)) !== null) {
    if (lastHeading) {
      sections.push({ heading: lastHeading, body: content.slice(lastIdx, match.index).trim() });
    }
    lastHeading = match[1];
    lastIdx = match.index + match[0].length;
  }
  if (lastHeading) {
    sections.push({ heading: lastHeading, body: content.slice(lastIdx).trim() });
  }
  return sections;
}

/** Extract content by mode from raw MD */
function extractByMode(content: string, mode: ExtractMode): string {
  const sections = parseSections(content);

  if (mode === 'user_messages') {
    return sections
      .filter(s => s.heading.startsWith('User ['))
      .map(s => {
        const text = s.body.replace(/<context>[\s\S]*?<\/context>/g, '').trim();
        return `### ${s.heading}\n${text}`;
      })
      .join('\n\n');
  }

  if (mode === 'edits') {
    return sections
      .filter(s => s.heading === 'Edit' || s.heading === 'Write' || s.heading === 'MultiEdit')
      .map(s => `### ${s.heading}\n${s.body}`)
      .join('\n\n');
  }

  if (mode === 'errors') {
    const errorPatterns = /error|failed|exception|panic|traceback|ENOENT|EACCES|ERR!|fatal|Cannot find|not found|denied/i;
    const errorSections: string[] = [];

    for (const s of sections) {
      if (s.heading.startsWith('Bash') || s.heading === 'Error') {
        // Check if output contains error patterns
        if (errorPatterns.test(s.body)) {
          errorSections.push(`### ${s.heading}\n${s.body}`);
        }
      }
    }
    return errorSections.join('\n\n') || 'No errors found in this session.';
  }

  return content;
}

/** Structured stats extracted from session content */
export interface SessionStats {
  sessionCount: number;
  totalUserTurns: number;
  totalAssistantTurns: number;
  toolUsage: Record<string, number>;
  filesTouched: string[];
  projects: string[];
  dateRange: { first: string; last: string };
  totalSizeKB: number;
  bashCommands: string[];
  errorCount: number;
}

/** Parse stats from one session's content */
function parseSessionStats(content: string): Omit<SessionStats, 'sessionCount' | 'projects' | 'dateRange' | 'totalSizeKB'> {
  const sections = parseSections(content);

  let userTurns = 0;
  let assistantTurns = 0;
  const toolCounts: Record<string, number> = {};
  const files = new Set<string>();
  const bashCmds: string[] = [];
  let errorCount = 0;

  const errorPatterns = /error|failed|exception|panic|traceback|ENOENT|EACCES|ERR!|fatal/i;

  for (const s of sections) {
    if (s.heading.startsWith('User [')) {
      userTurns++;
    } else if (s.heading.startsWith('Assistant [')) {
      assistantTurns++;
    } else if (/^(Bash|Read|Edit|Write|MultiEdit|Glob|Grep|Todos|Agent|ToolSearch|Error|TodoWrite|Skill)\b/.test(s.heading)) {
      // Tool section — extract tool name
      const toolName = s.heading.replace(/ — .*/, '').replace(/ \[.*/, '').trim();
      toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;

      // Extract file paths from Read/Edit/Write/Glob/Grep sections
      const pathMatches = s.body.matchAll(/(?<![/\w])[`"]?(\/(?:Users|home|var|tmp|src|app|lib|bin|components|pages|private)[\w./-]+\.\w+)[`"]?/g);
      for (const m of pathMatches) {
        const p = m[1];
        if (p.includes('/node_modules/') || p.includes('/.git/')) continue;
        files.add(p);
      }

      // Bash command descriptions
      if (s.heading.startsWith('Bash')) {
        const desc = s.heading.replace(/^Bash\s*—?\s*/, '').trim();
        if (desc && desc !== 'Bash') bashCmds.push(desc);
      }

      // Count errors in bash output
      if ((s.heading.startsWith('Bash') || s.heading === 'Error') && errorPatterns.test(s.body)) {
        errorCount++;
      }
    }
  }

  return {
    totalUserTurns: userTurns,
    totalAssistantTurns: assistantTurns,
    toolUsage: toolCounts,
    filesTouched: [...files],
    bashCommands: [...new Set(bashCmds)],
    errorCount,
  };
}

/** Aggregate stats across multiple sessions */
function aggregateStats(sessions: SessionMeta[], opts?: { since?: string; until?: string }): SessionStats {
  let filtered = filterByDate(sessions, opts?.since, opts?.until);

  const agg: SessionStats = {
    sessionCount: filtered.length,
    totalUserTurns: 0,
    totalAssistantTurns: 0,
    toolUsage: {},
    filesTouched: [],
    projects: [],
    dateRange: { first: '', last: '' },
    totalSizeKB: 0,
    bashCommands: [],
    errorCount: 0,
  };

  const allFiles = new Set<string>();
  const allBash = new Set<string>();
  const allProjects = new Set<string>();

  for (const session of filtered) {
    allProjects.add(session.project);
    agg.totalSizeKB += Math.round(session.sizeBytes / 1024);

    const content = session.filePaths.map(f => {
      try { return readFileSync(f, 'utf-8'); } catch { return ''; }
    }).join('\n');

    const stats = parseSessionStats(content);
    agg.totalUserTurns += stats.totalUserTurns;
    agg.totalAssistantTurns += stats.totalAssistantTurns;
    agg.errorCount += stats.errorCount;
    for (const [tool, count] of Object.entries(stats.toolUsage)) {
      agg.toolUsage[tool] = (agg.toolUsage[tool] || 0) + count;
    }
    for (const f of stats.filesTouched) allFiles.add(f);
    for (const b of stats.bashCommands) allBash.add(b);
  }

  agg.filesTouched = [...allFiles];
  agg.bashCommands = [...allBash];
  agg.projects = [...allProjects];

  if (filtered.length > 0) {
    const dates = filtered.map(s => s.modifiedAt).filter(Boolean).sort();
    agg.dateRange.first = dates[0] || '';
    agg.dateRange.last = dates[dates.length - 1] || '';
  }

  return agg;
}

/** Structured summary of a session */
export interface SessionSummary {
  id: string;
  project: string;
  goal: string;
  filesChanged: string[];
  filesRead: string[];
  keyActions: string[];
  userRequests: string[];
  outcome: string;
  errorCount: number;
  turnCount: number;
  sizeKB: number;
  modifiedAt: string;
}

/** Generate a summary for one session */
function summarizeSession(session: SessionMeta): SessionSummary {
  const content = session.filePaths.map(f => {
    try { return readFileSync(f, 'utf-8'); } catch { return ''; }
  }).join('\n');

  const sections = parseSections(content);

  // Goal = first user message (cleaned)
  const firstUser = sections.find(s => s.heading.startsWith('User ['));
  const goal = firstUser
    ? firstUser.body.replace(/<context>[\s\S]*?<\/context>/g, '').trim().slice(0, 300)
    : 'unknown';

  // Last assistant message = outcome
  const lastAssistant = [...sections].reverse().find(s => s.heading.startsWith('Assistant ['));
  const outcome = lastAssistant ? lastAssistant.body.slice(0, 300) : '';

  // Files
  const editFiles = new Set<string>();
  const readFiles = new Set<string>();
  const keyActions: string[] = [];
  let errorCount = 0;
  const errorPatterns = /error|failed|exception|panic|traceback|fatal/i;

  for (const s of sections) {
    const pathMatches = [...s.body.matchAll(/(?<![/\w])[`"]?(\/(?:Users|home|var|tmp|src|app|lib|bin|components|pages|private)[\w./-]+\.\w+)[`"]?/g)].map(m => m[1]);

    if (s.heading === 'Edit' || s.heading === 'Write' || s.heading === 'MultiEdit') {
      for (const p of pathMatches) editFiles.add(p);
      keyActions.push(`${s.heading}: ${pathMatches[0] || 'unknown file'}`);
    } else if (s.heading === 'Read') {
      for (const p of pathMatches) readFiles.add(p);
    } else if (s.heading.startsWith('Bash')) {
      const desc = s.heading.replace(/^Bash\s*—?\s*/, '').trim();
      if (desc && desc !== 'Bash') keyActions.push(`Bash: ${desc}`);
      if (errorPatterns.test(s.body)) errorCount++;
    }
  }

  // User requests (all user messages, truncated)
  const userRequests = sections
    .filter(s => s.heading.startsWith('User ['))
    .map(s => s.body.replace(/<context>[\s\S]*?<\/context>/g, '').trim().slice(0, 120))
    .filter(Boolean);

  const turnCount = sections.filter(s => s.heading.startsWith('User [')).length;

  return {
    id: session.id,
    project: session.project,
    goal,
    filesChanged: [...editFiles],
    filesRead: [...readFiles].filter(f => !editFiles.has(f)),
    keyActions: keyActions.slice(0, 30),
    userRequests: userRequests.slice(0, 20),
    outcome,
    errorCount,
    turnCount,
    sizeKB: Math.round(session.sizeBytes / 1024),
    modifiedAt: session.modifiedAt,
  };
}

/** Filter sessions by date range */
function filterByDate(sessions: SessionMeta[], since?: string, until?: string): SessionMeta[] {
  if (!since && !until) return sessions;

  return sessions.filter(s => {
    if (!s.modifiedAt) return false;
    const d = s.modifiedAt;
    if (since && d < since) return false;
    if (until && d > until) return false;
    return true;
  });
}

// ── Exported functions for new tools ────────────────────

export async function getSessionStats(opts?: {
  id?: string;
  project?: string;
  since?: string;
  until?: string;
}): Promise<SessionStats> {
  let sessions = listSessions();

  if (opts?.id) {
    const s = sessions.find(s => s.id === opts.id || s.sessionId === opts.id);
    if (!s) throw new Error(`Session not found: ${opts.id}`);
    sessions = [s];
  }

  if (opts?.project) {
    sessions = sessions.filter(s => s.project === opts.project);
  }

  return aggregateStats(sessions, { since: opts?.since, until: opts?.until });
}

export async function getSessionSummary(opts?: {
  id?: string;
  project?: string;
  since?: string;
  until?: string;
  limit?: number;
}): Promise<SessionSummary[]> {
  let sessions = listSessions();

  if (opts?.id) {
    const s = sessions.find(s => s.id === opts.id || s.sessionId === opts.id);
    if (!s) throw new Error(`Session not found: ${opts.id}`);
    return [summarizeSession(s)];
  }

  if (opts?.project) {
    sessions = sessions.filter(s => s.project === opts.project);
  }

  sessions = filterByDate(sessions, opts?.since, opts?.until);
  const limit = opts?.limit || 10;

  return sessions.slice(0, limit).map(summarizeSession);
}

export async function readSessionExtracted(id: string, extract: ExtractMode, range?: string): Promise<{
  name: string;
  content: string;
}> {
  const result = await readSessionResource(id, range);
  return {
    name: `${result.name} [${extract}]`,
    content: extractByMode(result.content, extract),
  };
}

// ── Scan ─────────────────────────────────────────────────

export async function scanSessions(): Promise<StructureDoc[]> {
  const sessions = listSessions();

  return sessions.map(s => {
    const sizeKB = Math.round(s.sizeBytes / 1024);
    const desc = s.format === 'chunked'
      ? `${s.filePaths.length} chunks, ${sizeKB}KB`
      : `${sizeKB}KB`;

    return {
      id: s.id,
      name: `${s.project} session (${desc})`,
      type: 'session',
      source: 'sessions' as const,
      parent: s.project,
      modified_at: s.modifiedAt,
      snippet: s.snippet,
    };
  });
}

// ── Search ───────────────────────────────────────────────

export async function searchSessions(query: string, limit: number, opts?: {
  since?: string;
  until?: string;
  project?: string;
}): Promise<SearchResult[]> {
  let sessions = listSessions();

  if (opts?.project) {
    sessions = sessions.filter(s => s.project === opts.project);
  }
  sessions = filterByDate(sessions, opts?.since, opts?.until);

  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (terms.length === 0) return [];

  const results: Array<SearchResult & { score: number }> = [];

  for (const session of sessions) {
    let bestScore = 0;
    let bestSnippet = session.snippet;

    for (const filePath of session.filePaths) {
      try {
        const content = readFileSync(filePath, 'utf-8').toLowerCase();
        const matchCount = terms.filter(t => content.includes(t)).length;

        if (matchCount > bestScore) {
          bestScore = matchCount;
          const termIdx = content.indexOf(terms[0]);
          if (termIdx >= 0) {
            const start = Math.max(0, termIdx - 80);
            const end = Math.min(content.length, termIdx + 120);
            bestSnippet = '...' + content.slice(start, end).replace(/\n/g, ' ') + '...';
          }
        }
      } catch {}
    }

    if (bestScore > 0) {
      const sizeKB = Math.round(session.sizeBytes / 1024);
      results.push({
        id: session.id,
        name: `${session.project} session (${sizeKB}KB)`,
        source: 'sessions',
        type: 'session',
        snippet: bestSnippet,
        modified_at: session.modifiedAt,
        score: bestScore,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, ...r }) => r);
}

// ── Read ─────────────────────────────────────────────────

export async function readSessionResource(id: string, range?: string): Promise<{
  name: string;
  content: string;
  url?: string;
}> {
  const archiveDir = getArchiveDir();

  // Find the session
  const sessions = listSessions();
  const session = sessions.find(s => s.id === id || s.sessionId === id);

  if (!session) {
    // Fallback: try direct file path
    const directFile = join(archiveDir, id.endsWith('.md') ? id : id + '.md');
    if (existsSync(directFile)) {
      const content = readFileSync(directFile, 'utf-8');
      return { name: `session ${id}`, content };
    }
    const directDir = join(archiveDir, id);
    if (existsSync(directDir) && statSync(directDir).isDirectory()) {
      const files = readdirSync(directDir).filter(f => f.endsWith('.md')).sort();
      const content = files.map(f => readFileSync(join(directDir, f), 'utf-8')).join('\n\n---\n\n');
      return { name: `session ${id}`, content };
    }
    throw new Error(`Session not found: ${id}`);
  }

  if (session.format === 'single') {
    // Single file — range not applicable (it's all one file)
    const content = readFileSync(session.filePaths[0], 'utf-8');
    const sizeKB = Math.round(content.length / 1024);
    return {
      name: `${session.project} session (${sizeKB}KB)`,
      content,
    };
  }

  // Chunked format — range selects which chunks
  const files = session.filePaths;
  let selectedFiles = files;

  if (range) {
    if (range === 'last') {
      selectedFiles = [files[files.length - 1]];
    } else if (range === 'summary' || range === 'first') {
      selectedFiles = [files[0]];
    } else if (range.includes('-')) {
      const [from, to] = range.split('-').map(Number);
      selectedFiles = files.filter((_, i) => i >= from && i <= to);
    } else {
      const idx = parseInt(range);
      if (!isNaN(idx) && files[idx]) {
        selectedFiles = [files[idx]];
      }
    }
  }

  const parts = selectedFiles.map(f => {
    try { return readFileSync(f, 'utf-8'); } catch { return ''; }
  }).filter(Boolean);

  return {
    name: `${session.project} session (${selectedFiles.length}/${files.length} chunks)`,
    content: parts.join('\n\n---\n\n'),
  };
}

// ── Session List (detailed) ──────────────────────────────

export interface SessionInfo {
  id: string;
  project: string;
  sessionId?: string;
  format: 'single' | 'chunked';
  chunks: number;
  sizeKB: number;
  totalLines?: number;
  modifiedAt: string;
  snippet: string;
}

export async function getSessionList(opts?: {
  project?: string;
  limit?: number;
}): Promise<SessionInfo[]> {
  let sessions = listSessions();

  if (opts?.project) {
    sessions = sessions.filter(s => s.project === opts.project);
  }

  const limit = opts?.limit || 50;

  return sessions.slice(0, limit).map(s => ({
    id: s.id,
    project: s.project,
    sessionId: s.sessionId,
    format: s.format,
    chunks: s.filePaths.length,
    sizeKB: Math.round(s.sizeBytes / 1024),
    totalLines: s.totalLines,
    modifiedAt: s.modifiedAt,
    snippet: s.snippet,
  }));
}
