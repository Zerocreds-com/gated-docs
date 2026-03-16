/**
 * Google Drive / Sheets / Docs connector.
 * Supports Service Account and OAuth2 (multi-account).
 */
import { google, type drive_v3, type sheets_v4 } from 'googleapis';
import { getServiceAccountCredentials, getCredential } from '../keychain.ts';
import { loadConfig } from '../config.ts';
import type { SearchResult, DocContent, StructureDoc } from '../types.ts';

const authCache = new Map<string, any>();

const READ_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
];

const WRITE_SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

/** Build OAuth2 auth from a base64-encoded token in keychain */
function buildOAuth(keychainKey: string): any | null {
  const token = getCredential('google', keychainKey);
  if (!token) return null;
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
    if (!decoded.client_id || !decoded.refresh_token) return null;
    const oauth2 = new google.auth.OAuth2(decoded.client_id, decoded.client_secret);
    oauth2.setCredentials({ refresh_token: decoded.refresh_token });
    return oauth2;
  } catch { return null; }
}

/**
 * Get auth for a specific account email, or default.
 */
function getAuthForAccount(email?: string): any {
  const cacheKey = email || '_default';
  if (authCache.has(cacheKey)) return authCache.get(cacheKey);

  // Specific account requested
  if (email) {
    const auth = buildOAuth(`oauth-${email}`);
    if (auth) { authCache.set(cacheKey, auth); return auth; }
  }

  // Default: try SA, then generic oauth
  const config = loadConfig();
  const account = config.sources.google?.account;

  if (account && account !== 'oauth') {
    const credentials = getServiceAccountCredentials(account);
    if (credentials && (credentials as any).client_email) {
      const auth = new google.auth.GoogleAuth({ credentials: credentials as any, scopes: READ_SCOPES });
      authCache.set(cacheKey, auth);
      return auth;
    }
  }

  const auth = buildOAuth('oauth');
  if (auth) { authCache.set(cacheKey, auth); return auth; }

  throw new Error('Google not configured. Run: gated-knowledge auth google');
}

/**
 * Get all configured Google auth clients (for multi-account scan/search).
 * Returns [{email, auth}] for each account.
 */
function getAllAuths(): Array<{ email: string; auth: any }> {
  const config = loadConfig();
  const results: Array<{ email: string; auth: any }> = [];
  const seen = new Set<string>();

  // Multi-account OAuth tokens
  if (config.google_accounts?.length) {
    for (const email of config.google_accounts) {
      const auth = buildOAuth(`oauth-${email}`);
      if (auth) {
        results.push({ email, auth });
        seen.add(email);
      }
    }
  }

  // SA fallback
  const account = config.sources.google?.account;
  if (account && account !== 'oauth' && !seen.has(account)) {
    const credentials = getServiceAccountCredentials(account);
    if (credentials && (credentials as any).client_email) {
      const auth = new google.auth.GoogleAuth({ credentials: credentials as any, scopes: READ_SCOPES });
      results.push({ email: account, auth });
      seen.add(account);
    }
  }

  // Generic oauth fallback (if no multi-account configured)
  if (results.length === 0) {
    const auth = buildOAuth('oauth');
    if (auth) results.push({ email: 'default', auth });
  }

  return results;
}

/** Get default auth (backward compat) */
function getAuth(): any {
  return getAuthForAccount();
}

function getWriteAuth(): any {
  // Write uses the same auth — OAuth scopes cover write if granted at auth time
  return getAuth();
}

function getDrive(auth?: any): drive_v3.Drive {
  return google.drive({ version: 'v3', auth: auth || getAuth() });
}

function getSheets(): sheets_v4.Sheets {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

// ── Scan: list all accessible files ─────────────────────

export async function scanGoogleDrive(): Promise<StructureDoc[]> {
  const auths = getAllAuths();
  if (auths.length === 0) throw new Error('No Google accounts configured');

  const allDocs: StructureDoc[] = [];
  const seenIds = new Set<string>();

  for (const { email, auth } of auths) {
    process.stderr.write(`[scan] Google: scanning ${email}...\n`);
    try {
      const accountDocs = await scanOneAccount(auth, email);
      // Deduplicate (same file shared across accounts)
      for (const doc of accountDocs) {
        if (!seenIds.has(doc.id)) {
          seenIds.add(doc.id);
          allDocs.push(doc);
        }
      }
    } catch (e: any) {
      process.stderr.write(`[scan] Google ${email}: ${e.message}\n`);
    }
  }

  return allDocs;
}

async function scanOneAccount(auth: any, email: string): Promise<StructureDoc[]> {
  const drive = getDrive(auth);
  const docs: StructureDoc[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: "trashed = false and (mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.google-apps.presentation' or mimeType contains 'video/' or mimeType contains 'audio/')",
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, parents, webViewLink, size)',
      pageSize: 200,
      pageToken,
      orderBy: 'modifiedTime desc',
    });

    const files = res.data.files || [];
    for (const f of files) {
      const type = mimeToType(f.mimeType || '');
      const doc: StructureDoc = {
        id: f.id!,
        name: f.name || 'Untitled',
        type,
        source: 'google',
        modified_at: f.modifiedTime || undefined,
        url: f.webViewLink || undefined,
      };
      // Add size info for media files
      if (isMediaMime(f.mimeType || '') && f.size) {
        const mb = (parseInt(f.size) / (1024 * 1024)).toFixed(1);
        doc.snippet = `${f.mimeType}, ${mb} MB`;
      }
      docs.push(doc);
    }

    pageToken = res.data.nextPageToken || undefined;
    if (docs.length % 200 === 0 || !pageToken) {
      process.stderr.write(`[scan] Google ${email}: ${docs.length} files${pageToken ? '...' : ' done'}\n`);
    }
  } while (pageToken);

  // Resolve parent folder names for context
  await resolveParentFolders(drive, docs);

  // Enrich spreadsheets with sheet names + headers
  const sheets = google.sheets({ version: 'v4', auth });
  for (const doc of docs) {
    if (doc.type !== 'spreadsheet') continue;
    try {
      // Get sheet names first
      const sheetsMeta = await sheets.spreadsheets.get({
        spreadsheetId: doc.id,
        fields: 'sheets.properties.title',
      });
      const sheetNames = (sheetsMeta.data.sheets || [])
        .map(s => s.properties?.title)
        .filter(Boolean) as string[];

      const sheetInfos: string[] = [];
      for (const sheetName of sheetNames.slice(0, 10)) {
        try {
          // Fetch first 5 rows to find headers
          const res = await sheets.spreadsheets.values.get({
            spreadsheetId: doc.id,
            range: `'${sheetName}'!A1:Z5`,
          });
          const rows = res.data.values || [];
          const headers = detectHeaderRow(rows);
          sheetInfos.push(headers ? `${sheetName}[${headers}]` : sheetName);
        } catch {
          sheetInfos.push(sheetName);
        }
      }

      doc.snippet = sheetInfos.join(' | ');
    } catch {} // skip unreadable spreadsheets
  }

  // Prefix parent with account email for multi-account grouping
  for (const doc of docs) {
    doc.parent = doc.parent ? `${email}/${doc.parent}` : email;
  }

  return docs;
}

async function resolveParentFolders(drive: drive_v3.Drive, docs: StructureDoc[]): Promise<void> {
  // Collect unique parent IDs
  const parentIds = new Set<string>();
  // We need to get parents from the API — re-fetch with parents field
  const filesWithParents = await drive.files.list({
    q: "trashed = false and (mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.google-apps.presentation' or mimeType contains 'video/' or mimeType contains 'audio/')",
    fields: 'files(id, parents)',
    pageSize: 500,
  });

  const parentMap = new Map<string, string[]>();
  for (const f of filesWithParents.data.files || []) {
    if (f.id && f.parents) {
      parentMap.set(f.id, f.parents);
      f.parents.forEach(p => parentIds.add(p));
    }
  }

  // Batch resolve folder names
  const folderNames = new Map<string, string>();
  for (const pid of parentIds) {
    try {
      const folder = await drive.files.get({ fileId: pid, fields: 'name' });
      if (folder.data.name) folderNames.set(pid, folder.data.name);
    } catch {} // skip inaccessible folders
  }

  // Assign parent names to docs
  for (const doc of docs) {
    const parents = parentMap.get(doc.id);
    if (parents?.length) {
      const name = folderNames.get(parents[0]);
      if (name && name !== 'My Drive') doc.parent = name;
    }
  }
}

// ── Search ──────────────────────────────────────────────

export async function searchGoogle(query: string, limit: number = 10): Promise<SearchResult[]> {
  const auths = getAllAuths();
  const allResults: SearchResult[] = [];
  const seenIds = new Set<string>();

  const escapedQuery = query.replace(/'/g, "\\'");

  for (const { auth } of auths) {
    try {
      const drive = getDrive(auth);
      const res = await drive.files.list({
        q: `fullText contains '${escapedQuery}' and trashed = false`,
        fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
        pageSize: limit,
        orderBy: 'modifiedTime desc',
      });

      for (const f of res.data.files || []) {
        if (f.id && !seenIds.has(f.id)) {
          seenIds.add(f.id);
          allResults.push({
            id: f.id,
            name: f.name || 'Untitled',
            source: 'google' as const,
            type: mimeToType(f.mimeType || ''),
            snippet: '',
            url: f.webViewLink || undefined,
            modified_at: f.modifiedTime || undefined,
          });
        }
      }
    } catch {}
  }

  return allResults.slice(0, limit);
}

// ── Read document content ────────────────────────────────

export async function readGoogleDoc(docId: string, range?: string): Promise<DocContent> {
  const drive = getDrive();

  // Get file metadata
  const meta = await drive.files.get({
    fileId: docId,
    fields: 'id, name, mimeType, webViewLink, size',
  });

  const mimeType = meta.data.mimeType || '';
  const name = meta.data.name || 'Untitled';
  const type = mimeToType(mimeType);

  let content: string;

  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    content = await readSpreadsheetContent(docId, range);
  } else if (mimeType === 'application/vnd.google-apps.document') {
    content = await readDocumentContent(docId);
  } else if (isMediaMime(mimeType)) {
    content = await readMediaContent(drive, docId, mimeType, meta.data.size);
  } else {
    // Export as plain text for other Google types
    const exported = await drive.files.export({
      fileId: docId,
      mimeType: 'text/plain',
    });
    content = String(exported.data);
  }

  return {
    id: docId,
    name,
    source: 'google',
    type,
    content,
    url: meta.data.webViewLink || undefined,
  };
}

async function readSpreadsheetContent(spreadsheetId: string, range?: string): Promise<string> {
  const sheets = getSheets();

  // If a specific range is provided, fetch it directly without preview limits
  if (range) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });
    const rows = res.data.values || [];
    if (rows.length === 0) return '(empty range)';

    const nonEmpty = rows.filter(r => r.some(c => c && String(c).trim()));
    const maxCols = Math.max(...rows.map(r => r.length));
    const parts: string[] = [];
    parts.push(`## ${range} (${nonEmpty.length} non-empty rows × ${maxCols} cols)\n`);
    for (const row of rows) {
      parts.push(row.join('\t'));
    }
    return parts.join('\n');
  }

  // Default: preview mode — show metadata + first 50 rows per sheet
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  });

  const sheetNames = (meta.data.sheets || []).map(s => s.properties?.title).filter(Boolean) as string[];
  const parts: string[] = [];

  for (const sheetName of sheetNames.slice(0, 10)) { // max 10 sheets
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sheetName}'`,
      });

      const rows = res.data.values || [];
      if (rows.length === 0) continue;

      const nonEmpty = rows.filter(r => r.some(c => c && String(c).trim()));
      const maxCols = Math.max(...rows.map(r => r.length));
      parts.push(`## Sheet: ${sheetName} (${nonEmpty.length} non-empty rows × ${maxCols} cols)`);

      // Header + first 50 rows
      const display = rows.slice(0, 51);
      for (const row of display) {
        parts.push(row.join('\t'));
      }

      if (rows.length > 51) {
        parts.push(`... (${rows.length - 51} more rows — use range "'${sheetName}'" to fetch all)`);
      }

      parts.push('');
    } catch {} // skip unreadable sheets
  }

  return parts.join('\n');
}

async function readDocumentContent(docId: string): Promise<string> {
  const drive = getDrive();
  const exported = await drive.files.export({
    fileId: docId,
    mimeType: 'text/plain',
  });
  return String(exported.data);
}

// ── Media transcription ──────────────────────────────────

async function readMediaContent(drive: drive_v3.Drive, fileId: string, mimeType: string, size?: string | null): Promise<string> {
  const sizeMB = size ? (parseInt(size) / (1024 * 1024)).toFixed(1) : '?';

  const { hasDeepgramKey, transcribe } = await import('../transcribe.ts');
  if (!hasDeepgramKey()) {
    return `[Media file: ${mimeType}, ${sizeMB} MB]\n\nTranscription requires Deepgram API key.\nRun: gated-knowledge auth deepgram --token <api-key>\n\nGet a key at https://console.deepgram.com/ (free tier: 45min/month)`;
  }

  // Download file binary from Google Drive
  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' },
  );
  const buffer = Buffer.from(response.data as ArrayBuffer);

  // Transcribe via Deepgram
  return await transcribe(buffer, mimeType);
}

// ── Delete file ──────────────────────────────────────────

export async function deleteGoogleFile(fileId: string): Promise<string> {
  const drive = google.drive({ version: 'v3', auth: getWriteAuth() });

  const meta = await drive.files.get({ fileId, fields: 'name, webViewLink' });
  const name = meta.data.name || 'Untitled';

  // Move to trash (safe, reversible)
  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
  });

  return `Moved to trash: "${name}"`;
}

// ── Write document content ───────────────────────────────

export async function writeGoogleDoc(docId: string, content: string): Promise<string> {
  const docs = google.docs({ version: 'v1', auth: getWriteAuth() });

  // Get current doc to find end index
  const doc = await docs.documents.get({ documentId: docId, fields: 'body.content' });
  const bodyContent = doc.data.body?.content || [];
  const lastElement = bodyContent[bodyContent.length - 1];
  const endIndex = lastElement?.endIndex ?? 1;

  const requests: any[] = [];

  // Delete all existing content (keep minimum 1-char paragraph)
  if (endIndex > 1) {
    requests.push({
      deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } },
    });
  }

  // Insert new content
  requests.push({
    insertText: { location: { index: 1 }, text: content },
  });

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests },
  });

  const meta = await google.drive({ version: 'v3', auth: getWriteAuth() }).files.get({
    fileId: docId,
    fields: 'name, webViewLink',
  });

  return `Written to "${meta.data.name}" — ${meta.data.webViewLink}`;
}

// ── Utils ────────────────────────────────────────────────

/**
 * Detect the header row from the first few rows of a sheet.
 * Strategy: prefer row 1 if it looks like headers (text labels, not data).
 * Fall back to the row with the best "header score" if row 1 is empty or data-like.
 */
function detectHeaderRow(rows: string[][]): string {
  if (rows.length === 0) return '';

  function headerScore(row: string[]): number {
    const filled = row.filter(c => c && c.trim());
    if (filled.length === 0) return 0;
    // Headers are typically short text labels, not emails/dates/numbers
    let textLike = 0;
    for (const cell of filled) {
      const v = cell.trim();
      // Penalize: emails, dates, long numbers, URLs
      if (v.includes('@') || /^\d{4}[-/]/.test(v) || /^[\d,.]+$/.test(v) || v.startsWith('http')) continue;
      // Penalize very long values (likely data, not headers)
      if (v.length > 60) continue;
      textLike++;
    }
    // Score: ratio of text-like cells * count bonus
    return (textLike / filled.length) * filled.length;
  }

  // Score each row
  const scores = rows.map((row, i) => ({ row, score: headerScore(row), idx: i }));

  // Prefer row 1 (idx 0) if it has a reasonable score
  const row1 = scores[0];
  if (row1 && row1.score >= 2) {
    const filled = row1.row.filter(c => c && c.trim());
    return filled.join(', ');
  }

  // Otherwise pick the best-scoring row
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  if (best && best.score > 0) {
    const filled = best.row.filter(c => c && c.trim());
    return filled.join(', ');
  }

  return '';
}

function mimeToType(mime: string): string {
  if (mime.includes('spreadsheet')) return 'spreadsheet';
  if (mime.includes('document')) return 'document';
  if (mime.includes('presentation')) return 'presentation';
  if (mime.includes('folder')) return 'folder';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

function isMediaMime(mime: string): boolean {
  return mime.startsWith('video/') || mime.startsWith('audio/');
}
