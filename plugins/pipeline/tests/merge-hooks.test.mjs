// smoke-21: merge hooks — spawnMergeReadyHook env-var contract.
//
// Covers the on_merge_ready hook path in publisher.mjs: null config is a
// no-op, a configured hook script receives the correct env vars.
import { test } from "node:test";
import { ok, equal } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnMergeReadyHook } from "../scripts/publisher.mjs";

// Patch loadPipelineConfig so tests don't read the real ~/.pipeline/config.json
// by intercepting the module. We use a temp-file side-channel instead: the
// hook script writes env vars to a file, which we read back in the test.

function makeTmpDir() {
  const tmp = mkdtempSync(join(tmpdir(), "smoke21-"));
  return { tmp, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

test("spawnMergeReadyHook: resolves immediately when on_merge_ready is null (no-op)", async () => {
  const start = Date.now();
  await spawnMergeReadyHook("proj", "feat", "autonomous/feat", "master", "/tmp/proj", { _cfg: {} });
  ok(Date.now() - start < 1000, "no-op hook should resolve almost immediately");
});

test("spawnMergeReadyHook: hook script receives correct PIPELINE_* env vars", async () => {
  const { tmp, cleanup } = makeTmpDir();
  try {
    // Write a small hook script that dumps relevant env vars to a JSON file.
    const outFile = join(tmp, "env-dump.json");
    const hookScript = join(tmp, "hook.mjs");
    writeFileSync(hookScript, [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({`,
      "  project: process.env.PIPELINE_PROJECT,",
      "  feature: process.env.PIPELINE_FEATURE,",
      "  branch: process.env.PIPELINE_BRANCH,",
      "  targetBranch: process.env.PIPELINE_TARGET_BRANCH,",
      "}), 'utf8');",
    ].join("\n"), "utf8");

    // Temporarily write a config that points on_merge_ready at our hook.
    // spawnMergeReadyHook calls loadPipelineConfig() which reads
    // ~/.pipeline/config.json — we can't safely mutate that in a test.
    // Instead, we invoke the hook indirectly by calling it in a child process
    // with HOME/USERPROFILE overridden so loadPipelineConfig reads our config.
    const configDir = join(tmp, ".pipeline");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
      hooks: { on_merge_ready: hookScript },
    }), "utf8");

    // Spawn a child that runs spawnMergeReadyHook with our HOME overridden.
    const { spawnSync } = await import("node:child_process");
    const publisherUrl = new URL("../scripts/publisher.mjs", import.meta.url).href;
    const script = [
      `import { spawnMergeReadyHook } from ${JSON.stringify(publisherUrl)};`,
      `await spawnMergeReadyHook("myproject", "my-feat", "autonomous/my-feat", "main", "/tmp/projroot");`,
    ].join("\n");
    const entryFile = join(tmp, "runner.mjs");
    writeFileSync(entryFile, script, "utf8");

    const env = { ...process.env, USERPROFILE: tmp, HOME: tmp };
    const r = spawnSync(process.execPath, [entryFile], { env, encoding: "utf8", timeout: 10_000 });
    ok(r.status === 0, `runner exited ${r.status}: ${r.stderr}`);
    ok(r.stderr === "" || !r.stderr.includes("Error"), `unexpected stderr: ${r.stderr}`);

    // Read the env dump written by the hook script.
    const dumped = JSON.parse(readFileSync(outFile, "utf8"));
    equal(dumped.project,      "myproject",         "PIPELINE_PROJECT");
    equal(dumped.feature,      "my-feat",            "PIPELINE_FEATURE");
    equal(dumped.branch,       "autonomous/my-feat", "PIPELINE_BRANCH");
    equal(dumped.targetBranch, "main",               "PIPELINE_TARGET_BRANCH");
  } finally { cleanup(); }
});

test("spawnMergeReadyHook: array hook shape [{command}] is resolved correctly", async () => {
  const { tmp, cleanup } = makeTmpDir();
  try {
    const outFile = join(tmp, "env-dump.json");
    const hookScript = join(tmp, "hook.mjs");
    writeFileSync(hookScript, [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ ok: true }), 'utf8');`,
    ].join("\n"), "utf8");

    const configDir = join(tmp, ".pipeline");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(configDir, { recursive: true });
    // Array shape (Claude Code hook format)
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
      hooks: { on_merge_ready: [{ command: hookScript }] },
    }), "utf8");

    const { spawnSync } = await import("node:child_process");
    const publisherUrl2 = new URL("../scripts/publisher.mjs", import.meta.url).href;
    const script = [
      `import { spawnMergeReadyHook } from ${JSON.stringify(publisherUrl2)};`,
      `await spawnMergeReadyHook("p", "f", "autonomous/f", "master", "/tmp/projroot");`,
    ].join("\n");
    const entryFile = join(tmp, "runner.mjs");
    writeFileSync(entryFile, script, "utf8");

    const env = { ...process.env, USERPROFILE: tmp, HOME: tmp };
    const r = spawnSync(process.execPath, [entryFile], { env, encoding: "utf8", timeout: 10_000 });
    ok(r.status === 0, `runner exited ${r.status}: ${r.stderr}`);

    const dumped = JSON.parse(readFileSync(outFile, "utf8"));
    equal(dumped.ok, true, "array hook shape should resolve command and run it");
  } finally { cleanup(); }
});
