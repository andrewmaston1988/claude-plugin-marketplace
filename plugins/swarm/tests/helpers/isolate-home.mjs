// Imported first by every test file: points SWARM_HOME, HOME and USERPROFILE at a
// throwaway dir so a run cannot read or write the real ~/.swarm or ~/.claude.
// Child processes (node --test workers, CLI spawns) inherit it.
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { after } from "node:test";

// An inherited SWARM_HOME is only trustworthy when WE set it — the marker says so.
// Without it, an operator who exports SWARM_HOME in their shell gets their real
// store written to by the suite, which is the one thing this file exists to stop.
// Each test-file process mints its own home; the marker lets a CLI child a test
// spawns inherit that dir rather than minting a second.
if (!process.env.SWARM_HOME || process.env.SWARM_TEST_HOME !== "1") {
  // One `swarm` dir under the OS temp root keeps every temp path we mint findable
  // (and one place to sweep); the home below is the only thing a run removes.
  mkdirSync(join(tmpdir(), "swarm"), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "swarm", "test-home-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  // Every later os.tmpdir() here, and in a child that inherits this env, lands here.
  // A SIBLING of the home, never a child: the governance gate reads everything under
  // the home as swarm-owned, so a fixture inside it would pass checks it must fail.
  const tmpDir = mkdtempSync(join(tmpdir(), "swarm", "tmp-"));
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = tmpDir;
  // A test-owned config, never the operator's: theirs carries hooks that act on
  // their machine (one MSYS spawn per git command on Windows) and LFS filters.
  // A global FILE still loses to a repo-local core.hooksPath, which one test
  // installs as its subject. Fixed values; autocrlf matches the operator's so
  // content assertions see the same bytes.
  const gitconfig = join(dir, ".gitconfig");
  writeFileSync(gitconfig, [
    "[user]",
    "\tname = Swarm Test",
    "\temail = swarm-test@example.invalid",
    "[commit]",
    "\tgpgsign = false",
    "[core]",
    "\tautocrlf = false",
    "",
  ].join("\n"));
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.SWARM_HOME = dir;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
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
  // Only the process that minted them removes them; a worker would pull a dir out
  // from under its siblings.
  process.on("exit", () => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort on exit */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort on exit */ }
  });
}

// No fetch in this process reaches a vendor. A CLI child a test spawns is not covered:
// it inherits the env, not this patch. An outbound TLS connect here has killed node
// outright with no output, so the run reports a bare `test failed` with nothing
// pointing at the request that caused it.
//
// Loopback stays open: several tests fetch the server they just started.
const realFetch = globalThis.fetch;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const blocked = [];
globalThis.fetch = (input, init) => {
  let url;
  try {
    // `new URL` is the resolution: a non-absolute input throws here and is handed
    // on, so the caller still sees fetch's own "Failed to parse URL" rejection.
    url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input?.url);
  } catch {
    return realFetch(input, init);
  }
  if (LOOPBACK.has(url.hostname)) return realFetch(input, init);
  blocked.push(url.href);
  return Promise.reject(new Error(`network access in a swarm test: ${url.href}`));
};

// A hook, not an exit code: the thrown error lands in the test report naming the
// URLs it refused, where a non-zero exit is reported as a bare `test failed`.
after(() => {
  if (blocked.length) throw new Error(`network access in a swarm test: ${blocked.join(", ")}`);
});
