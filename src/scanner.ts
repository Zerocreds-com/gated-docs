/**
 * Scanner — crawls all connected sources, builds structure.json.
 * Structure is used to generate dynamic MCP tool descriptions.
 */
import { loadConfig, saveStructure } from './config.ts';
import { hasCredential } from './keychain.ts';
import { generateDescription } from './description.ts';
import type { StructureDoc, Structure, SourceType } from './types.ts';

export async function scan(): Promise<Structure> {
  const config = loadConfig();
  const allDocs: StructureDoc[] = [];
  const errors: string[] = [];

  // Google
  if (config.sources.google?.enabled && config.sources.google.account) {
    if (hasCredential('google', config.sources.google.account)) {
      try {
        const { scanGoogleDrive } = await import('./connectors/google.ts');
        const docs = await scanGoogleDrive();
        allDocs.push(...docs);
        process.stderr.write(`[scan] Google: ${docs.length} documents\n`);
      } catch (e: any) {
        errors.push(`Google: ${e.message}`);
        process.stderr.write(`[scan] Google error: ${e.message}\n`);
      }
    } else {
      process.stderr.write(`[scan] Google: credentials not found in keychain\n`);
    }
  }

  // Notion
  if (config.sources.notion?.enabled) {
    if (hasCredential('notion', 'default')) {
      try {
        const { scanNotion } = await import('./connectors/notion.ts');
        const docs = await scanNotion();
        allDocs.push(...docs);
        process.stderr.write(`[scan] Notion: ${docs.length} pages\n`);
      } catch (e: any) {
        errors.push(`Notion: ${e.message}`);
        process.stderr.write(`[scan] Notion error: ${e.message}\n`);
      }
    }
  }

  // Slack
  if (config.sources.slack?.enabled) {
    if (hasCredential('slack', 'default')) {
      try {
        const { scanSlack } = await import('./connectors/slack.ts');
        const docs = await scanSlack();
        allDocs.push(...docs);
        process.stderr.write(`[scan] Slack: ${docs.length} channels\n`);
      } catch (e: any) {
        errors.push(`Slack: ${e.message}`);
        process.stderr.write(`[scan] Slack error: ${e.message}\n`);
      }
    }
  }

  // Build stats
  const stats: Structure['stats'] = {} as any;
  for (const source of ['google', 'notion', 'slack'] as SourceType[]) {
    const sourceDocs = allDocs.filter(d => d.source === source);
    if (sourceDocs.length === 0) continue;

    const types: Record<string, number> = {};
    for (const d of sourceDocs) {
      types[d.type] = (types[d.type] || 0) + 1;
    }
    stats[source] = { count: sourceDocs.length, types };
  }

  const structure: Structure = {
    generated_at: new Date().toISOString(),
    docs: allDocs,
    stats,
    mcp_description: generateDescription(allDocs, stats),
  };

  saveStructure(structure);

  if (errors.length) {
    process.stderr.write(`[scan] Errors: ${errors.join('; ')}\n`);
  }

  process.stderr.write(`[scan] Done: ${allDocs.length} total documents\n`);
  return structure;
}
