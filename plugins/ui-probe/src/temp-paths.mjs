// The one owner of ui-probe's temp layout: everything the plugin writes to temp lives under
// <tmpdir>/ui-probe, so nothing else has to guess which of %TEMP%'s entries are ours.

import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_FS = { readdirSync, rmSync, statSync };

// A day covers an agent reading yesterday's results; the newest 20 cover a burst.
export const RUNS_KEEP = 20;
export const RUNS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// A backlog must never stall a probe start, so one run deletes only so much of it.
export const RUNS_DELETE_CAP = 200;

// Run folders an earlier release left directly in ui-probe/: an ISO stamp or a Date.now() one.
const LEGACY_RUN = /^(?:\d{4}-\d{2}-\d{2}T[\d-]+Z|\d{13})$/;

/** The temp root. `UI_PROBE_TEMP` moves it elsewhere: the CLI suite sets it so a test probe
 *  can never prune the operator's own results. */
export function uiProbeTemp({ _tmpdir = tmpdir, env = process.env } = {}) {
  return env.UI_PROBE_TEMP || join(_tmpdir(), 'ui-probe');
}

export function runsDir(opts = {}) {
  return join(uiProbeTemp(opts), 'runs');
}

export function profilesDir(opts = {}) {
  return join(uiProbeTemp(opts), 'profiles');
}

export function platformPath(appid, opts = {}) {
  return join(uiProbeTemp(opts), `platform-${appid}.json`);
}

/** One run-directory name for both outDir defaults, so the two cannot drift apart again. */
export function defaultRunDir(opts = {}) {
  return join(runsDir(opts), new Date().toISOString().replace(/[:.]/g, '-'));
}

/** Where a run writes. Only the default dir is ui-probe's to prune: an `outDir` from the
 *  config or `--out` belongs to the caller. */
export function resolveOutDir(config, explicit, { _fs, _tmpdir, env, now } = {}) {
  if (explicit) return explicit;
  if (config?.outDir && !config.outDirDefaulted) return config.outDir;
  pruneRuns({ _fs, _tmpdir, env, now });
  return config?.outDir ?? defaultRunDir({ _tmpdir, env });
}

/** Delete runs older than `maxAgeMs`, always keeping the newest `keep`, and the legacy run
 *  folders an earlier release left in the root. Best effort — never fatal — and returns the
 *  number of folders removed. */
export function pruneRuns({
  now = Date.now,
  keep = RUNS_KEEP,
  maxAgeMs = RUNS_MAX_AGE_MS,
  cap = RUNS_DELETE_CAP,
  _fs = DEFAULT_FS,
  _tmpdir = tmpdir,
  env = process.env,
} = {}) {
  const at = now();
  const opts = { _tmpdir, env };
  let budget = cap;
  let removed = 0;
  const remove = (path) => {
    if (budget <= 0) return;
    try {
      _fs.rmSync(path, { recursive: true, force: true });
      removed += 1;
      budget -= 1;
    } catch {
      // A folder another process holds over stays for the next run to try.
    }
  };

  const runs = childDirs(_fs, runsDir(opts)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const [index, run] of runs.entries()) {
    if (index >= keep && at - run.mtimeMs > maxAgeMs) remove(run.path);
  }
  for (const entry of childDirs(_fs, uiProbeTemp(opts))) {
    if (LEGACY_RUN.test(entry.name) && at - entry.mtimeMs > maxAgeMs) remove(entry.path);
  }
  return removed;
}

/** Direct child directories of `root`, with their mtimes. A root that is absent or
 *  unreadable has no children: pruning is best effort and must never fail a run. */
function childDirs(_fs, root) {
  let entries;
  try {
    entries = _fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const children = [];
  for (const entry of entries) {
    const name = String(entry?.name ?? entry);
    if (entry && typeof entry.isDirectory === 'function' && !entry.isDirectory()) continue;
    const path = join(root, name);
    try {
      children.push({ name, path, mtimeMs: _fs.statSync(path).mtimeMs });
    } catch {
      // Vanished between the listing and the stat: nothing left to prune.
    }
  }
  return children;
}
