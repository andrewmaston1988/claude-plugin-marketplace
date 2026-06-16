import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { PIPELINE_DEFAULTS } from "./config-defaults.mjs";

export { PIPELINE_DEFAULTS };

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    out[k] = v !== null && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object"
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

// Read ~/.pipeline/config.json and deep-merge with PIPELINE_DEFAULTS.
// Always returns a complete config object; missing keys fall back to defaults.
// On parse failure, fall back to defaults and warn to stderr so the operator
// notices the file is unreadable (caller-driven, read-only path).
export function loadPipelineConfig(configPath) {
  if (configPath === undefined) configPath = join(homedir(), ".pipeline", "config.json");
  if (!existsSync(configPath)) return deepMerge({}, PIPELINE_DEFAULTS);
  try {
    return deepMerge(PIPELINE_DEFAULTS, JSON.parse(readFileSync(configPath, "utf8")));
  } catch (e) {
    process.stderr.write(`pipeline-config: could not parse ${configPath} — ${e.message}\n`);
    return deepMerge({}, PIPELINE_DEFAULTS);
  }
}

// Read the on-disk config, apply `mutator(cfg)`, and write the result back
// atomically (.tmp -> rename, mode 0o600). Returns the mutated config.
// Reads the raw on-disk JSON (not the defaults-merged copy) so the write does
// not balloon the file with every default key.
export function updatePipelineConfig(mutator, configPath) {
  if (configPath === undefined) configPath = join(homedir(), ".pipeline", "config.json");
  let raw = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (e) {
      // Atomic by design: throw before touching the file. A silent fallback
      // to `{}` would let a mutator blow away unrelated keys on the next
      // write (e.g. `pipeline stage-set` would erase the proxy block).
      throw new Error(`pipeline-config: could not parse ${configPath} — ${e.message}`);
    }
  }
  mutator(raw);
  mkdirSync(dirname(configPath), { recursive: true });
  const tmpPath = configPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(raw, null, 2), { mode: 0o600 });
  renameSync(tmpPath, configPath);
  return raw;
}
