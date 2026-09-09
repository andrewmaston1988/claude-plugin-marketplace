// Pure builders for `swarm install` — no I/O here, so the tests assert on the
// exact wrapper text and plan without ever touching the real ~/.local/bin.
// The subcommand in scripts/swarm.mjs does the writing.
import { join } from "node:path";

// Mirrors ~/.local/bin/pipeline / pipeline.cmd. Paths are quoted because node
// lives under "C:\Program Files". The explicit bin/swarm.mjs target is
// load-bearing: the resolver's no-args mode is statusline mode, which swallows
// failures by contract — an explicit rel target keeps the CLI on the
// exit-propagating branch.
export function bashWrapper(nodePath, resolverPath) {
  return `#!/usr/bin/env bash\nexec "${nodePath}" "${resolverPath}" bin/swarm.mjs "$@"\n`;
}

// CRLF is not cosmetic — cmd.exe parsing is unreliable on LF-only .cmd files.
export function cmdWrapper(nodePath, resolverPath) {
  return `@echo off\r\n"${nodePath}" "${resolverPath}" bin/swarm.mjs %*\r\n`;
}

// The resolver copy first, then the wrappers that exec it. `platform` is a
// parameter rather than a read of process.platform so this stays pure and both
// branches are testable from either OS. The .cmd is win32-only — the reference
// wizard gates it the same way, and on POSIX it is an unrunnable file.
export function installPlan({ userBin, nodePath, resolverSrc, platform = process.platform }) {
  const resolverPath = join(userBin, "swarm-resolver.mjs");
  const plan = [
    { path: resolverPath, copyFrom: resolverSrc },
    { path: join(userBin, "swarm"), content: bashWrapper(nodePath, resolverPath), mode: 0o755 },
  ];
  if (platform === "win32") plan.push({ path: join(userBin, "swarm.cmd"), content: cmdWrapper(nodePath, resolverPath) });
  return plan;
}
