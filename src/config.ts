import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Config, Structure } from './types.ts';

const HOME = homedir();
export const CONFIG_DIR = join(HOME, '.config', 'gated-info');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
export const STRUCTURE_PATH = join(CONFIG_DIR, 'structure.json');

const DEFAULT_CONFIG: Config = {
  sources: {},
  scan_interval_hours: 6,
};

export function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

export function loadConfig(): Config {
  ensureConfigDir();
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

export function loadStructure(): Structure | null {
  try {
    return JSON.parse(readFileSync(STRUCTURE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveStructure(structure: Structure): void {
  ensureConfigDir();
  writeFileSync(STRUCTURE_PATH, JSON.stringify(structure, null, 2) + '\n');
}

export function isStructureStale(config: Config): boolean {
  const structure = loadStructure();
  if (!structure) return true;
  const age = Date.now() - new Date(structure.generated_at).getTime();
  return age > config.scan_interval_hours * 60 * 60 * 1000;
}
