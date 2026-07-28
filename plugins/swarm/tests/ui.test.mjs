import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { createSnapshotWriter, repaintsInPlace, liveViewLines } from "../src/ui.mjs";

// Every case names its env explicitly: the suite itself may be running inside a
// repainting harness, and an inherited CLAUDECODE would decide these for us.
const BARE = {};

test("snapshot writer on a TTY: erases the previous block before repainting", () => {
  const chunks = [];
  const snap = createSnapshotWriter({ write: (s) => chunks.push(s), isTTY: true, env: BARE });
  snap("line1\nline2");
  snap("line1\nline2\nline3");
  ok(!chunks[0].includes("\x1b["), "first paint has nothing to erase");
  ok(chunks[1].startsWith("\x1b[2A\x1b[0J"), `second paint must cursor-up 2 and clear: ${JSON.stringify(chunks[1])}`);
  ok(chunks[1].endsWith("line3\n"));
});

// An appending destination renders only the TAIL of a captured run, so every
// blank line the writer emits costs a row of that view. Snapshots abut directly.
test("snapshot writer piped: plain blocks with no blank-line padding, no ANSI", () => {
  const chunks = [];
  const snap = createSnapshotWriter({ write: (s) => chunks.push(s), isTTY: false, env: BARE });
  snap("a\nb");
  snap("c");
  equal(chunks[0], "a\nb\n");
  equal(chunks[1], "c\n");
  ok(!chunks.join("").includes("\x1b["));
  ok(!chunks.join("").includes("\n\n"), "no blank line may separate piped snapshots");
});

// The duplication this fixes: piped-and-appending under Claude Code stacked a
// fresh roster once a second, and the harness live view — a fixed line window —
// showed the tail of the previous block above the current one.
test("snapshot writer under the Claude Code harness: repaints despite the pipe", () => {
  const chunks = [];
  const env = { CLAUDECODE: "1", SWARM_WINDOW_LINES: "2" }; // no filler, isolate the erase
  const snap = createSnapshotWriter({ write: (s) => chunks.push(s), isTTY: false, env });
  snap("x\ny");
  snap("x\nz");
  ok(chunks[1].startsWith("\x1b[2A\x1b[0J"), `harness paint must erase: ${JSON.stringify(chunks[1])}`);
});

// A short block leaves rows above it in the fixed window, and those rows are
// frozen — the erase only rewrites the block's own lines. Filling the window
// evicts them; the filler goes BELOW so the roster stays at the top.
test("snapshot writer under the harness: fills the window, filler below the block", () => {
  const chunks = [];
  const env = { CLAUDECODE: "1", SWARM_WINDOW_LINES: "9" };
  const snap = createSnapshotWriter({ write: (s) => chunks.push(s), isTTY: false, env });
  snap("a\nb\nc");
  equal(chunks[0], "a\nb\nc" + "\n".repeat(7), `block first, then filler: ${JSON.stringify(chunks[0])}`);
  snap("d\ne\nf");
  ok(chunks[1].startsWith("\x1b[9A\x1b[0J"), `erase must match the FILLED height: ${JSON.stringify(chunks[1])}`);
  // net growth of zero is what stops the window scrolling
  equal(chunks[1].replace(/^\x1b\[\d+A\x1b\[0J/, "").split("\n").length - 1, 9);
});

test("snapshot writer under the harness: a block at or over the window is untouched", () => {
  const chunks = [];
  const env = { CLAUDECODE: "1", SWARM_WINDOW_LINES: "4" };
  const snap = createSnapshotWriter({ write: (s) => chunks.push(s), isTTY: false, env });
  const tall = ["1", "2", "3", "4", "5", "6"].join("\n");
  snap(tall);
  equal(chunks[0], tall + "\n");
});

// A real terminal scrolls, so filler there is pure noise.
test("snapshot writer on a TTY: never filled", () => {
  const chunks = [];
  const snap = createSnapshotWriter({ write: (s) => chunks.push(s), isTTY: true, env: { CLAUDECODE: "1" } });
  snap("a\nb");
  equal(chunks[0], "a\nb\n");
});

test("liveViewLines: a budget only where the view is a fixed window", () => {
  equal(liveViewLines({ isTTY: false, env: { CLAUDECODE: "1" } }), 9, "the harness clips, so it gets a budget");
  equal(liveViewLines({ isTTY: true, env: { CLAUDECODE: "1" } }), null, "a TTY scrolls, so it needs none");
  equal(liveViewLines({ isTTY: false, env: BARE }), null, "a plain pipe appends, so it needs none");
  equal(liveViewLines({ isTTY: false, env: { CLAUDECODE: "1", SWARM_WINDOW_LINES: "20" } }), 20, "tunable");
});

test("repaintsInPlace: SWARM_REPAINT overrides both ways", () => {
  equal(repaintsInPlace({ isTTY: true, env: { SWARM_REPAINT: "0" } }), false, "0 forces append on a TTY");
  equal(repaintsInPlace({ isTTY: false, env: { SWARM_REPAINT: "1" } }), true, "1 forces repaint on a pipe");
  equal(repaintsInPlace({ isTTY: false, env: { SWARM_REPAINT: "0", CLAUDECODE: "1" } }), false, "0 beats CLAUDECODE");
  equal(repaintsInPlace({ isTTY: false, env: BARE }), false, "bare pipe appends");
});
