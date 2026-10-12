// The `treeRoot` config key: shipped once, defaulted in code (it is
// machine-relative, so the shipped file cannot carry a real path), and refused
// when a user hands it a relative one.
import { test } from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, initConfig, setConfigValue, swarmHome } from "../src/config.mjs";
import { treeRootFor } from "../src/worktree.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-cfg-tree-"));
}

test("the shipped config.default.json carries the treeRoot key", () => {
  const shipped = JSON.parse(readFileSync(fileURLToPath(new URL("../config.default.json", import.meta.url)), "utf8"));
  ok(Object.hasOwn(shipped, "treeRoot"),
    "a key the operator can only learn about from the source is a key they will never set");
  equal(shipped.treeRoot, null,
    "null means 'default', because the real value is <swarmHome>/worktrees and the shipped file is shared by every machine");
});

test("an unset treeRoot resolves to <swarmHome>/worktrees", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({}));
    const cfg = loadConfig(join(dir, "config.json"));
    equal(treeRootFor(cfg), resolve(join(swarmHome(), "worktrees")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("config init materialises treeRoot so the key is visible in the operator's own file", () => {
  const dir = tmp();
  try {
    const r = initConfig(join(dir, "config.json"));
    ok(r.added.includes("treeRoot"));
    equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).treeRoot, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a relative treeRoot is refused — it would resolve against whatever cwd launched swarm", () => {
  const dir = tmp();
  try {
    const path = join(dir, "config.json");
    throws(() => setConfigValue("treeRoot", "worktrees", path), /absolute path/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an absolute treeRoot is accepted and read back", () => {
  const dir = tmp();
  const root = mkdtempSync(join(tmpdir(), "swarm-trees-cfg-"));
  try {
    const path = join(dir, "config.json");
    const r = setConfigValue("treeRoot", root.replace(/\\/g, "/"), path);
    equal(r.changed, true);
    equal(treeRootFor(loadConfig(path)), resolve(root));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
