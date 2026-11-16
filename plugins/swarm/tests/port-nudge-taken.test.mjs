// Taken lanes in the port nudge: a lane ported into a branch that later landed. Row 1
// is the checkout the nudge measures from — a session whose cwd is another tree but
// whose command `cd`s into the porting one.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal } from "node:assert/strict";
import { resolve } from "node:path";
import { portingTree } from "../src/port-nudge.mjs";

test("row 1: portingTree follows one leading cd, then resolves -C against it", () => {
  // Roots built from a platform-absolute path: a literal "C:/work" is relative on
  // Linux, so the same rows would assert different things on each platform.
  const WORK = resolve("/work");
  const REPO = resolve("/x/my repo");
  const SHA = "a".repeat(40);

  // Quoted (either style) and bare, terminated by && or ;.
  equal(portingTree(`cd "${REPO}" && git cherry-pick ${SHA}`, WORK), REPO);
  equal(portingTree(`cd '${REPO}' && git commit -m x`, WORK), REPO);
  equal(portingTree("cd repo; git merge topic", WORK), resolve(WORK, "repo"));
  equal(portingTree("  cd repo && git merge topic", WORK), resolve(WORK, "repo"));

  // -C is resolved against the cd target, not the payload's cwd.
  equal(portingTree(`cd '${REPO}' && git -C sub commit`, WORK), resolve(REPO, "sub"));
  equal(portingTree("cd repo && git -C sub merge topic", WORK), resolve(WORK, "repo/sub"));

  // Two distinct -C paths leave no single tree: the cd target is the fallback.
  equal(portingTree(`cd "${REPO}" && git -C a commit && git -C b merge x`, WORK), REPO);

  // No leading cd: today's answer, which is the payload's cwd.
  equal(portingTree(`git -C "${REPO}" commit`, WORK), REPO);
  equal(portingTree("git commit -m x", WORK), WORK);

  // A cd mid-chain is not the shell's directory when the command started.
  equal(portingTree(`git status && cd "${REPO}" && git commit -m x`, WORK), WORK);
  equal(portingTree(`echo hi; cd "${REPO}" && git commit`, WORK), WORK);
});
