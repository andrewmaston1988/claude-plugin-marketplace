// Rows C1-C3: the in-process CLI returns what a spawned one returns, leaves no
// state behind, and the bin still behaves exactly as before.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCli, runCliInProcess, runValidated } from "./helpers/cli.mjs";
import { currentSink } from "../src/ui.mjs";
import { writeRosterEntry } from "../src/roster.mjs";
import { tmp, gateHome } from "./helpers/cli-fixture.mjs";

const BIN_ENTRY = fileURLToPath(new URL("../bin/swarm.mjs", import.meta.url));
const MODEL = "claude-haiku-4-5-20251001";

// Model discovery is off on purpose: a spawned CLI reaches the network and an
// in-process one is blocked by isolate-home, so a byte comparison needs neither.
const NO_DISCOVERY = {
  providers: { claude: { enabled: true, allowedRoots: [tmpdir()] }, ollama: { enabled: false } },
};

function world() {
  const dir = tmp();
  const home = gateHome(join(dir, "home"));
  writeRosterEntry("claude", {
    hydratedAt: Date.now(),
    source: null,
    models: [{ provider: "claude", model: MODEL, efforts: ["low", "medium", "high"], defaultEffort: "high" }],
  }, { SWARM_HOME: home });
  const manifest = join(dir, "m.json");
  writeFileSync(manifest, JSON.stringify({
    resultsDir: "out",
    tasks: [{ id: "a", prompt: "look", provider: "claude", model: MODEL }],
  }));
  const badManifest = join(dir, "bad.json");
  writeFileSync(badManifest, JSON.stringify({ resultsDir: "out", tasks: [] }));
  return { dir, home, manifest, badManifest, env: { SWARM_HOME: home } };
}

const shape = (r) => ({ status: r.status, stdout: r.stdout, stderr: r.stderr });

test("C1: in-process and spawned return equal status/stdout/stderr", async () => {
  const w = world();
  try {
    const opts = { cwd: w.dir, env: w.env, config: NO_DISCOVERY };
    const cases = [
      ["validate", w.manifest],
      ["validate", w.badManifest],
      ["status", join(w.dir, "no-such-run")],
      ["models"],
    ];
    for (const args of cases) {
      const spawned = runCli(args, opts);
      const inproc = await runCliInProcess(args, opts);
      deepEqual(shape(inproc), shape(spawned), `${args.join(" ")} differs`);
    }
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test("C2: the sink, cwd and env are restored after a call — including one that throws", async () => {
  const w = world();
  const before = currentSink();
  const cwdBefore = process.cwd();
  const envBefore = process.env.SWARM_HOME;
  try {
    await runCliInProcess(["status", join(w.dir, "no-such-run")], { cwd: w.dir, env: w.env });
    equal(currentSink(), before, "sink restored after a successful call");
    equal(process.cwd(), cwdBefore, "cwd restored");
    equal(process.env.SWARM_HOME, envBefore, "env restored");

    await runCliInProcess(["status", "x"], { cwd: join(w.dir, "no-such-dir"), env: w.env })
      .then(() => { throw new Error("chdir into a missing dir should throw"); }, () => {});
    equal(currentSink(), before, "sink restored after a throwing call");
    equal(process.cwd(), cwdBefore, "cwd restored after a throwing call");
    equal(process.env.SWARM_HOME, envBefore, "env restored after a throwing call");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test("C2: a run row's scheduler and snapshot output is captured, never printed", async () => {
  const dir = tmp();
  try {
    const home = gateHome(join(dir, "home"));
    writeRosterEntry("claude", {
      hydratedAt: Date.now(), source: null,
      models: [{ provider: "claude", model: MODEL, efforts: ["low", "medium", "high"], defaultEffort: "high" }],
    }, { SWARM_HOME: home });
    const manifest = join(dir, "m.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "scan", prompt: "look", provider: "claude", model: MODEL }],
    }));

    // Anything the run writes past the sink lands here instead — makeDefaultIo's
    // closing lines and the snapshot writer are the two bypass writers.
    const leaked = [];
    const realWrite = process.stdout.write;
    // Strings only: the test reporter writes its own framed Buffers here.
    process.stdout.write = function (chunk, ...rest) {
      if (typeof chunk === "string") leaked.push(chunk);
      return realWrite.call(this, chunk, ...rest);
    };
    let r;
    try {
      r = await runValidated(["run", manifest], {
        inProcess: true,
        quotaPreflight: false,
        cwd: dir,
        env: { SWARM_HOME: home, SWARM_SHIM_OUTPUT: "leaf-output-text" },
      });
    } finally {
      process.stdout.write = realWrite;
    }

    equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    equal(leaked.join(""), "", "every line went to the sink, none to the test process's stdout");
    equal(r.stdout.includes("scan"), true, `roster/closing lines captured:\n${r.stdout}`);
    const summary = JSON.parse(readFileSync(join(dir, "out", "summary.json"), "utf8"));
    deepEqual(summary.tasks.map((t) => t.state), ["ok"], "the run really executed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C3: the bin prints the same output and exit code as before", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-bin-"));
  try {
    const runBin = (args) => spawnSync(process.execPath, [BIN_ENTRY, ...args], {
      cwd: dir, encoding: "utf8", timeout: 60000, windowsHide: true, env: { ...process.env },
    });
    // No --version case exists: the pinned unknown-command contract is usage on
    // stderr and exit 1.
    const version = runBin(["--version"]);
    equal(version.status, 1);
    equal(version.stdout, "");
    equal(version.stderr.startsWith("usage: swarm.mjs <command>"), true, version.stderr);

    const badManifest = join(dir, "bad.json");
    writeFileSync(badManifest, JSON.stringify({ resultsDir: "out", tasks: [] }));
    const bad = runBin(["validate", badManifest]);
    equal(bad.status, 1);
    equal(bad.stdout, "");
    equal(bad.stderr.startsWith("manifest validation failed:"), true, bad.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
