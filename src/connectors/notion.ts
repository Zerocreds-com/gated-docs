/**
 * Notion connector — searches databases and pages.
 * Uses Notion API key stored in macOS Keychain.
 */
import { getCredential } from '../keychain.ts';
import type { SearchResult, DocContent, StructureDoc } from '../types.ts';

function getToken(): string {
  const token = getCredential('notion', 'default');
  if (!token) throw new Error('Notion not configured. Run: gated-docs auth notion --token <your-api-key>');
  return token;
}

async function notionFetch(path: string, body?: Record<string, unknown>): Promise<any> {
  const token = getToken();
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API error ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// ── Scan ─────────────────────────────────────────────────

export async function scanNotion(): Promise<StructureDoc[]> {
  const docs: StructureDoc[] = [];
  let startCursor: string | undefined;

  do {
    const res = await notionFetch('/search', {
      filter: { property: 'object', value: 'page' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 100,
      ...(startCursor ? { start_cursor: startCursor } : {}),
    });

    for (const page of res.results || []) {
      const title = extractNotionTitle(page);
      docs.push({
        id: page.id,
        name: title || 'Untitled',
        type: page.parent?.type === 'database_id' ? 'database-page' : 'page',
        source: 'notion',
        parent: page.parent?.database_id ? `db:${page.parent.database_id}` : undefined,
        modified_at: page.last_edited_time,
        url: page.url,
      });
    }

    startCursor = res.has_more ? res.next_cursor : undefined;
  } while (startCursor);

  // Also list databases
  let dbCursor: string | undefined;
  do {
    const res = await notionFetch('/search', {
      filter: { property: 'object', value: 'database' },
      page_size: 100,
      ...(dbCursor ? { start_cursor: dbCursor } : {}),
    });

    for (const db of res.results || []) {
      const title = extractNotionTitle(db);
      docs.push({
        id: db.id,
        name: title || 'Untitled Database',
        type: 'database',
        source: 'notion',
        modified_at: db.last_edited_time,
        url: db.url,
      });
    }

    dbCursor = res.has_more ? res.next_cursor : undefined;
  } while (dbCursor);

  return docs;
}

// ── Search ──────────────────────────────────────────────

export async function searchNotion(query: string, limit: number = 10): Promise<SearchResult[]> {
  const res = await notionFetch('/search', {
    query,
    page_size: Math.min(limit, 100),
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
  });

  return (res.results || []).map((item: any) => ({
    id: item.id,
    name: extractNotionTitle(item) || 'Untitled',
    source: 'notion' as const,
    type: item.object === 'database' ? 'database' : 'page',
    snippet: '',
    url: item.url,
    modified_at: item.last_edited_time,
  }));
}

// ── Read ────────────────────────────────────────────────

export async function readNotionPage(pageId: string): Promise<DocContent> {
  const page = await notionFetch(`/pages/${pageId}`);
  const title = extractNotionTitle(page) || 'Untitled';

  // Get page content (blocks)
  const blocks = await notionFetch(`/blocks/${pageId}/children?page_size=100`);
  const content = (blocks.results || [])
    .map((b: any) => extractBlockText(b))
    .filter(Boolean)
    .join('\n');

  return {
    id: pageId,
    name: title,
    source: 'notion',
    type: 'page',
    content: content || '(empty page)',
    url: page.url,
  };
}

// ── Utils ────────────────────────────────────────────────

function extractNotionTitle(obj: any): string {
  // Pages
  const props = obj.properties || {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop.type === 'title' && prop.title?.length) {
      return prop.title.map((t: any) => t.plain_text).join('');
    }
  }
  // Databases
  if (obj.title?.length) {
    return obj.title.map((t: any) => t.plain_text).join('');
  }
  return '';
}

function extractBlockText(block: any): string {
  const type = block.type;
  const data = block[type];
  if (!data) return '';

  if (data.rich_text) {
    const text = data.rich_text.map((t: any) => t.plain_text).join('');
    if (type === 'heading_1') return `# ${text}`;
    if (type === 'heading_2') return `## ${text}`;
    if (type === 'heading_3') return `### ${text}`;
    if (type === 'bulleted_list_item') return `- ${text}`;
    if (type === 'numbered_list_item') return `1. ${text}`;
    if (type === 'to_do') return `- [${data.checked ? 'x' : ' '}] ${text}`;
    if (type === 'code') return `\`\`\`\n${text}\n\`\`\``;
    return text;
  }

  if (type === 'divider') return '---';
  return '';
}
