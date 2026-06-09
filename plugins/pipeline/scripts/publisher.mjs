// Publisher — write outbound messages to disk + optional hook for forwarding.
//
// The plugin itself is **notifier-agnostic**: every report and notification
// gets written to a JSON file under `<paths.stateDir>/notifications/` (or a
// configured directory). The file contains a stable envelope schema that any
// forwarder (Slack, MS Teams, Discord, email, webhook, log shipper) can read.
//
// If `cfg.notifications.on_write` is set to a command, that command is
// spawned with the JSON file path as its single argument. The hook reads the
// JSON, picks fields it needs, and forwards however it likes.
//
// Out-of-the-box behavior for a public install: notifications land on disk as
// JSON files, nothing else happens. Operators wiring Slack or anything else
// set:
//
//   { "notifications": { "on_write": "/abs/path/to/forwarder.mjs" } }
//
// The plugin itself does **not** ship any sink-specific integration. Slack /
// MS Teams / Discord / email / webhook / log shipper forwarders live outside
// this plugin (your own script, a separate plugin, whatever).
//
// ── Envelope schema ─────────────────────────────────────────────────────────
//
//   {
//     "schema_version":  1,
//     "timestamp":       "YYYYMMDDTHHmmssZ",    // when published
//     "kind":            "notification" | "report",
//     "title":           "<short title>",
//     "priority":        "default" | "low" | "high",
//     "body":            "<message body, may be markdown>",
//     "source_file":     "<original report path, reports only>"   // optional
//   }
//
// Forwarders should treat unknown fields as opaque and not depend on field
// order. `schema_version` is bumped if the field set changes.
import { existsSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { loadPipelineConfig } from "../src/pipeline-config.mjs";
import { getPaths } from "../src/paths.mjs";

const SCHEMA_VERSION = 1;

function _slugify(s) {
  return String(s || "msg").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "msg";
}

function _timestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

function _dropDir(cfg, paths) {
  return cfg.notifications?.fallback_dir || join(paths.stateDir, "notifications");
}

function _writeEnvelope(envelope, paths, cfg) {
  const dir   = _dropDir(cfg, paths);
  const fname = `${envelope.timestamp}-${_slugify(envelope.title)}.json`;
  const target = join(dir, fname);
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, JSON.stringify(envelope, null, 2) + "\n", "utf8");
  return target;
}

// Hook spawn — bounded-wait synchronous chain. Hook receives the envelope file
// path as its only argv. Output redirects to `<stateDir>/notifications/hook.log`
// (append) so spawn / forwarder errors remain debuggable.
//
// Why we await instead of fire-and-forget: the originally-detached spawn raced
// the fast-exit CLI subprocess (`pipeline dev-complete` etc. exit ~150ms via
// setTimeout per the Windows UV_HANDLE_CLOSING workaround). On Windows the
// detached child got killed before its undici fetch finished, and the chain
// died silently. Awaiting the child close inside the publisher means the CLI
// subprocess holds the event loop open until the hook returns. The 15s
// timeout matches the old Python `slack_notify.py` behaviour and bounds the
// blast radius if the hook hangs.
//
// Returns a Promise<void> that resolves on child close or after the timeout.

function _resolveHookCommand(hookVal) {
  if (!hookVal) return null;
  if (typeof hookVal === "string") return hookVal;
  if (Array.isArray(hookVal) && hookVal[0]?.command) return hookVal[0].command;
  return null;
}

function _spawnHook(cfg, filePath, paths) {
  // New key first, legacy fallback for one release
  const hook = _resolveHookCommand(cfg.hooks?.on_notification)
            ?? _resolveHookCommand(cfg.notifications?.on_write);
  if (!hook) return Promise.resolve();
  const args = /\.(mjs|js)$/.test(hook) ? ["node", hook, filePath] : [hook, filePath];
  return new Promise((resolveSpawn) => {
    let logFd;
    try {
      const logDir = _dropDir(cfg, paths);
      mkdirSync(logDir, { recursive: true });
      logFd = openSync(join(logDir, "hook.log"), "a");
    } catch (e) {
      process.stderr.write(`notifications.on_write log open threw: ${e.message}\n`);
      resolveSpawn();
      return;
    }

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      try { closeSync(logFd); } catch {}
      resolveSpawn();
    };

    let child;
    try {
      child = spawn(args[0], args.slice(1), {
        stdio: ["ignore", logFd, logFd],
        detached: false,
        windowsHide: true,
      });
    } catch (e) {
      process.stderr.write(`notifications.on_write hook spawn threw: ${e.message}\n`);
      settle();
      return;
    }

    // 15s hard cap — matches the old Python slack_notify.py timeout. If the
    // hook hangs longer than this, the caller proceeds; the child becomes
    // orphaned but the chain is unblocked. Operator sees a "hook timed out"
    // line in hook.log so it's debuggable without keeping the caller hostage.
    const TIMEOUT_MS = 15_000;
    const timer = setTimeout(() => {
      try { process.stderr.write(`notifications.on_write hook timed out after ${TIMEOUT_MS}ms\n`); } catch {}
      try { child.kill(); } catch {}
      settle();
    }, TIMEOUT_MS);
    timer.unref?.();

    child.on("error", () => settle());
    child.on("close", () => { clearTimeout(timer); settle(); });
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

// Publish an existing report file. Wraps the report content in a JSON
// envelope. Returns true on success.
export async function publishReport(reportFile, { dryRun = false, _cfg, _paths } = {}) {
  if (!existsSync(reportFile)) {
    process.stderr.write(`Report file not found: ${reportFile}\n`);
    return false;
  }
  const cfg   = _cfg   ?? loadPipelineConfig();
  const paths = _paths ?? getPaths();

  const body = readFileSync(reportFile, "utf8");
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : reportFile.split(/[/\\]/).pop();
  const envelope = {
    schema_version: SCHEMA_VERSION,
    timestamp:      _timestamp(),
    kind:           "report",
    title,
    priority:       "default",
    body,
    source_file:    reportFile,
  };

  if (dryRun) {
    process.stdout.write(`[dry-run] would publish report envelope (title=${title})\n`);
    return true;
  }

  const target = _writeEnvelope(envelope, paths, cfg);
  process.stdout.write(`Report published: ${target}\n`);
  await _spawnHook(cfg, target, paths);
  return true;
}

// Publish a generic notification. Returns true on success.
export async function publishNotification({ title, message, messageFile, priority = "default" } = {}, { dryRun = false, _cfg, _paths } = {}) {
  if (!title) {
    process.stderr.write("publishNotification: title is required\n");
    return false;
  }
  if (message == null && !messageFile) {
    process.stderr.write("publishNotification: message or messageFile is required\n");
    return false;
  }
  const cfg   = _cfg   ?? loadPipelineConfig();
  const paths = _paths ?? getPaths();

  const body = messageFile && existsSync(messageFile) ? readFileSync(messageFile, "utf8") : (message ?? "");
  const envelope = {
    schema_version: SCHEMA_VERSION,
    timestamp:      _timestamp(),
    kind:           "notification",
    title,
    priority,
    body,
  };

  if (dryRun) {
    process.stdout.write(`[dry-run] would publish notification envelope (title=${title})\n`);
    return true;
  }

  const target = _writeEnvelope(envelope, paths, cfg);
  process.stdout.write(`Notification published: ${target}\n`);
  await _spawnHook(cfg, target, paths);
  return true;
}

// Spawn on_merge_ready hook — fires when a row reaches stage=merge.
// Fire-and-forget with 15s cap, exit code ignored.
export function spawnMergeReadyHook(project, feature, branch, targetBranch) {
  const cfg = loadPipelineConfig();
  const hook = _resolveHookCommand(cfg.hooks?.on_merge_ready);
  if (!hook) return Promise.resolve();
  const args = /\.(mjs|js)$/.test(hook) ? ["node", hook] : [hook];
  const env = {
    ...process.env,
    PIPELINE_PROJECT:       project,
    PIPELINE_FEATURE:       feature,
    PIPELINE_BRANCH:        branch,
    PIPELINE_TARGET_BRANCH: targetBranch,
  };
  return new Promise(resolve => {
    try {
      const child = spawn(args[0], args.slice(1), {
        env, stdio: "ignore", windowsHide: true, detached: false,
      });
      child.on("close", resolve);
      child.on("error", resolve);  // fire-and-forget; ignore errors
      setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 15_000).unref?.();
    } catch { resolve(); }
  });
}
