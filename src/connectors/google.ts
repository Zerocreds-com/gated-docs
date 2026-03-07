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

// ── Utils ────────────────────────────────────────────────

function mimeToType(mime: string): string {
  if (mime.includes('spreadsheet')) return 'spreadsheet';
  if (mime.includes('document')) return 'document';
  if (mime.includes('presentation')) return 'presentation';
  if (mime.includes('folder')) return 'folder';
  return 'file';
}
