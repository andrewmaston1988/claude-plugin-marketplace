// menuOptions matrix mirrors Python _menu_options(row, branch_exists).
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { menuOptions } from "../src/dashboard/tui/action-menu.mjs";

test("backlog row: queue prefix + 4 stypes (with branch) + delete", () => {
  const opts = menuOptions({ stage: "backlog" }, true);
  ok(opts.some(o => o.label.startsWith("Queue → Research")));
  ok(opts.some(o => o.label.startsWith("Queue → Dev")));
  ok(opts.some(o => o.label.startsWith("Queue → Review")));
  ok(opts.some(o => o.label.startsWith("Queue → Test")));
  ok(opts.some(o => o.action === "delete"));
  ok(!opts.some(o => o.action === "stage:backlog"));
});

test("dev row: re-queue prefix + return-to-backlog + delete", () => {
  const opts = menuOptions({ stage: "dev" }, true);
  ok(opts.some(o => o.label.startsWith("Re-queue → Dev")));
  ok(opts.some(o => o.action === "stage:backlog"));
  ok(opts.some(o => o.action === "delete"));
});

test("manual row: no queue options, return-to-backlog + delete", () => {
  const opts = menuOptions({ stage: "manual" }, true);
  ok(!opts.some(o => o.action.startsWith("queue:")));
  ok(opts.some(o => o.action === "stage:backlog"));
  ok(opts.some(o => o.action === "delete"));
});

test("done row: only Cancel (read-only)", () => {
  const opts = menuOptions({ stage: "done" }, true);
  equal(opts.length, 1);
  equal(opts[0].action, "cancel");
});

test("cancel is always last option", () => {
  for (const stage of ["backlog", "dev", "manual", "queued", "done"]) {
    const opts = menuOptions({ stage }, true);
    equal(opts[opts.length - 1].action, "cancel");
  }
});

test("branch_exists=false: no review/test options", () => {
  const opts = menuOptions({ stage: "dev" }, false);
  ok(!opts.some(o => o.action === "queue:review"));
  ok(!opts.some(o => o.action === "queue:test"));
  ok(opts.some(o => o.action === "queue:research"));
  ok(opts.some(o => o.action === "queue:dev"));
});

test("merge row: Merge now + return-to-backlog + delete, no queue options", () => {
  const opts = menuOptions({ stage: "merge" }, true);
  ok(opts.some(o => o.action === "merge"));
  ok(opts.some(o => o.action === "stage:backlog"));
  ok(opts.some(o => o.action === "delete"));
  ok(!opts.some(o => o.action.startsWith("queue:")));
  equal(opts[opts.length - 1].action, "cancel");
});
