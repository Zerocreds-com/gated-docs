/**
 * Cloudflare connector — zones, DNS, Workers, Pages, D1, KV, R2.
 * Uses API Token stored in OS credential store.
 * No SDK dependency — raw fetch against CF API v4.
 */
import { getCredential } from '../keychain.ts';
import { loadStructure } from '../config.ts';
import type { SearchResult, DocContent, StructureDoc } from '../types.ts';

const CF_API = 'https://api.cloudflare.com/client/v4';

function getToken(): string {
  const token = getCredential('cloudflare', 'default');
  if (!token) throw new Error('Cloudflare not configured. Run: gated-knowledge auth cloudflare --token <api-token>');
  return token;
}

async function cfGet(path: string): Promise<any> {
  const res = await fetch(`${CF_API}${path}`, {
    headers: { 'Authorization': `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CF API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function cfPost(path: string, body: any): Promise<any> {
  const res = await fetch(`${CF_API}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CF API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Account ID ──────────────────────────────────────────

let cachedAccountId: string | null = null;

async function getAccountId(): Promise<string> {
  if (cachedAccountId) return cachedAccountId;
  const data = await cfGet('/accounts?per_page=1');
  const accounts = data.result || [];
  if (accounts.length === 0) throw new Error('No Cloudflare accounts found');
  cachedAccountId = accounts[0].id;
  return cachedAccountId!;
}

// ── Scan ────────────────────────────────────────────────

export async function scanCloudflare(): Promise<StructureDoc[]> {
  const accountId = await getAccountId();
  const docs: StructureDoc[] = [];

  // Zones + DNS record counts
  try {
    const zonesData = await cfGet('/zones?per_page=50');
    for (const zone of zonesData.result || []) {
      let dnsSnippet = '';
      try {
        const dnsData = await cfGet(`/zones/${zone.id}/dns_records?per_page=100`);
        const records = dnsData.result || [];
        const typeCounts: Record<string, number> = {};
        for (const r of records) {
          typeCounts[r.type] = (typeCounts[r.type] || 0) + 1;
        }
        const typeStr = Object.entries(typeCounts).map(([t, n]) => `${n} ${t}`).join(', ');
        dnsSnippet = `${records.length} records (${typeStr})`;
      } catch {}

      docs.push({
        id: `zone:${zone.id}`,
        name: zone.name,
        type: 'zone',
        source: 'cloudflare',
        parent: 'Zones',
        snippet: dnsSnippet || undefined,
        url: `https://dash.cloudflare.com/${accountId}/${zone.name}`,
      });
    }
  } catch (e: any) {
    process.stderr.write(`[scan] CF zones: ${e.message?.slice(0, 80)}\n`);
  }

  // Workers
  try {
    const workersData = await cfGet(`/accounts/${accountId}/workers/scripts`);
    for (const w of workersData.result || []) {
      docs.push({
        id: `worker:${w.id}`,
        name: w.id,
        type: 'worker',
        source: 'cloudflare',
        parent: 'Workers',
        modified_at: w.modified_on || undefined,
      });
    }
  } catch (e: any) {
    process.stderr.write(`[scan] CF workers: ${e.message?.slice(0, 80)}\n`);
  }

  // Pages projects
  try {
    const pagesData = await cfGet(`/accounts/${accountId}/pages/projects`);
    for (const p of pagesData.result || []) {
      const domains = p.domains?.join(', ') || p.subdomain || '';
      docs.push({
        id: `pages:${p.name}`,
        name: p.name,
        type: 'pages_project',
        source: 'cloudflare',
        parent: 'Pages',
        snippet: domains ? `domains: ${domains}` : undefined,
        modified_at: p.latest_deployment?.modified_on || undefined,
      });
    }
  } catch (e: any) {
    process.stderr.write(`[scan] CF pages: ${e.message?.slice(0, 80)}\n`);
  }

  // D1 databases + table schemas
  try {
    const d1Data = await cfGet(`/accounts/${accountId}/d1/database?per_page=50`);
    for (const db of d1Data.result || []) {
      let tablesSnippet = '';
      try {
        const tablesRes = await cfPost(`/accounts/${accountId}/d1/database/${db.uuid}/query`, {
          sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
        });
        const tables = tablesRes.result?.[0]?.results || [];
        const tableNames: string[] = tables.map((t: any) => t.name);

        // Schema for each table (max 10)
        const tableInfos: string[] = [];
        for (const tableName of tableNames.slice(0, 10)) {
          try {
            const schemaRes = await cfPost(`/accounts/${accountId}/d1/database/${db.uuid}/query`, {
              sql: `PRAGMA table_info('${tableName}')`,
            });
            const cols = schemaRes.result?.[0]?.results || [];
            const colNames = cols.map((c: any) => c.name).join(', ');
            tableInfos.push(`${tableName}(${colNames})`);
          } catch {
            tableInfos.push(tableName);
          }
        }

        tablesSnippet = tableInfos.join(' | ');
        if (tableNames.length > 10) tablesSnippet += ` +${tableNames.length - 10} more`;
      } catch {}

      docs.push({
        id: `d1:${db.uuid}`,
        name: db.name,
        type: 'd1_database',
        source: 'cloudflare',
        parent: 'D1',
        snippet: tablesSnippet || undefined,
      });
    }
  } catch (e: any) {
    process.stderr.write(`[scan] CF D1: ${e.message?.slice(0, 80)}\n`);
  }

  // KV namespaces
  try {
    const kvData = await cfGet(`/accounts/${accountId}/storage/kv/namespaces?per_page=50`);
    for (const ns of kvData.result || []) {
      docs.push({
        id: `kv:${ns.id}`,
        name: ns.title,
        type: 'kv_namespace',
        source: 'cloudflare',
        parent: 'KV',
      });
    }
  } catch (e: any) {
    process.stderr.write(`[scan] CF KV: ${e.message?.slice(0, 80)}\n`);
  }

  // R2 buckets
  try {
    const r2Data = await cfGet(`/accounts/${accountId}/r2/buckets`);
    const buckets = r2Data.result?.buckets || r2Data.result || [];
    for (const b of (Array.isArray(buckets) ? buckets : [])) {
      docs.push({
        id: `r2:${b.name}`,
        name: b.name,
        type: 'r2_bucket',
        source: 'cloudflare',
        parent: 'R2',
      });
    }
  } catch (e: any) {
    process.stderr.write(`[scan] CF R2: ${e.message?.slice(0, 80)}\n`);
  }

  return docs;
}

// ── Search ──────────────────────────────────────────────

export async function searchCloudflare(query: string, limit: number = 10): Promise<SearchResult[]> {
  // CF has no global search API — filter structure locally
  const structure = loadStructure();
  if (!structure) return [];

  const q = query.toLowerCase();
  return structure.docs
    .filter(d => d.source === 'cloudflare' && (
      d.name.toLowerCase().includes(q) ||
      d.type.toLowerCase().includes(q) ||
      d.snippet?.toLowerCase().includes(q) ||
      d.parent?.toLowerCase().includes(q)
    ))
    .slice(0, limit)
    .map(d => ({
      id: d.id,
      name: d.name,
      source: 'cloudflare' as const,
      type: d.type,
      snippet: d.snippet || '',
      url: d.url,
    }));
}

// ── Read resource ───────────────────────────────────────

export async function readCloudflareResource(id: string): Promise<DocContent> {
  const colonIdx = id.indexOf(':');
  if (colonIdx === -1) throw new Error(`Invalid CF resource ID. Expected type:id (e.g. zone:abc123)`);
  const type = id.slice(0, colonIdx);
  const resourceId = id.slice(colonIdx + 1);
  const accountId = await getAccountId();

  switch (type) {
    case 'zone': return readZone(resourceId, accountId);
    case 'worker': return readWorker(resourceId, accountId);
    case 'pages': return readPagesProject(resourceId, accountId);
    case 'd1': return readD1Database(resourceId, accountId);
    case 'kv': return readKvNamespace(resourceId, accountId);
    case 'r2': return readR2Bucket(resourceId, accountId);
    default:
      throw new Error(`Unknown CF resource type: ${type}. Expected zone/worker/pages/d1/kv/r2`);
  }
}

async function readZone(zoneId: string, accountId: string): Promise<DocContent> {
  const [zoneData, dnsData] = await Promise.all([
    cfGet(`/zones/${zoneId}`),
    cfGet(`/zones/${zoneId}/dns_records?per_page=100`),
  ]);

  const zone = zoneData.result;
  const records = dnsData.result || [];

  const lines: string[] = [];
  lines.push(`Zone: ${zone.name}`);
  lines.push(`Status: ${zone.status}`);
  lines.push(`Plan: ${zone.plan?.name || 'unknown'}`);
  if (zone.name_servers?.length) lines.push(`Nameservers: ${zone.name_servers.join(', ')}`);
  lines.push('');
  lines.push(`## DNS Records (${records.length})`);

  const byType = new Map<string, any[]>();
  for (const r of records) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type)!.push(r);
  }

  for (const [rType, recs] of byType) {
    lines.push('');
    lines.push(`### ${rType} (${recs.length})`);
    for (const r of recs) {
      const proxied = r.proxied ? ' [proxied]' : '';
      const ttl = r.ttl === 1 ? 'Auto' : `${r.ttl}s`;
      lines.push(`  ${r.name} → ${r.content}${proxied} (TTL: ${ttl})`);
    }
  }

  return {
    id: `zone:${zoneId}`, name: zone.name, source: 'cloudflare', type: 'zone',
    content: lines.join('\n'),
    url: `https://dash.cloudflare.com/${accountId}/${zone.name}/dns`,
  };
}

async function readWorker(scriptName: string, accountId: string): Promise<DocContent> {
  const lines: string[] = [];
  lines.push(`Worker: ${scriptName}`);

  // Bindings
  try {
    const settings = await cfGet(`/accounts/${accountId}/workers/scripts/${scriptName}/settings`);
    const bindings = settings.result?.bindings || [];
    if (bindings.length) {
      lines.push('');
      lines.push('## Bindings');
      for (const b of bindings) {
        const extra = b.namespace_id ? ` (${b.namespace_id})` : b.database_id ? ` (${b.database_id})` : '';
        lines.push(`  ${b.name}: ${b.type}${extra}`);
      }
    }
  } catch {}

  // Custom domains
  try {
    const domains = await cfGet(`/accounts/${accountId}/workers/domains?service=${scriptName}`);
    if (domains.result?.length) {
      lines.push('');
      lines.push('## Custom Domains');
      for (const d of domains.result) {
        lines.push(`  ${d.hostname}`);
      }
    }
  } catch {}

  return {
    id: `worker:${scriptName}`, name: scriptName, source: 'cloudflare', type: 'worker',
    content: lines.join('\n'),
    url: `https://dash.cloudflare.com/${accountId}/workers/services/view/${scriptName}`,
  };
}

async function readPagesProject(projectName: string, accountId: string): Promise<DocContent> {
  const data = await cfGet(`/accounts/${accountId}/pages/projects/${projectName}`);
  const p = data.result;

  const lines: string[] = [];
  lines.push(`Pages Project: ${p.name}`);
  lines.push(`Subdomain: ${p.subdomain}`);
  if (p.domains?.length) lines.push(`Domains: ${p.domains.join(', ')}`);
  if (p.source?.config) {
    const c = p.source.config;
    lines.push(`Source: ${c.owner}/${c.repo_name} (${c.production_branch})`);
  }

  if (p.latest_deployment) {
    const d = p.latest_deployment;
    lines.push('');
    lines.push('## Latest Deployment');
    lines.push(`  URL: ${d.url}`);
    lines.push(`  Environment: ${d.environment}`);
    lines.push(`  Created: ${d.created_on}`);
  }

  if (p.deployment_configs?.production?.env_vars) {
    lines.push('');
    lines.push('## Env Vars (production, names only)');
    for (const key of Object.keys(p.deployment_configs.production.env_vars)) {
      lines.push(`  ${key}`);
    }
  }

  return {
    id: `pages:${projectName}`, name: projectName, source: 'cloudflare', type: 'pages_project',
    content: lines.join('\n'),
    url: `https://dash.cloudflare.com/${accountId}/pages/view/${projectName}`,
  };
}

async function readD1Database(dbId: string, accountId: string): Promise<DocContent> {
  const dbData = await cfGet(`/accounts/${accountId}/d1/database/${dbId}`);
  const db = dbData.result;

  const lines: string[] = [];
  lines.push(`D1 Database: ${db.name}`);
  lines.push(`UUID: ${db.uuid}`);
  if (db.file_size) lines.push(`Size: ${formatBytes(db.file_size)}`);

  try {
    const tablesRes = await cfPost(`/accounts/${accountId}/d1/database/${dbId}/query`, {
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    });
    const tables = tablesRes.result?.[0]?.results || [];

    for (const table of tables) {
      lines.push('');
      lines.push(`## ${table.name}`);
      try {
        const schemaRes = await cfPost(`/accounts/${accountId}/d1/database/${dbId}/query`, {
          sql: `PRAGMA table_info('${table.name}')`,
        });
        const cols = schemaRes.result?.[0]?.results || [];
        for (const col of cols) {
          const pk = col.pk ? ' PK' : '';
          const nn = col.notnull ? ' NOT NULL' : '';
          lines.push(`  ${col.name}: ${col.type || 'TEXT'}${pk}${nn}`);
        }

        const countRes = await cfPost(`/accounts/${accountId}/d1/database/${dbId}/query`, {
          sql: `SELECT COUNT(*) as count FROM "${table.name}"`,
        });
        const count = countRes.result?.[0]?.results?.[0]?.count;
        if (count !== undefined) lines.push(`  (${Number(count).toLocaleString()} rows)`);
      } catch {}
    }
  } catch {}

  return {
    id: `d1:${dbId}`, name: db.name, source: 'cloudflare', type: 'd1_database',
    content: lines.join('\n'),
  };
}

async function readKvNamespace(nsId: string, accountId: string): Promise<DocContent> {
  const structure = loadStructure();
  const doc = structure?.docs.find(d => d.id === `kv:${nsId}`);
  const title = doc?.name || nsId;

  const keysData = await cfGet(`/accounts/${accountId}/storage/kv/namespaces/${nsId}/keys?limit=100`);
  const keys = keysData.result || [];

  const lines: string[] = [];
  lines.push(`KV Namespace: ${title}`);
  lines.push(`ID: ${nsId}`);
  lines.push(`Keys shown: ${keys.length}`);
  lines.push('');

  for (const k of keys) {
    const exp = k.expiration ? ` (exp: ${new Date(k.expiration * 1000).toISOString().slice(0, 10)})` : '';
    lines.push(`  ${k.name}${exp}`);
  }

  if (keysData.result_info?.count > keys.length) {
    lines.push(`  ... +${keysData.result_info.count - keys.length} more`);
  }

  return {
    id: `kv:${nsId}`, name: title, source: 'cloudflare', type: 'kv_namespace',
    content: lines.join('\n'),
  };
}

async function readR2Bucket(bucketName: string, accountId: string): Promise<DocContent> {
  const lines: string[] = [];
  lines.push(`R2 Bucket: ${bucketName}`);

  try {
    const data = await cfGet(`/accounts/${accountId}/r2/buckets/${bucketName}`);
    const b = data.result;
    if (b.location) lines.push(`Location: ${b.location}`);
    if (b.creation_date) lines.push(`Created: ${b.creation_date}`);
  } catch {}

  return {
    id: `r2:${bucketName}`, name: bucketName, source: 'cloudflare', type: 'r2_bucket',
    content: lines.join('\n'),
  };
}

// ── D1 Query (text2sql) ────────────────────────────────

export async function runD1Query(databaseNameOrId: string, sql: string): Promise<string> {
  const accountId = await getAccountId();

  // Resolve name → UUID if needed
  let dbId = databaseNameOrId;
  if (!databaseNameOrId.match(/^[0-9a-f]{8}-/)) {
    const structure = loadStructure();
    const doc = structure?.docs.find(d =>
      d.source === 'cloudflare' && d.type === 'd1_database' &&
      d.name.toLowerCase() === databaseNameOrId.toLowerCase()
    );
    if (doc) {
      dbId = doc.id.replace('d1:', '');
    } else {
      throw new Error(`D1 database "${databaseNameOrId}" not found. Run: gated-knowledge scan`);
    }
  }

  const res = await cfPost(`/accounts/${accountId}/d1/database/${dbId}/query`, { sql });
  const result = res.result?.[0];
  if (!result) return 'No results';

  const rows = result.results || [];
  if (rows.length === 0) {
    return `Query OK. ${result.meta?.changes || 0} rows affected.`;
  }

  const headers = Object.keys(rows[0]);
  const lines: string[] = [];
  lines.push(headers.join('\t'));
  lines.push(headers.map(h => '-'.repeat(h.length)).join('\t'));

  for (const row of rows) {
    lines.push(headers.map(h => String(row[h] ?? 'NULL')).join('\t'));
  }

  if (result.meta) {
    lines.push('');
    if (result.meta.rows_read) lines.push(`Rows read: ${result.meta.rows_read}`);
    if (result.meta.duration) lines.push(`Duration: ${result.meta.duration}ms`);
  }

  return lines.join('\n');
}

// ── Utils ───────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
