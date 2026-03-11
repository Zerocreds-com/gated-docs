/**
 * Gmail connector — read and send emails via Gmail API.
 * Two separate OAuth2 tokens for least privilege:
 *   - gmail/oauth      → gmail.readonly (read, search)
 *   - gmail/oauth-send → gmail.send (compose and send)
 * Auth fallback chain: OAuth2 → SA+DWD → ADC
 */
import { google, type gmail_v1 } from 'googleapis';
import { getCredential, getServiceAccountCredentials } from '../keychain.ts';
import { loadConfig } from '../config.ts';

function getAuth() {
  // 1. OAuth2 refresh token — simplest, like n8n
  const oauthJson = getCredential('gmail', 'oauth');
  if (oauthJson) {
    try {
      const decoded = Buffer.from(oauthJson, 'base64').toString('utf-8');
      const { client_id, client_secret, refresh_token } = JSON.parse(decoded);
      const oauth2 = new google.auth.OAuth2(client_id, client_secret);
      oauth2.setCredentials({ refresh_token });
      return oauth2;
    } catch {}
  }

  // 2. SA + Domain-Wide Delegation
  const config = loadConfig();
  const account = config.sources.google?.account;
  const impersonate = config.google_impersonate;

  if (account && impersonate) {
    const credentials = getServiceAccountCredentials(account);
    if (credentials) {
      return new google.auth.JWT({
        email: (credentials as any).client_email,
        key: (credentials as any).private_key,
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        subject: impersonate,
      });
    }
  }

  // 3. ADC fallback (requires periodic gcloud auth refresh)
  return new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  });
}

function getGmail(): gmail_v1.Gmail {
  return google.gmail({ version: 'v1', auth: getAuth() });
}

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labels: string[];
}

export interface EmailFull {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

/**
 * List recent emails matching a Gmail search query.
 * Uses Gmail search syntax: from:, subject:, newer_than:, is:unread, etc.
 */
export async function listEmails(query?: string, maxResults: number = 10): Promise<EmailSummary[]> {
  const gmail = getGmail();

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: query || '',
    maxResults,
  });

  const messages = res.data.messages || [];
  if (messages.length === 0) return [];

  // Fetch metadata for each message (batch via individual gets)
  const summaries: EmailSummary[] = [];

  for (const msg of messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id!,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date'],
    });

    const headers = detail.data.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

    summaries.push({
      id: msg.id!,
      threadId: msg.threadId || '',
      from: getHeader('From'),
      to: getHeader('To'),
      subject: getHeader('Subject'),
      date: getHeader('Date'),
      snippet: detail.data.snippet || '',
      labels: detail.data.labelIds || [],
    });
  }

  return summaries;
}

/**
 * Read full email body by message ID.
 */
export async function readEmail(messageId: string): Promise<EmailFull> {
  const gmail = getGmail();

  const detail = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const headers = detail.data.payload?.headers || [];
  const getHeader = (name: string) =>
    headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

  const body = extractBody(detail.data.payload!);

  return {
    id: messageId,
    from: getHeader('From'),
    to: getHeader('To'),
    subject: getHeader('Subject'),
    date: getHeader('Date'),
    body,
  };
}

/**
 * Extract readable text body from Gmail message payload.
 * Prefers text/plain, falls back to text/html (stripped of tags).
 */
function extractBody(payload: gmail_v1.Schema$MessagePart): string {
  // Direct body on the payload
  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    if (payload.mimeType === 'text/plain') return decoded;
    if (payload.mimeType === 'text/html') return stripHtml(decoded);
  }

  // Multipart — recurse through parts
  if (payload.parts) {
    // Prefer text/plain
    const plain = findPart(payload.parts, 'text/plain');
    if (plain?.body?.data) {
      return Buffer.from(plain.body.data, 'base64url').toString('utf-8');
    }

    // Fallback to text/html
    const html = findPart(payload.parts, 'text/html');
    if (html?.body?.data) {
      return stripHtml(Buffer.from(html.body.data, 'base64url').toString('utf-8'));
    }

    // Nested multipart (e.g. multipart/alternative inside multipart/mixed)
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  return '(no text content)';
}

function findPart(parts: gmail_v1.Schema$MessagePart[], mimeType: string): gmail_v1.Schema$MessagePart | undefined {
  for (const part of parts) {
    if (part.mimeType === mimeType) return part;
    if (part.parts) {
      const found = findPart(part.parts, mimeType);
      if (found) return found;
    }
  }
  return undefined;
}

// ── Send ─────────────────────────────────────────────────

function getSendAuth() {
  // Separate OAuth2 token with gmail.send scope
  const oauthJson = getCredential('gmail', 'oauth-send');
  if (oauthJson) {
    try {
      const decoded = Buffer.from(oauthJson, 'base64').toString('utf-8');
      const { client_id, client_secret, refresh_token } = JSON.parse(decoded);
      const oauth2 = new google.auth.OAuth2(client_id, client_secret);
      oauth2.setCredentials({ refresh_token });
      return oauth2;
    } catch {}
  }

  // SA + DWD fallback
  const config = loadConfig();
  const account = config.sources.google?.account;
  const impersonate = config.google_impersonate;

  if (account && impersonate) {
    const credentials = getServiceAccountCredentials(account);
    if (credentials) {
      return new google.auth.JWT({
        email: (credentials as any).client_email,
        key: (credentials as any).private_key,
        scopes: ['https://www.googleapis.com/auth/gmail.send'],
        subject: impersonate,
      });
    }
  }

  throw new Error('No send credentials. Run: gated-docs auth gmail --send');
}

/**
 * Send an email via Gmail API.
 * Requires gmail/oauth-send token (gmail.send scope).
 * Subject is RFC 2047 encoded (=?UTF-8?B?...?=), body is base64 with Content-Transfer-Encoding.
 */
export async function sendEmail(to: string, subject: string, body: string, cc?: string, bcc?: string): Promise<{ id: string; threadId: string }> {
  const auth = getSendAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  // Build RFC 2822 message
  const lines: string[] = [];
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset=utf-8');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(Buffer.from(body).toString('base64'));

  const raw = Buffer.from(lines.join('\r\n')).toString('base64url');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return {
    id: res.data.id || '',
    threadId: res.data.threadId || '',
  };
}

// ── HTML helpers ─────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
