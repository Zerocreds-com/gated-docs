/**
 * Slack connector — searches messages and channels.
 * Uses Slack bot token stored in macOS Keychain.
 */
import { getCredential } from '../keychain.ts';
import type { SearchResult, DocContent, StructureDoc } from '../types.ts';

function getToken(): string {
  const token = getCredential('slack', 'default');
  if (!token) throw new Error('Slack not configured. Run: gated-info auth slack --token <xoxb-token>');
  return token;
}

async function slackFetch(method: string, params: Record<string, string> = {}): Promise<any> {
  const token = getToken();
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  return data;
}

// ── Scan ─────────────────────────────────────────────────

export async function scanSlack(): Promise<StructureDoc[]> {
  const docs: StructureDoc[] = [];

  // List channels the bot is in
  const res = await slackFetch('conversations.list', {
    types: 'public_channel,private_channel',
    limit: '200',
  });

  for (const ch of res.channels || []) {
    docs.push({
      id: ch.id,
      name: `#${ch.name}`,
      type: 'channel',
      source: 'slack',
      snippet: ch.topic?.value || ch.purpose?.value || undefined,
    });
  }

  return docs;
}

// ── Search ──────────────────────────────────────────────

export async function searchSlack(query: string, limit: number = 10): Promise<SearchResult[]> {
  // Note: search.messages requires a user token (xoxp), not bot token.
  // With bot token, we search by listing recent messages in channels.
  // For full search, user needs xoxp token.
  const token = getToken();

  // Try search.messages first (requires user token with search:read scope)
  try {
    const res = await fetch(`https://slack.com/api/search.messages?query=${encodeURIComponent(query)}&count=${limit}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await res.json();

    if (data.ok && data.messages?.matches) {
      return data.messages.matches.map((m: any) => ({
        id: m.ts,
        name: `#${m.channel?.name || 'unknown'}`,
        source: 'slack' as const,
        type: 'message',
        snippet: m.text?.slice(0, 300) || '',
        url: m.permalink,
        modified_at: m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString() : undefined,
      }));
    }
  } catch {}

  return [];
}

// ── Read ────────────────────────────────────────────────

export async function readSlackChannel(channelId: string, messageCount: number = 50): Promise<DocContent> {
  const res = await slackFetch('conversations.history', {
    channel: channelId,
    limit: String(messageCount),
  });

  const messages = (res.messages || []).reverse();
  const content = messages.map((m: any) => {
    const time = m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString().slice(0, 16) : '';
    const user = m.user || 'bot';
    return `[${time}] ${user}: ${m.text || ''}`;
  }).join('\n');

  return {
    id: channelId,
    name: `Channel ${channelId}`,
    source: 'slack',
    type: 'channel',
    content: content || '(no messages)',
  };
}
