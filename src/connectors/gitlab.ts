/**
 * GitLab connector — projects, merge requests, issues, commits, files, pipelines.
 * Uses Personal Access Token stored in OS credential store.
 * Supports self-hosted GitLab instances (custom URL in config).
 * No SDK dependency — raw fetch against GitLab REST API v4.
 *
 * Resource ID formats (used with read_document):
 *   project:123              — project overview + README + branches
 *   mr:123:5                 — merge request with diff + review comments
 *   issue:123:10             — issue with comments
 *   commits:123              — recent commits on default branch
 *   commits:123?ref=dev&path=src&since=2026-01-01  — filtered commits
 *   commit:123:abc123def     — single commit with diff + discussions
 *   tree:123                 — root directory listing
 *   tree:123?ref=main&path=src/lib  — subdirectory on specific branch
 *   file:123:path/to/file.ts — file content (default branch)
 *   file:123:path?ref=dev    — file content on specific branch
 *   pipelines:123            — recent pipelines
 *   pipelines:123?ref=main   — pipelines for specific branch
 *   pipeline:123:456         — pipeline details with jobs + failed logs
 */
import { getCredential } from '../keychain.ts';
import { loadConfig, loadStructure } from '../config.ts';
import type { SearchResult, DocContent, StructureDoc } from '../types.ts';

function getToken(): string {
  const token = getCredential('gitlab', 'default');
  if (!token) throw new Error('GitLab not configured. Run: gated-knowledge auth gitlab --token <personal-access-token>');
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

/** Fetch raw text (for file content, README, job logs). */
async function glGetRaw(path: string, params?: Record<string, string>): Promise<string> {
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
  return res.text();
}

/**
 * Parse resource ID with optional query params.
 * "commits:244?path=mczk&ref=main" -> { type: "commits", rest: "244", params: { path: "mczk", ref: "main" } }
 * "commit:244:abc123"              -> { type: "commit", rest: "244:abc123", params: {} }
 */
function parseResourceId(id: string): { type: string; rest: string; params: Record<string, string> } {
  const colonIdx = id.indexOf(':');
  if (colonIdx === -1) throw new Error('Invalid GitLab resource ID. Use type:id format (e.g. project:123, commits:123?path=src)');
  const type = id.slice(0, colonIdx);
  let rest = id.slice(colonIdx + 1);
  const params: Record<string, string> = {};

  const qIdx = rest.indexOf('?');
  if (qIdx !== -1) {
    const qs = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
    for (const pair of qs.split('&')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx !== -1) {
        params[decodeURIComponent(pair.slice(0, eqIdx))] = decodeURIComponent(pair.slice(eqIdx + 1));
      }
    }
  }

  return { type, rest, params };
}

// ── Scan ────────────────────────────────────────────────

export async function scanGitLab(): Promise<StructureDoc[]> {
  const docs: StructureDoc[] = [];

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
            mr.source_branch ? `${mr.source_branch} -> ${mr.target_branch}` : '',
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
          mr.source_branch ? `${mr.source_branch} -> ${mr.target_branch}` : '',
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

    // Search commits (across all projects — may require Elasticsearch on self-hosted)
    try {
      const commits = await glGet('/search', {
        scope: 'commits',
        search: query,
        per_page: String(Math.min(limit, 5)),
      });
      for (const c of commits) {
        results.push({
          id: `commit:${c.project_id}:${c.id}`,
          name: `${c.short_id} ${c.title}`,
          source: 'gitlab',
          type: 'commit',
          snippet: `${c.author_name} | ${c.committed_date?.slice(0, 10) || ''}`,
          url: c.web_url,
          modified_at: c.committed_date,
        });
      }
    } catch {} // Global commit search may not be available
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

export async function readGitLabResource(id: string, range?: string): Promise<DocContent> {
  const { type, rest, params } = parseResourceId(id);

  // range param is a shorthand: path filter for commits/tree, ref filter for pipelines
  if (range) {
    if (type === 'commits' || type === 'tree') {
      if (!params.path) params.path = range;
    } else if (type === 'pipelines') {
      if (!params.ref) params.ref = range;
    }
  }

  switch (type) {
    case 'project': return readProject(rest);
    case 'mr': return readMergeRequest(rest);
    case 'issue': return readIssue(rest);
    case 'commits': return readCommits(rest, params);
    case 'commit': return readCommit(rest);
    case 'tree': return readTree(rest, params);
    case 'file': return readFile(rest, params);
    case 'pipelines': return readPipelines(rest, params);
    case 'pipeline': return readPipeline(rest);
    default:
      throw new Error(
        `Unknown GitLab resource type: "${type}". Supported types:\n` +
        '  project:ID           — project overview + README\n' +
        '  mr:PID:IID           — merge request + diff + comments\n' +
        '  issue:PID:IID        — issue + comments\n' +
        '  commits:PID          — recent commits (add ?path=dir&ref=branch&since=date)\n' +
        '  commit:PID:SHA       — single commit + diff + discussions\n' +
        '  tree:PID             — repository directory (add ?path=subdir&ref=branch)\n' +
        '  file:PID:path/file   — file content (add ?ref=branch)\n' +
        '  pipelines:PID        — CI/CD pipelines (add ?ref=branch)\n' +
        '  pipeline:PID:ID      — pipeline details + jobs + failed logs'
      );
  }
}

// ── Project ─────────────────────────────────────────────

async function readProject(projectId: string): Promise<DocContent> {
  const p = await glGet(`/projects/${projectId}`);
  const lines: string[] = [];

  lines.push(`# ${p.path_with_namespace}`);
  lines.push('');
  if (p.description) lines.push(`${p.description}`);
  lines.push(`Default branch: ${p.default_branch}`);
  lines.push(`Visibility: ${p.visibility}`);
  if (p.topics?.length) lines.push(`Topics: ${p.topics.join(', ')}`);
  lines.push(`Created: ${p.created_at}`);
  lines.push(`Last activity: ${p.last_activity_at}`);
  if (p.star_count) lines.push(`Stars: ${p.star_count}`);
  if (p.forks_count) lines.push(`Forks: ${p.forks_count}`);

  // README (use glGetRaw — the endpoint returns raw text, not JSON)
  try {
    const readme = await glGetRaw(`/projects/${projectId}/repository/files/README.md/raw`, { ref: p.default_branch });
    lines.push('');
    lines.push('## README');
    lines.push(readme);
  } catch {
    try {
      const readme = await glGetRaw(`/projects/${projectId}/repository/files/readme.md/raw`, { ref: p.default_branch });
      lines.push('');
      lines.push('## README');
      lines.push(readme);
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

  // Hint about available sub-resources
  lines.push('');
  lines.push('## Available resources');
  lines.push(`  commits:${projectId}              — recent commits`);
  lines.push(`  commits:${projectId}?path=subdir  — commits touching a path`);
  lines.push(`  tree:${projectId}                 — browse repository files`);
  lines.push(`  pipelines:${projectId}            — CI/CD pipelines`);

  return {
    id: `project:${projectId}`, name: p.path_with_namespace, source: 'gitlab', type: 'project',
    content: lines.join('\n'),
    url: p.web_url,
  };
}

// ── Merge Request ───────────────────────────────────────

async function readMergeRequest(rest: string): Promise<DocContent> {
  const [projectId, iid] = rest.split(':');
  if (!projectId || !iid) throw new Error('MR ID format: mr:projectId:iid');

  const mr = await glGet(`/projects/${projectId}/merge_requests/${iid}`);
  const lines: string[] = [];

  lines.push(`MR !${mr.iid}: ${mr.title}`);
  lines.push(`State: ${mr.state}`);
  lines.push(`Author: ${mr.author?.username || mr.author?.name || 'unknown'}`);
  lines.push(`Branch: ${mr.source_branch} -> ${mr.target_branch}`);
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

  // Discussions — includes inline code comments with file/line context
  try {
    const discussions = await glGet(`/projects/${projectId}/merge_requests/${iid}/discussions`, {
      per_page: '100',
    });

    const reviewDiscussions = discussions.filter((d: any) =>
      d.notes?.some((n: any) => !n.system)
    );

    if (reviewDiscussions.length) {
      lines.push('');
      lines.push(`## Discussion threads (${reviewDiscussions.length})`);

      for (const disc of reviewDiscussions) {
        const notes = (disc.notes || []).filter((n: any) => !n.system);
        if (notes.length === 0) continue;

        const firstNote = notes[0];
        lines.push('');

        if (firstNote.position) {
          const pos = firstNote.position;
          const file = pos.new_path || pos.old_path || '';
          const line = pos.new_line || pos.old_line || '';
          const resolved = disc.resolved ? ' [RESOLVED]' : ' [OPEN]';
          lines.push(`### ${file}:${line}${resolved}`);
        } else {
          const resolved = disc.resolved ? ' [RESOLVED]' : disc.resolved === false ? ' [OPEN]' : '';
          lines.push(`### General comment${resolved}`);
        }

        for (const note of notes) {
          lines.push(`**${note.author?.username || 'unknown'}** (${note.created_at?.slice(0, 16)}):`);
          lines.push(note.body);
          lines.push('');
        }
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

// ── Issue ───────────────────────────────────────────────

async function readIssue(rest: string): Promise<DocContent> {
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

// ── Commits ─────────────────────────────────────────────

async function readCommits(projectId: string, params: Record<string, string>): Promise<DocContent> {
  const apiParams: Record<string, string> = { per_page: '40' };
  if (params.ref) apiParams.ref_name = params.ref;
  if (params.path) apiParams.path = params.path;
  if (params.since) apiParams.since = params.since;
  if (params.until) apiParams.until = params.until;
  if (params.author) apiParams.author = params.author;

  const [commits, project] = await Promise.all([
    glGet(`/projects/${projectId}/repository/commits`, apiParams),
    glGet(`/projects/${projectId}`),
  ]);

  const lines: string[] = [];
  const filters: string[] = [];
  if (params.ref) filters.push(`branch: ${params.ref}`);
  if (params.path) filters.push(`path: ${params.path}`);
  if (params.since) filters.push(`since: ${params.since}`);
  if (params.until) filters.push(`until: ${params.until}`);
  if (params.author) filters.push(`author: ${params.author}`);
  const filterStr = filters.length ? ` (${filters.join(', ')})` : '';

  lines.push(`Commits for ${project.path_with_namespace}${filterStr}`);
  lines.push(`Default branch: ${project.default_branch}`);
  lines.push('');

  for (const c of commits) {
    const date = c.committed_date?.slice(0, 10) || c.created_at?.slice(0, 10) || '';
    lines.push(`${c.short_id}  ${date}  ${c.author_name}: ${c.title}`);
  }

  if (commits.length === 0) {
    lines.push('No commits found matching the criteria.');
  }

  lines.push('');
  lines.push(`Showing ${commits.length} commits. To see diff + discussions for a commit:`);
  lines.push(`  read_document(id="commit:${projectId}:<short_id>", source="gitlab")`);

  // Build the ID with params for reproducibility
  const idParams = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const fullId = `commits:${projectId}${idParams ? '?' + idParams : ''}`;

  return {
    id: fullId,
    name: `Commits: ${project.path_with_namespace}${filterStr}`,
    source: 'gitlab',
    type: 'commits',
    content: lines.join('\n'),
    url: `${project.web_url}/-/commits/${params.ref || project.default_branch}${params.path ? '/' + params.path : ''}`,
  };
}

// ── Single Commit ───────────────────────────────────────

async function readCommit(rest: string): Promise<DocContent> {
  // rest = "projectId:sha"
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) throw new Error('Commit ID format: commit:projectId:sha');
  const projectId = rest.slice(0, colonIdx);
  const sha = rest.slice(colonIdx + 1);

  const [commit, project] = await Promise.all([
    glGet(`/projects/${projectId}/repository/commits/${sha}`),
    glGet(`/projects/${projectId}`),
  ]);

  const lines: string[] = [];
  lines.push(`Commit ${commit.id}`);
  lines.push(`Project: ${project.path_with_namespace}`);
  lines.push(`Author: ${commit.author_name} <${commit.author_email}>`);
  lines.push(`Date: ${commit.committed_date}`);
  if (commit.parent_ids?.length > 1) lines.push(`Merge commit (${commit.parent_ids.length} parents)`);
  if (commit.stats) {
    lines.push(`Stats: +${commit.stats.additions} -${commit.stats.deletions} (${commit.stats.total} total)`);
  }

  lines.push('');
  lines.push('## Message');
  lines.push(commit.message);

  // Diff
  try {
    const diff = await glGet(`/projects/${projectId}/repository/commits/${sha}/diff`, { per_page: '100' });
    if (diff.length) {
      lines.push('');
      lines.push(`## Changes (${diff.length} files)`);
      for (const d of diff) {
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

  // Discussions/comments on this commit
  try {
    const discussions = await glGet(`/projects/${projectId}/repository/commits/${sha}/discussions`, { per_page: '100' });
    const nonEmpty = discussions.filter((d: any) => d.notes?.some((n: any) => !n.system));

    if (nonEmpty.length) {
      lines.push('');
      lines.push(`## Comments (${nonEmpty.length} threads)`);

      for (const disc of nonEmpty) {
        const notes = (disc.notes || []).filter((n: any) => !n.system);
        if (notes.length === 0) continue;

        const firstNote = notes[0];
        lines.push('');

        if (firstNote.position) {
          const pos = firstNote.position;
          const file = pos.new_path || pos.old_path || '';
          const line = pos.new_line || pos.old_line || '';
          lines.push(`### ${file}:${line}`);
        } else {
          lines.push('### General comment');
        }

        for (const note of notes) {
          lines.push(`**${note.author?.username || 'unknown'}** (${note.created_at?.slice(0, 16)}):`);
          lines.push(note.body);
          lines.push('');
        }
      }
    }
  } catch {}

  return {
    id: `commit:${rest}`,
    name: `${commit.short_id} ${commit.title}`,
    source: 'gitlab',
    type: 'commit',
    content: lines.join('\n'),
    url: `${project.web_url}/-/commit/${sha}`,
  };
}

// ── Repository Tree ─────────────────────────────────────

async function readTree(projectId: string, params: Record<string, string>): Promise<DocContent> {
  const apiParams: Record<string, string> = { per_page: '100', recursive: 'false' };
  if (params.ref) apiParams.ref = params.ref;
  if (params.path) apiParams.path = params.path;

  const [tree, project] = await Promise.all([
    glGet(`/projects/${projectId}/repository/tree`, apiParams),
    glGet(`/projects/${projectId}`),
  ]);

  const pathLabel = params.path || '/';
  const ref = params.ref || project.default_branch;
  const lines: string[] = [];
  lines.push(`Repository: ${project.path_with_namespace}`);
  lines.push(`Path: ${pathLabel}`);
  lines.push(`Branch: ${ref}`);
  lines.push('');

  // Sort: directories first, then files
  const dirs = tree.filter((t: any) => t.type === 'tree');
  const files = tree.filter((t: any) => t.type === 'blob');

  for (const d of dirs) {
    lines.push(`  ${d.name}/`);
  }
  for (const f of files) {
    lines.push(`  ${f.name}`);
  }

  if (tree.length === 0) {
    lines.push('  (empty directory)');
  }

  lines.push('');
  lines.push(`${dirs.length} directories, ${files.length} files`);
  lines.push('');
  lines.push('To drill down into a subdirectory:');
  lines.push(`  read_document(id="tree:${projectId}?path=subdir", source="gitlab")`);
  lines.push('To read a file:');
  lines.push(`  read_document(id="file:${projectId}:${params.path ? params.path + '/' : ''}filename", source="gitlab")`);
  lines.push('To see commits touching this path:');
  lines.push(`  read_document(id="commits:${projectId}?path=${params.path || 'subdir'}", source="gitlab")`);

  const idParams = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const fullId = `tree:${projectId}${idParams ? '?' + idParams : ''}`;

  return {
    id: fullId,
    name: `${project.path_with_namespace}/${pathLabel}`,
    source: 'gitlab',
    type: 'tree',
    content: lines.join('\n'),
    url: `${project.web_url}/-/tree/${ref}/${params.path || ''}`,
  };
}

// ── File Content ────────────────────────────────────────

async function readFile(rest: string, params: Record<string, string>): Promise<DocContent> {
  // rest = "projectId:path/to/file" or just "projectId" (with path in params)
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) throw new Error('File ID format: file:projectId:path/to/file (optionally add ?ref=branch)');
  const projectId = rest.slice(0, colonIdx);
  const filePath = rest.slice(colonIdx + 1);
  if (!filePath) throw new Error('File path is required. Example: file:123:src/main.ts');

  const project = await glGet(`/projects/${projectId}`);
  const ref = params.ref || project.default_branch;

  // Get file content (raw endpoint returns actual content, not base64)
  const content = await glGetRaw(
    `/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}/raw`,
    { ref },
  );

  // Get file metadata for extra info
  let size = content.length;
  let lastCommitId = '';
  try {
    const meta = await glGet(`/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}`, { ref });
    size = meta.size || size;
    lastCommitId = meta.last_commit_id || '';
  } catch {}

  const lines: string[] = [];
  lines.push(`File: ${filePath}`);
  lines.push(`Project: ${project.path_with_namespace}`);
  lines.push(`Branch: ${ref}`);
  lines.push(`Size: ${size} bytes`);
  if (lastCommitId) lines.push(`Last commit: ${lastCommitId.slice(0, 12)}`);
  lines.push('');

  // Syntax-highlighted content
  const ext = filePath.split('.').pop() || '';
  lines.push(`\`\`\`${ext}`);
  lines.push(content);
  lines.push('```');

  // Blame summary (who wrote what)
  try {
    const blame = await glGet(`/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}/blame`, { ref });
    const authors = new Map<string, number>();
    for (const b of blame) {
      const name = b.commit?.author_name || 'unknown';
      authors.set(name, (authors.get(name) || 0) + (b.lines?.length || 0));
    }
    if (authors.size > 0) {
      lines.push('');
      lines.push('## Contributors (by lines)');
      const sorted = [...authors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      for (const [name, lineCount] of sorted) {
        lines.push(`  ${name}: ${lineCount} lines`);
      }
    }
  } catch {}

  return {
    id: `file:${rest}${params.ref ? '?ref=' + params.ref : ''}`,
    name: filePath,
    source: 'gitlab',
    type: 'file',
    content: lines.join('\n'),
    url: `${project.web_url}/-/blob/${ref}/${filePath}`,
  };
}

// ── Pipelines ───────────────────────────────────────────

async function readPipelines(projectId: string, params: Record<string, string>): Promise<DocContent> {
  const apiParams: Record<string, string> = {
    per_page: '20',
    order_by: 'updated_at',
    sort: 'desc',
  };
  if (params.ref) apiParams.ref = params.ref;
  if (params.status) apiParams.status = params.status;

  const [pipelines, project] = await Promise.all([
    glGet(`/projects/${projectId}/pipelines`, apiParams),
    glGet(`/projects/${projectId}`),
  ]);

  const lines: string[] = [];
  const filters: string[] = [];
  if (params.ref) filters.push(`ref: ${params.ref}`);
  if (params.status) filters.push(`status: ${params.status}`);
  const filterStr = filters.length ? ` (${filters.join(', ')})` : '';

  lines.push(`Pipelines for ${project.path_with_namespace}${filterStr}`);
  lines.push('');

  for (const p of pipelines) {
    const duration = p.duration ? ` ${p.duration}s` : '';
    const date = p.updated_at?.slice(0, 16) || p.created_at?.slice(0, 16) || '';
    const statusIcon: Record<string, string> = {
      success: '[OK]', failed: '[FAIL]', running: '[RUN]',
      pending: '[WAIT]', canceled: '[CANCEL]', skipped: '[SKIP]',
    };
    const icon = statusIcon[p.status] || `[${p.status}]`;
    lines.push(`${icon} #${p.id}  ${p.ref}  ${p.source || ''}${duration}  ${date}`);
  }

  if (pipelines.length === 0) {
    lines.push('No pipelines found.');
  }

  lines.push('');
  lines.push(`Use pipeline:${projectId}:<id> to see jobs, stages, and failed logs.`);

  const idParams = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const fullId = `pipelines:${projectId}${idParams ? '?' + idParams : ''}`;

  return {
    id: fullId,
    name: `Pipelines: ${project.path_with_namespace}${filterStr}`,
    source: 'gitlab',
    type: 'pipelines',
    content: lines.join('\n'),
    url: `${project.web_url}/-/pipelines`,
  };
}

// ── Single Pipeline ─────────────────────────────────────

async function readPipeline(rest: string): Promise<DocContent> {
  const [projectId, pipelineId] = rest.split(':');
  if (!projectId || !pipelineId) throw new Error('Pipeline ID format: pipeline:projectId:pipelineId');

  const [pipeline, jobs, project] = await Promise.all([
    glGet(`/projects/${projectId}/pipelines/${pipelineId}`),
    glGet(`/projects/${projectId}/pipelines/${pipelineId}/jobs`, { per_page: '100' }),
    glGet(`/projects/${projectId}`),
  ]);

  const lines: string[] = [];
  const statusIcon: Record<string, string> = {
    success: '[OK]', failed: '[FAIL]', running: '[RUN]',
    pending: '[WAIT]', canceled: '[CANCEL]',
  };
  const icon = statusIcon[pipeline.status] || `[${pipeline.status}]`;

  lines.push(`${icon} Pipeline #${pipeline.id}: ${pipeline.status}`);
  lines.push(`Project: ${project.path_with_namespace}`);
  lines.push(`Ref: ${pipeline.ref}`);
  lines.push(`SHA: ${pipeline.sha?.slice(0, 12)}`);
  lines.push(`Source: ${pipeline.source || 'unknown'}`);
  lines.push(`Created: ${pipeline.created_at}`);
  if (pipeline.started_at) lines.push(`Started: ${pipeline.started_at}`);
  if (pipeline.finished_at) lines.push(`Finished: ${pipeline.finished_at}`);
  if (pipeline.duration) lines.push(`Duration: ${pipeline.duration}s`);
  if (pipeline.queued_duration) lines.push(`Queued: ${pipeline.queued_duration}s`);
  if (pipeline.user) lines.push(`Triggered by: ${pipeline.user.username}`);

  if (jobs.length) {
    // Group by stage
    const stages = new Map<string, any[]>();
    for (const j of jobs) {
      const stage = j.stage || 'unknown';
      if (!stages.has(stage)) stages.set(stage, []);
      stages.get(stage)!.push(j);
    }

    lines.push('');
    lines.push(`## Jobs (${jobs.length})`);

    for (const [stage, stageJobs] of stages) {
      lines.push('');
      lines.push(`### Stage: ${stage}`);
      for (const j of stageJobs) {
        const jIcon = statusIcon[j.status] || `[${j.status}]`;
        const duration = j.duration ? ` (${Math.round(j.duration)}s)` : '';
        lines.push(`  ${jIcon} ${j.name}${duration}`);
        if (j.status === 'failed' && j.failure_reason) {
          lines.push(`       Reason: ${j.failure_reason}`);
        }
      }
    }

    // For failed jobs, fetch last lines of trace log
    const failedJobs = jobs.filter((j: any) => j.status === 'failed');
    if (failedJobs.length) {
      lines.push('');
      lines.push('## Failed job logs (last 50 lines)');
      for (const fj of failedJobs.slice(0, 3)) {
        try {
          const log = await glGetRaw(`/projects/${projectId}/jobs/${fj.id}/trace`);
          const lastLines = log.split('\n').slice(-50).join('\n');
          lines.push('');
          lines.push(`### ${fj.name} (job #${fj.id})`);
          lines.push('```');
          lines.push(lastLines);
          lines.push('```');
        } catch {}
      }
    }
  }

  return {
    id: `pipeline:${rest}`,
    name: `Pipeline #${pipeline.id} (${pipeline.status})`,
    source: 'gitlab',
    type: 'pipeline',
    content: lines.join('\n'),
    url: `${project.web_url}/-/pipelines/${pipelineId}`,
  };
}
