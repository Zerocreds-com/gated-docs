/**
 * Google Drive / Sheets / Docs connector.
 * Uses service account JSON stored in macOS Keychain.
 */
import { google, type drive_v3, type sheets_v4 } from 'googleapis';
import { getServiceAccountCredentials } from '../keychain.ts';
import { loadConfig } from '../config.ts';
import type { SearchResult, DocContent, StructureDoc } from '../types.ts';

let cachedAuth: ReturnType<typeof google.auth.GoogleAuth> | null = null;
let cachedAccount: string | null = null;
let cachedWriteAuth: ReturnType<typeof google.auth.GoogleAuth> | null = null;

function getAuth(): ReturnType<typeof google.auth.GoogleAuth> {
  const config = loadConfig();
  const account = config.sources.google?.account;
  if (!account) throw new Error('Google not configured. Run: gated-info auth google --service-account <key.json>');

  if (cachedAuth && cachedAccount === account) return cachedAuth;

  const credentials = getServiceAccountCredentials(account);
  if (!credentials) throw new Error(`Google credentials not found in keychain for ${account}. Run: gated-info auth google --service-account <key.json>`);

  cachedAuth = new google.auth.GoogleAuth({
    credentials: credentials as any,
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/documents.readonly',
    ],
  });
  cachedAccount = account;
  return cachedAuth;
}

function getWriteAuth(): ReturnType<typeof google.auth.GoogleAuth> {
  if (cachedWriteAuth) return cachedWriteAuth;

  const config = loadConfig();
  const account = config.sources.google?.account;
  if (!account) throw new Error('Google not configured. Run: gated-info auth google --service-account <key.json>');

  const credentials = getServiceAccountCredentials(account);
  if (!credentials) throw new Error(`Google credentials not found in keychain for ${account}.`);

  cachedWriteAuth = new google.auth.GoogleAuth({
    credentials: credentials as any,
    scopes: [
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
  return cachedWriteAuth;
}

function getDrive(): drive_v3.Drive {
  return google.drive({ version: 'v3', auth: getAuth() });
}

function getSheets(): sheets_v4.Sheets {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

// ── Scan: list all accessible files ─────────────────────

export async function scanGoogleDrive(): Promise<StructureDoc[]> {
  const drive = getDrive();
  const docs: StructureDoc[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: "trashed = false and (mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.google-apps.presentation')",
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, parents, webViewLink)',
      pageSize: 200,
      pageToken,
      orderBy: 'modifiedTime desc',
    });

    for (const f of res.data.files || []) {
      const type = mimeToType(f.mimeType || '');
      docs.push({
        id: f.id!,
        name: f.name || 'Untitled',
        type,
        source: 'google',
        modified_at: f.modifiedTime || undefined,
        url: f.webViewLink || undefined,
      });
    }

    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  // Resolve parent folder names for context
  await resolveParentFolders(drive, docs);

  // Enrich spreadsheets with sheet names + headers
  const sheets = getSheets();
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

  return docs;
}

async function resolveParentFolders(drive: drive_v3.Drive, docs: StructureDoc[]): Promise<void> {
  // Collect unique parent IDs
  const parentIds = new Set<string>();
  // We need to get parents from the API — re-fetch with parents field
  const filesWithParents = await drive.files.list({
    q: "trashed = false and (mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'application/vnd.google-apps.document')",
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
  const drive = getDrive();

  // Use Google Drive's full-text search
  const escapedQuery = query.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `fullText contains '${escapedQuery}' and trashed = false`,
    fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
    pageSize: limit,
    orderBy: 'modifiedTime desc',
  });

  return (res.data.files || []).map(f => ({
    id: f.id!,
    name: f.name || 'Untitled',
    source: 'google' as const,
    type: mimeToType(f.mimeType || ''),
    snippet: '', // Google API doesn't return snippets in file list
    url: f.webViewLink || undefined,
    modified_at: f.modifiedTime || undefined,
  }));
}

// ── Read document content ────────────────────────────────

export async function readGoogleDoc(docId: string): Promise<DocContent> {
  const drive = getDrive();

  // Get file metadata
  const meta = await drive.files.get({
    fileId: docId,
    fields: 'id, name, mimeType, webViewLink',
  });

  const mimeType = meta.data.mimeType || '';
  const name = meta.data.name || 'Untitled';
  const type = mimeToType(mimeType);

  let content: string;

  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    content = await readSpreadsheetContent(docId);
  } else if (mimeType === 'application/vnd.google-apps.document') {
    content = await readDocumentContent(docId);
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

async function readSpreadsheetContent(spreadsheetId: string): Promise<string> {
  const sheets = getSheets();

  // Get all sheet names
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

      parts.push(`## Sheet: ${sheetName}`);

      // Header + first 50 rows
      const display = rows.slice(0, 51);
      for (const row of display) {
        parts.push(row.join('\t'));
      }

      if (rows.length > 51) {
        parts.push(`... (${rows.length - 51} more rows)`);
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
  return 'file';
}
