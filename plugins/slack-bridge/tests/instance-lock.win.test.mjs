// The Windows half of the instance lock: named-pipe naming, and the case folding
// that keeps two spellings of one stateDir from opening two pipes.
//
// Its own file so the diff-aware Windows run always exercises it, not only when
// something in instance-lock.test.mjs's closure changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lockPath } from "../src/instance-lock.mjs";

test("the Windows pipe name ignores case in the stateDir path",
  { skip: process.platform !== "win32" ? "windows pipe naming" : false }, () => {
    assert.equal(lockPath("C:\\Users\\X\\claude-slack"), lockPath("c:/users/x/CLAUDE-SLACK"));
    assert.match(lockPath("C:\\Users\\X\\claude-slack"), /^\\\\\.\\pipe\\claude-slack-[0-9a-f]{16}$/);
  });
