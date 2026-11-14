// `swarm mcp list|set` and the two helpers it reads: the `claude mcp list` parser
// and the minimal config the setter writes. Every spawn and every home is a fake —
// nothing here reads or writes the real ~/.swarm or ~/.claude.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanMcpConfig, parseMcpList } from "../src/leaf-mcp.mjs";
import { runsKeyFor } from "../src/config.mjs";
import { cmdMcp } from "../scripts/cmd-mcp.mjs";

const SLACK = "plugin:slack-bridge:slack-bridge-remote";

// The shape `claude mcp list` prints, trimmed to the four servers in play.
const LISTING = [
  "Checking MCP server health…",
  "",
  `${SLACK}: node /opt/mcp/claude-slack.mjs remote-mcp - ✔ Connected`,
  "context7: https://mcp.context7.com/mcp (HTTP) - ✔ Connected",
  "scout: http://localhost:8765/mcp (HTTP) - ✔ Connected",
  "blender: /opt/mcp/uvx mcp-for-blender - ✔ Connected",
  "",
].join("\n");

function fakeSpawn({ listing = LISTING, status = 0, stderr = "" } = {}) {
  const calls = [];
  const fn = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    // `where` failing leaves the name as-is, which spawns the same on both hosts.
    if (cmd === "where") return { status: 1, stdout: "", stderr: "" };
    return { status, stdout: listing, stderr };
  };
  fn.calls = calls;
  return fn;
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "swarm-cmd-mcp-"));
  return {
    root,
    home: join(root, "home"),
    configPath: join(root, "config.json"),
    capture() {
      const lines = [];
      return { lines, out: (line) => lines.push(String(line)), err: (line) => lines.push(String(line)), text: () => lines.join("\n") };
    },
    done() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("parseMcpList: the four listing lines parse and the health-check header is skipped", () => {
  const servers = parseMcpList(LISTING);
  deepEqual(servers.map((s) => s.name), [SLACK, "context7", "scout", "blender"]);
  deepEqual(servers[0], {
    name: SLACK,
    target: "node /opt/mcp/claude-slack.mjs remote-mcp",
    status: "✔ Connected",
  });
  equal(servers[3].target, "/opt/mcp/uvx mcp-for-blender");
  deepEqual(parseMcpList(""), []);
});

test("cleanMcpConfig: on names not off are dropped; a repo not passed loses on but keeps hooks; emptied mcp and entries go", () => {
  const raw = {
    projects: [
      { name: "rts-mobile", mcp: { on: ["blender", "context7"] } },
      { name: "primordial", hooks: { preToolUse: "node guard.mjs" }, mcp: { on: ["blender"] } },
      { name: "gone-repo", mcp: { on: ["scout"] } },
    ],
    mcp: { off: ["blender"] },
  };
  const next = cleanMcpConfig(raw, { off: ["blender"], repos: [{ name: "rts-mobile", on: ["blender"] }] });
  deepEqual(next.projects, [
    { name: "rts-mobile", mcp: { on: ["blender"] } },
    { name: "primordial", hooks: { preToolUse: "node guard.mjs" } },
  ]);
  deepEqual(next.mcp, { off: ["blender"] });
  // The input is the caller's config; the writer must never mutate it.
  deepEqual(raw.projects[1].mcp, { on: ["blender"] });
});

test("cleanMcpConfig: removes the top-level mcp when nothing is off", () => {
  const next = cleanMcpConfig({ mcp: { off: ["blender"] }, projects: [{ name: "rts-mobile", mcp: { on: ["blender"] } }] }, {
    off: [],
    repos: [{ name: "rts-mobile", on: ["blender"] }],
  });
  equal(Object.hasOwn(next, "mcp"), false);
  // An entry narrowed to its bare name carries nothing: it goes too.
  deepEqual(next.projects, []);
});

test("swarm mcp set: two --repo flags both land, 'blender,' is one name and an empty --off removes mcp", () => {
  const box = sandbox();
  try {
    mkdirSync(box.root, { recursive: true });
    writeFileSync(box.configPath, JSON.stringify({ projects: [{ name: "rts-mobile", hooks: { preToolUse: "cmd" } }] }));
    const sink = box.capture();
    const options = { cfg: { claudePath: "claude" }, configPath: box.configPath, home: box.home, spawn: fakeSpawn(), out: sink.out, err: sink.err };

    equal(cmdMcp(["set", "--off", "blender,", "--repo", "rts-mobile=blender", "--repo", "rts-desktop=blender"], options), 0, sink.text());
    const first = JSON.parse(readFileSync(box.configPath, "utf8"));
    deepEqual(first.mcp, { off: ["blender"] });
    deepEqual(first.projects, [
      { name: "rts-mobile", hooks: { preToolUse: "cmd" }, mcp: { on: ["blender"] } },
      { name: "rts-desktop", mcp: { on: ["blender"] } },
    ]);
    ok(sink.text().includes("rts-mobile"), sink.text());
    ok(sink.text().includes("context7, scout, blender"), sink.text());
    ok(sink.text().includes("every other repo"), sink.text());

    equal(cmdMcp(["set", "--off", ""], options), 0, sink.text());
    const second = JSON.parse(readFileSync(box.configPath, "utf8"));
    equal(Object.hasOwn(second, "mcp"), false);
    deepEqual(second.projects, [{ name: "rts-mobile", hooks: { preToolUse: "cmd" } }]);
  } finally {
    box.done();
  }
});

test("swarm mcp set: writes only the keys it changes and a second identical run is byte-identical", () => {
  const box = sandbox();
  try {
    mkdirSync(box.root, { recursive: true });
    writeFileSync(box.configPath, JSON.stringify({ providers: { claude: { enabled: true } } }, null, 2) + "\n");
    const sink = box.capture();
    const options = { cfg: {}, configPath: box.configPath, home: box.home, spawn: fakeSpawn(), out: sink.out, err: sink.err };

    equal(cmdMcp(["set", "--off", "blender", "--repo", "rts-mobile=blender"], options), 0, sink.text());
    const once = readFileSync(box.configPath, "utf8");
    const written = JSON.parse(once);
    equal(Object.hasOwn(written, "timeoutMs"), false, "a shipped default must not be baked into the operator's file");
    equal(Object.hasOwn(written, "concurrency"), false, "a shipped default must not be baked into the operator's file");
    deepEqual(Object.keys(written).sort(), ["mcp", "projects", "providers"]);

    equal(cmdMcp(["set", "--off", "blender", "--repo", "rts-mobile=blender"], options), 0, sink.text());
    equal(readFileSync(box.configPath, "utf8"), once);
  } finally {
    box.done();
  }
});

test("swarm mcp set: a failed write leaves the original config intact", () => {
  const box = sandbox();
  try {
    mkdirSync(box.root, { recursive: true });
    const original = JSON.stringify({ providers: { claude: { enabled: true } } }, null, 2) + "\n";
    writeFileSync(box.configPath, original);
    // The temp path is unwritable, which stands in for a failed rename: either way the
    // original must survive untouched.
    mkdirSync(box.configPath + ".tmp");
    const sink = box.capture();
    const code = cmdMcp(["set", "--off", "blender"], {
      cfg: {}, configPath: box.configPath, home: box.home, spawn: fakeSpawn(), out: sink.out, err: sink.err,
    });
    equal(code, 1, sink.text());
    equal(readFileSync(box.configPath, "utf8"), original);
  } finally {
    box.done();
  }
});

test("swarm mcp list --json: a currently-off name the listing lacks is reported as not listed", () => {
  const box = sandbox();
  try {
    const sink = box.capture();
    const cfg = {
      mcp: { off: ["blender", SLACK] },
      projects: [{ name: "rts-mobile", mcp: { on: ["blender"] } }],
    };
    // The CLI stopped listing both servers; the off list still names them.
    const listing = "context7: https://mcp.context7.com/mcp (HTTP) - ✔ Connected\nscout: http://localhost:8765/mcp (HTTP) - ✔ Connected\n";
    const code = cmdMcp(["list", "--json"], { cfg, home: box.home, spawn: fakeSpawn({ listing }), out: sink.out, err: sink.err });
    equal(code, 0, sink.text());
    const report = JSON.parse(sink.text());
    const byName = Object.fromEntries(report.servers.map((s) => [s.name, s]));
    equal(byName.blender.off, true);
    equal(byName.blender.status, "not listed");
    deepEqual(byName.blender.onFor, ["rts-mobile"]);
    equal(byName[SLACK].status, "not listed");
    equal(byName[SLACK].off, true);
    equal(byName.context7.off, false);
    equal(byName.scout.target, "http://localhost:8765/mcp (HTTP)");
  } finally {
    box.done();
  }
});

test("swarm mcp list --json: repo candidates come from runsKeyFor matches, so a pruned-cwd repo still appears", () => {
  const box = sandbox();
  try {
    const reposRoot = join(box.root, "code");
    const repo = join(reposRoot, "rts-mobile");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(reposRoot, "never-ran", ".git"), { recursive: true });
    // A run directory with no manifest.json: every recorded cwd is a pruned tree,
    // and the forward key match is the only thing that can still name the repo.
    const runDir = join(box.home, "runs", runsKeyFor(repo), "ship-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.log"), "2026-11-14T00:00:00Z run-start\n");

    const sink = box.capture();
    const cfg = { allowedRoots: [reposRoot], mcp: { off: [] }, projects: [] };
    equal(cmdMcp(["list", "--json"], { cfg, home: box.home, spawn: fakeSpawn(), out: sink.out, err: sink.err }), 0, sink.text());
    const report = JSON.parse(sink.text());
    deepEqual(report.repos.map((r) => r.name), ["rts-mobile"]);
    ok(report.repos[0].lastRun, "a repo offered for per-repo setup carries when its leaves last ran");
  } finally {
    box.done();
  }
});

test("swarm mcp list --json: a configured project with no run directory survives 17 newer run repos", () => {
  const box = sandbox();
  try {
    const reposRoot = join(box.root, "code");
    const now = Date.now();
    for (let i = 0; i < 17; i++) {
      const repo = join(reposRoot, `repo-${String(i).padStart(2, "0")}`);
      mkdirSync(join(repo, ".git"), { recursive: true });
      const log = join(box.home, "runs", runsKeyFor(repo), "ship-1", "run.log");
      mkdirSync(join(log, ".."), { recursive: true });
      writeFileSync(log, "2026-11-14T00:00:00Z run-start\n");
      // Every run repo is newer than the configured project's absent run history.
      utimesSync(log, new Date(now - i * 60_000), new Date(now - i * 60_000));
    }

    const sink = box.capture();
    const cfg = { allowedRoots: [reposRoot], projects: [{ name: "zz-configured", mcp: { on: ["blender"] } }] };
    equal(cmdMcp(["list", "--json"], { cfg, home: box.home, spawn: fakeSpawn(), out: sink.out, err: sink.err }), 0, sink.text());
    const report = JSON.parse(sink.text());
    const configured = report.repos.find((r) => r.name === "zz-configured");
    ok(configured, `a configured project must stay listed whatever its run history: ${sink.text()}`);
    deepEqual(configured.on, ["blender"]);
  } finally {
    box.done();
  }
});

test("swarm mcp list --json: a server name in a project's on matches the listing exactly", () => {
  const box = sandbox();
  try {
    const sink = box.capture();
    const cfg = { mcp: { off: ["blender"] }, projects: [{ name: "rts-mobile", mcp: { on: ["Blender"] } }] };
    equal(cmdMcp(["list", "--json"], { cfg, home: box.home, spawn: fakeSpawn(), out: sink.out, err: sink.err }), 0, sink.text());
    const report = JSON.parse(sink.text());
    deepEqual(report.servers.find((s) => s.name === "blender").onFor, []);
  } finally {
    box.done();
  }
});

test("swarm mcp list: a failing listing exits 1 naming the command to run by hand", () => {
  const box = sandbox();
  try {
    const sink = box.capture();
    const code = cmdMcp(["list"], {
      cfg: {}, home: box.home, spawn: fakeSpawn({ status: 1, stderr: "boom" }), out: sink.out, err: sink.err,
    });
    equal(code, 1);
    ok(sink.text().includes("claude mcp list"), sink.text());
  } finally {
    box.done();
  }
});
