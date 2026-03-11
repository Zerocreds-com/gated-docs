/**
 * GitLab connector — projects, merge requests, issues, pipelines.
 * Uses Personal Access Token stored in macOS Keychain.
 * Supports self-hosted GitLab instances (custom URL in config).
 * No SDK dependency — raw fetch against GitLab REST API v4.
 */
import { getCredential } from '../keychain.ts';
import { loadConfig, loadStructure } from '../config.ts';
import type { SearchResult, DocContent, StructureDoc } from '../types.ts';

function getToken(): string {
  const token = getCredential('gitlab', 'default');
  if (!token) throw new Error('GitLab not configured. Run: gated-docs auth gitlab --token <personal-access-token>');
  return token;
}

function getBaseUrl(): string {
  const config = loadConfig();
  return (config.gitlab_url || 'https://gitlab.com').replace(/\/+$/, '');
}

async function glGet(path: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(`${getBaseUrl()}/api/v4${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    headers: { 'PRIVATE-TOKEN': getToken() },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitLab API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ── Scan ────────────────────────────────────────────────

export async function scanGitLab(): Promise<StructureDoc[]> {
  const docs: StructureDoc[] = [];
  const baseUrl = getBaseUrl();

  // Get accessible projects (up to 100)
  const projects = await glGet('/projects', {
    membership: 'true',
    per_page: '100',
    order_by: 'updated_at',
    sort: 'desc',
  });

  for (const p of projects) {
    const namespace = p.namespace?.full_path || p.namespace?.name || '';

    docs.push({
      id: `project:${p.id}`,
      name: p.path_with_namespace,
      type: 'project',
      source: 'gitlab',
      parent: namespace,
      modified_at: p.last_activity_at || p.updated_at,
      url: p.web_url,
      snippet: p.description?.slice(0, 200) || undefined,
    });

    // Open merge requests for this project (up to 20)
    try {
      const mrs = await glGet(`/projects/${p.id}/merge_requests`, {
        state: 'opened',
        per_page: '20',
        order_by: 'updated_at',
      });

      for (const mr of mrs) {
        docs.push({
          id: `mr:${p.id}:${mr.iid}`,
          name: `!${mr.iid} ${mr.title}`,
          type: 'merge_request',
          source: 'gitlab',
          parent: p.path_with_namespace,
          modified_at: mr.updated_at,
          url: mr.web_url,
          snippet: [
            mr.source_branch ? `${mr.source_branch} → ${mr.target_branch}` : '',
            mr.description?.slice(0, 150) || '',
          ].filter(Boolean).join(' | '),
        });
      }
    } catch {}

    // Open issues for this project (up to 20)
    try {
      const issues = await glGet(`/projects/${p.id}/issues`, {
        state: 'opened',
        per_page: '20',
        order_by: 'updated_at',
      });

      for (const issue of issues) {
        docs.push({
          id: `issue:${p.id}:${issue.iid}`,
          name: `#${issue.iid} ${issue.title}`,
          type: 'issue',
          source: 'gitlab',
          parent: p.path_with_namespace,
          modified_at: issue.updated_at,
          url: issue.web_url,
          snippet: [
            issue.labels?.length ? `labels: ${issue.labels.join(', ')}` : '',
            issue.description?.slice(0, 150) || '',
          ].filter(Boolean).join(' | '),
        });
      }
    } catch {}
  }

  return docs;
}

// ── Search ──────────────────────────────────────────────

export async function searchGitLab(query: string, limit: number = 10): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  // Try GitLab search API (may not be available on all instances)
  try {
    // Search merge requests
    const mrs = await glGet('/merge_requests', {
      search: query,
      scope: 'all',
      state: 'all',
      per_page: String(limit),
    });
    for (const mr of mrs.slice(0, limit)) {
      const projectPath = mr.references?.full?.split('!')[0]?.replace(/!$/, '') || '';
      results.push({
        id: `mr:${mr.project_id}:${mr.iid}`,
        name: `!${mr.iid} ${mr.title}`,
        source: 'gitlab',
        type: 'merge_request',
        snippet: [
          projectPath,
          mr.source_branch ? `${mr.source_branch} → ${mr.target_branch}` : '',
          mr.state,
        ].filter(Boolean).join(' | '),
        url: mr.web_url,
        modified_at: mr.updated_at,
      });
    }

    // Search issues
    const issues = await glGet('/issues', {
      search: query,
      scope: 'all',
      state: 'all',
      per_page: String(limit),
    });
    for (const issue of issues.slice(0, limit)) {
      results.push({
        id: `issue:${issue.project_id}:${issue.iid}`,
        name: `#${issue.iid} ${issue.title}`,
        source: 'gitlab',
        type: 'issue',
        snippet: [
          issue.state,
          issue.labels?.length ? `labels: ${issue.labels.join(', ')}` : '',
          issue.description?.slice(0, 100) || '',
        ].filter(Boolean).join(' | '),
        url: issue.web_url,
        modified_at: issue.updated_at,
      });
    }

    // Search projects
    const projects = await glGet('/projects', {
      search: query,
      per_page: String(Math.min(limit, 5)),
    });
    for (const p of projects) {
      results.push({
        id: `project:${p.id}`,
        name: p.path_with_namespace,
        source: 'gitlab',
        type: 'project',
        snippet: p.description?.slice(0, 200) || '',
        url: p.web_url,
        modified_at: p.last_activity_at,
      });
    }
  } catch {
    // Fallback to local structure search
    const structure = loadStructure();
    if (!structure) return [];
    const q = query.toLowerCase();
    return structure.docs
      .filter(d => d.source === 'gitlab' && (
        d.name.toLowerCase().includes(q) ||
        d.snippet?.toLowerCase().includes(q) ||
        d.parent?.toLowerCase().includes(q)
      ))
      .slice(0, limit)
      .map(d => ({
        id: d.id,
        name: d.name,
        source: 'gitlab' as const,
        type: d.type,
        snippet: d.snippet || '',
        url: d.url,
        modified_at: d.modified_at,
      }));
  }

  return results.slice(0, limit);
}

// ── Read resource ───────────────────────────────────────

export async function readGitLabResource(id: string): Promise<DocContent> {
  const colonIdx = id.indexOf(':');
  if (colonIdx === -1) throw new Error('Invalid GitLab resource ID. Expected type:projectId:iid (e.g. mr:123:5)');
  const type = id.slice(0, colonIdx);
  const rest = id.slice(colonIdx + 1);

  switch (type) {
    case 'project': return readProject(rest);
    case 'mr': return readMergeRequest(rest);
    case 'issue': return readIssue(rest);
    default:
      throw new Error(`Unknown GitLab resource type: ${type}. Expected project/mr/issue`);
  }
}

async function readProject(projectId: string): Promise<DocContent> {
  const p = await glGet(`/projects/${projectId}`);
  const lines: string[] = [];

  lines.push(`Project: ${p.path_with_namespace}`);
  if (p.description) lines.push(`Description: ${p.description}`);
  lines.push(`Default branch: ${p.default_branch}`);
  lines.push(`Visibility: ${p.visibility}`);
  if (p.topics?.length) lines.push(`Topics: ${p.topics.join(', ')}`);
  lines.push(`Created: ${p.created_at}`);
  lines.push(`Last activity: ${p.last_activity_at}`);
  if (p.star_count) lines.push(`Stars: ${p.star_count}`);
  if (p.forks_count) lines.push(`Forks: ${p.forks_count}`);

  // README
  try {
    const readme = await glGet(`/projects/${projectId}/repository/files/README.md/raw`, {});
    if (typeof readme === 'string') {
      lines.push('');
      lines.push('## README');
      lines.push(readme);
    }
  } catch {
    // Try README (no extension) or readme.md
    try {
      const readme = await glGet(`/projects/${projectId}/repository/files/readme.md/raw`, {});
      if (typeof readme === 'string') {
        lines.push('');
        lines.push('## README');
        lines.push(readme);
      }
    } catch {}
  }

  // Recent branches
  try {
    const branches = await glGet(`/projects/${projectId}/repository/branches`, {
      per_page: '10',
      order_by: 'updated',
      sort: 'desc',
    });
    if (branches.length) {
      lines.push('');
      lines.push('## Recent branches');
      for (const b of branches) {
        const date = b.commit?.committed_date ? ` (${b.commit.committed_date.slice(0, 10)})` : '';
        lines.push(`  ${b.name}${date}`);
      }
    }
  } catch {}

  return {
    id: `project:${projectId}`, name: p.path_with_namespace, source: 'gitlab', type: 'project',
    content: lines.join('\n'),
    url: p.web_url,
  };
}

async function readMergeRequest(rest: string): Promise<DocContent> {
  // rest = "projectId:iid"
  const [projectId, iid] = rest.split(':');
  if (!projectId || !iid) throw new Error('MR ID format: mr:projectId:iid');

  const mr = await glGet(`/projects/${projectId}/merge_requests/${iid}`);
  const lines: string[] = [];

  lines.push(`MR !${mr.iid}: ${mr.title}`);
  lines.push(`State: ${mr.state}`);
  lines.push(`Author: ${mr.author?.username || mr.author?.name || 'unknown'}`);
  lines.push(`Branch: ${mr.source_branch} → ${mr.target_branch}`);
  lines.push(`Created: ${mr.created_at}`);
  lines.push(`Updated: ${mr.updated_at}`);
  if (mr.merged_by) lines.push(`Merged by: ${mr.merged_by.username}`);
  if (mr.labels?.length) lines.push(`Labels: ${mr.labels.join(', ')}`);
  if (mr.milestone) lines.push(`Milestone: ${mr.milestone.title}`);
  if (mr.reviewers?.length) lines.push(`Reviewers: ${mr.reviewers.map((r: any) => r.username).join(', ')}`);

  if (mr.description) {
    lines.push('');
    lines.push('## Description');
    lines.push(mr.description);
  }

  // Discussion / comments
  try {
    const notes = await glGet(`/projects/${projectId}/merge_requests/${iid}/notes`, {
      per_page: '50',
      sort: 'asc',
    });
    const humanNotes = notes.filter((n: any) => !n.system);
    if (humanNotes.length) {
      lines.push('');
      lines.push(`## Comments (${humanNotes.length})`);
      for (const note of humanNotes) {
        lines.push('');
        lines.push(`**${note.author?.username || 'unknown'}** (${note.created_at?.slice(0, 16)}):`);
        lines.push(note.body);
      }
    }
  } catch {}

  // Diff (changes)
  try {
    const changes = await glGet(`/projects/${projectId}/merge_requests/${iid}/changes`);
    const diffs = changes.changes || [];
    if (diffs.length) {
      lines.push('');
      lines.push(`## Changes (${diffs.length} files)`);
      for (const d of diffs) {
        lines.push('');
        const status = d.new_file ? ' [new]' : d.deleted_file ? ' [deleted]' : d.renamed_file ? ` [renamed from ${d.old_path}]` : '';
        lines.push(`### ${d.new_path}${status}`);
        if (d.diff) {
          lines.push('```diff');
          lines.push(d.diff);
          lines.push('```');
        }
      }
    }
  } catch {}

  return {
    id: `mr:${rest}`, name: `!${mr.iid} ${mr.title}`, source: 'gitlab', type: 'merge_request',
    content: lines.join('\n'),
    url: mr.web_url,
  };
}

async function readIssue(rest: string): Promise<DocContent> {
  // rest = "projectId:iid"
  const [projectId, iid] = rest.split(':');
  if (!projectId || !iid) throw new Error('Issue ID format: issue:projectId:iid');

  const issue = await glGet(`/projects/${projectId}/issues/${iid}`);
  const lines: string[] = [];

  lines.push(`Issue #${issue.iid}: ${issue.title}`);
  lines.push(`State: ${issue.state}`);
  lines.push(`Author: ${issue.author?.username || issue.author?.name || 'unknown'}`);
  lines.push(`Created: ${issue.created_at}`);
  lines.push(`Updated: ${issue.updated_at}`);
  if (issue.assignees?.length) lines.push(`Assignees: ${issue.assignees.map((a: any) => a.username).join(', ')}`);
  if (issue.labels?.length) lines.push(`Labels: ${issue.labels.join(', ')}`);
  if (issue.milestone) lines.push(`Milestone: ${issue.milestone.title}`);
  if (issue.weight) lines.push(`Weight: ${issue.weight}`);
  if (issue.due_date) lines.push(`Due: ${issue.due_date}`);

  if (issue.description) {
    lines.push('');
    lines.push('## Description');
    lines.push(issue.description);
  }

  // Comments
  try {
    const notes = await glGet(`/projects/${projectId}/issues/${iid}/notes`, {
      per_page: '50',
      sort: 'asc',
    });
    const humanNotes = notes.filter((n: any) => !n.system);
    if (humanNotes.length) {
      lines.push('');
      lines.push(`## Comments (${humanNotes.length})`);
      for (const note of humanNotes) {
        lines.push('');
        lines.push(`**${note.author?.username || 'unknown'}** (${note.created_at?.slice(0, 16)}):`);
        lines.push(note.body);
      }
    }
  } catch {}

  return {
    id: `issue:${rest}`, name: `#${issue.iid} ${issue.title}`, source: 'gitlab', type: 'issue',
    content: lines.join('\n'),
    url: issue.web_url,
  };
}
