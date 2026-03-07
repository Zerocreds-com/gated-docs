// ── Source types ──────────────────────────────────────────

export type SourceType = 'google' | 'notion' | 'slack' | 'telegram';

export interface SourceConfig {
  enabled: boolean;
  account?: string; // SA email for Google, workspace for Slack
}

export interface Config {
  sources: Partial<Record<SourceType, SourceConfig>>;
  scan_interval_hours: number;
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
