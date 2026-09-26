// roots.mjs is the one containment predicate every gate reads (governance, dispatch,
// ask, the leaf write guard). This is the shape a config entry can take that it got
// wrong: a root that IS the filesystem root.
import { test } from "node:test";
import { equal } from "node:assert/strict";
import { posix } from "node:path";
import { isUnderRoot } from "../src/roots.mjs";

// The posix filesystem root cannot be reproduced on win32 — resolve("/") there is the
// current drive root, and normalizeForCompare strips its trailing separator, so the
// broken branch is unreachable from a Windows runner. Injecting the posix module puts
// the predicate on the POSIX branch without a POSIX host.
const asPosix = { _path: posix };

test("isUnderRoot: a filesystem-root entry still matches its descendants", () => {
  equal(isUnderRoot("/tmp/leaf", "/", asPosix), true);
  // Controls, not pins: both hold with or without the root fix. The first line is the pin.
  equal(isUnderRoot("/", "/", asPosix), true);
  equal(isUnderRoot("/tmp", "/etc", asPosix), false);
});
