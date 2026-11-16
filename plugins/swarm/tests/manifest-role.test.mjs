// `role: "verifier"` — the refusals the field carries, and the warning that catches
// the incident shape whose author never set the field.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { roleErrors, roleWarnings } from "../src/manifest-role.mjs";
import { validateTaskShapes } from "../src/manifest-task-shape.mjs";
import { validateTaskRelations } from "../src/manifest-relations.mjs";

const label = (t) => `task '${t.id}'`;
const task = (over = {}) => ({ id: "verify-x", prompt: "report", model: "claude-haiku-4-5-20251001", ...over });

test("row 1: a verifier holding Edit, Write or NotebookEdit is refused, naming the tool and the fix; Bash alone passes", () => {
  for (const [allowedTools, tool] of [
    ["Read,Edit,Bash", "Edit"],
    ["Read,Write", "Write"],
    ["Read,NotebookEdit", "NotebookEdit"],
  ]) {
    const errors = roleErrors([task({ role: "verifier", allowedTools })], label);
    equal(errors.length, 1, `${allowedTools}: ${errors.join("\n")}`);
    ok(errors[0].includes(tool), `the offending tool is named: ${errors[0]}`);
    ok(errors[0].includes("may not hold edit tools"), errors[0]);
    ok(errors[0].includes("Drop Edit/Write/NotebookEdit"), `the fix is spelled: ${errors[0]}`);
    ok(errors[0].includes("keep it and the verifier runs in its own tree"), errors[0]);
  }
  // The contract's own shape: a verifier reads commits with git, in its own tree.
  deepEqual(roleErrors([task({ role: "verifier", allowedTools: "Read,Grep,Glob,Bash" })], label), []);
});

test("row 2: a Bash-holding verifier naming any workspace is refused, but an integrate.from source passes", () => {
  // Bash makes it a writer, so only the role rule can refuse the named tree.
  const errors = roleErrors([task({ role: "verifier", allowedTools: "Read,Bash", workspace: "feat" })], label);
  equal(errors.length, 1, errors.join("\n"));
  ok(errors[0].includes("may not name a workspace"), errors[0]);
  ok(errors[0].includes('"feat"'), errors[0]);
  ok(errors[0].includes('Drop "workspace"'), `the fix is spelled: ${errors[0]}`);

  // A reporting leaf is a legitimate merge source: it owns a tree (Bash), so the
  // relation rule accepts it and the role rule adds nothing.
  const tasks = [
    task({ id: "verify-x", role: "verifier", allowedTools: "Read,Bash" }),
    { id: "seed", after: ["verify-x"], integrate: { into: "feat", from: ["verify-x"] } },
  ];
  deepEqual(roleErrors(tasks, label), []);
  deepEqual(roleWarnings(tasks, label), []);
  const relationErrors = [];
  validateTaskRelations(tasks, relationErrors, label);
  deepEqual(relationErrors, []);
});

test("row 3: role accepts only the string \"verifier\", and an unknown key is still refused", () => {
  for (const role of ["reviewer", "Verifier", 5, null, ""]) {
    const errors = [];
    validateTaskShapes([task({ role })], errors, label);
    ok(errors.some((e) => e.includes('role must be "verifier"')), `${JSON.stringify(role)}: ${errors.join("\n")}`);
    ok(errors.some((e) => e.includes('"role": "verifier"')), `the fix is spelled inline: ${errors.join("\n")}`);
    ok(!errors.some((e) => e.includes("unknown key")), `role is a known key: ${errors.join("\n")}`);
  }
  const accepted = [];
  validateTaskShapes([task({ role: "verifier" })], accepted, label);
  deepEqual(accepted, []);

  const unknown = [];
  validateTaskShapes([task({ rol: "verifier" })], unknown, label);
  ok(unknown.some((e) => e.includes("unknown key 'rol'")), unknown.join("\n"));
});

test("row 4: the verifier-prefix warning fires on edits or a shared workspace, never on Bash alone or on the field", () => {
  // (a) an edit tool is what makes a reporting-sounding task a writer.
  const edits = roleWarnings([task({ allowedTools: "Read,Edit,Bash" })], label);
  equal(edits.length, 1, edits.join("\n"));
  ok(edits[0].includes("task 'verify-x' looks like a verifier but can edit"), edits[0]);
  ok(edits[0].includes('"role": "verifier"'), `the fix is spelled: ${edits[0]}`);
  ok(edits[0].includes("rename it if it really writes"), edits[0]);

  // (b) a workspace the writers share is the second half of the same contract.
  const shared = roleWarnings([
    task({ id: "impl", allowedTools: "Read,Edit,Bash", workspace: "feat" }),
    task({ id: "review-x", allowedTools: "Read,Grep,Bash", workspace: "feat" }),
  ], label);
  equal(shared.length, 1, shared.join("\n"));
  ok(shared[0].includes("task 'review-x'"), shared[0]);
  ok(shared[0].includes(`names the writers' workspace "feat"`), shared[0]);

  // (c) the documented phased-chain reviewer: Bash, its own tree, silent.
  deepEqual(roleWarnings([task({ id: "review-phase-1", allowedTools: "Read,Grep,Bash" })], label), []);

  // (d) only the three verifier prefixes are a signal.
  deepEqual(roleWarnings([task({ id: "find-x", allowedTools: "Read,Edit" })], label), []);

  // (e) a task that declares the role is the refusals' business, never the warning's.
  deepEqual(roleWarnings([task({ role: "verifier", allowedTools: "Read,Edit" })], label), []);
});
