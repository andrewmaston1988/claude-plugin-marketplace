// Codex coverage: the shell shapes real gpt leaves emit — newline-joined statements,
// concatenated-segment payloads, `$root` + Join-Path, and over-cap multi-reads.
import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { computeCoverage, coverageRetryBlock } from "../src/coverage.mjs";
import { dbl, event, transcript, readsOf, PS_EXE, pwshRun } from "./helpers/codex-events.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/coverage/", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "swarm-codex-shapes-"));
const writeLines = (dir, name, n) => { const p = join(dir, name); writeFileSync(p, "x\n".repeat(n)); return p; };
// The real form: codex POSIX-quotes the argv, so a payload holding `$` arrives as
// concatenated `'…'` and `"…"` segments, with separators doubled inside `"…"`.
const rawPwsh = (arg) => `"${dbl(PS_EXE)}" -Command ${arg}`;
const OVER_CAP = "x\n".repeat(20_001); // 40,002 bytes
const UNVERIFIABLE = " (unverifiable: output past the 40000-byte codex cap — read one file per command)";

test("codex shapes: two windowed reads joined by a newline in one command cover both windows", () => {
  const dir = tmp();
  try {
    const A = join(dir, "a.mjs"), B = join(dir, "b.mjs");
    const payload = `@(Get-Content -LiteralPath '${dbl(A)}')[0..2]\n@(Get-Content -LiteralPath '${dbl(B)}')[0..1]`;
    deepEqual(readsOf(transcript(event(pwshRun(payload), { output: "x\n".repeat(5) })), dir),
      [{ file: A, offset: 1, limit: 3 }, { file: B, offset: 1, limit: 2 }]);
    const crlf = payload.replace("\n", "\r\n");
    deepEqual(readsOf(transcript(event(pwshRun(crlf), { output: "x\n".repeat(5) })), dir),
      [{ file: A, offset: 1, limit: 3 }, { file: B, offset: 1, limit: 2 }], "a preceding \\r goes with the newline");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex shapes (guard): a newline inside a quoted path does not split the statement", () => {
  const dir = tmp();
  try {
    const odd = join(dir, "line1\nline2.mjs");
    deepEqual(readsOf(transcript(event(pwshRun(`Get-Content -Raw '${odd}'`), { output: "x\n" })), dir),
      [{ file: odd, offset: 1, limit: 1 }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex shapes: a -Command argument in concatenated '…'\"…\" segments unwraps to the real payload", () => {
  const dir = tmp();
  try {
    const F = join(dir, "a.mjs");
    const reads = readsOf(transcript(event(rawPwsh(`'Get-Content -Raw '"'${dbl(F)}'"`), { output: "x\nx\n" })), dir);
    deepEqual(reads, [{ file: F, offset: 1, limit: 2 }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex shapes: an unterminated quote in the -Command argument credits nothing", () => {
  const dir = tmp();
  try {
    const F = join(dir, "a.mjs");
    deepEqual(readsOf(transcript(event(rawPwsh(`'Get-Content -Raw ${dbl(F)}`), { output: "x\n" })), dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex shapes (guard): a non-shell exe credits nothing, however its argument is quoted", () => {
  const dir = tmp();
  try {
    const F = join(dir, "a.mjs");
    const cmd = `"${dbl("C:\\tools\\fetch.exe")}" -c 'Get-Content -Raw '"'${dbl(F)}'"`;
    deepEqual(readsOf(transcript(event(cmd, { output: "x\n" })), dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex shapes: $root='<abs>' then Get-Content -Raw (Join-Path $root '<name>') covers <abs>/<name>", () => {
  const dir = tmp();
  try {
    const sep = dir.includes("\\") ? "\\" : "/";
    const arg = `'$root='"'${dbl(dir)}'; Get-Content -Raw (Join-Path "'$root '"'a.mjs'); Get-Content -Raw (Join-Path "'$root '"'b.mjs')"`;
    deepEqual(readsOf(transcript(event(rawPwsh(arg), { output: "x\nx\nx\n" })), dir),
      [{ file: `${dir}${sep}a.mjs`, offset: 1, limit: 3 }, { file: `${dir}${sep}b.mjs`, offset: 1, limit: 3 }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex shapes: an assignment AFTER the read does not resolve it", () => {
  const dir = tmp();
  try {
    const payload = `Get-Content -Raw (Join-Path $root 'a.mjs'); $root='${dbl(dir)}'`;
    deepEqual(readsOf(transcript(event(pwshRun(payload), { output: "x\n" })), dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex shapes: an unassigned or computed $p yields no read (never the junk path <cwd>/$p)", () => {
  const dir = tmp();
  try {
    deepEqual(readsOf(transcript(event(pwshRun("Get-Content -Raw $p"), { output: "x\n" })), dir), [], "unassigned");
    deepEqual(readsOf(transcript(event(pwshRun("$p = Get-Location; Get-Content -Raw $p"), { output: "x\n" })), dir), [], "computed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex shapes: an over-cap multi-read marks each path unverifiable, and every missed render says so", () => {
  const dir = tmp();
  try {
    const A = writeLines(dir, "a.mjs", 5), B = writeLines(dir, "b.mjs", 5);
    const payload = `Get-Content -Raw '${dbl(A)}'; Get-Content -Raw '${dbl(B)}'`;
    const reads = readsOf(transcript(event(pwshRun(payload), { output: OVER_CAP })), dir);
    deepEqual(reads, [{ file: A, unverifiable: true }, { file: B, unverifiable: true }]);
    const partial = [...reads, { file: A, offset: 1, limit: 2 }];
    const cov = computeCoverage([A, { path: B, lines: [[2, 3]] }], partial, { cwd: dir });
    deepEqual(cov.missed, [`${A}:3-5${UNVERIFIABLE}`, `${B}:2-3${UNVERIFIABLE}`]);
    deepEqual(computeCoverage([B], reads, { cwd: dir }).missed, [`${B}${UNVERIFIABLE}`], "nothing else read: the bare path");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex shapes: over cap, a lone read beside a non-read statement is unverifiable — its bytes may sit outside both halves", () => {
  const dir = tmp();
  try {
    const A = writeLines(dir, "a.mjs", 5);
    const piped = `Get-ChildItem C:\\ -Recurse | Select-Object -First 3000\nGet-Content -Raw '${dbl(A)}'`;
    deepEqual(readsOf(transcript(event(pwshRun(piped), { output: OVER_CAP })), dir), [{ file: A, unverifiable: true }], "newline + pipe");
    const chained = `Get-ChildItem C:\\ -Recurse | Select-Object -First 3000; Get-Content -Raw '${dbl(A)}'`;
    deepEqual(readsOf(transcript(event(pwshRun(chained), { output: OVER_CAP })), dir), [{ file: A, unverifiable: true }], "; + pipe");
    const plain = `Write-Output start; Get-Content -Raw '${dbl(A)}'`;
    deepEqual(readsOf(transcript(event(pwshRun(plain), { output: OVER_CAP })), dir), [{ file: A, unverifiable: true }], "unrecognised statement");
    const assigned = `$root='${dbl(dir)}'; Get-Content -Raw (Join-Path $root 'a.mjs')`;
    ok(!readsOf(transcript(event(pwshRun(assigned), { output: OVER_CAP })), dir)[0].unverifiable, "an assignment emits nothing: a lone read stays windowed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex shapes: computeCoverage — an unverifiable entry alone leaves the file incomplete, never a NaN-window complete", () => {
  const dir = tmp();
  try {
    const A = writeLines(dir, "a.mjs", 5);
    const cov = computeCoverage([A], [{ file: A, unverifiable: true }], { cwd: dir });
    equal(cov.status, "incomplete");
    equal(cov.read, 0);
    deepEqual(cov.gaps, [{ path: A, ranges: [[1, 5]] }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex shapes: the codex re-ask says one command per call", () => {
  const block = coverageRetryBlock([{ path: "/x/a.mjs", ranges: [[1, 3]] }], { runner: "codex", platform: "linux" });
  ok(block.includes("one command per call"), block);
  ok(!coverageRetryBlock([{ path: "/x/a.mjs", ranges: [[1, 3]] }], { runner: "claude" }).includes("one command per call"),
    "claude's Read is already one file per call");
});

test("codex shapes: the REAL rv-maintainability slice credits its $root shards and newline-joined windows", () => {
  const shards = "C:\\Users\\Andrew\\AppData\\Local\\Temp\\claude\\C--code-claude-plugin-marketplace\\820981ec-d49f-44af-8417-8c4b11abf226\\scratchpad\\mgs-review\\shards\\";
  const names = [
    "001-plugins_slack-bridge_CONFIG.md-e9a76746.diff",
    "002-plugins_slack-bridge_README.md-3cb278a1.diff",
    "003-plugins_slack-bridge_assets_slack-app-manifest.yaml-edf8f88e.diff",
    "004-plugins_slack-bridge_src_config.mjs-365d99b6.diff",
    "005-plugins_slack-bridge_src_core_claude-subprocess.mjs-46b6054d.diff",
    "006-plugins_slack-bridge_src_core_handler.mjs-141912ad.diff",
    "007-plugins_slack-bridge_src_core_session-value.mjs-9f04a917.diff",
    "008-plugins_slack-bridge_tests_fakes.mjs-10289e6d.diff",
    "009-plugins_slack-bridge_tests_handler.test.mjs-5eb9aa58.diff",
    "010-plugins_slack-bridge_tests_integration_dm-flow.test.mjs-085b2a94.diff",
  ];
  const text = readFileSync(join(FIXTURES, "rv-maintainability.codex.jsonl"), "utf8");
  const reads = readsOf(text, "C:/code/claude-plugin-marketplace");
  // item_7: five Join-Path shards, one 174-line output shared by all five.
  const joined = names.slice(0, 5).map((n) => ({ file: shards + n, offset: 1, limit: 174 }));
  // item_14 is piped through ForEach-Object: it credits nothing.
  // item_0: ten newline-joined windows, each inside the 614-line output.
  const ends = [54, 42, 17, 35, 16, 214, 40, 55, 61, 70];
  const windows = names.map((n, i) => ({ file: shards + n, offset: 1, limit: ends[i] + 1 }));
  deepEqual(reads, [...joined, ...windows]);
});
