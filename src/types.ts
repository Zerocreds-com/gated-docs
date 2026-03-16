// ── Source types ──────────────────────────────────────────

export type SourceType = 'google' | 'notion' | 'slack' | 'telegram' | 'cloudflare' | 'gitlab' | 'langsmith' | 'sessions';

export interface SourceConfig {
  enabled: boolean;
  account?: string; // SA email for Google, workspace for Slack
}

export interface SessionsUser {
  name: string;       // display name
  id: string;         // unique slug (e.g. "vova-kobzev")
}

export interface SessionsSharing {
  driver: 'google-drive' | 'supabase' | 'local';
  folder_id?: string;  // Google Drive shared folder ID
  url?: string;        // Supabase URL
  key?: string;        // Supabase anon key
  mode: 'all' | 'whitelist' | 'blacklist';
  include?: string[];  // glob patterns for project dirs to share
  exclude?: string[];  // glob patterns for project dirs to exclude
  auto_share: boolean;
}

export interface SessionsConfig {
  user: SessionsUser;
  archive_dir: string;      // default: ~/.config/session-snapshot/archive
  sharing?: SessionsSharing;
}

export interface TeamConfig {
  name: string;
  sessions?: {
    driver: 'google-drive' | 'supabase';
    folder_id?: string;
    url?: string;
    anon_key?: string;
  };
}

export interface Config {
  sources: Partial<Record<SourceType, SourceConfig>>;
  scan_interval_hours: number;
  bigquery_project?: string; // override project for BQ queries (when SA is in different project)
  google_impersonate?: string; // email to impersonate via Domain-Wide Delegation (e.g. vladimir@skillset.ae)
  google_accounts?: string[]; // OAuth2 account emails (multi-account: each has google/oauth-{email} in keychain)
  gitlab_url?: string; // GitLab instance URL (e.g. https://gitlab.example.com), defaults to https://gitlab.com
  sessions?: SessionsConfig;
  team?: TeamConfig;
}

// ── Structure (scan output) ──────────────────────────────

export interface StructureDoc {
  id: string;
  name: string;
  type: string;       // spreadsheet, document, presentation, folder, page, channel
  source: SourceType;
  parent?: string;     // folder name or database name
  modified_at?: string;
  url?: string;
  snippet?: string;    // first ~200 chars of content
}

export interface Structure {
  generated_at: string;
  docs: StructureDoc[];
  stats: Record<SourceType, { count: number; types: Record<string, number> }>;
  mcp_description: string;
}

// ── Search result ────────────────────────────────────────

export interface SearchResult {
  id: string;
  name: string;
  source: SourceType;
  type: string;
  snippet: string;
  url?: string;
  modified_at?: string;
}

export interface DocContent {
  id: string;
  name: string;
  source: SourceType;
  type: string;
  content: string;
  url?: string;
}
