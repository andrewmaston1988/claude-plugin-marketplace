import { test } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../hooks/leaf-write-guard.mjs", import.meta.url));

// Drive the hook as Codex does: the payload on stdin, NO argv roots, the roots in
// SWARM_WRITE_GUARD_ROOTS. `envRoots: undefined` deletes the var, so a value in the
// test runner's own env can never decide a case.
function runHook(stdin, { envRoots, argv = [], cwd } = {}) {
  const env = { ...process.env };
  delete env.SWARM_WRITE_GUARD_ROOTS;
  if (envRoots !== undefined) env.SWARM_WRITE_GUARD_ROOTS = envRoots;
  const r = spawnSync(process.execPath, [HOOK, ...argv], { input: stdin, encoding: "utf8", env, ...(cwd && { cwd }) });
  equal(r.status, 0, `the hook must always exit 0 — stderr: ${r.stderr}`);
  return r.stdout.trim();
}

// The apply_patch payload shape: the patch in tool_input.command, targets relative
// to the payload's own cwd.
const patch = (cwd, ...lines) =>
  JSON.stringify({ tool_name: "apply_patch", tool_input: { command: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") }, cwd });
const write = (filePath) => JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath } });

function makeTree() {
  const base = mkdtempSync(join(tmpdir(), "swarm-cguard-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return { root, outside, clean: () => rmSync(base, { recursive: true, force: true }) };
}

const reasonOf = (out) => JSON.parse(out).hookSpecificOutput;
const escape = (s) => s.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&");

test("apply_patch: an Update File outside the env roots is denied; one inside is allowed", () => {
  const t = makeTree();
  try {
    const envRoots = JSON.stringify([t.root]);
    const out = runHook(patch(t.root, `*** Update File: ${join(t.outside, "evil.txt")}`, "@@", "-a", "+b"), { envRoots });
    ok(out, "an outside apply_patch must be denied");
    equal(reasonOf(out).permissionDecision, "deny");
    match(reasonOf(out).permissionDecisionReason, new RegExp(escape(join(t.outside, "evil.txt"))));
    equal(runHook(patch(t.root, "*** Update File: inside.txt", "@@", "-a", "+b"), { envRoots }), "");
  } finally {
    t.clean();
  }
});

test("apply_patch: every header counts — an outside Move to after an inside Update File is denied", () => {
  const t = makeTree();
  try {
    const envRoots = JSON.stringify([t.root]);
    const dest = join(t.outside, "moved.txt");
    const out = runHook(patch(t.root, "*** Add File: new.txt", "+hi", "*** Update File: inside.txt", `*** Move to: ${dest}`, "@@", "-a", "+b"), { envRoots });
    ok(out, "the outside Move to must be denied");
    equal(reasonOf(out).permissionDecision, "deny");
    match(reasonOf(out).permissionDecisionReason, new RegExp(escape(dest)));
    const del = runHook(patch(t.root, "*** Add File: new.txt", "+hi", `*** Delete File: ${join(t.outside, "gone.txt")}`), { envRoots });
    ok(del, "an outside Delete File must be denied");
    equal(reasonOf(del).permissionDecision, "deny");
    equal(runHook(patch(t.root, "*** Add File: a.txt", "+hi", "*** Update File: b.txt", "*** Move to: sub/c.txt", "*** Delete File: d.txt"), { envRoots }), "");
  } finally {
    t.clean();
  }
});

test("apply_patch: relative paths resolve against the payload cwd, not the hook's own cwd", () => {
  const t = makeTree();
  try {
    const envRoots = JSON.stringify([t.root]);
    // Payload cwd inside the root, hook process run from outside: allowed.
    equal(runHook(patch(t.root, "*** Add File: hello.txt", "+hi"), { envRoots, cwd: t.outside }), "");
    // Payload cwd outside the root, hook process run from inside: denied.
    const out = runHook(patch(t.outside, "*** Add File: hello.txt", "+hi"), { envRoots, cwd: t.root });
    ok(out, "a relative path under an outside payload cwd must be denied");
    equal(reasonOf(out).permissionDecision, "deny");
  } finally {
    t.clean();
  }
});

test("env roots confine a Write when argv carries none", () => {
  const t = makeTree();
  try {
    const out = runHook(write(join(t.outside, "evil.txt")), { envRoots: JSON.stringify([t.root]) });
    ok(out, "an outside Write must be denied under env roots");
    equal(reasonOf(out).permissionDecision, "deny");
  } finally {
    t.clean();
  }
});

test("argv roots win over env roots", () => {
  const t = makeTree();
  try {
    const out = runHook(write(join(t.outside, "evil.txt")), { argv: [t.root], envRoots: JSON.stringify([t.outside]) });
    ok(out, "the argv root must decide, not the env root");
    equal(reasonOf(out).permissionDecision, "deny");
  } finally {
    t.clean();
  }
});

test("no argv roots and SWARM_WRITE_GUARD_ROOTS unset, empty, unparseable or [] — fail open", () => {
  const t = makeTree();
  try {
    const outsideWrite = write(join(t.outside, "evil.txt"));
    const outsidePatch = patch(t.root, `*** Add File: ${join(t.outside, "evil.txt")}`, "+hi");
    for (const envRoots of [undefined, "", "not json", "[]", "{}", "[1]"]) {
      equal(runHook(outsideWrite, { envRoots }), "", `Write must fail open for env ${JSON.stringify(envRoots)}`);
      equal(runHook(outsidePatch, { envRoots }), "", `apply_patch must fail open for env ${JSON.stringify(envRoots)}`);
    }
  } finally {
    t.clean();
  }
});

test("hooks.json runs leaf-write-guard.mjs on a PreToolUse apply_patch entry, with no argv roots", () => {
  const hooks = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
  const entries = (hooks.hooks.PreToolUse || []).filter((e) => e.matcher === "apply_patch");
  equal(entries.length, 1, "one apply_patch PreToolUse entry");
  const commands = entries[0].hooks.map((h) => h.command);
  // A fixed command: Codex keys hook trust by the command's hash, so per-leaf roots
  // must arrive by env, never baked into argv.
  ok(
    commands.includes('node "${CLAUDE_PLUGIN_ROOT}/hooks/leaf-write-guard.mjs"'),
    `the apply_patch entry must run leaf-write-guard.mjs with no argv — got ${JSON.stringify(commands)}`,
  );
});
