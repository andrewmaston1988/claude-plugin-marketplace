// Imported first by every pipeline test file: points HOME and USERPROFILE at a
// throwaway dir so a run cannot read or write the operator's real ~/.pipeline.
// Child processes (node --test workers, hook spawns) inherit it.
import { mkdtempSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir, tmpdir } from "node:os";

// Reuse an inherited home only when the marker AND the path prove the helper
// minted it. A spawned child then shares its parent's dir instead of minting a
// second; a stray PIPELINE_TEST_HOME=1 in the operator's shell mints a fresh
// one rather than writing through to their real home.
const home = homedir();
const minted = home === tmpdir() || home.startsWith(tmpdir() + sep);
if (process.env.PIPELINE_TEST_HOME !== "1" || !minted) {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-test-home-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  // getPaths() prefers the XDG vars on Linux; left set they would point the
  // suite at the operator's real data dir even with HOME moved.
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_STATE_HOME;
  delete process.env.XDG_CACHE_HOME;
  process.env.PIPELINE_TEST_HOME = "1";
  // Only a process that minted a dir removes one, so a worker cannot pull it
  // out from under its parent.
  process.on("exit", () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort on exit */ }
  });
}
