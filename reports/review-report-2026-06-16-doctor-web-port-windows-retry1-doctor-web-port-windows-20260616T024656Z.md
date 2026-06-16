# Code Review Report: doctor-web-port-windows (attempt 1)

**Plan:** `C:\code\claude-plugin-marketplace/plans/doctor-web-port-windows.md`
**Source branch:** `autonomous/doctor-web-port-windows`
**Target branch:** `master`
**Reviewer:** Claude (claude-sonnet-4-6)
**Correlation ID:** doctor-web-port-windows-20260616T024656Z

---

### Concerns

- **[BLOCKER]** Implementation exists only as uncommitted working-tree changes — not on the branch. The committed diff of `autonomous/doctor-web-port-windows` against `master` contains zero changes to `plugins/pipeline/src/setup/doctor.mjs` or `plugins/pipeline/tests/doctor.test.mjs`. The `dwpw` worktree had `M plugins/pipeline/src/setup/doctor.mjs` and `M plugins/pipeline/tests/doctor.test.mjs` as unstaged modifications, stashed at `auto: code-review-doctor-web-port-windows` and restored after review. The plan's work is complete but was never committed. Evidence: `git diff master...autonomous/doctor-web-port-windows -- plugins/pipeline/src/setup/doctor.mjs` produced empty output; `git status --short` in the `dwpw` worktree confirmed both files modified before stash. (§24)

- **[ADVISORY]** §16 comment run — once committed, the 8-line section comment block at the top of the helper section in `doctor.mjs` will trigger a §16 advisory. The block (`// --- web-port-conflict helpers --- ... they can be unit-tested with synthetic spawnSync output.`) spans 8 consecutive comment-only lines; §16 sets 6–9 lines → ADVISORY. The platform-divergence context is genuinely load-bearing, but it can be distilled to 2–3 lines without losing the constraint. Evidence: manual count of lines 378–385 in the working-tree doctor.mjs. (§16)

### Open questions

- The committed branch carries 3 unrelated commits above `master` (PRs #107 keepalive cleanup, #108 QA-loop fidelity, #109 SessionStart/PreToolUse hooks). All 15 changed files are out of scope per the plan's Files Changed section. Are these commits intended to be squashed away before merge, or are they expected on this branch?
- The uncommitted implementation was reviewed informally and the logic is sound: `parseNetstatPids` / `parseTasklist` / `parseWmicCommandLine` helpers are clean, `detectPortOccupant` correctly chains netstat → tasklist → wmic on Windows with wmic guarded in try/catch, tests cover 7 distinct scenarios including the wmic-failure (Server 2022+) path. The §16 advisory on the comment block is the only quality note — everything else is Pride-worthy.

### Pride

- The uncommitted implementation is well-designed: dependency-injection via the `run` parameter (defaulting to `spawnSync`) makes the entire Windows detection path unit-testable without real system calls, and the tests exploit this cleanly with a `fakeRunner` stub. This is the right architecture for platform-specific shell-out code. (§15, §12)

### Verdict
**Needs work**

The plan's implementation is complete in the working tree but was never committed to the branch. The branch as-reviewed (`autonomous/doctor-web-port-windows`) does not include the doctor fix. Dev must commit the stashed doctor.mjs + doctor.test.mjs changes and resolve the §16 comment-block advisory before resubmitting.

---

review_verdict: needs_work
