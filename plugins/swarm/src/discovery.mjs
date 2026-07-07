import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { swarmHome } from "./config.mjs";

// Model discovery. Source of truth is the daemon's recommendations endpoint —
// verified as the exact data source of the `ollama launch` picker (returns
// :cloud names WITH per-model description/context/plan). Fallbacks, in order,
// because the endpoint is experimental/undocumented:
//   1. {provider.url}/api/experimental/model-recommendations
//   2. https://ollama.com/api/experimental/model-recommendations
//   3. https://ollama.com/api/tags  (names WITHOUT the :cloud suffix — append)
//   4. cfg.provider.discoverCmd TUI scrape (last resort)
// `ollama list` and local /v1/models are NEVER used (locally pulled models
// only — :cloud never appears there). Never pulls.

function withSuffix(name, suffix) {
  return name.endsWith(suffix) ? name : name + suffix;
}

function parseRecommendations(body, suffix) {
  const recs = Array.isArray(body?.recommendations) ? body.recommendations : [];
  return recs
    .filter((r) => typeof r?.model === "string" && r.model.endsWith(suffix))
    .map((r) => ({ model: r.model, description: r.description || "" }));
}

function parseTags(body, suffix) {
  const models = Array.isArray(body?.models) ? body.models : [];
  return models
    .filter((m) => typeof m?.name === "string")
    .map((m) => ({ model: withSuffix(m.name, suffix), description: m.description || "" }));
}

// Last resort: run the interactive picker command, scrape :cloud names from
// its output, then kill it.
export function scrapeDiscoverCmd(cfg, spawnImpl = nodeSpawn, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const suffix = cfg.provider.cloudSuffix || ":cloud";
    const [cmd, ...args] = String(cfg.provider.discoverCmd).split(/\s+/).filter(Boolean);
    let out = "";
    let child;
    try {
      child = spawnImpl(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve([]);
      return;
    }
    const finish = () => {
      const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const names = [...new Set(out.match(new RegExp(`[\\w./-]+${escaped}`, "g")) || [])];
      resolve(names.map((model) => ({ model, description: "" })));
    };
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    if (timer.unref) timer.unref();
    child.on("error", finish);
    child.on("close", () => { clearTimeout(timer); finish(); });
  });
}

export async function discoverModels(cfg, fetchImpl = globalThis.fetch, { spawnImpl } = {}) {
  const suffix = cfg.provider.cloudSuffix || ":cloud";
  const base = String(cfg.provider.url).replace(/\/+$/, "");
  const sources = [
    { url: `${base}/api/experimental/model-recommendations`, parse: parseRecommendations },
    { url: "https://ollama.com/api/experimental/model-recommendations", parse: parseRecommendations },
    { url: "https://ollama.com/api/tags", parse: parseTags },
  ];
  for (const s of sources) {
    try {
      const res = await fetchImpl(s.url);
      if (!res.ok) continue;
      const models = s.parse(await res.json(), suffix);
      if (models.length) return models;
    } catch {
      continue; // endpoint down or shape unexpected — walk the chain
    }
  }
  const scraped = await scrapeDiscoverCmd(cfg, spawnImpl);
  if (scraped.length) return scraped;
  throw new Error(
    "model discovery failed: recommendations endpoints, catalog, and discoverCmd all yielded nothing — " +
    "is ollama running and >= the version that serves /api/experimental/model-recommendations?"
  );
}

// Cache the last discovery so the ultraswarm hook can name real models in its
// offers without a network round-trip. Written on every `models` run.
export function writeModelsCache(models, env = process.env) {
  const dir = swarmHome(env);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "models-cache.json");
  writeFileSync(p, JSON.stringify({ updated: new Date().toISOString(), models }, null, 2) + "\n");
  return p;
}
