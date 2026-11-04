#!/usr/bin/env node
// The regression gate: plays every lifecycle cell on this checkout and on another ref
// of this plugin, and fails on any cell where this checkout is worse. --write-baseline
// saves the ref's outcomes for the CI test instead.
// Usage: node plugins/slack-bridge/tests/lifecycle/gate.mjs [--against origin/master] [--write-baseline]
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startSession } from "./session-sim.mjs";
import { CELLS, cellName, runCell } from "./scenarios.mjs";
import { regressions } from "./compare.mjs";
import { ACCEPTED } from "./accepted.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "../..");
const repoRoot = path.resolve(pluginRoot, "../..");
const args = process.argv.slice(2);
const against = args.includes("--against") ? args[args.indexOf("--against") + 1] : "origin/master";

async function playAll(root) {
  const out = {};
  for (const cell of CELLS) {
    const s = await startSession(root);
    try {
      out[cellName(cell)] = await runCell(s, cell);
    } catch (e) {
      out[cellName(cell)] = { error: e.message };
    } finally {
      await s.stop();
    }
  }
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-base-"));
try {
  execSync(`git archive --format=tar ${against} plugins/slack-bridge | tar -x -C "${tmp}"`, { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] });
  const base = await playAll(path.join(tmp, "plugins/slack-bridge"));
  if (args.includes("--write-baseline")) {
    const file = path.join(here, "baseline.json");
    fs.writeFileSync(file, JSON.stringify({ ref: execSync(`git rev-parse --short ${against}`, { cwd: pluginRoot }).toString().trim(), cells: base }, null, 2) + "\n");
    console.log(`baseline written: ${file}`);
    process.exit(0);
  }
  const mine = await playAll(pluginRoot);
  let failed = 0;
  for (const name of Object.keys(base)) {
    const worse = regressions(mine[name], base[name])
      .filter((m) => !ACCEPTED.some((a) => a.cell === name && a.measure === m));
    if (worse.length) failed++;
    console.log(`${worse.length ? "WORSE" : "ok   "} ${name}${worse.length ? ` — ${worse.join("; ")}` : ""}`);
    if (worse.length) console.log(`        ${against}: ${JSON.stringify(base[name])}\n        here: ${JSON.stringify(mine[name])}`);
  }
  console.log(`${failed} of ${Object.keys(base).length} cells worse than ${against}`);
  process.exitCode = failed ? 1 : 0;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
setTimeout(() => process.exit(process.exitCode ?? 0), 150);
