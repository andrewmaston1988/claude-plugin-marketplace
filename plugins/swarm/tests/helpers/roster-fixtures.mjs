// Shared fixtures for the roster read-through tests: temp homes, a Claude
// catalog writer and stub local/network adapters.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The plan's own number, as a literal: a test stepping against the exported
// constant moves with it and never goes red.
export const TWELVE_H = 12 * 60 * 60_000;

export const cachePath = (dir) => join(dir, "models-cache.json");
export const home = () => mkdtempSync(join(tmpdir(), "swarm-roster-"));
// HOME too, not just SWARM_HOME: the claude adapter's discovery reads
// ~/.claude/cache/model-catalog, and a real one would add rows here.
export const envOf = (dir) => ({ SWARM_HOME: dir, HOME: dir, USERPROFILE: dir });

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export function writeCatalog(dir, file, { fetchedAt, ids, mtimeMs }) {
  const catalogDir = join(dir, ".claude", "cache", "model-catalog");
  mkdirSync(catalogDir, { recursive: true });
  const path = join(catalogDir, file);
  writeFileSync(path, JSON.stringify({
    fetchedAt,
    catalog: { config: { models: ids.map((id) => ({ id, name: id })) } },
  }));
  if (mtimeMs != null) utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  return path;
}

export function localAdapter(id, rows, log = []) {
  const source = () => `${id}-catalog@1`;
  return {
    id,
    runnerId: "claude",
    rosterHydration: "local",
    enabled: () => true,
    validateTask: () => [],
    capabilities: {
      discoverModels: () => { log.push(id); return rows; },
      rosterSource: source,
      rosterStale: (entry) => entry?.source !== source(),
    },
  };
}

export function networkAdapter(id, { rows = [{ model: `${id}-new` }], fail = null, log = [], enabled = () => true } = {}) {
  return {
    id,
    runnerId: "claude",
    rosterHydration: "network",
    enabled,
    validateTask: () => [],
    capabilities: {
      discoverModels: async (context) => {
        log.push(context);
        if (fail) throw new Error(fail);
        return rows;
      },
    },
  };
}

export const entryOf = (id, model, hydratedAt) => ({ hydratedAt, source: null, models: [{ provider: id, model }] });
export const namesOf = (rows) => rows.map((row) => row.model);

