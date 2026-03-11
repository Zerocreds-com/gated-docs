#!/usr/bin/env node --experimental-strip-types
/**
 * gated-docs CLI — auth, scan, search, status, setup.
 */

// Check Node.js version before anything else
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`\x1b[31m[gated-docs] Node.js 22+ required (you have ${process.versions.node})\x1b[0m`);
  console.error(`\nInstall the latest version:`);
  console.error(`  brew install node        # Homebrew (macOS)`);
  console.error(`  nvm install 22           # nvm`);
  console.error(`  fnm install 22           # fnm`);
  console.error(`  https://nodejs.org       # manual download`);
  process.exit(1);
}

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, saveConfig, loadStructure, CONFIG_PATH, STRUCTURE_PATH } from '../src/config.ts';
import { storeServiceAccountJson, storeCredential, hasCredential, deleteCredential, getServiceAccountCredentials } from '../src/keychain.ts';
import { scan } from '../src/scanner.ts';

const args = process.argv.slice(2);
const command = args[0];

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';

function info(msg: string) { console.log(`${CYAN}[gated-docs]${NC} ${msg}`); }
function ok(msg: string) { console.log(`${GREEN}  OK${NC} ${msg}`); }
function fail(msg: string) { console.log(`${RED}  ERR${NC} ${msg}`); }
function warn(msg: string) { console.log(`${YELLOW}  !${NC} ${msg}`); }

async function main() {
  switch (command) {
    case 'auth':
      await cmdAuth();
      break;
    case 'scan':
      await cmdScan();
      break;
    case 'status':
      cmdStatus();
      break;
    case 'search':
      await cmdSearch();
      break;
    case 'setup':
      await cmdSetup();
      break;
    case 'deauth':
      cmdDeauth();
      break;
    case 'check-email':
      await cmdCheckEmail();
      break;
    case 'impersonate':
      cmdImpersonate();
      break;
    default:
      printHelp();
  }
}

// ── auth ────────────────────────────────────────────────

async function cmdAuth() {
  const source = args[1];

  if (source === 'google') {
    const saFlag = args.indexOf('--service-account');
    if (saFlag === -1 || !args[saFlag + 1]) {
      fail('Usage: gated-docs auth google --service-account <path-to-key.json>');
      console.log(`\n${DIM}How to get a service account key:`);
      console.log('  1. Go to https://console.cloud.google.com/iam-admin/serviceaccounts');
      console.log('  2. Select your project (or create one)');
      console.log('  3. Click on a service account (or create one)');
      console.log('  4. Go to "Keys" tab → "Add Key" → "Create new key" → JSON');
      console.log('  5. Download the JSON file');
      console.log('  6. Share your Google Drive folders with the service account email');
      console.log(`  7. Run: gated-docs auth google --service-account ./downloaded-key.json${NC}`);
      process.exit(1);
    }

    const keyPath = resolve(args[saFlag + 1]);
    if (!existsSync(keyPath)) {
      fail(`File not found: ${keyPath}`);
      process.exit(1);
    }

    const keyJson = readFileSync(keyPath, 'utf-8');
    let parsed: any;
    try {
      parsed = JSON.parse(keyJson);
    } catch {
      fail('Invalid JSON file');
      process.exit(1);
    }

    if (parsed.type !== 'service_account') {
      fail(`Expected "type": "service_account", got "${parsed.type}"`);
      process.exit(1);
    }

    const email = storeServiceAccountJson(keyJson);
    ok(`Google service account stored in Keychain: ${email}`);

    // Update config
    const config = loadConfig();
    config.sources.google = { enabled: true, account: email };

    // --impersonate flag: enable Domain-Wide Delegation
    const impFlag = args.indexOf('--impersonate');
    if (impFlag !== -1 && args[impFlag + 1]) {
      config.google_impersonate = args[impFlag + 1];
      ok(`Domain-Wide Delegation: will impersonate ${config.google_impersonate}`);
    }

    saveConfig(config);
    ok('Config updated');

    // Auto-scan
    info('Scanning sources...');
    try {
      const structure = await scan();
      ok(`Found ${structure.docs.length} documents`);
    } catch (e: any) {
      warn(`Scan: ${e.message} (you can re-run: gated-docs scan)`);
    }

    console.log(`\n${BOLD}Next steps:${NC}`);
    console.log(`  1. Share your Google Drive folder with: ${CYAN}${email}${NC}`);
    console.log(`     (Right-click folder → Share → paste the email → Viewer)`);
    console.log(`  2. Restart Claude Code to pick up the MCP server`);
    updateClaudeMdAuth();

  } else if (source === 'gmail') {
    await authGmail();

  } else if (source === 'notion') {
    const tokenFlag = args.indexOf('--token');
    if (tokenFlag === -1 || !args[tokenFlag + 1]) {
      fail('Usage: gated-docs auth notion --token <your-notion-api-key>');
      console.log(`\n${DIM}How to get a Notion API key:`);
      console.log('  1. Go to https://www.notion.so/my-integrations');
      console.log('  2. Click "New integration"');
      console.log('  3. Give it a name (e.g., "gated-docs")');
      console.log('  4. Copy the "Internal Integration Token" (starts with ntn_)');
      console.log('  5. In Notion, share databases/pages with your integration');
      console.log(`  6. Run: gated-docs auth notion --token ntn_xxxx${NC}`);
      process.exit(1);
    }

    const token = args[tokenFlag + 1];
    storeCredential('notion', 'default', token);
    ok('Notion token stored in Keychain');

    const config = loadConfig();
    config.sources.notion = { enabled: true };
    saveConfig(config);
    ok('Config updated');

    await autoScan();

  } else if (source === 'slack') {
    const tokenFlag = args.indexOf('--token');
    if (tokenFlag === -1 || !args[tokenFlag + 1]) {
      fail('Usage: gated-docs auth slack --token <xoxb-or-xoxp-token>');
      console.log(`\n${DIM}How to get a Slack token:`);
      console.log('  1. Go to https://api.slack.com/apps');
      console.log('  2. Create an app → "From scratch"');
      console.log('  3. OAuth & Permissions → add scopes:');
      console.log('     Bot: channels:read, channels:history');
      console.log('     User (for search): search:read');
      console.log('  4. Install to workspace');
      console.log(`  5. Copy the token (xoxb-... or xoxp-...)${NC}`);
      process.exit(1);
    }

    const token = args[tokenFlag + 1];
    storeCredential('slack', 'default', token);
    ok('Slack token stored in Keychain');

    const config = loadConfig();
    config.sources.slack = { enabled: true };
    saveConfig(config);
    ok('Config updated');

    await autoScan();

  } else if (source === 'telegram') {
    info('Telegram Client API auth (full access to your chats)');
    console.log(`\n${DIM}You need api_id and api_hash from https://my.telegram.org/`);
    console.log('  1. Go to https://my.telegram.org/ → log in with your phone');
    console.log('  2. Click "API development tools"');
    console.log('  3. Create an application (any name)');
    console.log(`  4. Copy api_id (number) and api_hash (string)${NC}\n`);

    const apiIdFlag = args.indexOf('--api-id');
    const apiHashFlag = args.indexOf('--api-hash');

    let apiId: number;
    let apiHash: string;

    if (apiIdFlag !== -1 && apiHashFlag !== -1 && args[apiIdFlag + 1] && args[apiHashFlag + 1]) {
      apiId = parseInt(args[apiIdFlag + 1]);
      apiHash = args[apiHashFlag + 1];
    } else {
      // Interactive input
      const { default: input } = await import('input');
      const apiIdStr = await input.text('api_id (number): ');
      apiId = parseInt(apiIdStr);
      apiHash = await input.text('api_hash (string): ');
    }

    if (!apiId || !apiHash) {
      fail('api_id and api_hash are required');
      process.exit(1);
    }

    info('Starting Telegram auth (you will receive a code)...');
    const { interactiveAuth, storeTelegramCreds } = await import('../src/connectors/telegram.ts');
    const session = await interactiveAuth(apiId, apiHash);

    storeTelegramCreds({ apiId, apiHash, session });
    ok('Telegram session stored in Keychain');

    const config = loadConfig();
    config.sources.telegram = { enabled: true };
    saveConfig(config);
    ok('Config updated');

    await autoScan();

  } else if (source === 'cloudflare') {
    const tokenFlag = args.indexOf('--token');
    if (tokenFlag === -1 || !args[tokenFlag + 1]) {
      fail('Usage: gated-docs auth cloudflare --token <api-token>');
      console.log(`\n${DIM}How to get a Cloudflare API token:`);
      console.log('  1. Go to https://dash.cloudflare.com/profile/api-tokens');
      console.log('  2. Click "Create Token"');
      console.log('  3. Use "Custom token" template');
      console.log('  4. Add permissions (all Read):');
      console.log('     Zone: Zone, DNS');
      console.log('     Account: Workers Scripts, Pages, D1, Workers KV Storage, R2');
      console.log('  5. Zone Resources: Include All Zones');
      console.log(`  6. Copy the token and run: gated-docs auth cloudflare --token <token>${NC}`);
      process.exit(1);
    }

    const token = args[tokenFlag + 1];
    storeCredential('cloudflare', 'default', token);
    ok('Cloudflare API token stored in Keychain');

    const config = loadConfig();
    config.sources.cloudflare = { enabled: true };
    saveConfig(config);
    ok('Config updated');

    await autoScan();

  } else if (source === 'gitlab') {
    const tokenFlag = args.indexOf('--token');
    if (tokenFlag === -1 || !args[tokenFlag + 1]) {
      fail('Usage: gated-docs auth gitlab --token <personal-access-token> [--url https://gitlab.example.com]');
      console.log(`\n${DIM}How to get a GitLab Personal Access Token:`);
      console.log('  1. Go to your GitLab instance → User Settings → Access Tokens');
      console.log('     (or /-/user_settings/personal_access_tokens)');
      console.log('  2. Create a token with scopes: read_api, read_repository');
      console.log('  3. Copy the token');
      console.log(`  4. Run: gated-docs auth gitlab --token glpat-xxxx --url https://gitlab.example.com${NC}`);
      process.exit(1);
    }

    const token = args[tokenFlag + 1];
    storeCredential('gitlab', 'default', token);
    ok('GitLab token stored in Keychain');

    const config = loadConfig();
    config.sources.gitlab = { enabled: true };

    // --url flag for self-hosted instances
    const urlFlag = args.indexOf('--url');
    if (urlFlag !== -1 && args[urlFlag + 1]) {
      config.gitlab_url = args[urlFlag + 1].replace(/\/+$/, '');
      ok(`GitLab URL: ${config.gitlab_url}`);
    }

    saveConfig(config);
    ok('Config updated');

    await autoScan();

  } else {
    fail('Usage: gated-docs auth <google|notion|slack|telegram|cloudflare|gitlab> [options]');
  }
}

// ── auth gmail (OAuth2) ──────────────────────────────────

async function authGmail() {
  const isSend = args.includes('--send');
  const scope = isSend
    ? 'https://www.googleapis.com/auth/gmail.send'
    : 'https://www.googleapis.com/auth/gmail.readonly';
  const keychainKey = isSend ? 'oauth-send' : 'oauth';
  const label = isSend ? 'Gmail send' : 'Gmail read';

  const { google } = await import('googleapis');
  const http = await import('node:http');
  const { storeCredential, getCredential } = await import('../src/keychain.ts');

  // Get client_id/secret from flags, file, or reuse from existing read token
  let clientId: string | undefined;
  let clientSecret: string | undefined;

  const fileFlag = args.indexOf('--client-secret-file');
  const idFlag = args.indexOf('--client-id');
  const secretFlag = args.indexOf('--client-secret');

  if (fileFlag !== -1 && args[fileFlag + 1]) {
    const filePath = resolve(args[fileFlag + 1]);
    if (!existsSync(filePath)) { fail(`File not found: ${filePath}`); process.exit(1); }
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    const creds = raw.installed || raw.web;
    if (!creds) { fail('Invalid OAuth client JSON — expected "installed" or "web" key'); process.exit(1); }
    clientId = creds.client_id;
    clientSecret = creds.client_secret;
  } else if (idFlag !== -1 && secretFlag !== -1 && args[idFlag + 1] && args[secretFlag + 1]) {
    clientId = args[idFlag + 1];
    clientSecret = args[secretFlag + 1];
  } else {
    // Try reusing client_id/secret from existing read token
    const existing = getCredential('gmail', 'oauth');
    if (existing) {
      try {
        const decoded = JSON.parse(Buffer.from(existing, 'base64').toString('utf-8'));
        clientId = decoded.client_id;
        clientSecret = decoded.client_secret;
        info(`Reusing OAuth client from existing Gmail read token`);
      } catch {}
    }
  }

  if (!clientId || !clientSecret) {
    fail('Usage: gated-docs auth gmail [--send] --client-secret-file <path/client_secret.json>');
    console.log(`       gated-docs auth gmail [--send] --client-id <ID> --client-secret <SECRET>`);
    console.log(`\n${DIM}How to get OAuth credentials:`);
    console.log('  1. Open https://console.cloud.google.com/apis/credentials');
    console.log('  2. Click "+ Create Credentials" → "OAuth client ID"');
    console.log('  3. Application type: "Desktop app"');
    console.log('  4. Download the JSON file');
    console.log(`  5. Run: gated-docs auth gmail --client-secret-file ~/Downloads/client_secret_xxx.json${NC}`);
    if (isSend) console.log(`\nTip: if you already ran 'auth gmail' (read), just run 'auth gmail --send' — client creds will be reused.`);
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3847/callback');
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [scope],
  });

  // Start temporary local server to receive the callback
  const code = await new Promise<string>((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost:3847');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Authorization denied</h2><p>You can close this tab.</p>');
        srv.close();
        reject(new Error(`OAuth denied: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h2>✓ ${label} connected!</h2><p>You can close this tab and return to the terminal.</p>`);
        srv.close();
        resolve(code);
        return;
      }

      res.writeHead(404);
      res.end();
    });

    srv.listen(3847, () => {
      info(`Opening browser for ${label} authorization...`);
      import('node:child_process').then(cp => {
        cp.execSync(`open "${authUrl}"`);
      });
    });

    // Timeout after 2 minutes
    setTimeout(() => { srv.close(); reject(new Error('Auth timed out (2 min)')); }, 120000);
  });

  // Exchange code for tokens
  info('Exchanging auth code for tokens...');
  const { tokens } = await oauth2.getToken(code);

  if (!tokens.refresh_token) {
    fail('No refresh token received. Try again — Google may require re-consent.');
    process.exit(1);
  }

  // Store in Keychain (base64-encoded — security CLI strips JSON quotes)
  const creds = JSON.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
  });
  storeCredential('gmail', keychainKey, Buffer.from(creds).toString('base64'));
  ok(`${label} OAuth tokens stored in Keychain`);

  // Verify — getProfile requires gmail.readonly, skip for send-only token
  oauth2.setCredentials(tokens);
  if (!isSend) {
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    ok(`Connected to: ${profile.data.emailAddress}`);
  } else {
    ok(`Gmail send token stored (gmail.send scope)`);
  }

  console.log(`\n${label} access is permanent — no token refresh needed.`);
  console.log(`To revoke: ${CYAN}gated-docs deauth gmail${NC}`);
  if (!isSend && !getCredential('gmail', 'oauth-send')) {
    console.log(`\nTo also enable sending: ${CYAN}gated-docs auth gmail --send${NC} (reuses same client creds)`);
  }
  updateClaudeMdAuth();
}

// ── update CLAUDE.md auth status ─────────────────────────

function updateClaudeMdAuth() {
  const claudeMdPath = resolve(import.meta.dirname!, '..', 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) return;

  try {
    let content = readFileSync(claudeMdPath, 'utf-8');
    const config = loadConfig();

    // Build current auth status
    const lines: string[] = [];
    if (config.sources.google?.enabled) {
      const sa = config.sources.google.account || 'unknown';
      lines.push(`- Google Drive/Sheets/Docs: SA (${sa})`);
    }
    if (config.sources.google?.enabled && config.google_impersonate) {
      lines.push(`- BigQuery: SA + DWD impersonating ${config.google_impersonate}`);
    }
    if (hasCredential('gmail', 'oauth')) {
      const sendToo = hasCredential('gmail', 'oauth-send');
      lines.push(`- Gmail read: OAuth2 refresh token (permanent)`);
      if (sendToo) lines.push('- Gmail send: OAuth2 refresh token (permanent)');
    }
    if (config.sources.notion?.enabled) lines.push('- Notion: integration token');
    if (config.sources.slack?.enabled) lines.push('- Slack: bot token');
    if (config.sources.telegram?.enabled) lines.push('- Telegram: MTProto session');
    if (config.sources.cloudflare?.enabled) lines.push('- Cloudflare: API token');
    if (config.sources.gitlab?.enabled) {
      const url = config.gitlab_url || 'https://gitlab.com';
      lines.push(`- GitLab: Personal Access Token (${url})`);
    }

    const authBlock = `## Current auth\n\n${lines.join('\n')}`;

    // Replace or append auth block
    const authRegex = /## Current auth\n\n[\s\S]*?(?=\n## |\n$)/;
    if (authRegex.test(content)) {
      content = content.replace(authRegex, authBlock);
    } else {
      content = content.trimEnd() + '\n\n' + authBlock + '\n';
    }

    writeFileSync(claudeMdPath, content);
  } catch {}
}

// ── auto-scan helper ────────────────────────────────────

async function autoScan() {
  info('Scanning sources...');
  try {
    const structure = await scan();
    ok(`Found ${structure.docs.length} documents`);
    console.log(`\nRestart Claude Code to pick up the changes.`);
  } catch (e: any) {
    warn(`Scan failed: ${e.message}`);
    console.log(`You can retry: ${CYAN}gated-docs scan${NC}`);
  }
  updateClaudeMdAuth();
}

// ── scan ────────────────────────────────────────────────

async function cmdScan() {
  info('Scanning connected sources...');
  const structure = await scan();
  ok(`Scan complete: ${structure.docs.length} documents`);

  for (const [source, stat] of Object.entries(structure.stats)) {
    const types = Object.entries(stat.types).map(([t, n]) => `${n} ${t}s`).join(', ');
    ok(`${source}: ${stat.count} (${types})`);
  }

  console.log(`\nStructure saved to: ${DIM}${STRUCTURE_PATH}${NC}`);
  console.log(`MCP description will update on next Claude Code restart.`);
}

// ── status ──────────────────────────────────────────────

function cmdStatus() {
  const config = loadConfig();
  const structure = loadStructure();

  console.log(`\n${BOLD}gated-docs status${NC}\n`);
  console.log(`Config: ${DIM}${CONFIG_PATH}${NC}`);
  console.log(`Structure: ${DIM}${STRUCTURE_PATH}${NC}\n`);

  // Sources
  console.log(`${BOLD}Sources:${NC}`);

  const googleCfg = config.sources.google;
  if (googleCfg?.enabled) {
    const hasCreds = googleCfg.account && hasCredential('google', googleCfg.account);
    console.log(`  Google: ${hasCreds ? GREEN + 'connected' : RED + 'no credentials'}${NC} (${googleCfg.account || 'no account'})`);
  } else {
    console.log(`  Google: ${DIM}not configured${NC}`);
  }

  const notionCfg = config.sources.notion;
  if (notionCfg?.enabled) {
    const hasCreds = hasCredential('notion', 'default');
    console.log(`  Notion: ${hasCreds ? GREEN + 'connected' : RED + 'no credentials'}${NC}`);
  } else {
    console.log(`  Notion: ${DIM}not configured${NC}`);
  }

  const slackCfg = config.sources.slack;
  if (slackCfg?.enabled) {
    const hasCreds = hasCredential('slack', 'default');
    console.log(`  Slack:  ${hasCreds ? GREEN + 'connected' : RED + 'no credentials'}${NC}`);
  } else {
    console.log(`  Slack:  ${DIM}not configured${NC}`);
  }

  const telegramCfg = config.sources.telegram;
  if (telegramCfg?.enabled) {
    const hasCreds = hasCredential('telegram', 'default');
    console.log(`  Telegram: ${hasCreds ? GREEN + 'connected' : RED + 'no credentials'}${NC}`);
  } else {
    console.log(`  Telegram: ${DIM}not configured${NC}`);
  }

  // Gmail (separate from Google source)
  const gmailRead = hasCredential('gmail', 'oauth');
  const gmailSend = hasCredential('gmail', 'oauth-send');
  if (gmailRead || gmailSend) {
    const parts = [];
    if (gmailRead) parts.push('read');
    if (gmailSend) parts.push('send');
    console.log(`  Gmail:  ${GREEN}connected${NC} (${parts.join(' + ')})`);
  } else {
    console.log(`  Gmail:  ${DIM}not configured${NC}`);
  }

  const cloudflareCfg = config.sources.cloudflare;
  if (cloudflareCfg?.enabled) {
    const hasCreds = hasCredential('cloudflare', 'default');
    console.log(`  Cloudflare: ${hasCreds ? GREEN + 'connected' : RED + 'no credentials'}${NC}`);
  } else {
    console.log(`  Cloudflare: ${DIM}not configured${NC}`);
  }

  const gitlabCfg = config.sources.gitlab;
  if (gitlabCfg?.enabled) {
    const hasCreds = hasCredential('gitlab', 'default');
    const url = config.gitlab_url || 'https://gitlab.com';
    console.log(`  GitLab: ${hasCreds ? GREEN + 'connected' : RED + 'no credentials'}${NC} (${url})`);
  } else {
    console.log(`  GitLab: ${DIM}not configured${NC}`);
  }

  // Structure
  if (structure) {
    console.log(`\n${BOLD}Last scan:${NC} ${structure.generated_at}`);
    console.log(`Documents: ${structure.docs.length}`);
    for (const [source, stat] of Object.entries(structure.stats)) {
      const types = Object.entries(stat.types).map(([t, n]) => `${n} ${t}s`).join(', ');
      console.log(`  ${source}: ${stat.count} (${types})`);
    }

    console.log(`\n${BOLD}MCP description:${NC}`);
    console.log(structure.mcp_description.split('\n').map(l => `  ${l}`).join('\n'));
  } else {
    console.log(`\n${YELLOW}No scan data yet.${NC} Run: gated-docs scan`);
  }
  console.log('');
}

// ── search (CLI test) ───────────────────────────────────

async function cmdSearch() {
  const query = args.slice(1).join(' ');
  if (!query) {
    fail('Usage: gated-docs search <query>');
    process.exit(1);
  }

  info(`Searching: "${query}"...`);
  const config = loadConfig();
  const results: any[] = [];

  if (config.sources.google?.enabled) {
    try {
      const { searchGoogle } = await import('../src/connectors/google.ts');
      results.push(...await searchGoogle(query, 5));
    } catch (e: any) {
      warn(`Google: ${e.message}`);
    }
  }

  if (config.sources.notion?.enabled) {
    try {
      const { searchNotion } = await import('../src/connectors/notion.ts');
      results.push(...await searchNotion(query, 5));
    } catch (e: any) {
      warn(`Notion: ${e.message}`);
    }
  }

  if (config.sources.telegram?.enabled) {
    try {
      const { searchTelegram } = await import('../src/connectors/telegram.ts');
      results.push(...await searchTelegram(query, 5));
    } catch (e: any) {
      warn(`Telegram: ${e.message}`);
    }
  }

  if (config.sources.cloudflare?.enabled) {
    try {
      const { searchCloudflare } = await import('../src/connectors/cloudflare.ts');
      results.push(...await searchCloudflare(query, 5));
    } catch (e: any) {
      warn(`Cloudflare: ${e.message}`);
    }
  }

  if (config.sources.gitlab?.enabled) {
    try {
      const { searchGitLab } = await import('../src/connectors/gitlab.ts');
      results.push(...await searchGitLab(query, 5));
    } catch (e: any) {
      warn(`GitLab: ${e.message}`);
    }
  }

  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  for (const r of results) {
    console.log(`\n  ${BOLD}${r.name}${NC} [${r.source}/${r.type}]`);
    if (r.snippet) console.log(`  ${DIM}${r.snippet}${NC}`);
    if (r.url) console.log(`  ${CYAN}${r.url}${NC}`);
    console.log(`  ID: ${r.id}`);
  }
  console.log('');
}

// ── setup (register MCP) ───────────────────────────────

async function cmdSetup() {
  const { execSync } = await import('node:child_process');
  const repoDir = resolve(import.meta.dirname!, '..');

  info('Registering gated-docs MCP server...');

  const claudeJson = resolve(process.env.HOME || '', '.claude.json');
  let config: any = {};
  try {
    config = JSON.parse(readFileSync(claudeJson, 'utf-8'));
  } catch {}

  if (!config.mcpServers) config.mcpServers = {};

  config.mcpServers['gated-docs'] = {
    type: 'stdio',
    command: 'node',
    args: ['--experimental-strip-types', `${repoDir}/bin/mcp-server.ts`],
    env: {},
  };

  const { writeFileSync } = await import('node:fs');
  writeFileSync(claudeJson, JSON.stringify(config, null, 2) + '\n');
  ok('MCP server registered in ~/.claude.json');

  console.log(`\n${BOLD}Next steps:${NC}`);
  console.log(`  1. Add credentials: ${CYAN}gated-docs auth google --service-account <key.json>${NC}`);
  console.log(`  2. Scan sources:    ${CYAN}gated-docs scan${NC}`);
  console.log(`  3. Restart Claude Code to activate MCP`);
  console.log('');
}

// ── check-email ──────────────────────────────────────────

async function cmdCheckEmail() {
  const queryOrId = args.slice(1).join(' ');

  // If argument looks like a message ID (no spaces, alphanumeric), read full email
  if (queryOrId && /^[a-zA-Z0-9]+$/.test(queryOrId) && queryOrId.length > 10) {
    info(`Reading email ${queryOrId}...`);
    const { readEmail } = await import('../src/connectors/gmail.ts');
    const email = await readEmail(queryOrId);
    console.log(`\n  ${BOLD}${email.subject}${NC}`);
    console.log(`  From: ${email.from}`);
    console.log(`  Date: ${email.date}`);
    console.log(`  ${DIM}───${NC}`);
    console.log(email.body);
    return;
  }

  const query = queryOrId || undefined;
  info(query ? `Searching emails: "${query}"...` : 'Fetching latest emails...');

  const { listEmails } = await import('../src/connectors/gmail.ts');
  const emails = await listEmails(query, 10);

  if (emails.length === 0) {
    console.log('No emails found.');
    return;
  }

  for (const e of emails) {
    console.log(`\n  ${BOLD}${e.subject || '(no subject)'}${NC}`);
    console.log(`  From: ${e.from}`);
    console.log(`  Date: ${e.date}`);
    if (e.snippet) console.log(`  ${DIM}${e.snippet.slice(0, 120)}${NC}`);
    console.log(`  ID: ${CYAN}${e.id}${NC}`);
  }
  console.log('');
}

// ── impersonate (set DWD email) ──────────────────────────

function cmdImpersonate() {
  const email = args[1];
  if (!email || !email.includes('@')) {
    fail('Usage: gated-docs impersonate <user@domain.com>');
    console.log(`\n${DIM}Sets Domain-Wide Delegation impersonation email.`);
    console.log('The SA will act on behalf of this user for Gmail and BigQuery.');
    console.log(`Requires DWD to be configured in Google Admin Console.${NC}`);
    process.exit(1);
  }

  const config = loadConfig();
  config.google_impersonate = email;
  saveConfig(config);
  ok(`Impersonation set: ${email}`);
  console.log(`\n${BOLD}Make sure DWD is configured:${NC}`);
  console.log(`  admin.google.com → Security → API controls → Domain-wide delegation`);
  console.log(`  Client ID: ${CYAN}${getSaClientId(config) || '(run gated-docs status to check)'}${NC}`);
  console.log(`  Scopes: gmail.readonly, bigquery.readonly`);
}

function getSaClientId(config: ReturnType<typeof loadConfig>): string {
  const account = config.sources.google?.account;
  if (!account) return '';
  const creds = getServiceAccountCredentials(account);
  return (creds as any)?.client_id || '';
}

// ── deauth ──────────────────────────────────────────────

function cmdDeauth() {
  const source = args[1];
  if (!source) {
    fail('Usage: gated-docs deauth <google|notion|slack|telegram|cloudflare|gitlab|gmail>');
    process.exit(1);
  }

  const config = loadConfig();

  if (source === 'google' && config.sources.google?.account) {
    deleteCredential('google', config.sources.google.account);
    config.sources.google = { enabled: false };
  } else if (source === 'notion') {
    deleteCredential('notion', 'default');
    config.sources.notion = { enabled: false };
  } else if (source === 'slack') {
    deleteCredential('slack', 'default');
    config.sources.slack = { enabled: false };
  } else if (source === 'telegram') {
    deleteCredential('telegram', 'default');
    config.sources.telegram = { enabled: false };
  } else if (source === 'cloudflare') {
    deleteCredential('cloudflare', 'default');
    config.sources.cloudflare = { enabled: false };
  } else if (source === 'gitlab') {
    deleteCredential('gitlab', 'default');
    config.sources.gitlab = { enabled: false };
  } else if (source === 'gmail') {
    deleteCredential('gmail', 'oauth');
    deleteCredential('gmail', 'oauth-send');
  }

  saveConfig(config);
  ok(`${source} disconnected`);
  updateClaudeMdAuth();
}

// ── help ────────────────────────────────────────────────

function printHelp() {
  console.log(`
${BOLD}gated-docs${NC} — MCP server for auth-gated sources

${BOLD}Commands:${NC}
  auth google --service-account <key.json>   Connect Google Drive
    [--impersonate user@domain.com]            Enable Domain-Wide Delegation
  impersonate <email>                        Set DWD impersonation email
  auth notion --token <ntn_xxx>              Connect Notion
  auth slack  --token <xoxb-xxx>             Connect Slack
  auth telegram                              Connect Telegram (Client API)
  auth cloudflare --token <cf-token>         Connect Cloudflare
  auth gitlab --token <pat> [--url <url>]    Connect GitLab (self-hosted or gitlab.com)
  auth gmail --client-secret-file <json>     Connect Gmail read (OAuth2, permanent)
  auth gmail --send                          Connect Gmail send (reuses client creds)
  scan                                       Scan all sources, update structure
  search <query>                             Test search from CLI
  check-email [query]                        Check Gmail inbox
  status                                     Show connection status
  setup                                      Register MCP server in ~/.claude.json
  deauth <source>                            Remove credentials

${BOLD}Quick start:${NC}
  gated-docs setup
  gated-docs auth google --service-account ~/Downloads/key.json
  gated-docs scan

${BOLD}How it works:${NC}
  Credentials stored in macOS Keychain (not on disk).
  MCP server runs as stdio — no network port, no exposure.
  Claude Code calls search/read_document tools when needed.
`);
}

main().catch(e => {
  fail(e.message);
  process.exit(1);
});
