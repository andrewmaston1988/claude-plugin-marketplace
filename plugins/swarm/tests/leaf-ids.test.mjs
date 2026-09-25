import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { parseCloneId } from "../src/leaf-ids.mjs";

test("parseCloneId returns the parent and decimal index for clone ids", () => {
  deepEqual(parseCloneId("fix[12]"), { parent: "fix", index: "12" });
  equal(parseCloneId("fix[1]tail"), null);
  equal(parseCloneId("fix[x]"), null);
});
