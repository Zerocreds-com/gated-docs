#!/usr/bin/env node --experimental-strip-types
/**
 * gated-info CLI — auth, scan, search, status, setup.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, saveConfig, loadStructure, CONFIG_PATH, STRUCTURE_PATH } from '../src/config.ts';
import { storeServiceAccountJson, storeCredential, hasCredential, deleteCredential } from '../src/keychain.ts';
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

function info(msg: string) { console.log(`${CYAN}[gated-info]${NC} ${msg}`); }
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
      fail('Usage: gated-info auth google --service-account <path-to-key.json>');
      console.log(`\n${DIM}How to get a service account key:`);
      console.log('  1. Go to https://console.cloud.google.com/iam-admin/serviceaccounts');
      console.log('  2. Select your project (or create one)');
      console.log('  3. Click on a service account (or create one)');
      console.log('  4. Go to "Keys" tab → "Add Key" → "Create new key" → JSON');
      console.log('  5. Download the JSON file');
      console.log('  6. Share your Google Drive folders with the service account email');
      console.log(`  7. Run: gated-info auth google --service-account ./downloaded-key.json${NC}`);
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
    saveConfig(config);
    ok('Config updated');

    console.log(`\n${BOLD}Next steps:${NC}`);
    console.log(`  1. Share your Google Drive folder with: ${CYAN}${email}${NC}`);
    console.log(`     (Right-click folder → Share → paste the email → Viewer)`);
    console.log(`  2. Run: ${CYAN}gated-info scan${NC}`);
    console.log(`  3. Restart Claude Code to pick up the MCP server`);

  } else if (source === 'notion') {
    const tokenFlag = args.indexOf('--token');
    if (tokenFlag === -1 || !args[tokenFlag + 1]) {
      fail('Usage: gated-info auth notion --token <your-notion-api-key>');
      console.log(`\n${DIM}How to get a Notion API key:`);
      console.log('  1. Go to https://www.notion.so/my-integrations');
      console.log('  2. Click "New integration"');
      console.log('  3. Give it a name (e.g., "gated-info")');
      console.log('  4. Copy the "Internal Integration Token" (starts with ntn_)');
      console.log('  5. In Notion, share databases/pages with your integration');
      console.log(`  6. Run: gated-info auth notion --token ntn_xxxx${NC}`);
      process.exit(1);
    }

    const token = args[tokenFlag + 1];
    storeCredential('notion', 'default', token);
    ok('Notion token stored in Keychain');

    const config = loadConfig();
    config.sources.notion = { enabled: true };
    saveConfig(config);
    ok('Config updated');

    console.log(`\nNext: ${CYAN}gated-info scan${NC}`);

  } else if (source === 'slack') {
    const tokenFlag = args.indexOf('--token');
    if (tokenFlag === -1 || !args[tokenFlag + 1]) {
      fail('Usage: gated-info auth slack --token <xoxb-or-xoxp-token>');
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

    console.log(`\nNext: ${CYAN}gated-info scan${NC}`);

  } else {
    fail('Usage: gated-info auth <google|notion|slack> [options]');
  }
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

  console.log(`\n${BOLD}gated-info status${NC}\n`);
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
    console.log(`\n${YELLOW}No scan data yet.${NC} Run: gated-info scan`);
  }
  console.log('');
}

// ── search (CLI test) ───────────────────────────────────

async function cmdSearch() {
  const query = args.slice(1).join(' ');
  if (!query) {
    fail('Usage: gated-info search <query>');
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

  info('Registering gated-info MCP server...');

  const claudeJson = resolve(process.env.HOME || '', '.claude.json');
  let config: any = {};
  try {
    config = JSON.parse(readFileSync(claudeJson, 'utf-8'));
  } catch {}

  if (!config.mcpServers) config.mcpServers = {};

  config.mcpServers['gated-info'] = {
    type: 'stdio',
    command: 'node',
    args: ['--experimental-strip-types', `${repoDir}/bin/mcp-server.ts`],
    env: {},
  };

  const { writeFileSync } = await import('node:fs');
  writeFileSync(claudeJson, JSON.stringify(config, null, 2) + '\n');
  ok('MCP server registered in ~/.claude.json');

  console.log(`\n${BOLD}Next steps:${NC}`);
  console.log(`  1. Add credentials: ${CYAN}gated-info auth google --service-account <key.json>${NC}`);
  console.log(`  2. Scan sources:    ${CYAN}gated-info scan${NC}`);
  console.log(`  3. Restart Claude Code to activate MCP`);
  console.log('');
}

// ── deauth ──────────────────────────────────────────────

function cmdDeauth() {
  const source = args[1];
  if (!source) {
    fail('Usage: gated-info deauth <google|notion|slack>');
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
  }

  saveConfig(config);
  ok(`${source} disconnected`);
}

// ── help ────────────────────────────────────────────────

function printHelp() {
  console.log(`
${BOLD}gated-info${NC} — MCP server for auth-gated sources

${BOLD}Commands:${NC}
  auth google --service-account <key.json>   Connect Google Drive
  auth notion --token <ntn_xxx>              Connect Notion
  auth slack  --token <xoxb-xxx>             Connect Slack
  scan                                       Scan all sources, update structure
  search <query>                             Test search from CLI
  status                                     Show connection status
  setup                                      Register MCP server in ~/.claude.json
  deauth <source>                            Remove credentials

${BOLD}Quick start:${NC}
  gated-info setup
  gated-info auth google --service-account ~/Downloads/key.json
  gated-info scan

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
