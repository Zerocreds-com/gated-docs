/**
 * Cross-platform credential storage.
 * - macOS: Keychain Access (security CLI)
 * - Linux: secret-tool (libsecret)
 * - Windows: DPAPI-encrypted JSON file via PowerShell
 */
import { execSync } from 'node:child_process';
import { platform, homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SERVICE_PREFIX = 'gated-docs';

function isMac(): boolean {
  return platform() === 'darwin';
}

function isWindows(): boolean {
  return platform() === 'win32';
}

// ── Windows DPAPI helpers ────────────────────────────────

function getWindowsCredsPath(): string {
  const base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  const dir = join(base, 'gated-knowledge');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'credentials.json');
}

function loadWindowsCreds(): Record<string, string> {
  const path = getWindowsCredsPath();
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function saveWindowsCreds(creds: Record<string, string>): void {
  writeFileSync(getWindowsCredsPath(), JSON.stringify(creds, null, 2) + '\n');
}

function dpapiEncrypt(value: string): string {
  // PowerShell DPAPI encrypt → base64 string (tied to current Windows user)
  const ps = `
    Add-Type -AssemblyName System.Security
    $bytes = [System.Text.Encoding]::UTF8.GetBytes('${value.replace(/'/g, "''")}')
    $enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
    [Convert]::ToBase64String($enc)
  `.trim();
  return execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function dpapiDecrypt(encrypted: string): string {
  const ps = `
    Add-Type -AssemblyName System.Security
    $enc = [Convert]::FromBase64String('${encrypted}')
    $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser')
    [System.Text.Encoding]::UTF8.GetString($bytes)
  `.trim();
  return execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

// ── Public API ───────────────────────────────────────────

/**
 * Store a credential in the OS credential store.
 * - macOS: Keychain Access
 * - Linux: secret-tool (libsecret)
 * - Windows: DPAPI-encrypted file
 */
export function storeCredential(source: string, account: string, value: string): void {
  const service = `${SERVICE_PREFIX}-${source}`;

  if (isWindows()) {
    const creds = loadWindowsCreds();
    creds[`${service}/${account}`] = dpapiEncrypt(value);
    saveWindowsCreds(creds);
  } else if (isMac()) {
    // Delete existing entry first (ignore errors if not found)
    try {
      execSync(
        `security delete-generic-password -s "${service}" -a "${account}"`,
        { stdio: 'pipe' }
      );
    } catch {}

    // Add new entry
    execSync(
      `security add-generic-password -s "${service}" -a "${account}" -w "${value}" -U`,
      { stdio: 'pipe' }
    );
  } else {
    // Linux: secret-tool
    execSync(
      `echo -n "${value}" | secret-tool store --label="${service}" service "${service}" account "${account}"`,
      { stdio: 'pipe' }
    );
  }
}

/**
 * Retrieve a credential from the OS credential store.
 * Returns null if not found.
 */
export function getCredential(source: string, account: string): string | null {
  const service = `${SERVICE_PREFIX}-${source}`;

  try {
    if (isWindows()) {
      const creds = loadWindowsCreds();
      const encrypted = creds[`${service}/${account}`];
      if (!encrypted) return null;
      return dpapiDecrypt(encrypted);
    } else if (isMac()) {
      return execSync(
        `security find-generic-password -s "${service}" -a "${account}" -w`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
    } else {
      return execSync(
        `secret-tool lookup service "${service}" account "${account}"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
    }
  } catch {
    return null;
  }
}

/**
 * Delete a credential from the OS credential store.
 */
export function deleteCredential(source: string, account: string): boolean {
  const service = `${SERVICE_PREFIX}-${source}`;

  try {
    if (isWindows()) {
      const creds = loadWindowsCreds();
      const key = `${service}/${account}`;
      if (!(key in creds)) return false;
      delete creds[key];
      saveWindowsCreds(creds);
      return true;
    } else if (isMac()) {
      execSync(
        `security delete-generic-password -s "${service}" -a "${account}"`,
        { stdio: 'pipe' }
      );
    } else {
      execSync(
        `secret-tool clear service "${service}" account "${account}"`,
        { stdio: 'pipe' }
      );
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a credential exists without retrieving the value.
 */
export function hasCredential(source: string, account: string): boolean {
  return getCredential(source, account) !== null;
}

/**
 * Store a service account JSON (base64-encoded) in credential store.
 */
export function storeServiceAccountJson(jsonContent: string): string {
  const parsed = JSON.parse(jsonContent);
  const email = parsed.client_email || 'unknown';
  const encoded = Buffer.from(jsonContent).toString('base64');
  storeCredential('google', email, encoded);
  return email;
}

/**
 * Retrieve and decode a service account JSON from credential store.
 */
export function getServiceAccountCredentials(account: string): Record<string, unknown> | null {
  const encoded = getCredential('google', account);
  if (!encoded) return null;

  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}
