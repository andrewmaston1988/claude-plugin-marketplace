// Resolves the Playwright library the MCP server ships, and the browser dir.
// The bake-off installs nothing: every contender borrows the same library.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CANDIDATES = () => [
  process.env.UI_PROBE_PLAYWRIGHT,
  path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@playwright', 'mcp', 'node_modules', 'playwright'),
  path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'playwright'),
].filter(Boolean);

let cached;

export function playwrightPackageDir() {
  if (cached) return cached;
  const fromNpm = () => {
    try {
      const root = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
        encoding: 'utf8', timeout: 20000,
      }).trim();
      return path.join(root, '@playwright', 'mcp', 'node_modules', 'playwright');
    } catch {
      return null;
    }
  };
  const tried = [];
  for (const dir of [...CANDIDATES(), fromNpm()]) {
    if (!dir) continue;
    tried.push(dir);
    try {
      createRequire(path.join(dir, 'package.json')).resolve('./package.json');
      cached = dir;
      return dir;
    } catch { /* next */ }
  }
  throw new Error(`playwright package not found; tried:\n${tried.join('\n')}`);
}

export function loadPlaywright() {
  // The library reads this at launch time, so set it before the first launch.
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath();
  return createRequire(path.join(playwrightPackageDir(), 'package.json'))('playwright');
}

export function browsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  return path.join(process.env.LOCALAPPDATA || '', 'ui-probe', 'ms-playwright');
}

// Environment every Playwright launch must carry: the browser dir has to be
// the same value at install and at run, or the launch dies "Executable doesn't exist".
export function playwrightEnv(extra = {}) {
  return { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath(), ...extra };
}

export const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
