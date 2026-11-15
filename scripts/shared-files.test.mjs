// Files duplicated by copy rather than import must stay byte-identical: an
// install copies only a plugin's own directory, and this checkout has
// core.symlinks=false, so neither a cross-plugin import nor a symlink works.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// One source file followed by its copies.
const SHARED = [
  ["plugins/swarm/src/claude-catalog.mjs", "plugins/checkpoint/hooks/lib/claude-catalog.mjs"],
];

/** Byte offset of the first difference, or -1 when the bodies are equal. */
function firstDifference(a, b) {
  const end = Math.min(a.length, b.length);
  for (let i = 0; i < end; i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : end;
}

const lineAt = (body, offset) => body.subarray(0, offset).toString("utf8").split("\n").length;

test("each shared file group is byte-identical", () => {
  for (const [source, ...copies] of SHARED) {
    const original = readFileSync(join(ROOT, source));
    for (const copy of copies) {
      const body = readFileSync(join(ROOT, copy));
      const at = firstDifference(original, body);
      if (at === -1) continue;
      assert.fail(
        `shared files diverged: ${source} (line ${lineAt(original, at)}) vs `
          + `${copy} (line ${lineAt(body, at)}), first difference at byte ${at}`,
      );
    }
  }
});
