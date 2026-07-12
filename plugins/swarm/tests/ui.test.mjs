import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { createSnapshotWriter } from "../src/ui.mjs";

test("snapshot writer on a TTY: erases the previous block before repainting", () => {
  const chunks = [];
  const snap = createSnapshotWriter({ write: (s) => chunks.push(s), isTTY: true });
  snap("line1\nline2");
  snap("line1\nline2\nline3");
  ok(!chunks[0].includes("\x1b["), "first paint has nothing to erase");
  ok(chunks[1].startsWith("\x1b[2A\x1b[0J"), `second paint must cursor-up 2 and clear: ${JSON.stringify(chunks[1])}`);
  ok(chunks[1].endsWith("line3\n"));
});

// The harness renders only the TAIL of a captured run, so every blank line the
// writer emits costs a row of the operator's live view. Snapshots abut directly.
test("snapshot writer piped: plain blocks with no blank-line padding, no ANSI", () => {
  const chunks = [];
  const snap = createSnapshotWriter({ write: (s) => chunks.push(s), isTTY: false });
  snap("a\nb");
  snap("c");
  equal(chunks[0], "a\nb\n");
  equal(chunks[1], "c\n");
  ok(!chunks.join("").includes("\x1b["));
  ok(!chunks.join("").includes("\n\n"), "no blank line may separate piped snapshots");
});
