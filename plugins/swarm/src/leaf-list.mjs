import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isSentinelModel } from "./manifest.mjs";
import { cloneId, childId } from "./leaf-ids.mjs";

function clonesFor(base, resultIds) {
  const prefix = cloneId(base, "").slice(0, -1);
  return resultIds.filter((id) => {
    if (!id.startsWith(prefix) || !id.endsWith("]")) return false;
    const index = id.slice(prefix.length, -1);
    const n = Number(index);
    return Number.isSafeInteger(n) && n >= 0 && String(n) === index;
  });
}

function manifestResultIds(manifest, resultIds) {
  const allowed = new Set();
  if (!Array.isArray(manifest?.tasks)) return allowed;

  for (const task of manifest.tasks) {
    if (typeof task?.id !== "string") continue;
    allowed.add(task.id);
    const expanded = task.forEach ? clonesFor(task.id, resultIds) : [task.id];
    for (const id of expanded) allowed.add(id);

    if (!Array.isArray(task.child)) continue;
    for (const parentId of expanded) {
      for (const child of task.child) {
        if (typeof child?.id !== "string") continue;
        const cid = childId(parentId, child.id);
        allowed.add(cid);
        if (child.forEach) {
          for (const clone of clonesFor(cid, resultIds)) allowed.add(clone);
        }
      }
    }
  }
  return allowed;
}

export function listLeavesFrom(dir, { gradeable = false } = {}, { readResult, resultPath, transcriptPath }) {
  const resultsRoot = join(dir, "results");
  if (!existsSync(resultsRoot)) return [];
  const files = readdirSync(resultsRoot).filter((f) => f.endsWith(".json"));
  const manifestPath = join(dir, "manifest.json");
  let allowed;
  if (existsSync(manifestPath)) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { manifest = {}; }
    allowed = manifestResultIds(manifest, files.map((f) => f.slice(0, -".json".length)));
  }
  return files
    .filter((f) => !allowed || allowed.has(f.slice(0, -".json".length)))
    .map((f) => {
      const id = f.slice(0, -".json".length);
      const result = readResult(dir, id);
      return result && {
        id, model: result.model,
        ...(result.provider && { provider: result.provider }),
        ...(result.runner && { runner: result.runner }),
        result, resultPath: resultPath(dir, id), transcriptPath: transcriptPath(dir, id),
      };
    })
    .filter((leaf) => leaf && (!gradeable || (leaf.model && !isSentinelModel(leaf.model))));
}
