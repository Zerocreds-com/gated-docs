/**
 * LangSmith connector — projects, runs/traces, datasets.
 * Uses API key stored in OS credential store.
 * No SDK dependency — raw fetch against LangSmith REST API.
 */
import { getCredential } from '../keychain.ts';
import { loadStructure } from '../config.ts';
import type { SearchResult, DocContent, StructureDoc } from '../types.ts';

const BASE_URL = 'https://api.smith.langchain.com/api/v1';

function getApiKey(): string {
  const key = getCredential('langsmith', 'default');
  if (!key) throw new Error('LangSmith not configured. Run: gated-knowledge auth langsmith --token <api-key>');
  return key;
}

async function lsGet(path: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    headers: { 'x-api-key': getApiKey() },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LangSmith API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function lsPost(path: string, body: any): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'x-api-key': getApiKey(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LangSmith API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Scan ────────────────────────────────────────────────

export async function scanLangSmith(): Promise<StructureDoc[]> {
  const docs: StructureDoc[] = [];

  // List projects (sessions in API)
  const projects = await lsGet('/sessions', { limit: '100' });
  for (const p of (Array.isArray(projects) ? projects : [])) {
    docs.push({
      id: `project:${p.id}`,
      name: p.name,
      type: 'project',
      source: 'langsmith',
      modified_at: p.last_run_start_time || p.modified_at,
      snippet: [
        p.run_count ? `${p.run_count} runs` : '',
        p.description || '',
      ].filter(Boolean).join(' | ').slice(0, 200) || undefined,
    });
  }

  // List datasets
  try {
    const datasets = await lsGet('/datasets', { limit: '100' });
    for (const ds of (Array.isArray(datasets) ? datasets : [])) {
      docs.push({
        id: `dataset:${ds.id}`,
        name: ds.name,
        type: 'dataset',
        source: 'langsmith',
        modified_at: ds.modified_at,
        snippet: [
          ds.example_count ? `${ds.example_count} examples` : '',
          ds.description || '',
        ].filter(Boolean).join(' | ').slice(0, 200) || undefined,
      });
    }
  } catch {}

  return docs;
}

// ── Search ──────────────────────────────────────────────

export async function searchLangSmith(query: string, limit: number = 10): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  // Search runs via POST /runs/query
  try {
    const body: any = {
      limit: Math.min(limit, 20),
      select: ['id', 'name', 'run_type', 'status', 'error', 'start_time', 'end_time', 'total_tokens', 'session_name'],
    };

    // If query looks like a filter expression, use it directly
    if (query.startsWith('eq(') || query.startsWith('and(') || query.startsWith('or(') || query.startsWith('has(')) {
      body.filter = query;
    } else {
      body.query = query;
    }

    const data = await lsPost('/runs/query', body);
    const runs = data.runs || data;
    for (const run of (Array.isArray(runs) ? runs : []).slice(0, limit)) {
      const duration = run.end_time && run.start_time
        ? `${((new Date(run.end_time).getTime() - new Date(run.start_time).getTime()) / 1000).toFixed(1)}s`
        : '';
      results.push({
        id: `run:${run.id}`,
        name: run.name || run.run_type || 'run',
        source: 'langsmith',
        type: 'run',
        snippet: [
          run.run_type,
          run.status,
          run.error ? `error: ${run.error.slice(0, 80)}` : '',
          duration,
          run.total_tokens ? `${run.total_tokens} tokens` : '',
          run.session_name ? `project: ${run.session_name}` : '',
        ].filter(Boolean).join(' | '),
        modified_at: run.start_time,
      });
    }
  } catch {}

  // Also search projects/datasets in local structure
  const structure = loadStructure();
  if (structure) {
    const q = query.toLowerCase();
    const structResults = structure.docs
      .filter(d => d.source === 'langsmith' && (
        d.name.toLowerCase().includes(q) ||
        d.snippet?.toLowerCase().includes(q)
      ))
      .slice(0, limit)
      .map(d => ({
        id: d.id,
        name: d.name,
        source: 'langsmith' as const,
        type: d.type,
        snippet: d.snippet || '',
        url: d.url,
        modified_at: d.modified_at,
      }));

    const seen = new Set(results.map(r => r.id));
    for (const r of structResults) {
      if (!seen.has(r.id)) results.push(r);
    }
  }

  return results.slice(0, limit);
}

// ── Read resource ───────────────────────────────────────

export async function readLangSmithResource(id: string): Promise<DocContent> {
  const colonIdx = id.indexOf(':');
  if (colonIdx === -1) throw new Error('Invalid LangSmith resource ID. Expected type:id (e.g. project:uuid, run:uuid, dataset:uuid)');
  const type = id.slice(0, colonIdx);
  const resourceId = id.slice(colonIdx + 1);

  switch (type) {
    case 'project': return readProject(resourceId);
    case 'run': return readRun(resourceId);
    case 'dataset': return readDataset(resourceId);
    default:
      throw new Error(`Unknown LangSmith resource type: ${type}. Expected project/run/dataset`);
  }
}

async function readProject(projectId: string): Promise<DocContent> {
  const p = await lsGet(`/sessions/${projectId}`);
  const lines: string[] = [];

  lines.push(`Project: ${p.name}`);
  if (p.description) lines.push(`Description: ${p.description}`);
  lines.push(`Run count: ${p.run_count || 0}`);
  if (p.last_run_start_time) lines.push(`Last run: ${p.last_run_start_time}`);
  lines.push(`Created: ${p.created_at || p.start_time}`);

  if (p.feedback_stats && Object.keys(p.feedback_stats).length) {
    lines.push('');
    lines.push('## Feedback stats');
    for (const [key, val] of Object.entries(p.feedback_stats) as [string, any][]) {
      lines.push(`  ${key}: avg=${val.avg?.toFixed(2) || 'N/A'}, count=${val.n || 0}`);
    }
  }

  // Recent runs (last 20)
  try {
    const data = await lsPost('/runs/query', {
      session_id: [projectId],
      limit: 20,
      select: ['id', 'name', 'run_type', 'status', 'error', 'start_time', 'end_time', 'total_tokens'],
    });
    const runList = data.runs || data;
    if (Array.isArray(runList) && runList.length > 0) {
      lines.push('');
      lines.push(`## Recent runs (${runList.length})`);
      for (const r of runList) {
        const duration = r.end_time && r.start_time
          ? `${((new Date(r.end_time).getTime() - new Date(r.start_time).getTime()) / 1000).toFixed(1)}s`
          : '';
        const tokens = r.total_tokens ? `${r.total_tokens}tok` : '';
        const error = r.error ? ` ERROR: ${r.error.slice(0, 80)}` : '';
        lines.push(`  ${r.name || r.run_type} [${r.status}] ${duration} ${tokens}${error}`);
        lines.push(`    ID: run:${r.id}  (${r.start_time?.slice(0, 16) || ''})`);
      }
    }
  } catch {}

  return {
    id: `project:${projectId}`,
    name: p.name,
    source: 'langsmith',
    type: 'project',
    content: lines.join('\n'),
  };
}

async function readRun(runId: string): Promise<DocContent> {
  const r = await lsGet(`/runs/${runId}`);
  const lines: string[] = [];

  lines.push(`Run: ${r.name || 'unnamed'}`);
  lines.push(`Type: ${r.run_type}`);
  lines.push(`Status: ${r.status}`);
  if (r.session_name) lines.push(`Project: ${r.session_name}`);
  if (r.start_time) lines.push(`Start: ${r.start_time}`);
  if (r.end_time) lines.push(`End: ${r.end_time}`);
  if (r.end_time && r.start_time) {
    const ms = new Date(r.end_time).getTime() - new Date(r.start_time).getTime();
    lines.push(`Duration: ${(ms / 1000).toFixed(2)}s`);
  }
  if (r.total_tokens) lines.push(`Tokens: ${r.total_tokens} (prompt: ${r.prompt_tokens || 0}, completion: ${r.completion_tokens || 0})`);
  if (r.total_cost != null) lines.push(`Cost: $${r.total_cost.toFixed(4)}`);
  if (r.parent_run_id) lines.push(`Parent run: run:${r.parent_run_id}`);
  if (r.tags?.length) lines.push(`Tags: ${r.tags.join(', ')}`);

  if (r.error) {
    lines.push('');
    lines.push('## Error');
    lines.push(r.error);
  }

  if (r.inputs) {
    lines.push('');
    lines.push('## Inputs');
    lines.push(JSON.stringify(r.inputs, null, 2).slice(0, 10000));
  }

  if (r.outputs) {
    lines.push('');
    lines.push('## Outputs');
    lines.push(JSON.stringify(r.outputs, null, 2).slice(0, 10000));
  }

  if (r.feedback_stats && Object.keys(r.feedback_stats).length) {
    lines.push('');
    lines.push('## Feedback');
    for (const [key, val] of Object.entries(r.feedback_stats) as [string, any][]) {
      lines.push(`  ${key}: ${JSON.stringify(val)}`);
    }
  }

  // Child runs
  try {
    const children = await lsPost('/runs/query', {
      filter: `eq(parent_run_id, "${runId}")`,
      limit: 50,
      select: ['id', 'name', 'run_type', 'status', 'error', 'start_time', 'end_time', 'total_tokens'],
    });
    const childList = children.runs || children;
    if (Array.isArray(childList) && childList.length > 0) {
      lines.push('');
      lines.push(`## Child runs (${childList.length})`);
      for (const c of childList) {
        const dur = c.end_time && c.start_time
          ? `${((new Date(c.end_time).getTime() - new Date(c.start_time).getTime()) / 1000).toFixed(1)}s`
          : '';
        const tokens = c.total_tokens ? `${c.total_tokens}tok` : '';
        const error = c.error ? ' ERROR' : '';
        lines.push(`  ${c.run_type}:${c.name || 'unnamed'} [${c.status}] ${dur} ${tokens}${error}`);
      }
    }
  } catch {}

  return {
    id: `run:${runId}`,
    name: r.name || `run ${runId.slice(0, 8)}`,
    source: 'langsmith',
    type: 'run',
    content: lines.join('\n'),
  };
}

async function readDataset(datasetId: string): Promise<DocContent> {
  const ds = await lsGet(`/datasets/${datasetId}`);
  const lines: string[] = [];

  lines.push(`Dataset: ${ds.name}`);
  if (ds.description) lines.push(`Description: ${ds.description}`);
  lines.push(`Examples: ${ds.example_count || 0}`);
  lines.push(`Created: ${ds.created_at}`);
  if (ds.modified_at) lines.push(`Modified: ${ds.modified_at}`);
  if (ds.data_type) lines.push(`Data type: ${ds.data_type}`);

  // List examples (up to 20)
  try {
    const examples = await lsGet('/examples', {
      dataset: datasetId,
      limit: '20',
    });
    if (Array.isArray(examples) && examples.length > 0) {
      lines.push('');
      lines.push(`## Examples (showing ${examples.length} of ${ds.example_count || '?'})`);
      for (const ex of examples) {
        lines.push('');
        lines.push(`### Example ${ex.id?.slice(0, 8) || ''}`);
        if (ex.inputs) lines.push(`Inputs: ${JSON.stringify(ex.inputs, null, 2).slice(0, 2000)}`);
        if (ex.outputs) lines.push(`Outputs: ${JSON.stringify(ex.outputs, null, 2).slice(0, 2000)}`);
      }
    }
  } catch {}

  return {
    id: `dataset:${datasetId}`,
    name: ds.name,
    source: 'langsmith',
    type: 'dataset',
    content: lines.join('\n'),
  };
}
