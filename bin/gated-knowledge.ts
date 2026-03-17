#!/usr/bin/env node --experimental-strip-types
/**
 * gated-knowledge CLI — auth, scan, search, status, setup.
 */

// Check Node.js version before anything else
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`\x1b[31m[gated-knowledge] Node.js 22+ required (you have ${process.versions.node})\x1b[0m`);
  console.error(`\nInstall the latest version:`);
  console.error(`  https://nodejs.org       # official installer (all platforms)`);
  console.error(`  brew install node        # macOS (Homebrew)`);
  console.error(`  winget install OpenJS.NodeJS  # Windows`);
  console.error(`  nvm install 22           # nvm`);
  console.error(`  fnm install 22           # fnm`);
  process.exit(1);
}

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
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

function info(msg: string) { console.log(`${CYAN}[gated-knowledge]${NC} ${msg}`); }
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
    case 'init':
      await cmdInit();
      break;
    case 'team':
      await cmdTeam();
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

    if (saFlag !== -1 && args[saFlag + 1]) {
      // ── Service Account flow (advanced) ─────────────────
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
      ok(`Google service account stored securely: ${email}`);

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
        warn(`Scan: ${e.message} (you can re-run: gated-knowledge scan)`);
      }

      console.log(`\n${BOLD}Next steps:${NC}`);
      console.log(`  1. Share your Google Drive folder with: ${CYAN}${email}${NC}`);
      console.log(`     (Right-click folder → Share → paste the email → Viewer)`);
      console.log(`  2. Restart Claude Code to pick up the MCP server`);
      updateClaudeMdAuth();
    } else {
      // ── OAuth2 browser flow (default, easy) ─────────────
      await authGoogleOAuth();
    }

  } else if (source === 'gmail') {
    await authGmail();

  } else if (source === 'notion') {
    const tokenFlag = args.indexOf('--token');
    if (tokenFlag === -1 || !args[tokenFlag + 1]) {
      fail('Usage: gated-knowledge auth notion --token <your-notion-api-key>');
      console.log(`\n${DIM}How to get a Notion API key:`);
      console.log('  1. Go to https://www.notion.so/my-integrations');
      console.log('  2. Click "New integration"');
      console.log('  3. Give it a name (e.g., "gated-knowledge")');
      console.log('  4. Copy the "Internal Integration Token" (starts with ntn_)');
      console.log('  5. In Notion, share databases/pages with your integration');
      console.log(`  6. Run: gated-knowledge auth notion --token ntn_xxxx${NC}`);
      process.exit(1);
    }

    const token = args[tokenFlag + 1];
    storeCredential('notion', 'default', token);
    ok('Notion token stored securely');

    const config = loadConfig();
    config.sources.notion = { enabled: true };
    saveConfig(config);
    ok('Config updated');

    await autoScan('notion');

  } else if (source === 'slack') {
    const tokenFlag = args.indexOf('--token');
    if (tokenFlag === -1 || !args[tokenFlag + 1]) {
      fail('Usage: gated-knowledge auth slack --token <xoxb-or-xoxp-token>');
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
    ok('Slack token stored securely');

    const config = loadConfig();
    config.sources.slack = { enabled: true };
    saveConfig(config);
    ok('Config updated');

    await autoScan('slack');

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
    ok('Telegram session stored securely');

    const config = loadConfig();
    config.sources.telegram = { enabled: true };
    saveConfig(config);
    ok('Config updated');

    await autoScan('telegram');

  } else if (source === 'cloudflare') {
    const tokenFlag = args.indexOf('--token');
    if (tokenFlag === -1 || !args[tokenFlag + 1]) {
      fail('Usage: gated-knowledge auth cloudflare --token <api-token>');
      console.log(`\n${DIM}How to get a Cloudflare API token:`);
      console.log('  1. Go to https://dash.cloudflare.com/profile/api-tokens');
      console.log('  2. Click "Create Token"');
      console.log('  3. Use "Custom token" template');
      console.log('  4. Add permissions (all Read):');
      console.log('     Zone: Zone, DNS');
      console.log('     Account: Workers Scripts, Pages, D1, Workers KV Storage, R2');
      console.log('  5. Zone Resources: Include All Zones');
      console.log(`  6. Copy the token and run: gated-knowledge auth cloudflare --token <token>${NC}`);
      process.exit(1);
    }

    const token = args[tokenFlag + 1];
    storeCredential('cloudflare', 'default', token);
    ok('Cloudflare API token stored securely');

    // Verify token & probe permissions
    console.log(`\n${DIM}Verifying token permissions...${NC}`);
    try {
      const { probeCloudflarePermissions } = await import('../src/connectors/cloudflare.ts');
      const probe = await probeCloudflarePermissions(token);
      if (!probe.valid) {
        console.log(`  ${RED}✗ Token verification failed (status: ${probe.status || 'unknown'})${NC}`);
      } else {
        console.log(`  ${GREEN}✓ Token is ${probe.status || 'active'}${NC}${probe.expires_on ? ` (expires: ${probe.expires_on})` : ''}`);
        const entries = Object.entries(probe.permissions);
        if (entries.length > 0) {
          console.log(`  Permissions detected:`);
          for (const [name, hasAccess] of entries) {
            console.log(`    ${hasAccess ? GREEN + '✓' : RED + '✗'} ${name}${NC}`);
          }
        }
      }
    } catch (e: any) {
      console.log(`  ${DIM}(probe failed: ${e.message})${NC}`);
    }

    const config = loadConfig();
    config.sources.cloudflare = { enabled: true };
    saveConfig(config);
    ok('Config updated');

    await autoScan('cloudflare');

  } else if (source === 'gitlab') {
    const tokenFlag = args.indexOf('--token');
    if (tokenFlag === -1 || !args[tokenFlag + 1]) {
      fail('Usage: gated-knowledge auth gitlab --token <personal-access-token> [--url https://gitlab.example.com]');
      console.log(`\n${DIM}How to get a GitLab Personal Access Token:`);
      console.log('  1. Go to your GitLab instance → User Settings → Access Tokens');
      console.log('     (or /-/user_settings/personal_access_tokens)');
      console.log('  2. Create a token with scopes: read_api, read_repository');
      console.log('  3. Copy the token');
      console.log(`  4. Run: gated-knowledge auth gitlab --token glpat-xxxx --url https://gitlab.example.com${NC}`);
      process.exit(1);
    }

    const token = args[tokenFlag + 1];
    storeCredential('gitlab', 'default', token);
    ok('GitLab token stored securely');

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

    await autoScan('gitlab');

  } else if (source === 'langsmith') {
    const tokenFlag = args.indexOf('--token');
    if (tokenFlag === -1 || !args[tokenFlag + 1]) {
      fail('Usage: gated-knowledge auth langsmith --token <ls-api-key>');
      console.log(`\n${DIM}How to get a LangSmith API key:`);
      console.log('  1. Go to https://smith.langchain.com');
      console.log('  2. Click your avatar → Settings → API Keys');
      console.log('  3. Click "Create API Key"');
      console.log('  4. Copy the key (starts with lsv2_ or ls_)');
      console.log(`  5. Run: gated-knowledge auth langsmith --token lsv2_xxxx${NC}`);
      process.exit(1);
    }

    const token = args[tokenFlag + 1];
    storeCredential('langsmith', 'default', token);
    ok('LangSmith API key stored securely');

    const config = loadConfig();
    config.sources.langsmith = { enabled: true };
    saveConfig(config);
    ok('Config updated');

    await autoScan('langsmith');

  } else if (source === 'deepgram') {
    const tokenFlag = args.indexOf('--token');
    if (tokenFlag === -1 || !args[tokenFlag + 1]) {
      fail('Usage: gated-knowledge auth deepgram --token <api-key>');
      console.log(`\n${DIM}How to get a Deepgram API key:`);
      console.log('  1. Go to https://console.deepgram.com/');
      console.log('  2. Sign up (free tier: 45 min/month transcription)');
      console.log('  3. Go to API Keys → Create Key');
      console.log('  4. Copy the key');
      console.log(`  5. Run: gated-knowledge auth deepgram --token <key>${NC}`);
      process.exit(1);
    }

    const token = args[tokenFlag + 1];
    storeCredential('deepgram', 'default', token);
    ok('Deepgram API key stored securely');
    console.log(`\nMedia files (video/audio) in Google Drive will now be transcribed automatically.`);
    console.log(`Model: nova-2 | Auto language detection | Speaker diarization`);

  } else if (source === 'drive') {
    await authDrive();

  } else {
    fail('Usage: gated-knowledge auth <google|notion|slack|telegram|cloudflare|gitlab|langsmith|deepgram|drive> [options]');
  }
}

// ── auth google OAuth2 (browser flow, zero GCP Console) ──

async function authGoogleOAuth() {
  const { getCredential } = await import('../src/keychain.ts');

  // Check if already authorized (skip re-auth unless --force)
  if (!args.includes('--force')) {
    const existing = getCredential('google', 'oauth');
    if (existing) {
      try {
        const { google } = await import('googleapis');
        const decoded = JSON.parse(Buffer.from(existing, 'base64').toString('utf-8'));
        const oauth2 = new google.auth.OAuth2(decoded.client_id, decoded.client_secret);
        oauth2.setCredentials({ refresh_token: decoded.refresh_token });
        const drive = google.drive({ version: 'v3', auth: oauth2 });
        await drive.files.list({ pageSize: 1 });

        // Check which accounts are connected
        const config = loadConfig();
        const accounts = config.google_accounts?.length ? config.google_accounts.join(', ') : 'connected';
        ok(`Google Drive already authorized (${accounts})`);
        console.log(`To add another account: ${CYAN}gated-knowledge auth google --force${NC}`);
        console.log(`To disconnect: ${CYAN}gated-knowledge deauth google${NC}`);
        return;
      } catch {
        // Token exists but broken — proceed with re-auth
        info('Existing token expired, re-authorizing...');
      }
    }
  }

  const scopes = [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/documents.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
  ];
  const label = 'Google Drive/Sheets/Docs';

  const { google } = await import('googleapis');
  const http = await import('node:http');
  const { storeCredential } = await import('../src/keychain.ts');

  // Built-in OAuth client (works for any Google account, zero setup)
  let clientId = '982575655412-9k1vr8s1dug51t3711rnhiiircfab96t.apps.googleusercontent.com';
  let clientSecret = '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';

  // Allow override via flags or file
  const fileFlag = args.indexOf('--client-secret-file');
  const idFlag = args.indexOf('--client-id');
  const secretFlag = args.indexOf('--client-secret');

  if (fileFlag !== -1 && args[fileFlag + 1]) {
    const filePath = resolve(args[fileFlag + 1]);
    if (!existsSync(filePath)) { fail(`File not found: ${filePath}`); process.exit(1); }
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    const creds = raw.installed || raw.web;
    if (!creds) { fail('Invalid OAuth client JSON'); process.exit(1); }
    clientId = creds.client_id;
    clientSecret = creds.client_secret;
    info('Using OAuth client from file');
  } else if (idFlag !== -1 && secretFlag !== -1 && args[idFlag + 1] && args[secretFlag + 1]) {
    clientId = args[idFlag + 1];
    clientSecret = args[secretFlag + 1];
    info('Using OAuth client from flags');
  }

  // ── Browser auth flow ──────────────────────────────────
  console.log(`\n${BOLD}Browser will open for Google authorization.${NC}`);
  console.log(`${DIM}⚠  You may see "Google hasn't verified this app" — this is normal.`);
  console.log(`   Click "Advanced" → "Go to gated-knowledge (unsafe)" to proceed.`);
  console.log(`   This is safe: credentials stay on your machine, nothing is sent to us.${NC}\n`);

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3847/callback');
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
  });

  function startAuthServer(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        const url = new URL(req.url!, 'http://localhost:3847');
        const authCode = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h2>Authorization denied</h2><p>You can close this tab.</p>');
          srv.close();
          reject(new Error(`OAuth denied: ${error}`));
          return;
        }
        if (authCode) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<h2>Google Drive connected!</h2><p>You can close this tab and return to the terminal.</p>`);
          srv.close();
          resolve(authCode);
          return;
        }
        res.writeHead(404);
        res.end();
      });

      srv.listen(3847, () => {
        import('node:child_process').then(cp => {
          const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'start ""'
            : 'xdg-open';
          cp.execSync(`${cmd} "${authUrl}"`);
        });
      });

      setTimeout(() => { srv.close(); reject(new Error('Auth timed out (2 min)')); }, 120000);
    });
  }

  let code: string;
  try {
    code = await startAuthServer();
  } catch (e: any) {
    // First attempt failed — show URL for manual retry in the right browser
    warn(`${e.message}`);
    console.log(`\n${BOLD}Wrong browser or account? Open this URL manually in the right one:${NC}`);
    console.log(`\n  ${CYAN}${authUrl}${NC}\n`);
    code = await startAuthServer();
  }

  info('Exchanging auth code for tokens...');
  const { tokens } = await oauth2.getToken(code);

  if (!tokens.refresh_token) {
    fail('No refresh token received. Try again.');
    process.exit(1);
  }

  // Discover account email via Drive API (always works, no extra APIs needed)
  oauth2.setCredentials(tokens);
  let accountEmail = 'unknown';
  try {
    const driveForEmail = google.drive({ version: 'v3', auth: oauth2 });
    const about = await driveForEmail.about.get({ fields: 'user(emailAddress)' });
    accountEmail = about.data.user?.emailAddress || 'unknown';
  } catch {}

  // Store token keyed by email (supports multi-account)
  const creds = JSON.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
  });
  storeCredential('google', `oauth-${accountEmail}`, Buffer.from(creds).toString('base64'));
  // Also store as generic 'oauth' for backward compat (last-added account)
  storeCredential('google', 'oauth', Buffer.from(creds).toString('base64'));

  // Verify — list one file
  const drive = google.drive({ version: 'v3', auth: oauth2 });
  const testList = await drive.files.list({ pageSize: 1 });
  const fileCount = testList.data.files?.length || 0;

  ok(`${label} connected via OAuth2: ${CYAN}${accountEmail}${NC}`);
  if (fileCount > 0) ok(`Verified: can access Google Drive`);

  // Update config — add to google_accounts list
  const config = loadConfig();
  config.sources.google = { enabled: true, account: 'oauth' };
  if (!config.google_accounts) config.google_accounts = [];
  if (!config.google_accounts.includes(accountEmail)) {
    config.google_accounts.push(accountEmail);
  }
  saveConfig(config);

  // Auto-scan
  info('Scanning sources...');
  try {
    const structure = await scan();
    ok(`Found ${structure.docs.length} documents`);
  } catch (e: any) {
    warn(`Scan: ${e.message} (you can re-run: gated-knowledge scan)`);
  }

  console.log(`\n${label} access is permanent — no re-login needed.`);
  console.log(`To revoke: ${CYAN}gated-knowledge deauth google${NC}`);
  updateClaudeMdAuth();
}

// ── auth drive (OAuth2 for session sharing) ─────────────

async function authDrive() {
  const scope = 'https://www.googleapis.com/auth/drive.file';
  const label = 'Google Drive (session sharing)';

  const { google } = await import('googleapis');
  const http = await import('node:http');
  const { storeCredential, getCredential } = await import('../src/keychain.ts');

  // Get client_id/secret from flags, file, team invite, or existing Gmail token
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
    if (!creds) { fail('Invalid OAuth client JSON'); process.exit(1); }
    clientId = creds.client_id;
    clientSecret = creds.client_secret;
  } else if (idFlag !== -1 && secretFlag !== -1 && args[idFlag + 1] && args[secretFlag + 1]) {
    clientId = args[idFlag + 1];
    clientSecret = args[secretFlag + 1];
  } else {
    // Try reusing from existing Gmail or Drive token
    for (const key of ['oauth', 'oauth-send']) {
      const existing = getCredential('gmail', key);
      if (existing) {
        try {
          const decoded = JSON.parse(Buffer.from(existing, 'base64').toString('utf-8'));
          clientId = decoded.client_id;
          clientSecret = decoded.client_secret;
          info('Reusing OAuth client from existing Gmail token');
          break;
        } catch {}
      }
    }
    // Try from existing drive token
    if (!clientId) {
      const existing = getCredential('drive', 'oauth');
      if (existing) {
        try {
          const decoded = JSON.parse(Buffer.from(existing, 'base64').toString('utf-8'));
          clientId = decoded.client_id;
          clientSecret = decoded.client_secret;
          info('Reusing OAuth client from existing Drive token');
        } catch {}
      }
    }
  }

  if (!clientId || !clientSecret) {
    fail('Usage: gated-knowledge auth drive --client-secret-file <path/client_secret.json>');
    console.log(`       gated-knowledge auth drive --client-id <ID> --client-secret <SECRET>`);
    console.log(`\n${DIM}Uses the same OAuth client as Gmail. If Gmail is already configured, just run:`);
    console.log(`  gated-knowledge auth drive${NC}`);
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3847/callback');
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [scope],
  });

  const code = await new Promise<string>((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost:3847');
      const authCode = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Authorization denied</h2><p>You can close this tab.</p>');
        srv.close();
        reject(new Error(`OAuth denied: ${error}`));
        return;
      }
      if (authCode) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>✓ Drive connected for session sharing!</h2><p>You can close this tab.</p>');
        srv.close();
        resolve(authCode);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    srv.listen(3847, () => {
      info('Opening browser for Drive authorization...');
      import('node:child_process').then(cp => {
        const cmd = process.platform === 'darwin' ? 'open'
          : process.platform === 'win32' ? 'start ""'
          : 'xdg-open';
        cp.execSync(`${cmd} "${authUrl}"`);
      });
    });

    setTimeout(() => { srv.close(); reject(new Error('Auth timed out (2 min)')); }, 120000);
  });

  info('Exchanging auth code for tokens...');
  const { tokens } = await oauth2.getToken(code);

  if (!tokens.refresh_token) {
    fail('No refresh token received. Try again.');
    process.exit(1);
  }

  const creds = JSON.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
  });
  storeCredential('drive', 'oauth', Buffer.from(creds).toString('base64'));
  ok('Drive OAuth tokens stored securely (drive.file scope)');
  console.log(`\n${label} access is permanent — no re-login needed.`);
  console.log(`To revoke: ${CYAN}gated-knowledge deauth drive${NC}`);
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
    fail('Usage: gated-knowledge auth gmail [--send] --client-secret-file <path/client_secret.json>');
    console.log(`       gated-knowledge auth gmail [--send] --client-id <ID> --client-secret <SECRET>`);
    console.log(`\n${DIM}How to get OAuth credentials:`);
    console.log('  1. Open https://console.cloud.google.com/apis/credentials');
    console.log('  2. Click "+ Create Credentials" → "OAuth client ID"');
    console.log('  3. Application type: "Desktop app"');
    console.log('  4. Download the JSON file');
    console.log(`  5. Run: gated-knowledge auth gmail --client-secret-file ~/Downloads/client_secret_xxx.json${NC}`);
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
        const cmd = process.platform === 'win32' ? 'start ""'
          : process.platform === 'darwin' ? 'open'
          : 'xdg-open';
        cp.execSync(`${cmd} "${authUrl}"`);
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

  // Store credentials (base64-encoded for safe storage)
  const creds = JSON.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
  });
  storeCredential('gmail', keychainKey, Buffer.from(creds).toString('base64'));
  ok(`${label} OAuth tokens stored securely`);

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
  console.log(`To revoke: ${CYAN}gated-knowledge deauth gmail${NC}`);
  if (!isSend && !getCredential('gmail', 'oauth-send')) {
    console.log(`\nTo also enable sending: ${CYAN}gated-knowledge auth gmail --send${NC} (reuses same client creds)`);
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
    if (config.sources.langsmith?.enabled) lines.push('- LangSmith: API key');

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

async function autoScan(only?: import('../src/types.ts').SourceType) {
  info(only ? `Scanning ${only}...` : 'Scanning sources...');
  try {
    const structure = await scan(only);
    const count = only
      ? structure.docs.filter(d => d.source === only).length
      : structure.docs.length;
    ok(`Found ${count} ${only || ''} documents`);
    console.log(`\nRestart Claude Code to pick up the changes.`);
  } catch (e: any) {
    warn(`Scan failed: ${e.message}`);
    console.log(`You can retry: ${CYAN}gated-knowledge scan${NC}`);
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

  console.log(`\n${BOLD}gated-knowledge status${NC}\n`);
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

  const langsmithCfg = config.sources.langsmith;
  if (langsmithCfg?.enabled) {
    const hasCreds = hasCredential('langsmith', 'default');
    console.log(`  LangSmith: ${hasCreds ? GREEN + 'connected' : RED + 'no credentials'}${NC}`);
  } else {
    console.log(`  LangSmith: ${DIM}not configured${NC}`);
  }

  // Deepgram (service, not a source)
  const hasDeepgram = hasCredential('deepgram', 'default');
  if (hasDeepgram) {
    console.log(`  Deepgram:  ${GREEN}connected${NC} (media transcription enabled)`);
  } else {
    console.log(`  Deepgram:  ${DIM}not configured${NC} (optional, for video/audio transcription)`);
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
    console.log(`\n${YELLOW}No scan data yet.${NC} Run: gated-knowledge scan`);
  }
  console.log('');
}

// ── search (CLI test) ───────────────────────────────────

async function cmdSearch() {
  const query = args.slice(1).join(' ');
  if (!query) {
    fail('Usage: gated-knowledge search <query>');
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

  if (config.sources.langsmith?.enabled) {
    try {
      const { searchLangSmith } = await import('../src/connectors/langsmith.ts');
      results.push(...await searchLangSmith(query, 5));
    } catch (e: any) {
      warn(`LangSmith: ${e.message}`);
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

  info('Registering gated-knowledge MCP server...');

  const claudeJson = resolve(homedir(), '.claude.json');
  let config: any = {};
  try {
    config = JSON.parse(readFileSync(claudeJson, 'utf-8'));
  } catch {}

  if (!config.mcpServers) config.mcpServers = {};

  // Remove old name if present
  delete config.mcpServers['gated-docs'];

  config.mcpServers['gated-knowledge'] = {
    type: 'stdio',
    command: 'node',
    args: ['--experimental-strip-types', resolve(repoDir, 'bin', 'mcp-server.ts')],
    env: {},
  };

  const { writeFileSync } = await import('node:fs');
  writeFileSync(claudeJson, JSON.stringify(config, null, 2) + '\n');
  ok('MCP server registered in ~/.claude.json');

  console.log(`\n${BOLD}Next steps:${NC}`);
  console.log(`  1. Add credentials: ${CYAN}gated-knowledge auth google --service-account <key.json>${NC}`);
  console.log(`  2. Scan sources:    ${CYAN}gated-knowledge scan${NC}`);
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
    fail('Usage: gated-knowledge impersonate <user@domain.com>');
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
  console.log(`  Client ID: ${CYAN}${getSaClientId(config) || '(run gated-knowledge status to check)'}${NC}`);
  console.log(`  Scopes: gmail.readonly, bigquery.readonly`);
}

function getSaClientId(config: ReturnType<typeof loadConfig>): string {
  const account = config.sources.google?.account;
  if (!account) return '';
  const creds = getServiceAccountCredentials(account);
  return (creds as any)?.client_id || '';
}

// ── team ────────────────────────────────────────────────

async function cmdTeam() {
  const subcommand = args[1];

  if (subcommand === 'create') {
    await teamCreate();
  } else {
    fail('Usage: gated-knowledge team create');
  }
}

async function teamCreate() {
  const { default: input } = await import('input');
  const { getCredential } = await import('../src/keychain.ts');

  info('Creating team invite code for session sharing\n');

  // 1. Team name
  const teamName = await input.text('Team name: ');

  // 2. Drive folder ID
  console.log(`\n${BOLD}Shared Drive folder:${NC}`);
  console.log(`${DIM}Create a folder on Google Drive and share it with your team.`);
  console.log(`Copy the folder ID from the URL: drive.google.com/drive/folders/<THIS_ID>${NC}\n`);
  const folderId = await input.text('Shared folder ID: ');

  // 3. OAuth client credentials
  let clientId: string | undefined;
  let clientSecret: string | undefined;

  // Try to reuse from existing Gmail/Drive token
  for (const [svc, key] of [['gmail', 'oauth'], ['gmail', 'oauth-send'], ['drive', 'oauth']] as const) {
    const existing = getCredential(svc, key);
    if (existing) {
      try {
        const decoded = JSON.parse(Buffer.from(existing, 'base64').toString('utf-8'));
        clientId = decoded.client_id;
        clientSecret = decoded.client_secret;
        ok(`Found OAuth client from ${svc} token`);
        break;
      } catch {}
    }
  }

  if (!clientId || !clientSecret) {
    console.log(`\n${BOLD}OAuth client credentials:${NC}`);
    console.log(`${DIM}Same OAuth client used for Gmail auth. Download from:`);
    console.log(`https://console.cloud.google.com/apis/credentials${NC}\n`);

    const fileFlag = args.indexOf('--client-secret-file');
    if (fileFlag !== -1 && args[fileFlag + 1]) {
      const filePath = resolve(args[fileFlag + 1]);
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      const creds = raw.installed || raw.web;
      clientId = creds?.client_id;
      clientSecret = creds?.client_secret;
    } else {
      const filePath = await input.text('Path to client_secret.json: ');
      const raw = JSON.parse(readFileSync(resolve(filePath), 'utf-8'));
      const creds = raw.installed || raw.web;
      clientId = creds?.client_id;
      clientSecret = creds?.client_secret;
    }
  }

  if (!clientId || !clientSecret) {
    fail('Could not get OAuth client credentials');
    process.exit(1);
  }

  // 4. Generate invite code
  const teamConfig = {
    team: teamName,
    oauth_client_id: clientId,
    oauth_client_secret: clientSecret,
    drive_folder_id: folderId,
  };

  const code = 'gk_' + Buffer.from(JSON.stringify(teamConfig)).toString('base64');

  console.log(`\n${BOLD}${GREEN}Invite code generated!${NC}\n`);
  console.log(`Send this to your team members:\n`);
  console.log(`${CYAN}─────────────────────────────────────────${NC}`);
  console.log(code);
  console.log(`${CYAN}─────────────────────────────────────────${NC}`);
  console.log(`\n${BOLD}What to tell them:${NC}`);
  console.log(`  Paste this into Claude Code:`);
  console.log(`  ${DIM}"Настрой мне шаринг сессий: ${code.slice(0, 30)}..."${NC}`);
  console.log(`\n  Or run directly:`);
  console.log(`  ${CYAN}gated-knowledge init sessions --team ${code.slice(0, 30)}...${NC}`);
  console.log(`\nThis code contains OAuth client ID (not a secret) + folder ID.`);
  console.log(`Each team member will authorize via browser to get their own token.`);
}

// ── init ────────────────────────────────────────────────

async function cmdInit() {
  const subcommand = args[1];

  if (subcommand === 'sessions') {
    await initSessions();
  } else {
    fail('Usage: gated-knowledge init sessions');
    console.log(`\n${DIM}Available init commands:`);
    console.log(`  init sessions   Set up session archiving & sharing${NC}`);
  }
}

async function initSessions() {
  info('Setting up Claude Code session sharing\n');

  // Parse flags (so Claude can pass everything non-interactively)
  const teamFlag = args.indexOf('--team');
  const nameFlag = args.indexOf('--name');
  const idFlag = args.indexOf('--id');
  const projectsFlag = args.indexOf('--projects');

  const teamCode = teamFlag !== -1 ? args[teamFlag + 1] : undefined;
  let userName = nameFlag !== -1 ? args[nameFlag + 1] : undefined;
  let userId = idFlag !== -1 ? args[idFlag + 1] : undefined;
  const projectsFilter = projectsFlag !== -1 ? args[projectsFlag + 1] : undefined;

  // Check if session-snapshot archive exists
  const defaultArchive = resolve(homedir(), '.config', 'session-snapshot', 'archive');
  const archiveExists = existsSync(defaultArchive);

  if (!archiveExists) {
    warn('session-snapshot archive not found at ~/.config/session-snapshot/archive');
    console.log(`${DIM}Install session-snapshot first:`);
    console.log(`  cd ~/Documents/GitHub/session-snapshot && node bin/cli.sh install${NC}\n`);
  } else {
    const { readdirSync } = await import('node:fs');
    const sessions = readdirSync(defaultArchive).filter(d => {
      try { return statSync(resolve(defaultArchive, d)).isDirectory(); } catch { return false; }
    });
    ok(`Found ${sessions.length} archived sessions`);
  }

  // User setup — from flags or interactive
  if (!userName) {
    const { default: input } = await import('input');
    userName = await input.text('Display name: ');
  }
  if (!userId) {
    const defaultId = userName!.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (nameFlag !== -1) {
      // Non-interactive — use default ID
      userId = defaultId;
    } else {
      const { default: input } = await import('input');
      userId = await input.text(`User ID [${defaultId}]: `) || defaultId;
    }
  }

  ok(`User: ${userName} (${userId})`);

  const config = loadConfig();
  config.sources.sessions = { enabled: true };
  config.sessions = {
    user: { name: userName!, id: userId! },
    archive_dir: defaultArchive,
  };

  // Team invite code → decode + OAuth + configure sharing
  if (teamCode) {
    const raw = teamCode.startsWith('gk_') ? teamCode.slice(3) : teamCode;
    let teamConfig: any;
    try {
      teamConfig = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
    } catch {
      fail('Invalid team invite code');
      process.exit(1);
    }

    ok(`Team: ${teamConfig.team}`);
    ok(`Shared folder: ${teamConfig.drive_folder_id}`);

    config.team = {
      name: teamConfig.team,
      sessions: {
        driver: 'google-drive',
        folder_id: teamConfig.drive_folder_id,
      },
    };

    config.sessions.sharing = {
      driver: 'google-drive',
      folder_id: teamConfig.drive_folder_id,
      mode: projectsFilter ? 'whitelist' : 'all',
      include: projectsFilter ? projectsFilter.split(',').map((s: string) => s.trim()) : undefined,
      auto_share: true,
    };

    // OAuth for Drive — reuse client creds from invite code
    const { getCredential } = await import('../src/keychain.ts');
    const existingDrive = getCredential('drive', 'oauth');

    if (existingDrive) {
      ok('Drive OAuth token already exists — skipping auth');
    } else {
      info('Authorizing Google Drive access...');

      // Inject OAuth client_id/secret into args and call authDrive
      const origArgs = [...args];
      // Clear args and set up for authDrive
      args.length = 0;
      args.push('auth', 'drive',
        '--client-id', teamConfig.oauth_client_id,
        '--client-secret', teamConfig.oauth_client_secret);

      await authDrive();

      // Restore args
      args.length = 0;
      args.push(...origArgs);
    }

    saveConfig(config);
    ok('Team session sharing configured');

  } else {
    // Manual setup — interactive
    const { default: input } = await import('input');

    console.log(`\n${BOLD}Sharing mode:${NC}`);
    console.log(`  1) Google Drive (via shared folder)`);
    console.log(`  2) Supabase (real-time)`);
    console.log(`  3) Local only (no sharing)\n`);

    const sharingChoice = await input.text('Choice [3]: ') || '3';

    if (sharingChoice === '1') {
      const folderId = await input.text('Shared Drive folder ID: ');
      config.sessions.sharing = {
        driver: 'google-drive',
        folder_id: folderId,
        mode: 'all',
        auto_share: false,
      };

      console.log(`\n${BOLD}Which projects to share?${NC}`);
      console.log(`  1) All`);
      console.log(`  2) Specific projects only\n`);

      const filterChoice = await input.text('Choice [1]: ') || '1';
      if (filterChoice === '2') {
        const includes = await input.text('Projects (comma-separated): ');
        config.sessions.sharing.mode = 'whitelist';
        config.sessions.sharing.include = includes.split(',').map((s: string) => s.trim());
      }

      // Auth Drive if no token
      const { getCredential } = await import('../src/keychain.ts');
      if (!getCredential('drive', 'oauth')) {
        info('Need Drive authorization for sharing...');
        const origArgs = [...args];
        args.length = 0;
        args.push('auth', 'drive');
        await authDrive();
        args.length = 0;
        args.push(...origArgs);
      }

      ok('Google Drive sharing configured');
    } else if (sharingChoice === '2') {
      const url = await input.text('Supabase URL: ');
      const key = await input.text('Supabase anon key: ');
      config.sessions.sharing = {
        driver: 'supabase',
        url,
        key,
        mode: 'all',
        auto_share: false,
      };
      ok('Supabase sharing configured');
    }

    saveConfig(config);
    ok('Sessions config saved');
  }

  // Scan
  info('Scanning sessions...');
  try {
    const structure = await scan();
    const sessionDocs = structure.docs.filter(d => d.source === 'sessions');
    ok(`Indexed ${sessionDocs.length} sessions`);
  } catch (e: any) {
    warn(`Scan: ${e.message}`);
  }

  console.log(`\n${BOLD}Done!${NC} Session tools available:`);
  console.log(`  ${CYAN}session_list${NC}     — list sessions`);
  console.log(`  ${CYAN}session_search${NC}   — search across sessions`);
  console.log(`  ${CYAN}read_document${NC}    — read session (source="sessions")`);
  if (config.sessions?.sharing) {
    console.log(`  ${CYAN}gated-knowledge share${NC} — upload sessions to team`);
  }
  console.log(`\nRestart Claude Code to activate.`);
}

// ── deauth ──────────────────────────────────────────────

function cmdDeauth() {
  const source = args[1];
  if (!source) {
    fail('Usage: gated-knowledge deauth <google|notion|slack|telegram|cloudflare|gitlab|langsmith|gmail|deepgram>');
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
  } else if (source === 'langsmith') {
    deleteCredential('langsmith', 'default');
    config.sources.langsmith = { enabled: false };
  } else if (source === 'gmail') {
    deleteCredential('gmail', 'oauth');
    deleteCredential('gmail', 'oauth-send');
  } else if (source === 'deepgram') {
    deleteCredential('deepgram', 'default');
  } else if (source === 'drive') {
    deleteCredential('drive', 'oauth');
  }

  saveConfig(config);
  ok(`${source} disconnected`);
  updateClaudeMdAuth();
}

// ── help ────────────────────────────────────────────────

function printHelp() {
  console.log(`
${BOLD}gated-knowledge${NC} — MCP server for auth-gated sources + session archive

${BOLD}Commands:${NC}
  auth google                                Connect Google Drive (OAuth2, browser login)
    [--service-account <key.json>]              Advanced: use Service Account instead
    [--impersonate user@domain.com]             Enable Domain-Wide Delegation (SA only)
  impersonate <email>                        Set DWD impersonation email
  auth notion --token <ntn_xxx>              Connect Notion
  auth slack  --token <xoxb-xxx>             Connect Slack
  auth telegram                              Connect Telegram (Client API)
  auth cloudflare --token <cf-token>         Connect Cloudflare
  auth gitlab --token <pat> [--url <url>]    Connect GitLab (self-hosted or gitlab.com)
  auth langsmith --token <ls-key>            Connect LangSmith (tracing & observability)
  auth deepgram --token <api-key>            Enable audio/video transcription (Deepgram nova-2)
  auth gmail --client-secret-file <json>     Connect Gmail read (OAuth2, permanent)
  auth gmail --send                          Connect Gmail send (reuses client creds)
  auth drive                                 Connect Google Drive for session sharing (OAuth2)
  init sessions                              Set up session archiving & sharing
  init sessions --team <invite-code>         Join team (auto-configures everything)
    [--name <name>] [--id <slug>]              Optional: set user name/ID non-interactively
    [--projects <a,b,c>]                       Optional: whitelist projects to share
  team create                                Generate team invite code (admin)
  scan                                       Scan all sources, update structure
  search <query>                             Test search from CLI
  check-email [query]                        Check Gmail inbox
  status                                     Show connection status
  setup                                      Register MCP server in ~/.claude.json
  deauth <source>                            Remove credentials

${BOLD}Quick start:${NC}
  gated-knowledge setup
  gated-knowledge auth google
  gated-knowledge scan

${BOLD}How it works:${NC}
  Credentials stored in OS secure storage (Keychain / DPAPI / secret-tool).
  MCP server runs as stdio — no network port, no exposure.
  Claude Code calls search/read_document tools when needed.
`);
}

main().catch(e => {
  fail(e.message);
  process.exit(1);
});
