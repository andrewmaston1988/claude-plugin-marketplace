// Child run by tests/no-network-guard.test.mjs: one test that reaches a vendor.
// The guard refuses the request and fails this file through its `after` hook, so
// the parent sees a non-zero exit whose output names the URL. The host never
// resolves, so a guard that let the fetch through still makes no real call.
import "../helpers/isolate-home.mjs";
import { test } from "node:test";

test("a non-loopback fetch is refused", async () => {
  await fetch("https://network-guard.invalid/pricing").catch(() => {});
});
