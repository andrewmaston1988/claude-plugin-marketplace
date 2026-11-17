// The ownership half of the reaper: verdicts, the sweep and the pre-scan. The
// process-facing side (kills, listings, start queries) lives in reaper-process.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  OWNER_FILE,
  PROFILE_PREFIX,
  isUiProbeProfile,
  ownerStartMs,
  preScanProfiles,
  readOwnerFile,
  reapOrphans,
  sweepProfiles,
  writeOwnerFile,
} from "../src/reaper.mjs";
import { OLD, aged, cmdFor, profileFolder, recorder, tempRoot } from "./reaper-support.mjs";

// --- row 3: ownership verdicts ------------------------------------------------

test("row 3: a browser whose owner is dead is stopped", async (t) => {
  const dir = tempRoot(t);
  const profile = profileFolder(dir, "dead");
  writeOwnerFile(profile, { pid: 9001, startMs: 1_000 });
  const kill = recorder();
  const result = await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [{ pid: 4001, cmd: cmdFor(profile) }],
    kill,
    isAlive: () => false,
  });
  assert.deepEqual(kill.calls, [{ pids: [4001], options: { platform: process.platform, timeoutMs: 5000 } }]);
  assert.deepEqual(result.killed, [4001]);
});

test("row 3: a live owner with its recorded start time is left alone", async (t) => {
  const dir = tempRoot(t);
  const profile = profileFolder(dir, "live");
  const ownerPid = 9001;
  writeOwnerFile(profile, { pid: ownerPid, startMs: 1_000_000 });
  aged(profile); // force the pre-scan to consult the lister
  const kill = recorder();
  const result = await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [{ pid: 4001, cmd: cmdFor(profile, "chrome.exe") }],
    kill,
    isAlive: (pid) => pid === ownerPid,
    queryStarts: async () => new Map([[ownerPid, 1_000_000]]),
  });
  assert.deepEqual(kill.calls, []);
  assert.deepEqual(result.killed, []);
  assert.ok(existsSync(profile), "a held old profile is not swept");
});

test("row 3: a clock step that moves the recorded start forward keeps a live owner alive", async (t) => {
  const dir = tempRoot(t);
  const profile = profileFolder(dir, "clock-step");
  // Recorded 60 s later than the OS says: a clock step, not a reused PID.
  writeOwnerFile(profile, { pid: 9001, startMs: 1_060_000 });
  aged(profile); // force the pre-scan to consult the lister
  const kill = recorder();
  const result = await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [{ pid: 4001, cmd: cmdFor(profile, "chrome.exe") }],
    kill,
    isAlive: () => true,
    queryStarts: async () => new Map([[9001, 1_000_000]]),
    queryStart: async () => 1_000_000,
  });
  assert.deepEqual(kill.calls, []);
  assert.deepEqual(result.killed, []);
});

test("row 3: a reused PID is stopped even though its owner looks alive", async (t) => {
  const dir = tempRoot(t);
  const profile = profileFolder(dir, "reused");
  writeOwnerFile(profile, { pid: 9001, startMs: 1_000_000 });
  const kill = recorder();
  await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [{ pid: 4001, cmd: cmdFor(profile, "chrome.exe") }],
    kill,
    isAlive: (pid) => pid === 9001,
    queryStarts: async () => new Map([[9001, 1_005_000]]), // 5 s apart
  });
  assert.deepEqual(kill.calls[0].pids, [4001]);
});

test("row 3: an unreadable start time is left alone, never killed on a guess", async (t) => {
  const dir = tempRoot(t);
  const profile = profileFolder(dir, "unknown");
  writeOwnerFile(profile, { pid: 9001, startMs: 1_000 });
  aged(profile);
  const kill = recorder();
  await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [{ pid: 4001, cmd: cmdFor(profile) }],
    kill,
    isAlive: () => true,
    queryStarts: async () => new Map([[9001, null]]),
  });
  assert.deepEqual(kill.calls, []);
});

test("row 3: an ownerless browser is stopped only past the grace", async (t) => {
  const dir = tempRoot(t);
  const oldProfile = profileFolder(dir, "ownerless-old");
  const youngProfile = profileFolder(dir, "ownerless-young");
  const kill = recorder();
  await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [
      { pid: 4001, cmd: cmdFor(oldProfile) },
      { pid: 4002, cmd: cmdFor(youngProfile) },
    ],
    kill,
    isAlive: () => false,
    queryStarts: async (pids) => new Map(pids.map((pid) => [pid, pid === 4001 ? Date.now() - OLD : Date.now() - 60_000])),
  });
  assert.deepEqual(kill.calls[0].pids, [4001]);
});

test("row 3: an unparseable owner reads as absent and follows the grace", async (t) => {
  const dir = tempRoot(t);
  const profile = profileFolder(dir, "torn-owner");
  writeFileSync(join(profile, OWNER_FILE), "{not json");
  const kill = recorder();
  await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [{ pid: 4001, cmd: cmdFor(profile, "brave.exe") }],
    kill,
    isAlive: () => true,
    queryStarts: async () => new Map([[4001, Date.now() - OLD]]),
  });
  assert.deepEqual(kill.calls[0].pids, [4001]);
});

test("row 3: a renderer child is never the PID that is stopped", async (t) => {
  const dir = tempRoot(t);
  const profile = profileFolder(dir, "renderer");
  writeOwnerFile(profile, { pid: 9001, startMs: 1_000 });
  const kill = recorder();
  await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [
      { pid: 4001, cmd: cmdFor(profile) },
      { pid: 4002, cmd: `${cmdFor(profile)} --type=renderer` },
    ],
    kill,
    isAlive: () => false,
  });
  assert.deepEqual(kill.calls[0].pids, [4001]);
});

// --- rows 4, 5: foreign profiles and the sweep --------------------------------

test("row 4: a profile outside tmpDir is never touched, whatever its name", async (t) => {
  const dir = tempRoot(t);
  const decoy = profileFolder(dir, "decoy");
  writeOwnerFile(decoy, { pid: 9001, startMs: 1_000 }); // dead: the pre-scan must not skip
  const foreign = join(tmpdir(), "..", `${PROFILE_PREFIX}foreign`);
  const operatorProfile = join(tmpdir(), "Google", "Chrome", "User Data");
  const kill = recorder();
  await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [
      { pid: 5001, cmd: cmdFor(foreign) },
      { pid: 5002, cmd: `chrome.exe --user-data-dir="${operatorProfile}"` },
      { pid: 5003, cmd: `chrome.exe --user-data-dir="${join(dir, "not-a-probe")}"` },
    ],
    kill,
    isAlive: () => false,
  });
  assert.deepEqual(kill.calls, []);
});

test("row 5: the sweep removes old unheld profiles and keeps young and held ones", async (t) => {
  const dir = tempRoot(t);
  const old = profileFolder(dir, "old");
  const young = profileFolder(dir, "young");
  const held = profileFolder(dir, "held");
  aged(old);
  aged(held);
  const result = await sweepProfiles({ tmpDir: dir, liveProfiles: [held] });
  assert.deepEqual(result.removed, [old]);
  assert.equal(existsSync(old), false);
  assert.ok(existsSync(young));
  assert.ok(existsSync(held));
});

test("row 5: the sweep yields, so a launch's budget can bound it", async (t) => {
  const dir = tempRoot(t);
  const STALE = 30;
  const BLOCK_MS = 40;
  const BUDGET_MS = 500;
  for (let i = 0; i < STALE; i++) aged(profileFolder(dir, `stale-${i}`));
  // Each delete blocks the loop; only a yield between folders lets the launch's timer fire.
  const fs = {
    readdirSync,
    statSync,
    readFileSync,
    rmSync: (path, options) => {
      const end = Date.now() + BLOCK_MS;
      while (Date.now() < end) { /* a delete that holds the loop, like a large folder */ }
      rmSync(path, options);
    },
  };
  const reap = reapOrphans({ tmpDir: dir, fs, listProcesses: () => [], kill: recorder() });
  const winner = await Promise.race([
    reap.then(() => "reap"),
    new Promise((done) => setTimeout(() => done("budget"), BUDGET_MS)),
  ]);
  assert.equal(winner, "budget", "the reap yielded often enough for a launch's timer to fire");
  await reap;
});

test("row 5: a listing that failed or cannot be parsed skips the sweep", async (t) => {
  const dir = tempRoot(t);
  const held = profileFolder(dir, "held-on-failure");
  aged(held);
  const base = { tmpDir: dir, kill: recorder(), isAlive: () => false };
  for (const listProcesses of [() => { throw new Error("no process lister"); }, () => "not a list"]) {
    const result = await reapOrphans({ ...base, listProcesses });
    assert.equal(result.skipped, "listing-failed");
    assert.ok(existsSync(held), "a held profile survives a listing that could not answer");
  }
});

test("row 5: a browser that survived the stop keeps its profile from the sweep", async (t) => {
  const dir = tempRoot(t);
  const profile = profileFolder(dir, "survivor");
  writeOwnerFile(profile, { pid: 9001, startMs: 1_000 });
  aged(profile); // after the owner file, which would otherwise refresh the folder's mtime
  const result = await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [{ pid: 4001, cmd: cmdFor(profile) }],
    kill: () => ({ killed: [], failed: [4001] }),
    isAlive: () => false,
  });
  assert.deepEqual(result.killed, []);
  assert.deepEqual(result.failed, [4001]);
  assert.ok(existsSync(profile), "a browser reported as a survivor still holds its folder");
});

// --- row 9: the pre-scan ------------------------------------------------------

test("row 9: a clean pre-scan never reaches the lister", async (t) => {
  const owned = tempRoot(t);
  const profile = profileFolder(owned, "owned");
  writeOwnerFile(profile, { pid: 9001, startMs: 1_000 });
  const empty = tempRoot(t);
  let listed = 0;
  const base = {
    listProcesses: () => { listed += 1; return []; },
    kill: recorder(),
    isAlive: (pid) => pid === 9001,
    queryStarts: async () => new Map([[9001, 1_000]]),
  };
  assert.equal((await reapOrphans({ ...base, tmpDir: owned })).skipped, "prescan");
  assert.equal((await reapOrphans({ ...base, tmpDir: empty })).skipped, "prescan");
  assert.equal(listed, 0);
  const prescan = { isAlive: (pid) => pid === 9001, queryStarts: async () => new Map([[9001, 1_000]]) };
  assert.equal((await preScanProfiles({ tmpDir: owned, ...prescan })).reason, "owned");
  assert.equal((await preScanProfiles({ tmpDir: empty, ...prescan })).reason, "clean");
});

test("row 9: the caller's own owner file is read locally, with no process spawn", async (t) => {
  const dir = tempRoot(t);
  const profile = profileFolder(dir, "self");
  writeOwnerFile(profile, { pid: process.pid, startMs: ownerStartMs() });
  let queried = 0;
  const result = await preScanProfiles({
    tmpDir: dir,
    queryStarts: async () => { queried += 1; return new Map(); },
  });
  assert.equal(result.reason, "owned");
  assert.equal(queried, 0, "our own pid's start time is already known");
});

test("row 9: every live owner's start time comes from one query", async (t) => {
  const dir = tempRoot(t);
  const owners = [9101, 9102, 9103];
  owners.forEach((pid, i) => writeOwnerFile(profileFolder(dir, `owner-${i}`), { pid, startMs: 5_000 }));
  const calls = [];
  const result = await preScanProfiles({
    tmpDir: dir,
    isAlive: () => true,
    queryStarts: async (pids) => {
      calls.push(pids);
      return new Map(pids.map((pid) => [pid, 5_000]));
    },
  });
  assert.equal(result.reason, "owned");
  assert.equal(calls.length, 1, "one query, not one spawn per owner");
  assert.deepEqual([...calls[0]].sort((a, b) => a - b), owners);
});

test("row 9: one stale folder opens the gate to the lister", async (t) => {
  const dir = tempRoot(t);
  const profile = profileFolder(dir, "stale");
  writeOwnerFile(profile, { pid: 9001, startMs: 1_000 });
  aged(profile);
  let listed = 0;
  await reapOrphans({
    tmpDir: dir,
    listProcesses: () => { listed += 1; return []; },
    kill: recorder(),
    isAlive: () => true,
    queryStarts: async () => new Map([[9001, 1_000]]),
  });
  assert.equal(listed, 1);
});

// --- row 3: the verdict pass's own seam ---------------------------------------

test("row 3: the reap path needs no start query for our own owner", async (t) => {
  const dir = tempRoot(t);
  const own = profileFolder(dir, "self");
  writeOwnerFile(own, { pid: process.pid, startMs: ownerStartMs() });
  // A dead owner opens the pre-scan gate without touching our own profile's verdict.
  writeOwnerFile(profileFolder(dir, "dead-elsewhere"), { pid: 9001, startMs: 1_000 });
  const perPid = [];
  const batched = [];
  const kill = recorder();
  await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [{ pid: 4001, cmd: cmdFor(own) }],
    kill,
    isAlive: (pid) => pid === process.pid,
    queryStart: async (pid) => { perPid.push(pid); return ownerStartMs(); },
    queryStarts: async (pids) => {
      batched.push(...pids);
      return new Map(pids.map((pid) => [pid, 1_000]));
    },
  });
  assert.deepEqual(perPid, [], "no start is resolved one PID at a time");
  assert.deepEqual(batched, [], "our own start time is already known");
  assert.deepEqual(kill.calls, []);
});

test("row 3: the verdict pass resolves every candidate's start in one query", async (t) => {
  const dir = tempRoot(t);
  const ownerPids = [9201, 9202, 9203];
  const processes = [];
  ownerPids.forEach((pid, i) => {
    const profile = profileFolder(dir, `live-${i}`);
    writeOwnerFile(profile, { pid, startMs: 1_000 });
    processes.push({ pid: 4100 + i, cmd: cmdFor(profile) });
  });
  // The ownerless folder opens the pre-scan gate without a query of its own.
  processes.push({ pid: 4200, cmd: cmdFor(profileFolder(dir, "ownerless")) });
  const queries = [];
  const kill = recorder();
  await reapOrphans({
    tmpDir: dir,
    listProcesses: () => processes,
    kill,
    isAlive: () => true,
    queryStarts: async (pids) => {
      queries.push([...pids].sort((a, b) => a - b));
      return new Map(pids.map((pid) => [pid, ownerPids.includes(pid) ? 1_000 : Date.now() - OLD]));
    },
  });
  assert.equal(queries.length, 1, "one query, not one spawn per candidate");
  assert.deepEqual(queries[0], [...ownerPids, 4200].sort((a, b) => a - b));
  assert.deepEqual(kill.calls[0].pids, [4200]);
});

// --- owner file helpers -------------------------------------------------------

test("the owner file is written to a temp name, renamed, and reads back", (t) => {
  const profile = profileFolder(tempRoot(t), "owner");
  assert.equal(readOwnerFile(profile), null);
  const file = writeOwnerFile(profile, { pid: 4242, startMs: 1234 });
  assert.deepEqual(readOwnerFile(profile), { pid: 4242, startMs: 1234 });
  assert.equal(existsSync(`${file}.tmp`), false);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { pid: 4242, startMs: 1234 });
  const ops = [];
  writeOwnerFile(profile, {
    pid: 1,
    startMs: 2,
    fs: {
      writeFileSync: (path) => ops.push(["write", path]),
      renameSync: (from, to) => ops.push(["rename", from, to]),
    },
  });
  assert.deepEqual(ops.map(([op]) => op), ["write", "rename"]);
  assert.ok(ops[0][1].endsWith(".tmp") && ops[1][2].endsWith(OWNER_FILE));
});

test("a missing or malformed owner file reads as no owner", (t) => {
  const profile = profileFolder(tempRoot(t), "malformed");
  assert.equal(readOwnerFile(profile), null);
  for (const body of ["{not json", JSON.stringify({ pid: "x", startMs: 1 }), JSON.stringify({ pid: 5 })]) {
    writeFileSync(join(profile, OWNER_FILE), body);
    assert.equal(readOwnerFile(profile), null);
  }
  assert.equal(ownerStartMs(10_000, 2.4), 7_600);
});

test("only a direct child of tmpDir named with our prefix is our profile", (t) => {
  const dir = tempRoot(t);
  assert.equal(isUiProbeProfile(join(dir, `${PROFILE_PREFIX}a`), { tmpDir: dir }), true);
  assert.equal(isUiProbeProfile(join(dir, "other"), { tmpDir: dir }), false);
  assert.equal(isUiProbeProfile(join(dir, "nested", `${PROFILE_PREFIX}a`), { tmpDir: dir }), false);
  assert.equal(isUiProbeProfile(`${dir}${sep}..${sep}${PROFILE_PREFIX}escape`, { tmpDir: dir }), false);
  assert.equal(isUiProbeProfile(join(tmpdir(), "..", `${PROFILE_PREFIX}a`), { tmpDir: dir }), false);
  assert.equal(isUiProbeProfile("", { tmpDir: dir }), false);
});
