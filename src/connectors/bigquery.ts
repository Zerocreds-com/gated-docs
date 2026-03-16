/**
 * BigQuery connector — run queries, list datasets/tables/jobs.
 * Auth priority: SA credentials → ADC (application default credentials).
 * ADC is useful when org policy blocks SA key creation.
 */
import { google, type bigquery_v2 } from 'googleapis';
import { getServiceAccountCredentials } from '../keychain.ts';
import { loadConfig } from '../config.ts';
import type { SearchResult, StructureDoc } from '../types.ts';

function getAuth() {
  const config = loadConfig();
  const account = config.sources.google?.account;
  const impersonate = config.google_impersonate;

  // SA + Domain-Wide Delegation — impersonate user for cross-project access
  if (account && impersonate) {
    const credentials = getServiceAccountCredentials(account);
    if (credentials) {
      return new google.auth.JWT({
        email: (credentials as any).client_email,
        key: (credentials as any).private_key,
        scopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
        subject: impersonate,
      });
    }
  }

  // SA without impersonation (same project)
  if (!config.bigquery_project && account) {
    const credentials = getServiceAccountCredentials(account);
    if (credentials) {
      return new google.auth.GoogleAuth({
        credentials: credentials as any,
        scopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
      });
    }
  }

  // ADC fallback (~/.config/gcloud/application_default_credentials.json)
  return new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
  });
}

function getBQ(): bigquery_v2.Bigquery {
  return google.bigquery({ version: 'v2', auth: getAuth() });
}

function getProjectId(): string {
  const config = loadConfig();

  // Config override (for cross-project queries)
  if (config.bigquery_project) return config.bigquery_project;

  // SA project
  const account = config.sources.google?.account;
  if (account) {
    const credentials = getServiceAccountCredentials(account);
    if ((credentials as any)?.project_id) return (credentials as any).project_id;
  }

  // ADC — try gcloud default project
  try {
    const { execSync } = require('node:child_process');
    return execSync('gcloud config get-value project', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {}

  return '';
}

// ── Scan: list datasets and tables with schemas ─────────

export async function scanBigQuery(): Promise<StructureDoc[]> {
  const bq = getBQ();
  const projectId = getProjectId();
  const docs: StructureDoc[] = [];

  const datasets = await bq.datasets.list({ projectId });

  for (const ds of datasets.data.datasets || []) {
    const datasetId = ds.datasetReference?.datasetId;
    if (!datasetId) continue;

    docs.push({
      id: `${projectId}.${datasetId}`,
      name: datasetId,
      type: 'dataset',
      source: 'google',
      parent: 'BigQuery',
    });

    // List tables + fetch schema for each
    try {
      const tables = await bq.tables.list({ projectId, datasetId, maxResults: 50 });
      for (const t of tables.data.tables || []) {
        const tableId = t.tableReference?.tableId;
        if (!tableId) continue;

        const rowCount = t.numRows ? Number(t.numRows) : 0;
        const rowStr = rowCount ? `${rowCount.toLocaleString()} rows` : '';

        // Freshness from last modified time
        const modifiedMs = t.creationTime ? Number(t.creationTime) : 0;
        let freshness = '';
        let modifiedAt: string | undefined;
        try {
          // tables.list gives creationTime, get gives lastModifiedTime
          const detail = await bq.tables.get({ projectId, datasetId, tableId });
          const lastMod = detail.data.lastModifiedTime ? Number(detail.data.lastModifiedTime) : 0;
          if (lastMod) {
            modifiedAt = new Date(lastMod).toISOString();
            freshness = formatAge(lastMod);
          }

          // Schema — compact column list
          const fields = detail.data.schema?.fields || [];
          const cols = fields.map(f => `${f.name}(${shortType(f.type || '?')})`).join(', ');

          const parts = [cols ? `columns: ${cols}` : '', rowStr, freshness].filter(Boolean);

          docs.push({
            id: `${projectId}.${datasetId}.${tableId}`,
            name: tableId,
            type: t.type === 'VIEW' ? 'view' : 'table',
            source: 'google',
            parent: `BigQuery/${datasetId}`,
            snippet: parts.join(' | ') || undefined,
            modified_at: modifiedAt,
          });
        } catch {
          // Fallback without schema
          docs.push({
            id: `${projectId}.${datasetId}.${tableId}`,
            name: tableId,
            type: t.type === 'VIEW' ? 'view' : 'table',
            source: 'google',
            parent: `BigQuery/${datasetId}`,
            snippet: rowStr || undefined,
          });
        }
      }
    } catch {} // skip datasets we can't list
  }

  return docs;
}

function shortType(t: string): string {
  const map: Record<string, string> = {
    STRING: 'STR', INTEGER: 'INT', INT64: 'INT', FLOAT: 'FLOAT', FLOAT64: 'FLOAT',
    BOOLEAN: 'BOOL', BOOL: 'BOOL', TIMESTAMP: 'TS', DATE: 'DATE', DATETIME: 'DT',
    RECORD: 'REC', BYTES: 'BYTES', NUMERIC: 'NUM', BIGNUMERIC: 'BIGNUM', JSON: 'JSON',
  };
  return map[t] || t;
}

function formatAge(timestampMs: number): string {
  const age = Date.now() - timestampMs;
  const mins = Math.floor(age / 60000);
  if (mins < 60) return `updated ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `updated ${days}d ago`;
  return `updated ${Math.floor(days / 30)}mo ago`;
}

// ── Run a query ─────────────────────────────────────────

export async function runQuery(sql: string, maxRows: number = 100): Promise<string> {
  const bq = getBQ();
  const projectId = getProjectId();

  const res = await bq.jobs.query({
    projectId,
    requestBody: {
      query: sql,
      useLegacySql: false,
      maxResults: maxRows,
      timeoutMs: 30000,
    },
  });

  if (!res.data.jobComplete) {
    // Job still running — get job ID for follow-up
    const jobId = res.data.jobReference?.jobId;
    return `Query started but not complete yet. Job ID: ${jobId}\nUse bigquery_job to check status.`;
  }

  const schema = res.data.schema?.fields || [];
  const rows = res.data.rows || [];
  const totalRows = res.data.totalRows || '0';

  // Format as table
  const headers = schema.map(f => f.name || '?');
  const lines: string[] = [];
  lines.push(headers.join('\t'));
  lines.push(headers.map(h => '-'.repeat(h.length)).join('\t'));

  for (const row of rows) {
    const values = (row.f || []).map((cell: any) => cell.v ?? 'NULL');
    lines.push(values.join('\t'));
  }

  if (Number(totalRows) > rows.length) {
    lines.push(`\n... showing ${rows.length} of ${totalRows} total rows`);
  }

  const bytesProcessed = res.data.totalBytesProcessed;
  if (bytesProcessed) {
    lines.push(`\nBytes processed: ${formatBytes(Number(bytesProcessed))}`);
  }

  return lines.join('\n');
}

// ── List datasets ───────────────────────────────────────

export async function listDatasets(): Promise<string> {
  const bq = getBQ();
  const projectId = getProjectId();

  const res = await bq.datasets.list({ projectId });
  const datasets = res.data.datasets || [];

  if (datasets.length === 0) return 'No datasets found.';

  const lines = datasets.map(ds => {
    const id = ds.datasetReference?.datasetId || '?';
    const loc = ds.location || '?';
    return `  ${id} (${loc})`;
  });

  return `Datasets in ${projectId}:\n${lines.join('\n')}`;
}

// ── List tables in a dataset ────────────────────────────

export async function listTables(datasetId: string): Promise<string> {
  const bq = getBQ();
  const projectId = getProjectId();

  const res = await bq.tables.list({ projectId, datasetId, maxResults: 100 });
  const tables = res.data.tables || [];

  if (tables.length === 0) return `No tables in ${datasetId}.`;

  const lines = tables.map(t => {
    const name = t.tableReference?.tableId || '?';
    const type = t.type || 'TABLE';
    const rows = t.numRows ? `${Number(t.numRows).toLocaleString()} rows` : '';
    const size = t.numBytes ? formatBytes(Number(t.numBytes)) : '';
    const info = [type, rows, size].filter(Boolean).join(', ');
    return `  ${name} (${info})`;
  });

  return `Tables in ${projectId}.${datasetId}:\n${lines.join('\n')}`;
}

// ── Table schema ────────────────────────────────────────

export async function getTableSchema(fullTableId: string): Promise<string> {
  const bq = getBQ();
  const parts = fullTableId.split('.');
  if (parts.length < 3) return 'Use format: project.dataset.table';

  const [projectId, datasetId, tableId] = parts;

  const res = await bq.tables.get({ projectId, datasetId, tableId });
  const fields = res.data.schema?.fields || [];
  const numRows = res.data.numRows;
  const numBytes = res.data.numBytes;

  const lines: string[] = [];
  lines.push(`Table: ${fullTableId}`);
  if (numRows) lines.push(`Rows: ${Number(numRows).toLocaleString()}`);
  if (numBytes) lines.push(`Size: ${formatBytes(Number(numBytes))}`);
  lines.push('');
  lines.push('Schema:');

  for (const f of fields) {
    const nullable = f.mode === 'NULLABLE' ? '(nullable)' : f.mode === 'REPEATED' ? '(repeated)' : '';
    lines.push(`  ${f.name}: ${f.type} ${nullable}`.trimEnd());
  }

  return lines.join('\n');
}

// ── List jobs ───────────────────────────────────────────

export async function listJobs(state?: string): Promise<string> {
  const bq = getBQ();
  const projectId = getProjectId();

  const params: any = { projectId, maxResults: 20, projection: 'minimal' };
  if (state) params.stateFilter = [state.toUpperCase()];

  const res = await bq.jobs.list(params);
  const jobs = res.data.jobs || [];

  if (jobs.length === 0) return state ? `No ${state} jobs.` : 'No recent jobs.';

  const lines: string[] = [];
  for (const j of jobs) {
    const id = j.jobReference?.jobId?.slice(0, 20) || '?';
    const status = j.status?.state || '?';
    const type = j.configuration?.jobType || '?';
    const created = j.statistics?.creationTime
      ? new Date(Number(j.statistics.creationTime)).toISOString().slice(0, 16)
      : '';
    const bytes = j.statistics?.totalBytesProcessed
      ? formatBytes(Number(j.statistics.totalBytesProcessed))
      : '';

    lines.push(`  [${status}] ${type} ${id}... ${created} ${bytes}`.trimEnd());
  }

  return `Recent jobs in ${projectId}:\n${lines.join('\n')}`;
}

// ── Utils ───────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
