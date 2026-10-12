// Preloaded by `npm test` (--import): points SWARM_HOME at a throwaway dir so no
// test that forgets to isolate can write runs, scores or caches into the real
// ~/.swarm. Child processes (node --test workers, CLI spawns) inherit it.
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

// An inherited SWARM_HOME is only trustworthy when WE set it — the marker says so.
// Without it, an operator who exports SWARM_HOME in their shell gets their real
// store written to by the suite, which is the one thing this file exists to stop.
// Plain "always override" is not the fix: the workers must inherit the parent's dir,
// not each mint their own.
if (!process.env.SWARM_HOME || process.env.SWARM_TEST_HOME !== "1") {
  const dir = mkdtempSync(join(tmpdir(), "swarm-test-home-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  process.env.SWARM_HOME = dir;
  process.env.SWARM_TEST_HOME = "1";
  process.env.SWARM_CREDENTIALS = join(dir, "claude-credentials.json");
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH || ""}`;
  // Keep tests off the live Codex meter with a PATH-first stub. Bare win32 spawn
  // resolves only .exe/.com, so node.exe treats app-server as a script and exits 1.
  if (process.platform === "win32") {
    const stub = join(binDir, "codex.exe");
    try { linkSync(process.execPath, stub); } catch { copyFileSync(process.execPath, stub); }
  } else {
    writeFileSync(join(binDir, "codex"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  // Only the process that minted it removes it; a worker would pull the dir out
  // from under its siblings.
  process.on("exit", () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort on exit */ }
  });
}
