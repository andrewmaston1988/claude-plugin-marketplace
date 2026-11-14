// `swarm mcp` — which servers a leaf starts. `list` shows the machine's roster with
// today's off/on state; `set` writes the operator's answers through the one config
// write path. Neither touches a run.
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConfig, runsKeyFor, swarmHome, updateUserConfig } from "../src/config.mjs";
import { cleanMcpConfig, namesEqual, parseMcpList } from "../src/leaf-mcp.mjs";
import { toSpawnable } from "../src/dispatch.mjs";
import { out as stdout, err as stderr } from "../src/ui.mjs";

const MAX_REPOS = 16;
// `claude mcp list` health-checks every server, briefly starting each stdio one.
const LIST_TIMEOUT_MS = 60_000;

const offNamesOf = (cfg) => (Array.isArray(cfg?.mcp?.off) ? cfg.mcp.off : []);
const projectsOf = (cfg) => (Array.isArray(cfg?.projects) ? cfg.projects : []);
const onOf = (project) => (Array.isArray(project?.mcp?.on) ? project.mcp.on : []);

function repoOnFor(cfg, repoName) {
  const project = projectsOf(cfg).find((p) => namesEqual(p.name, repoName));
  return onOf(project);
}

// A repo's run directory is found by the forward key, never by decoding a recorded
// cwd: most old cwds are pruned worktrees that no longer exist.
function newestRun(runsRoot, key) {
  const dir = join(runsRoot, key);
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  let newest = 0;
  for (const name of names) {
    try { newest = Math.max(newest, statSync(join(dir, name)).mtimeMs); } catch { /* vanished */ }
  }
  return newest || null;
}

function lastRunNamed(runsRoot, name) {
  let keys = [];
  try { keys = readdirSync(runsRoot); } catch { return null; }
  const hit = keys.find((key) => {
    if (namesEqual(key, name)) return true;
    const tail = key.slice(key.length - name.length);
    return key.length > name.length && key[key.length - name.length - 1] === "-" && namesEqual(tail, name);
  });
  return hit ? newestRun(runsRoot, hit) : null;
}

// The repos offered for per-repo setup: the ones leaves have actually run in, newest
// first, then every repo already in `projects`. Configured projects always make the
// list whatever their run history — `set` is authoritative, so a project that fell
// out of the listing would lose its `on` on the next setup run.
export function repoCandidates(cfg, home) {
  const runsRoot = join(home, "runs");
  const projects = projectsOf(cfg);
  const byName = new Map();
  for (const root of Array.isArray(cfg?.allowedRoots) ? cfg.allowedRoots : []) {
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      if (!existsSync(join(dir, ".git"))) continue;
      const lastRun = newestRun(runsRoot, runsKeyFor(dir));
      if (lastRun == null) continue;
      byName.set(entry.name, { name: entry.name, lastRun });
    }
  }
  const runRepos = [...byName.values()].sort((a, b) => (b.lastRun ?? 0) - (a.lastRun ?? 0) || a.name.localeCompare(b.name));
  const picked = runRepos.slice(0, Math.max(0, MAX_REPOS - projects.length));
  for (const project of projects) {
    if (picked.some((repo) => namesEqual(repo.name, project.name))) continue;
    const ran = runRepos.find((repo) => namesEqual(repo.name, project.name));
    picked.push({ name: project.name, lastRun: ran ? ran.lastRun : lastRunNamed(runsRoot, project.name) });
  }
  return picked;
}

// The roster a leaf sees, with each server's state and the repos that turn it back
// on. An off name the CLI no longer lists is still offered — otherwise setup could
// never untick it.
export function mcpReport(cfg, home, listingText) {
  const off = offNamesOf(cfg);
  const projects = projectsOf(cfg);
  // Server names are the CLI's own and match exactly; only repo names fold case.
  const decorate = (server) => ({
    ...server,
    off: off.includes(server.name),
    onFor: projects.filter((p) => onOf(p).includes(server.name)).map((p) => p.name),
  });
  const servers = parseMcpList(listingText).map(decorate);
  for (const name of off) {
    if (!servers.some((s) => s.name === name)) {
      servers.push(decorate({ name, target: "", status: "not listed" }));
    }
  }
  const repos = repoCandidates(cfg, home).map(({ name, lastRun }) => ({
    name,
    on: repoOnFor(cfg, name),
    lastRun: lastRun ? new Date(lastRun).toISOString() : null,
  }));
  return { servers, repos };
}

function runListing(cfg, { spawn, env, platform }) {
  const { cmd, args } = toSpawnable([cfg?.claudePath || "claude", "mcp", "list"], {
    _spawnSync: spawn,
    _env: env,
    _platform: platform,
  });
  // stdin is ignored: the real CLI waits on an open pipe before it prints anything.
  const result = spawn(cmd, args, {
    encoding: "utf8",
    timeout: LIST_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env,
  });
  const detail = (result?.stderr || "").toString().trim();
  if (result?.error || result?.status !== 0) {
    const why = result?.error?.message || result?.signal || `exit ${result?.status}`;
    return { ok: false, reason: detail ? `${why}: ${detail}` : why };
  }
  return { ok: true, text: (result.stdout || "").toString() };
}

function cmdList(rest, { cfg, home, env, spawn, platform, out: write, err: writeErr }) {
  const listed = runListing(cfg, { spawn, env, platform });
  if (!listed.ok) {
    writeErr(`swarm mcp list: \`claude mcp list\` failed (${listed.reason}) — run \`claude mcp list\` by hand; nothing was changed.`);
    return 1;
  }
  const report = mcpReport(cfg, home, listed.text);
  if (rest.includes("--json")) {
    write(JSON.stringify(report, null, 2));
    return 0;
  }
  const width = Math.max(6, ...report.servers.map((s) => s.name.length), ...report.repos.map((r) => r.name.length));
  write(`MCP servers (${report.servers.length}) — leaves start every one unless it is off:`);
  for (const server of report.servers) {
    const turnedOn = server.onFor.length ? `  (turned back on by ${server.onFor.join(", ")})` : "";
    write(`  ${server.name.padEnd(width)}  ${(server.off ? "off" : "on").padEnd(3)}  ${server.status}  ${server.target}${turnedOn}`);
  }
  if (report.repos.length) {
    write("repos leaves have run in, newest first, with the servers they turn back on:");
    for (const repo of report.repos) {
      write(`  ${repo.name.padEnd(width)}  ${repo.on.length ? repo.on.join(", ") : "defaults only"}`);
    }
  }
  return 0;
}

// Every `--repo`, not just the first: the file-wide getFlag helper drops the rest.
function flagValues(name, args) {
  const values = [];
  for (let i = 0; i < args.length; i++) if (args[i] === `--${name}` && i + 1 < args.length) values.push(args[i + 1]);
  return values;
}

const splitNames = (text) => String(text ?? "").split(",").map((n) => n.trim()).filter(Boolean);

function parseRepoFlag(value) {
  const at = value.indexOf("=");
  if (at < 1) return null;
  return { name: value.slice(0, at).trim(), on: splitNames(value.slice(at + 1)) };
}

function cmdSet(rest, { cfg, home, env, spawn, platform, configPath, out: write, err: writeErr }) {
  const offFlags = flagValues("off", rest);
  if (!offFlags.length) {
    writeErr('swarm mcp set: needs --off <a,b> — pass --off "" to turn every server back on.');
    return 1;
  }
  const repos = [];
  for (const raw of flagValues("repo", rest)) {
    const repo = parseRepoFlag(raw);
    if (!repo || !repo.name) {
      writeErr(`swarm mcp set: --repo wants <repo>=<servers> — e.g. --repo "rts-mobile=blender"; got '${raw}'`);
      return 1;
    }
    repos.push(repo);
  }
  // Two flags for one repo: the last answer wins rather than both being merged. The
  // last `--off` wins the same way.
  const lastByRepo = [...new Map(repos.map((r) => [r.name.toLowerCase(), r])).values()];
  const off = splitNames(offFlags[offFlags.length - 1]);

  let written;
  try {
    written = updateUserConfig((next) => cleanMcpConfig(next, { off, repos: lastByRepo }), configPath, env);
  } catch (e) {
    writeErr(`swarm: ${e.message}`);
    return 1;
  }

  const shape = {};
  if (written.config.mcp) shape.mcp = written.config.mcp;
  if (written.config.projects) shape.projects = written.config.projects;
  write(`config: ${written.path}`);
  write(JSON.stringify(shape, null, 2));

  // The full roster makes "what its leaves start" answerable; without it the table
  // still names what each repo turns back on, and says why the rest is missing.
  const listed = runListing(cfg, { spawn, env, platform });
  const roster = listed.ok ? mcpReport(cfg, home, listed.text).servers.map((s) => s.name) : null;
  const started = (on) => (roster ? roster.filter((name) => !off.includes(name) || on.includes(name)) : null);
  const rows = lastByRepo.map((repo) => ({ label: repo.name, on: repoOnFor(written.config, repo.name) }));
  const width = Math.max(16, ...rows.map((r) => r.label.length));
  const cell = (on) => {
    const names = started(on);
    if (names) return names.join(", ") || "(none)";
    return on.length ? `turns back on ${on.join(", ")}` : "defaults only";
  };
  write("leaf MCP servers:");
  for (const row of rows) write(`  ${row.label.padEnd(width)}  ${cell(row.on)}`);
  write(`  ${"every other repo".padEnd(width)}  ${cell([])}`);
  if (!listed.ok) write(`  (claude mcp list failed — ${listed.reason} — so only what each repo turns back on is listed.)`);
  return 0;
}

export function cmdMcp(rest = [], options = {}) {
  const env = options.env ?? process.env;
  const ctx = {
    cfg: options.cfg ?? getConfig(),
    home: options.home ?? swarmHome(env),
    env,
    spawn: options.spawn ?? nodeSpawnSync,
    platform: options.platform ?? process.platform,
    configPath: options.configPath ?? env.SWARM_CONFIG,
    out: options.out ?? stdout,
    err: options.err ?? stderr,
  };
  const [sub, ...tail] = rest;
  if (sub === "list") return cmdList(tail, ctx);
  if (sub === "set") return cmdSet(tail, ctx);
  if (options.usage) ctx.err(options.usage);
  else ctx.err('swarm mcp: subcommands are `list [--json]` and `set --off <a,b> [--repo <repo>=<servers>]…`');
  return 1;
}
