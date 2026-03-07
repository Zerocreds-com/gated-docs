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

  parts.push('Use when you need data from Google Sheets, Docs, Notion pages, Slack or Telegram messages.');
  parts.push('Specify source parameter to narrow search to google/notion/slack/telegram.');

  return parts.join('\n');
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
