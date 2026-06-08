// Smoke tests for Unit 3.3 — pipeline CLI modules
import { run as runRows     } from "../src/cli/rows.mjs";
import { run as runStage    } from "../src/cli/stage.mjs";
import { run as runProgress } from "../src/cli/progress.mjs";
import { run as runQueue    } from "../src/cli/queue.mjs";
import { run as runDispatch } from "../src/cli/dispatch.mjs";
import { connectPath, rowAdd, close } from "../scripts/pipeline-db/index.mjs";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;

function assert(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else       { console.error(`  ✗ ${label}`); fail++; }
}

async function capture(fn) {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = s => { out += s; return true; };
  const code = await fn();
  process.stdout.write = orig;
  return { code, out };
}

async function captureErr(fn) {
  let out = "";
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = s => { out += s; return true; };
  const code = await fn();
  process.stderr.write = orig;
  return { code, out };
}

const dir = mkdtempSync(join(tmpdir(), "pipeline-smoke-"));
const memDir = join(dir, "memory");
mkdirSync(memDir, { recursive: true });

try {
  // ── seed DB ──
  const db = connectPath(join(dir, "pipeline.db"));
  rowAdd(db, { feature: "feat-a", planFile: "feat-a.md", stage: "queued" });
  rowAdd(db, { feature: "feat-b", planFile: "feat-b.md", stage: "dev" });
  close(db);

  // ── stage-get ──────────────────────────────────────────────────────────────
  console.log("\nstage-get");
  const sg = await capture(() => runStage("stage-get", [dir, "feat-a"]));
  assert("exit 0", sg.code === 0);
  assert("output stage=queued", sg.out.trim() === "stage=queued");

  // ── stage-set ──────────────────────────────────────────────────────────────
  console.log("\nstage-set");
  const ss = await capture(() => runStage("stage-set", [dir, "feat-a", "dev"]));
  assert("exit 0", ss.code === 0);
  assert("output OK", ss.out.trim() === "OK");
  const sg2 = await capture(() => runStage("stage-get", [dir, "feat-a"]));
  assert("stage now dev", sg2.out.trim() === "stage=dev");

  // stage-set merge requires --qa-pass
  const ssm = await captureErr(() => runStage("stage-set", [dir, "feat-a", "merge"]));
  assert("merge without qa-pass exit 1", ssm.code === 1);
  assert("merge error message", ssm.out.includes("qa-pass"));

  // ── rows --format json ─────────────────────────────────────────────────────
  console.log("\nrows JSON");
  const rj = await capture(() => runRows("rows", [dir, "--format", "json"]));
  assert("exit 0", rj.code === 0);
  const parsed = JSON.parse(rj.out);
  assert("2 rows", parsed.length === 2);
  assert("notes key present", "notes" in parsed[0]);
  assert("qa_pass is string", typeof parsed[0].qa_pass === "string");

  // ── rows --format plain ────────────────────────────────────────────────────
  console.log("\nrows plain");
  const rp = await capture(() => runRows("rows", [dir, "--format", "plain"]));
  assert("exit 0", rp.code === 0);
  assert("tab-separated", rp.out.includes("\t"));

  // ── row-add upsert ─────────────────────────────────────────────────────────
  console.log("\nrow-add upsert");
  const ra = await capture(() => runRows("row-add", [dir, "feat-new", "feat-new.md", "backlog"]));
  assert("exit 0", ra.code === 0);
  assert("OK", ra.out.trim() === "OK");
  const rj2 = await capture(() => runRows("rows", [dir, "--format", "json"]));
  const p2 = JSON.parse(rj2.out);
  assert("3 rows after add", p2.length === 3);

  // row-add existing feature → upsert
  const ra2 = await capture(() => runRows("row-add", [dir, "feat-new", "feat-new.md", "research"]));
  assert("upsert exit 0", ra2.code === 0);
  assert("upsert says updated", ra2.out.includes("updated"));

  // ── row-delete ─────────────────────────────────────────────────────────────
  console.log("\nrow-delete");
  const rd = await capture(() => runRows("row-delete", [dir, "feat-new"]));
  assert("exit 0", rd.code === 0);
  assert("OK", rd.out.trim() === "OK");

  // ── progress-create / mark / get ──────────────────────────────────────────
  console.log("\nprogress");
  const pc = await capture(() =>
    runProgress("progress-create", [memDir, "my-slug", "--steps", "read docs|write code|test it"])
  );
  assert("create exit 0", pc.code === 0);

  const pm = await capture(() => runProgress("progress-mark", [memDir, "my-slug", "1", "done"]));
  assert("mark exit 0", pm.code === 0);

  const pg = await capture(() => runProgress("progress-get", [memDir, "my-slug", "--format", "tasks"]));
  assert("get tasks exit 0", pg.code === 0);
  const tasks = JSON.parse(pg.out);
  assert("3 tasks", tasks.length === 3);
  assert("first task completed", tasks[0].status === "completed");
  assert("second task pending", tasks[1].status === "pending");
  assert("subject has prefix", tasks[0].subject.includes(":"));

  const pgmd = await capture(() => runProgress("progress-get", [memDir, "my-slug", "--format", "md"]));
  assert("get md exit 0", pgmd.code === 0);
  assert("md has [x]", pgmd.out.includes("[x]"));

  const pr = await capture(() => runProgress("progress-resume", [memDir, "my-slug"]));
  assert("resume exit 0", pr.code === 0);
  assert("resume returns 2", pr.out.trim() === "2");

  const pdel = await capture(() => runProgress("progress-delete", [memDir, "my-slug"]));
  assert("delete exit 0", pdel.code === 0);

  // ── queue-name-derive ──────────────────────────────────────────────────────
  console.log("\nqueue-name-derive");
  const qnd = await capture(() => runQueue("queue-name-derive", ["add kafka consumer retry logic"]));
  assert("exit 0", qnd.code === 0);
  assert("has name=", qnd.out.startsWith("name="));
  assert("reasonable name", qnd.out.includes("kafka"));

  // ── target-branch-get ─────────────────────────────────────────────────────
  console.log("\ntarget-branch-get");
  const tbg = await capture(() => runDispatch("target-branch-get", [dir, "feat-a"]));
  assert("exit 0", tbg.code === 0);
  assert("output target_branch=main", tbg.out.trim() === "target_branch=main");

  // ── rebase-required-set ───────────────────────────────────────────────────
  console.log("\nrebase-required-set");
  const rrs = await capture(() => runDispatch("rebase-required-set", [dir, "feat-a", "1"]));
  assert("exit 0", rrs.code === 0);
  assert("OK", rrs.out.trim() === "OK");

  // ── done (manual → merge) ─────────────────────────────────────────────────
  console.log("\ndone");
  // Set feat-b to manual first (with qa_pass)
  const ss2 = await capture(() =>
    runStage("stage-set", [dir, "feat-b", "manual", "--qa-pass", "true"])
  );
  assert("set to manual ok", ss2.code === 0);
  const dn = await capture(() => runStage("done", [dir, "feat-b"]));
  assert("done exit 0", dn.code === 0);
  assert("done OK message", dn.out.includes("advanced to merge"));

  // ── unknown subcommand ─────────────────────────────────────────────────────
  console.log("\nunknown subcommand");
  const unk = await runDispatch("no-such-cmd", []);
  assert("returns null", unk === null);

} finally {
  rmSync(dir, { recursive: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
