/**
 * Telegram connector — Client API (MTProto) via gramjs.
 * Full access to all chats and messages (not a bot).
 * Uses api_id, api_hash and session string from macOS Keychain.
 */
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { getCredential, storeCredential } from '../keychain.ts';
import type { SearchResult, DocContent, StructureDoc } from '../types.ts';

// ── Auth helpers ─────────────────────────────────────────

interface TelegramCreds {
  apiId: number;
  apiHash: string;
  session: string;
}

export function getTelegramCreds(): TelegramCreds | null {
  const raw = getCredential('telegram', 'default');
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

export function storeTelegramCreds(creds: TelegramCreds): void {
  const encoded = Buffer.from(JSON.stringify(creds)).toString('base64');
  storeCredential('telegram', 'default', encoded);
}

// ── Client management ────────────────────────────────────

let cachedClient: TelegramClient | null = null;

async function getClient(): Promise<TelegramClient> {
  if (cachedClient?.connected) return cachedClient;

  const creds = getTelegramCreds();
  if (!creds) throw new Error('Telegram not configured. Run: gated-docs auth telegram');

  const session = new StringSession(creds.session);
  const client = new TelegramClient(session, creds.apiId, creds.apiHash, {
    connectionRetries: 3,
  });

  await client.connect();
  cachedClient = client;
  return client;
}

/**
 * Interactive auth flow — called from CLI only.
 * Prompts for phone number and confirmation code.
 */
export async function interactiveAuth(apiId: number, apiHash: string): Promise<string> {
  const { default: input } = await import('input');

  const session = new StringSession('');
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber: async () => await input.text('Phone number (with country code, e.g. +7...): '),
    phoneCode: async () => await input.text('Code from Telegram: '),
    password: async () => await input.text('2FA password (if enabled): '),
    onError: (err) => { console.error('Auth error:', err.message); },
  });

  const sessionString = client.session.save() as unknown as string;
  await client.disconnect();
  return sessionString;
}

// ── Scan: list dialogs (chats) ──────────────────────────

export async function scanTelegram(): Promise<StructureDoc[]> {
  const client = await getClient();
  const docs: StructureDoc[] = [];

  const dialogs = await client.getDialogs({ limit: 100 });

  for (const dialog of dialogs) {
    const entity = dialog.entity;
    if (!entity) continue;

    let type = 'chat';
    let name = dialog.title || 'Unknown';

    if (entity.className === 'User') {
      type = 'user';
      const user = entity as Api.User;
      name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'Unknown';
    } else if (entity.className === 'Channel') {
      const channel = entity as Api.Channel;
      type = channel.megagroup ? 'group' : 'channel';
    } else if (entity.className === 'Chat') {
      type = 'group';
    }

    docs.push({
      id: dialog.id!.toString(),
      name,
      type,
      source: 'telegram',
      snippet: dialog.message?.message?.slice(0, 100) || undefined,
    });
  }

  return docs;
}

// ── Search messages ─────────────────────────────────────

export async function searchTelegram(query: string, limit: number = 10): Promise<SearchResult[]> {
  const client = await getClient();
  const results: SearchResult[] = [];

  // Global search across all chats
  const messages = await client.getMessages(undefined as any, {
    search: query,
    limit,
  });

  for (const msg of messages) {
    if (!msg.message) continue;

    let chatName = 'Unknown';
    try {
      if (msg.peerId) {
        const entity = await client.getEntity(msg.peerId);
        if ('title' in entity) {
          chatName = (entity as any).title;
        } else if ('firstName' in entity) {
          chatName = [(entity as any).firstName, (entity as any).lastName].filter(Boolean).join(' ');
        }
      }
    } catch {}

    results.push({
      id: msg.id.toString(),
      name: chatName,
      source: 'telegram',
      type: 'message',
      snippet: msg.message.slice(0, 300),
      modified_at: msg.date ? new Date(msg.date * 1000).toISOString() : undefined,
    });
  }

  return results;
}

// ── Read chat history ───────────────────────────────────

export async function readTelegramChat(chatId: string, messageCount: number = 50): Promise<DocContent> {
  const client = await getClient();

  // Resolve entity
  let entity: Api.TypeEntity;
  try {
    entity = await client.getEntity(chatId);
  } catch {
    // Try as numeric ID
    entity = await client.getEntity(BigInt(chatId) as any);
  }

  let chatName = 'Unknown';
  if ('title' in entity) {
    chatName = (entity as any).title;
  } else if ('firstName' in entity) {
    chatName = [(entity as any).firstName, (entity as any).lastName].filter(Boolean).join(' ');
  }

  const messages = await client.getMessages(entity, { limit: messageCount });

  const lines: string[] = [];
  for (const msg of messages.reverse()) {
    const time = msg.date ? new Date(msg.date * 1000).toISOString().slice(0, 16) : '';
    let sender = '';
    try {
      if (msg.senderId) {
        const senderEntity = await client.getEntity(msg.senderId);
        if ('firstName' in senderEntity) {
          sender = [(senderEntity as any).firstName, (senderEntity as any).lastName].filter(Boolean).join(' ');
        } else if ('title' in senderEntity) {
          sender = (senderEntity as any).title;
        }
      }
    } catch {
      sender = msg.senderId?.toString() || 'unknown';
    }

    if (msg.message) {
      lines.push(`[${time}] ${sender}: ${msg.message}`);
    }
  }

  return {
    id: chatId,
    name: chatName,
    source: 'telegram',
    type: 'chat',
    content: lines.join('\n') || '(no messages)',
  };
}
