#!/usr/bin/env node
// ui-probe CLI. Every src module is imported inside the branch that needs it: `screens` and
// `--help` must never pay for the browser stack, and `run` only launches a browser when the
// scenario actually reaches a step that needs one.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deviceFlag, getFlag, hasFlag, positionals, varsFrom } from "../src/flags.mjs";

const HELP = [
  "usage: ui-probe <command> [options]",
  "",
  "commands:",
  "  capture <screen>|--url <url>   capture a configured screen (or a bare url)",
  "  run <scenario.yaml|json>       run a scenario; exit 0 passed, 1 failed, 2 inconclusive,",
  "                                 3 needs_review, 64 invalid scenario/config/arguments",
  "  validate [<file>] [--config]   validate a scenario file and/or the config",
  "  screens                        list the config's screens",
  "  doctor                         check config, and then whichever of the tv, browser",
  "                                 and baseUrl checks the config needs",
  "  tv probe                       measure the TV platform; see its options below",
  "",
  "options:",
  "  --config <path>        config file (default: .ui-probe.json found walking up from cwd)",
  "  --url <url>            capture this url instead of a named screen",
  "  --viewport <a,b>       viewport names (capture default: phone,desktop)",
  "  --var k=value          variable for auth commands; repeatable",
  "  --out <dir>            output directory",
  "  --allow-writes         permit writes for this one invocation",
  "  --include-background   observe the page behind a modal dialog",
  "  --device tv|desktop    where a tv-backend journey or capture runs (default: desktop)",
  "  --attach-port <n>      join a TV debug forward already running instead of relaunching",
  "  --screenshot           capture on the TV: also replay a screenshot (slow on the set)",
  "  --video <url>          tv probe: a same-origin clip for the video checks",
  "  --navigate <url>       tv probe: test what the app may navigate to",
  "  --listen <seconds>     tv probe: record physical remote presses for this long",
  "  --help                 this text",
  "",
].join("\n");

const argv = process.argv.slice(2);
const cmd = argv[0];

const out = (line) => process.stdout.write(line + "\n");
const err = (line) => process.stderr.write(line + "\n");
// Windows UV handle teardown needs a beat before exit or stdout is lost.
const settle = (code) => { setTimeout(() => process.exit(code), 150); };

(async () => {
  if (cmd === undefined || cmd === "--help") { process.stdout.write(HELP); settle(0); return; }

  if (cmd === "capture") {
    const rest = argv.slice(1);
    let loaded;
    try {
      loaded = await loadConfig(getFlag("--config", rest), true);
    } catch (e) { if (reportConfigError(e)) return; throw e; }
    const config = loaded.config;

    const url = getFlag("--url", rest);
    const name = positionals(rest)[0];
    let screen;
    if (url) {
      screen = { url };
    } else if (name && config.screens?.[name]) {
      screen = config.screens[name];
    } else if (name) {
      err(`no screen named ${name} in ${loaded.path}; run "ui-probe screens" to list them`);
      settle(64);
      return;
    } else {
      err("capture needs a screen name or --url <url>");
      settle(64);
      return;
    }

    const { vars, problem } = varsFrom(rest);
    if (problem) { err(problem); settle(64); return; }
    const viewports = getFlag("--viewport", rest)?.split(",").map((v) => v.trim()).filter(Boolean);

    const device = deviceFlag(rest);
    if (device.problem) { err(device.problem); settle(64); return; }

    if (device.value === "tv") {
      const { captureTvBranch } = await import("../src/tv/cli.mjs");
      const done = await captureTvBranch({ screen, config, rest, getFlag, source: name ?? url });
      if (done.stderr) err(done.stderr);
      if (done.digest) process.stdout.write(done.digest.endsWith("\n") ? done.digest : `${done.digest}\n`);
      settle(done.exitCode);
      return;
    }

    const { capture } = await import("../src/capture.mjs");
    const { AuthError } = await import("../src/auth.mjs");
    let session = null;
    try {
      const { digest } = await capture(screen, {
        config,
        cdp: async () => {
          session = await openBrowser(config.browser);
          return session.client;
        },
        outDir: getFlag("--out", rest) ?? undefined,
        viewports,
        vars,
        allowWrites: hasFlag("--allow-writes", rest),
        includeBackground: hasFlag("--include-background", rest),
        source: name ?? url,
      });
      if (digest) process.stdout.write(digest.endsWith("\n") ? digest : `${digest}\n`);
    } catch (e) {
      if (e instanceof AuthError) { err(e.message); settle(64); return; }
      throw e;
    } finally {
      if (session) await session.close();
    }
    settle(0);
    return;
  }

  if (cmd === "run") {
    const rest = argv.slice(1);
    const file = positionals(rest)[0];
    if (!file) { err("run needs a scenario file"); settle(64); return; }
    const format = scenarioFormat(file);
    if (!format) { err(`unsupported scenario extension ${JSON.stringify(path.extname(file))}`); settle(64); return; }

    let doc;
    try {
      const { parseScenario } = await import("../src/ir.mjs");
      doc = parseScenario(readFileSync(file, "utf8"), { format });
    } catch (e) {
      err(e.code === "ENOENT" ? `cannot read ${file}: ${e.message}` : `${file}: ${e.message}`);
      settle(64);
      return;
    }

    let config = null;
    try {
      config = (await loadConfig(getFlag("--config", rest), false)).config;
    } catch (e) { if (reportConfigError(e)) return; throw e; }

    const viewportName = getFlag("--viewport", rest);
    if (viewportName) {
      const viewport = config?.viewports?.[viewportName];
      if (!viewport) { err(`unknown viewport ${JSON.stringify(viewportName)}; add it to viewports in the config`); settle(64); return; }
      const step = { width: viewport.width, height: viewport.height };
      if (viewport.touch) step.touch = true;
      if (viewport.dpr !== undefined) step.dpr = viewport.dpr;
      doc = { ...doc, steps: [{ viewport: step }, ...doc.steps] };
    }

    const { vars, problem } = varsFrom(rest);
    if (problem) { err(problem); settle(64); return; }
    const device = deviceFlag(rest);
    if (device.problem) { err(device.problem); settle(64); return; }
    const outDir = resolveOutDir(config, getFlag("--out", rest));
    // An include resolves beside the file that names it, so every loader gets that file's path.
    const scenarioPath = path.resolve(file);

    const { digestLine } = await import("../src/digest.mjs");
    const { resolveCookies, AuthError } = await import("../src/auth.mjs");
    let cookies;
    try {
      // Resolved before the browser exists, so a missing --var costs no launch.
      cookies = await resolveCookies(config, vars);
    } catch (e) {
      if (e instanceof AuthError) { err(e.message); settle(64); return; }
      throw e;
    }

    let result;
    if (device.value === "tv") {
      const { runTvBranch } = await import("../src/tv/cli.mjs");
      const done = await runTvBranch({
        doc, config, rest, getFlag, cookies,
        baseUrl: config?.baseUrl ?? null, source: path.basename(file),
        baseDir: path.dirname(scenarioPath), file: scenarioPath,
      });
      if (done.stderr) err(done.stderr);
      if (done.exitCode !== 0) { settle(done.exitCode); return; }
      // What the set cost to reach, before any step is judged.
      if (done.timings) out(attachLine(done.timings));
      result = done.result;
    } else {
      const backend = doc.backend ?? "browser";
      if (backend === "tv") {
        // The config-only half of the write policy: refused before a browser launches.
        const { assertTvPolicy, scenarioOpens, TvRefusal } = await import("../src/tv/cli.mjs");
        try {
          assertTvPolicy(config, {
            backend,
            allowWrites: hasFlag("--allow-writes", rest),
            opens: scenarioOpens(doc, { baseDir: path.dirname(scenarioPath), file: scenarioPath }),
          });
        } catch (e) {
          if (e instanceof TvRefusal) { err(e.message); settle(64); return; }
          throw e;
        }
      }

      const { run } = await import("../src/runner.mjs");
      let session = null;
      let launchError = null;
      try {
        result = await run(doc, {
          cdp: async () => {
            try {
              session = await openBrowser(config?.browser);
              return session.client;
            } catch (e) {
              launchError = e;
              throw e;
            }
          },
          baseUrl: config?.baseUrl ?? null,
          allowWrites: hasFlag("--allow-writes", rest),
          cookies,
          device: "desktop",
          // The desktop device stands in for the set, so a tv journey's writes are scoped here too.
          testOrigin: config?.tv?.testOrigin ?? null,
          source: path.basename(file),
          baseDir: path.dirname(scenarioPath),
          file: scenarioPath,
        });
      } catch (e) {
        if (session) await session.close();
        if (e instanceof AuthError) { err(e.message); settle(64); return; }
        // The environment failed the probe, not the app: inconclusive, never "failed".
        if (launchError) { err(`inconclusive: browser: ${e.message}`); settle(2); return; }
        throw e;
      }
      if (session) await session.close();
    }

    for (const problem of result.problems ?? []) printProblem(problem);
    const counts = { passed: 0, failed: 0, inconclusive: 0, not_run: 0 };
    for (const step of result.steps) {
      counts[step.outcome] = (counts[step.outcome] ?? 0) + 1;
      out(digestLine(step));
    }
    out(`run: ${result.outcome} (${counts.passed} passed, ${counts.failed} failed, ${counts.inconclusive} inconclusive, ${counts.not_run} not run) → ${outDir}`);
    writeResults(outDir, result.steps);
    settle(result.exitCode);
    return;
  }

  if (cmd === "tv") {
    if (argv[1] !== "probe") {
      err(`unknown tv subcommand: ${argv[1] ?? "(none)"} — the only one is probe`);
      settle(64);
      return;
    }
    const rest = argv.slice(2);
    let loaded;
    try {
      loaded = await loadConfig(getFlag("--config", rest), true);
    } catch (e) { if (reportConfigError(e)) return; throw e; }
    const { tvProbeBranch } = await import("../src/tv/cli.mjs");
    const done = await tvProbeBranch({ config: loaded.config, rest, getFlag, resolveOutDir, out, err });
    if (done.stderr) err(done.stderr);
    settle(done.exitCode);
    return;
  }

  if (cmd === "validate") {
    const rest = argv.slice(1);
    const file = positionals(rest)[0];
    const wantsConfig = hasFlag("--config", rest) || !file;
    let failed = false;

    if (file) {
      const format = scenarioFormat(file);
      if (!format) { err(`unsupported scenario extension ${JSON.stringify(path.extname(file))}`); settle(64); return; }
      try {
        const { parseScenario, validate } = await import("../src/ir.mjs");
        const doc = parseScenario(readFileSync(file, "utf8"), { format });
        const scenarioPath = path.resolve(file);
        const problems = validate(doc, { baseDir: path.dirname(scenarioPath), file: scenarioPath });
        if (problems.length) {
          failed = true;
          err(`${file}: ${problems.length} problem(s)`);
          for (const problem of problems) printProblem(problem);
        } else {
          out(`ok   ${file}`);
        }
      } catch (e) {
        err(`${file}: ${e.message}`);
        settle(64);
        return;
      }
    }

    if (wantsConfig) {
      try {
        const loaded = await loadConfig(getFlag("--config", rest), true);
        out(`ok   config: ${loaded.path}`);
      } catch (e) {
        if (!Array.isArray(e.errors)) throw e;
        failed = true;
        printConfigErrors(e);
      }
    }
    settle(failed ? 64 : 0);
    return;
  }

  if (cmd === "screens") {
    const rest = argv.slice(1);
    let loaded;
    try {
      loaded = await loadConfig(getFlag("--config", rest), true);
    } catch (e) { if (reportConfigError(e)) return; throw e; }
    const screens = loaded.config.screens ?? {};
    const names = Object.keys(screens);
    if (!names.length) out("(no screens)");
    for (const name of names) {
      const screen = screens[name];
      const measure = (screen.measure ?? []).join(" ");
      out(`${name}  ${screen.url}${measure ? `  measure: ${measure}` : ""}`);
    }
    settle(0);
    return;
  }

  if (cmd === "doctor") {
    const rest = argv.slice(1);
    let loaded;
    try {
      loaded = await loadConfig(getFlag("--config", rest), true);
    } catch (e) { if (reportConfigError(e)) return; throw e; }
    out(`ok   config: ${loaded.path}`);

    if (loaded.config.tv) {
      const { doctorTv } = await import("../src/tv/cli.mjs");
      if (!doctorTv(loaded.config, { out, err })) { settle(1); return; }
    } else {
      out("skip tv: the config has no tv block");
    }

    try {
      const { findBrowser, launch } = await import("../src/browser.mjs");
      const exe = findBrowser({ browser: loaded.config.browser });
      const session = await launch({ browser: exe });
      await session.close();
      out(`ok   browser: ${exe}`);
    } catch (e) {
      err(`FAIL browser: ${e.message}`);
      settle(1);
      return;
    }

    try {
      const response = await fetch(loaded.config.baseUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      out(`ok   baseUrl: ${loaded.config.baseUrl} (${response.status})`);
    } catch (e) {
      err(`FAIL baseUrl: ${e.message}`);
      settle(1);
      return;
    }

    settle(0);
    return;
  }

  err(`unknown command: ${cmd}`);
  process.stdout.write(HELP);
  settle(64);
})().catch((e) => {
  process.stderr.write(`${(e && e.message) || String(e)}\n`);
  process.exit(1);
});

// -- helpers ----------------------------------------------------------------

async function loadConfig(explicit, required) {
  const { findConfig, loadConfig: read, ConfigError } = await import("../src/config.mjs");
  const configPath = explicit ?? findConfig(process.cwd());
  if (!configPath) {
    if (!required) return { path: null, config: null };
    throw new ConfigError([{
      field: "file",
      problem: `no .ui-probe.json found from ${process.cwd()}`,
      fix: "add a .ui-probe.json with a baseUrl, or pass --config <path>",
      example: '{ "baseUrl": "http://127.0.0.1:8001" }',
    }]);
  }
  return { path: configPath, config: read(configPath) };
}

function reportConfigError(e) {
  if (!Array.isArray(e.errors)) return false;
  printConfigErrors(e);
  settle(64);
  return true;
}

function printConfigErrors(e) {
  err(`FAIL config: ${e.message}`);
  for (const item of e.errors) {
    if (item.fix) err(`  fix: ${item.fix}`);
    if (item.example) err(`  e.g. ${item.example}`);
  }
}

function attachLine({ attachMs, relaunchMs }) {
  const relaunch = relaunchMs == null ? "n/a" : `${relaunchMs} ms`;
  return `tv attach: ${attachMs} ms, relaunch: ${relaunch}`;
}

function printProblem(problem) {
  if (typeof problem === "string") { err(`note: ${problem}`); return; }
  err(`${problem.field}: ${problem.problem}`);
  if (problem.fix) err(`  fix: ${problem.fix}`);
  if (problem.example) err(`  e.g. ${problem.example}`);
}

async function openBrowser(browserPath) {
  const { findBrowser, launch } = await import("../src/browser.mjs");
  const { connect } = await import("../src/cdp.mjs");
  const raw = await launch({ browser: findBrowser({ browser: browserPath }) });
  let client;
  try {
    client = await connect(raw.port);
  } catch (e) {
    await Promise.resolve(raw.close()).catch(() => {});
    throw e;
  }
  return {
    client,
    close: () => Promise.resolve(raw.close()).catch((e) => err(`browser close: ${e.message}`)),
  };
}

function writeResults(outDir, steps) {
  mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, "results.json");
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(steps, null, 2));
  renameSync(tmp, target);
}

function resolveOutDir(config, explicit) {
  if (explicit) return explicit;
  if (config?.outDir) return config.outDir;
  return path.join(os.tmpdir(), "ui-probe", String(Date.now()));
}

function scenarioFormat(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  return null;
}

