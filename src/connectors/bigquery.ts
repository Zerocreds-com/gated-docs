/**
 * BigQuery connector — run queries, list datasets/tables/jobs.
 * Uses the same Google service account as Drive/Sheets.
 */
import { google, type bigquery_v2 } from 'googleapis';
import { getServiceAccountCredentials } from '../keychain.ts';
import { loadConfig } from '../config.ts';
import type { SearchResult, StructureDoc } from '../types.ts';

function getAuth() {
  const config = loadConfig();
  const account = config.sources.google?.account;
  if (!account) throw new Error('Google not configured. Run: gated-info auth google --service-account <key.json>');

  const credentials = getServiceAccountCredentials(account);
  if (!credentials) throw new Error(`Google credentials not found in keychain for ${account}`);

  return new google.auth.GoogleAuth({
    credentials: credentials as any,
    scopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
  });
}

function getBQ(): bigquery_v2.Bigquery {
  return google.bigquery({ version: 'v2', auth: getAuth() });
}

function getProjectId(): string {
  const config = loadConfig();
  const account = config.sources.google?.account;
  if (!account) throw new Error('Google not configured');
  const credentials = getServiceAccountCredentials(account);
  return (credentials as any)?.project_id || '';
}

// ── Scan: list datasets and tables ──────────────────────

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

    // List tables in dataset
    try {
      const tables = await bq.tables.list({ projectId, datasetId, maxResults: 50 });
      for (const t of tables.data.tables || []) {
        const tableId = t.tableReference?.tableId;
        if (!tableId) continue;

        const rowCount = t.numRows ? `${Number(t.numRows).toLocaleString()} rows` : '';
        const sizeBytes = t.numBytes ? formatBytes(Number(t.numBytes)) : '';
        const info = [rowCount, sizeBytes].filter(Boolean).join(', ');

        docs.push({
          id: `${projectId}.${datasetId}.${tableId}`,
          name: tableId,
          type: t.type === 'VIEW' ? 'view' : 'table',
          source: 'google',
          parent: `BigQuery/${datasetId}`,
          snippet: info || undefined,
        });
      }
    } catch {} // skip datasets we can't list
  }

  return docs;
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
