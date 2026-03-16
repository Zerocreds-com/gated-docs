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

  // BigQuery (uses same Google SA credentials)
  if (config.sources.google?.enabled && config.sources.google.account) {
    if (hasCredential('google', config.sources.google.account)) {
      try {
        const { scanBigQuery } = await import('./connectors/bigquery.ts');
        const docs = await scanBigQuery();
        allDocs.push(...docs);
        process.stderr.write(`[scan] BigQuery: ${docs.length} datasets/tables\n`);
      } catch (e: any) {
        // BigQuery might not be enabled — that's fine
        if (!e.message?.includes('403') && !e.message?.includes('bigquery')) {
          errors.push(`BigQuery: ${e.message}`);
        }
        process.stderr.write(`[scan] BigQuery: skipped (${e.message?.slice(0, 80)})\n`);
      }
    }
  }

  // Telegram
  if (config.sources.telegram?.enabled) {
    if (hasCredential('telegram', 'default')) {
      try {
        const { scanTelegram } = await import('./connectors/telegram.ts');
        const docs = await scanTelegram();
        allDocs.push(...docs);
        process.stderr.write(`[scan] Telegram: ${docs.length} chats\n`);
      } catch (e: any) {
        errors.push(`Telegram: ${e.message}`);
        process.stderr.write(`[scan] Telegram error: ${e.message}\n`);
      }
    }
  }

  // Cloudflare
  if (config.sources.cloudflare?.enabled) {
    if (hasCredential('cloudflare', 'default')) {
      try {
        const { scanCloudflare } = await import('./connectors/cloudflare.ts');
        const docs = await scanCloudflare();
        allDocs.push(...docs);
        process.stderr.write(`[scan] Cloudflare: ${docs.length} resources\n`);
      } catch (e: any) {
        errors.push(`Cloudflare: ${e.message}`);
        process.stderr.write(`[scan] Cloudflare error: ${e.message}\n`);
      }
    }
  }

  // GitLab
  if (config.sources.gitlab?.enabled) {
    if (hasCredential('gitlab', 'default')) {
      try {
        const { scanGitLab } = await import('./connectors/gitlab.ts');
        const docs = await scanGitLab();
        allDocs.push(...docs);
        process.stderr.write(`[scan] GitLab: ${docs.length} resources\n`);
      } catch (e: any) {
        errors.push(`GitLab: ${e.message}`);
        process.stderr.write(`[scan] GitLab error: ${e.message}\n`);
      }
    }
  }

  // LangSmith
  if (config.sources.langsmith?.enabled) {
    if (hasCredential('langsmith', 'default')) {
      try {
        const { scanLangSmith } = await import('./connectors/langsmith.ts');
        const docs = await scanLangSmith();
        allDocs.push(...docs);
        process.stderr.write(`[scan] LangSmith: ${docs.length} resources\n`);
      } catch (e: any) {
        errors.push(`LangSmith: ${e.message}`);
        process.stderr.write(`[scan] LangSmith error: ${e.message}\n`);
      }
    }
  }

  // Sessions (local — no credentials needed, auto-detect if archive exists)
  {
    const sessionsEnabled = config.sources.sessions?.enabled;
    const archiveDir = config.sessions?.archive_dir
      || (await import('node:path')).join((await import('node:os')).homedir(), '.config', 'session-snapshot', 'archive');
    const archiveExists = sessionsEnabled || (await import('node:fs')).existsSync(archiveDir);

    if (archiveExists) {
      try {
        const { scanSessions } = await import('./connectors/sessions.ts');
        const docs = await scanSessions();
        allDocs.push(...docs);
        process.stderr.write(`[scan] Sessions: ${docs.length} sessions\n`);
      } catch (e: any) {
        errors.push(`Sessions: ${e.message}`);
        process.stderr.write(`[scan] Sessions error: ${e.message}\n`);
      }
    }
  }

  // Build stats
  const stats: Structure['stats'] = {} as any;
  for (const source of ['google', 'notion', 'slack', 'telegram', 'cloudflare', 'gitlab', 'langsmith', 'sessions'] as SourceType[]) {
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
