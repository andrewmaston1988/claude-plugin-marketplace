import { test } from "node:test";
import { equal, match, doesNotMatch, ok } from "node:assert/strict";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWizard } from "../src/setup/wizard.mjs";

function freshPaths() {
  const tmp = mkdtempSync(join(tmpdir(), "pipeline-wizard-err-"));
  const projectRoot = join(tmp, "code", "demo-app");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, ".git"), "gitdir: ./not-a-real-repo\n");
  return {
    tmp,
    paths: {
      configDir: join(tmp, "pipeline"),
      stateDir:  join(tmp, "state"),
      dataDir:   join(tmp, "data"),
      logDir:    join(tmp, "logs"),
    },
  };
}

function cleanup(tmp) { rmSync(tmp, { recursive: true, force: true }); }

const baseOpts = {
  nonInteractive:            true,
  installDeps:               false,
  installAutostart:          true,
  installPathAlias:          false,
  continueOnFailedPrechecks: true,
};

// Collect all say() calls via _testHooks.say — avoids process.stdout.write
// override which interferes with concurrent TAP reporter output on Windows.
function makeSayCollector() {
  const lines = [];
  return {
    say: (s) => lines.push(s),
    getOutput: () => lines.join("\n"),
  };
}

test("wizard: autostart error captured in setupErrors with correct shape", async () => {
  const ctx = freshPaths();
  const col = makeSayCollector();
  const prevExitCode = process.exitCode;
  let ret;
  try {
    ret = await runWizard({
      paths: ctx.paths,
      log: () => {},
      opts: {
        ...baseOpts,
        _testHooks: {
          say:              col.say,
          renderTemplate:   () => "<xml/>",
          installAutostart: async () => { throw new Error("Access Denied: schtasks failed"); },
          verifyAutostart:  async () => ({ ok: false, detail: "not installed" }),
        },
      },
    });
  } finally {
    process.exitCode = prevExitCode;
    cleanup(ctx.tmp);
  }
  ok(Array.isArray(ret.setupErrors), "runWizard returns setupErrors array");
  equal(ret.setupErrors.length, 1);
  equal(ret.setupErrors[0].step, "autostart");
  equal(ret.setupErrors[0].message, "Access Denied: schtasks failed");
  ok(ret.setupErrors[0].hint, "hint is present");
});

// schtasks hint is Windows-only; the Linux hint is a different string.
const testWin = process.platform === "win32" ? test : test.skip;

testWin("wizard: autostart failure surfaces in final summary with hint", async () => {
  const ctx = freshPaths();
  const col = makeSayCollector();
  const prevExitCode = process.exitCode;
  try {
    await runWizard({
      paths: ctx.paths,
      log: () => {},
      opts: {
        ...baseOpts,
        _testHooks: {
          say:              col.say,
          renderTemplate:   () => "<xml/>",
          installAutostart: async () => { throw new Error("Access Denied: schtasks failed"); },
          verifyAutostart:  async () => ({ ok: false, detail: "not installed" }),
        },
      },
    });
  } finally {
    process.exitCode = prevExitCode;
    cleanup(ctx.tmp);
  }
  const out = col.getOutput();
  match(out, /⚠ Setup completed with errors:/);
  match(out, /✗ autostart: Access Denied: schtasks failed/);
  match(out, /schtasks \/Delete \/TN ClaudePipelineOrchestrator/);
});

test("wizard: process.exitCode is 2 when setupErrors non-empty", async () => {
  const ctx = freshPaths();
  const col = makeSayCollector();
  const prevExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    await runWizard({
      paths: ctx.paths,
      log: () => {},
      opts: {
        ...baseOpts,
        _testHooks: {
          say:              col.say,
          renderTemplate:   () => "<xml/>",
          installAutostart: async () => { throw new Error("Permission denied"); },
          verifyAutostart:  async () => ({ ok: false, detail: "not installed" }),
        },
      },
    });
    equal(process.exitCode, 2);
  } finally {
    process.exitCode = prevExitCode;
    cleanup(ctx.tmp);
  }
});

testWin("wizard: existing-task pre-warning printed when schtasks /Query resolves", async () => {
  const ctx = freshPaths();
  const col = makeSayCollector();
  const prevExitCode = process.exitCode;
  try {
    await runWizard({
      paths: ctx.paths,
      log: () => {},
      opts: {
        ...baseOpts,
        _testHooks: {
          say:              col.say,
          querySchtasks:    async () => { /* resolves — task found */ },
          renderTemplate:   () => "<xml/>",
          installAutostart: async () => {},
          verifyAutostart:  async () => ({ ok: true, detail: "Task Scheduler entry found" }),
        },
      },
    });
  } finally {
    process.exitCode = prevExitCode;
    cleanup(ctx.tmp);
  }
  match(col.getOutput(), /ℹ Existing scheduled task detected/);
});

test("wizard: clean run has no error summary and exits with code 0", async () => {
  const ctx = freshPaths();
  const col = makeSayCollector();
  const prevExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    await runWizard({
      paths: ctx.paths,
      log: () => {},
      opts: {
        ...baseOpts,
        _testHooks: {
          say:              col.say,
          renderTemplate:   () => "<xml/>",
          installAutostart: async () => {},
          verifyAutostart:  async () => ({ ok: true, detail: "Task Scheduler entry found" }),
        },
      },
    });
    equal(process.exitCode, 0);
  } finally {
    process.exitCode = prevExitCode;
    cleanup(ctx.tmp);
  }
  doesNotMatch(col.getOutput(), /⚠ Setup completed with errors:/);
});
