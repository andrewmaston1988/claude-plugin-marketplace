import { test } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../hooks/leaf-write-guard.mjs", import.meta.url));

// Drive the hook the way Claude Code does — the PreToolUse payload on stdin, the
// allowed roots in argv — so the contract under test is the process boundary
// itself, not an exported helper that could pass while the entry point is broken.
// No leaf is spawned.
function runHook(roots, stdin, { cwd } = {}) {
  const r = spawnSync(process.execPath, [HOOK, ...roots], { input: stdin, encoding: "utf8", ...(cwd && { cwd }) });
  equal(r.status, 0, `the hook must always exit 0 — stderr: ${r.stderr}`);
  return r.stdout.trim();
}

const write = (filePath) => JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath } });

// A tree with an inside and an outside, so "under the root" is a real question
// rather than a string prefix.
function makeTree() {
  const base = mkdtempSync(join(tmpdir(), "swarm-wguard-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, "inside.txt"), "in");
  writeFileSync(join(outside, "evil.txt"), "out");
  return { base, root, outside, clean: () => rmSync(base, { recursive: true, force: true }) };
}

test("a path under the allowed root is allowed (empty stdout)", () => {
  const t = makeTree();
  try {
    equal(runHook([t.root], write(join(t.root, "inside.txt"))), "");
  } finally {
    t.clean();
  }
});

test("a path under a second allowed root is allowed", () => {
  const t = makeTree();
  try {
    equal(runHook([t.root, t.outside], write(join(t.outside, "evil.txt"))), "");
  } finally {
    t.clean();
  }
});

test("a relative path inside the root is allowed", () => {
  const t = makeTree();
  try {
    equal(runHook([t.root], write("inside.txt"), { cwd: t.root }), "");
  } finally {
    t.clean();
  }
});

test("an absolute path outside the root is denied, naming the path and the root", () => {
  const t = makeTree();
  try {
    const attempted = join(t.outside, "evil.txt");
    const out = JSON.parse(runHook([t.root], write(attempted)));
    equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
    equal(out.hookSpecificOutput.permissionDecision, "deny");
    // The reason is the only diagnostic the digest will carry, so both halves
    // must be in it.
    match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(attempted.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&")));
    match(out.hookSpecificOutput.permissionDecisionReason, /root/);
  } finally {
    t.clean();
  }
});

test("a '..' traversal that resolves outside the root is denied", () => {
  const t = makeTree();
  try {
    const traversal = join(t.root, "..", "outside", "evil.txt");
    const out = JSON.parse(runHook([t.root], write(traversal)));
    equal(out.hookSpecificOutput.permissionDecision, "deny");
  } finally {
    t.clean();
  }
});

test("a symlink pointing out of the root is denied", () => {
  const t = makeTree();
  try {
    const link = join(t.root, "escape");
    // A Windows directory junction needs no elevation; a POSIX symlink needs none
    // either. A file symlink on Windows would need SeCreateSymbolicLinkPrivilege.
    symlinkSync(t.outside, link, process.platform === "win32" ? "junction" : "dir");
    const attempted = join(link, "evil.txt");
    const out = JSON.parse(runHook([t.root], write(attempted)));
    equal(out.hookSpecificOutput.permissionDecision, "deny");
  } finally {
    t.clean();
  }
});

test("a malformed payload is ALLOWED — fail open, never brick the leaf", () => {
  const t = makeTree();
  try {
    equal(runHook([t.root], "not json {{{"), "");
    equal(runHook([t.root], ""), "");
    equal(runHook([t.root], JSON.stringify({ tool_name: "Write", tool_input: {} })), "");
    equal(runHook([t.root], JSON.stringify({ tool_name: "Write", tool_input: { file_path: 42 } })), "");
  } finally {
    t.clean();
  }
});

test("the hook is imported, not run: importing it must not read stdin", () => {
  // A hook that runs main() on import would hang or exit non-zero here.
  const r = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(new URL("../hooks/leaf-write-guard.mjs", import.meta.url).href)})`], {
    encoding: "utf8",
    timeout: 10000,
  });
  equal(r.status, 0, r.stderr);
  ok(!r.stdout.trim(), `an import must emit nothing, got: ${r.stdout}`);
});
