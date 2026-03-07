/**
 * macOS Keychain / Linux secret-tool integration.
 * Credentials are stored in OS-level secure storage and retrieved only when needed.
 */
import { execSync } from 'node:child_process';
import { platform } from 'node:os';

const SERVICE_PREFIX = 'gated-info';

function isMac(): boolean {
  return platform() === 'darwin';
}

/**
 * Store a credential in the OS keychain.
 * On macOS: Keychain Access
 * On Linux: secret-tool (libsecret)
 */
export function storeCredential(source: string, account: string, value: string): void {
  const service = `${SERVICE_PREFIX}-${source}`;

  if (isMac()) {
    // Delete existing entry first (ignore errors if not found)
    try {
      execSync(
        `security delete-generic-password -s "${service}" -a "${account}" 2>/dev/null`,
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
 * Retrieve a credential from the OS keychain.
 * Returns null if not found.
 */
export function getCredential(source: string, account: string): string | null {
  const service = `${SERVICE_PREFIX}-${source}`;

  try {
    if (isMac()) {
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
 * Delete a credential from the OS keychain.
 */
export function deleteCredential(source: string, account: string): boolean {
  const service = `${SERVICE_PREFIX}-${source}`;

  try {
    if (isMac()) {
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
 * Store a service account JSON (base64-encoded) in keychain.
 */
export function storeServiceAccountJson(jsonContent: string): string {
  const parsed = JSON.parse(jsonContent);
  const email = parsed.client_email || 'unknown';
  const encoded = Buffer.from(jsonContent).toString('base64');
  storeCredential('google', email, encoded);
  return email;
}

/**
 * Retrieve and decode a service account JSON from keychain.
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
