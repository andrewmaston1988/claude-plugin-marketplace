// Preloaded by `npm test` (--import): points SWARM_HOME at a throwaway dir so no
// test that forgets to isolate can write runs, scores or caches into the real
// ~/.swarm. Child processes (node --test workers, CLI spawns) inherit it.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// An inherited SWARM_HOME is only trustworthy when WE set it — the marker says so.
// Without it, an operator who exports SWARM_HOME in their shell gets their real
// store written to by the suite, which is the one thing this file exists to stop.
// Plain "always override" is not the fix: the workers must inherit the parent's dir,
// not each mint their own.
if (!process.env.SWARM_HOME || process.env.SWARM_TEST_HOME !== "1") {
  const dir = mkdtempSync(join(tmpdir(), "swarm-test-home-"));
  process.env.SWARM_HOME = dir;
  process.env.SWARM_TEST_HOME = "1";
  // Only the process that minted it removes it; a worker would pull the dir out
  // from under its siblings.
  process.on("exit", () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort on exit */ }
  });
}
