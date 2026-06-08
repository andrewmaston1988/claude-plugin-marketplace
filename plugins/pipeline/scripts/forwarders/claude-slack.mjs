#!/usr/bin/env node
// Built-in notifications.on_write forwarder for Slack.
//
// Reads the envelope JSON written by publisher.mjs (path passed as argv[2]),
// resolves the destination channel by envelope kind, then shells out to
// `claude-slack notify <channel> <message>`:
//
//   envelope.kind === "report"       → governance_channel (fallback pipeline_channel)
//   envelope.kind === "notification" → pipeline_channel   (fallback governance_channel)
//
// Backward-compat: the legacy `slack_channel` key (pre-rename) is still read
// as a final fallback so existing configs keep working for one release.
//
// Wired by the setup wizard when both a Slack channel and `claude-slack` are
// detected. Users wanting a different forwarder can either:
//   (a) replace `notifications.on_write` in config.json with their own script
//       (any executable taking the envelope file path as argv[1] works), or
//   (b) inspect this file as a reference implementation.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

function _loadConfig() {
  const path = join(homedir(), ".pipeline", "config.json");
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
}

function _resolveChannel(cfg, envelope) {
  const n          = cfg.notifications || {};
  // Backward-compat: pre-rename key was `slack_channel`. Prefer the new
  // `governance_channel`; fall back to legacy key so existing configs work.
  const governance = n.governance_channel ?? n.slack_channel ?? null;
  const pipeline   = n.pipeline_channel   ?? null;
  const kind       = envelope?.kind ?? "notification";
  if (kind === "report") return governance || pipeline || null;
  return pipeline || governance || null;
}

function _findClaudeSlack() {
  // 1) CLAUDE_SLACK_PLUGIN env override (tests / non-standard installs).
  if (process.env.CLAUDE_SLACK_PLUGIN && existsSync(process.env.CLAUDE_SLACK_PLUGIN)) {
    return process.env.CLAUDE_SLACK_PLUGIN;
  }
  // 2) Standard plugin-marketplace install location. Robust against PATH
  //    quirks — `where claude-slack` on Windows misses `.mjs`; mingw bash PATH
  //    has POSIX separators that the Win path walk can't decode.
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const cache = join(home, ".claude", "plugins", "cache");
  if (existsSync(cache)) {
    try {
      for (const owner of readdirSync(cache)) {
        const sb = join(cache, owner, "slack-bridge");
        if (!existsSync(sb)) continue;
        for (const ver of readdirSync(sb)) {
          const exe = join(sb, ver, "bin", "claude-slack.mjs");
          if (existsSync(exe)) return exe;
        }
      }
    } catch {}
  }
  // 3) PATH walk fallback — covers shim/.cmd installs on a sane shell.
  const dirs = (process.env.PATH || "").split(/[;:]/);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".mjs", ".js", ""] : [""];
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of exts) {
      const p = join(d, "claude-slack" + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

(async () => {
  const envelopePath = process.argv[2];
  if (!envelopePath || !existsSync(envelopePath)) {
    process.stderr.write(`claude-slack forwarder: envelope file missing: ${envelopePath}\n`);
    process.exit(1);
  }

  let env;
  try { env = JSON.parse(readFileSync(envelopePath, "utf8")); }
  catch (e) { process.stderr.write(`claude-slack forwarder: bad JSON: ${e.message}\n`); process.exit(1); }

  const cfg     = _loadConfig();
  const channel = _resolveChannel(cfg, env);
  const slack   = _findClaudeSlack();
  if (!channel) { process.stderr.write("claude-slack forwarder: no channel configured — skipping.\n"); return; }
  if (!slack)   { process.stderr.write("claude-slack forwarder: claude-slack not on PATH — skipping.\n"); return; }

  // Title becomes Slack's `text` field (preview / notification text); body
  // becomes the attachment body that renders inline. Slack truncates very
  // long messages, so cap the body at 30k to stay well under the 40k limit.
  const title = env.title || "(no title)";
  const body  = String(env.body || "").slice(0, 30_000);

  const args = [].concat(
    /\.(mjs|js)$/.test(slack) ? ["node", slack] : [slack],
    ["notify", "--channel", channel, "--title", title, "--message", body],
  );
  // Await the claude-slack child completion before exiting. The forwarder was
  // previously a fire-and-forget spawn, but Slack posts via undici take ~500ms
  // and the orphaned child loses its stdio when this forwarder exits — the
  // fetch then fails silently. Awaiting keeps the chain alive for the duration
  // of the post. Errors propagate via the child's stdio (inherit) for log
  // visibility.
  await new Promise((resolveSpawn) => {
    const child = spawn(args[0], args.slice(1), { stdio: "inherit", detached: false });
    child.on("close", resolveSpawn);
    child.on("error", () => resolveSpawn());
  });
})().catch(e => { process.stderr.write(e.message + "\n"); process.exit(1); });
