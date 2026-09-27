import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// Fixtures shared by the CLI test files. They live here rather than in
// cli.test.mjs because importing a .test.mjs from another .test.mjs
// re-registers and re-runs its rows in the importing file's process.

// The one place the provider policy lives. `allowedRoots` gates EVERY provider, claude
// included, and an empty list denies — so a fixture HOME without it refuses every
// dispatching row; fixtures live under tmpdir, so that is the root they declare and
// `extra` keys win. Ollama and Claude are on explicitly: both shipped defaults are
// `enabled: false`, so a fixture that omits one refuses every row that dispatches to it.
export const gateConfig = (extra = {}) => JSON.stringify({ providers: { claude: { enabled: true, allowedRoots: [tmpdir()] }, ollama: { enabled: true } }, ...extra });

// Writes that config into `home` and returns it — every fixture HOME a dispatching row
// reads goes through here, so the block exists in exactly one place.
export function gateHome(home, extra = {}) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), gateConfig(extra));
  return home;
}

export function gitOut(args, cwd) {
  return (spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).stdout || "").trim();
}

export function commitAll(cwd, msg) {
  spawnSync("git", ["add", "."], { cwd, windowsHide: true });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", msg], { cwd, windowsHide: true });
}

// A git repo with one commit: runs are filed under the dispatching repo. It also carries
// the fixture HOME every row points at, pre-gated, so a row only writes its own config
// keys when it has a reason to.
export function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "swarm-cli-"));
  spawnSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  commitAll(dir, "init");
  gateHome(join(dir, "home"));
  return dir;
}
