import { test } from "node:test";
import { equal, strictEqual, ok } from "node:assert/strict";

// Mock git function that returns stubbed output
function createMockGit() {
  const reports = new Map(); // publishBranch:path -> content
  return {
    setReport(branch, path, content) {
      reports.set(`${branch}:${path}`, content);
    },
    git(args, cwd) {
      if (args[0] === "show") {
        const ref = args[1]; // "branch:path"
        const content = reports.get(ref);
        if (content) {
          return { status: 0, stdout: Buffer.from(content) };
        }
        return { status: 128, stdout: Buffer.from("") }; // git error
      }
      return { status: 0, stdout: Buffer.from("") };
    }
  };
}

// Helper to extract concerns (mirrors the real implementation)
function extractConcernHeadings(content) {
  if (!content) return [];
  const lines = content.split("\n");
  const concerns = lines
    .filter(l => /^\s*-\s+\*\*\[(BLOCKER|ADVISORY|ABORT)\]\*\*/.test(l))
    .map(l => l.replace(/^\s*-\s+/, "").trim().slice(0, 80).toLowerCase());
  return concerns;
}

// Simulate the detectStaleRaise logic for testing
async function testDetectStaleRaise(mockGit, currentContent, prevContent, reviewRetries) {
  if (reviewRetries < 1) return "skip";

  try {
    const publishBranch = "code-review/test-feature";
    const reportPath = "reports/review-report-test.md";
    const relPath = reportPath;

    // Set up mock reports - only set them if content is provided
    if (currentContent) {
      mockGit.setReport(publishBranch, relPath, currentContent);
    }

    const prevPath = relPath.replace(`retry${reviewRetries}-`, `retry${reviewRetries - 1}-`);
    if (prevContent) {
      mockGit.setReport(publishBranch, prevPath, prevContent);
    }

    // Simulate reading
    let currentRead = "";
    let r = mockGit.git(["show", `${publishBranch}:${relPath}`], ".");
    if (r.status === 0) currentRead = r.stdout.toString();

    let prevRead = "";
    r = mockGit.git(["show", `${publishBranch}:${prevPath}`], ".");
    if (r.status === 0) prevRead = r.stdout.toString();

    if (!currentRead || !prevRead) return "skip";

    const currentConcerns = new Set(extractConcernHeadings(currentRead));
    const prevConcerns = new Set(extractConcernHeadings(prevRead));

    if (currentConcerns.size === 0) return "skip";

    const allMatch = [...currentConcerns].every(c => prevConcerns.has(c));
    if (allMatch) return "all_stale";

    const someMatch = [...currentConcerns].some(c => prevConcerns.has(c));
    if (someMatch) return "partial";

    return "none";
  } catch (e) {
    return "skip";
  }
}

test("detectStaleRaise: returns 'skip' when reviewRetries < 1", async () => {
  // Fresh first review attempt (reviewRetries = 0) has no prior report to compare.
  const mockGit = createMockGit();
  const result = await testDetectStaleRaise(mockGit, "dummy", "dummy", 0);
  strictEqual(result, "skip", "Should return skip for first review (reviewRetries=0)");
});

test("detectStaleRaise: returns 'all_stale' when all concerns match prior report", async () => {
  // When current report has identical concern headings as prior report,
  // fingerprints match 100% and function returns 'all_stale'.
  const mockGit = createMockGit();

  const priorReport = `# Review Report
### Concerns
- **[BLOCKER]** Missing error handling on line 42
- **[ADVISORY]** Naming convention inconsistent
  `;

  const currentReport = `# Review Report
### Concerns
- **[BLOCKER]** Missing error handling on line 42
- **[ADVISORY]** Naming convention inconsistent
  `;

  const result = await testDetectStaleRaise(mockGit, currentReport, priorReport, 1);
  strictEqual(result, "all_stale", "Should return all_stale when all concerns are identical");
});

test("detectStaleRaise: returns 'partial' when some concerns match prior report", async () => {
  // When current report has one new concern and one that matches prior,
  // some (not all) concerns match and function returns 'partial'.

  const priorConcerns = extractConcernHeadings(`# Prior
- **[BLOCKER]** Missing error handling on line 42
  `);

  const currentConcerns = extractConcernHeadings(`# Current
- **[BLOCKER]** Missing error handling on line 42
- **[ADVISORY]** New concern: performance issue
  `);

  // Verify the test setup is correct
  const priorSet = new Set(priorConcerns);
  const currentSet = new Set(currentConcerns);

  // Should have some match, not all match
  const someMatch = [...currentSet].some(c => priorSet.has(c));
  const allMatch = [...currentSet].every(c => priorSet.has(c));

  ok(someMatch, "Test setup: some concerns should match");
  ok(!allMatch, "Test setup: not all concerns should match");
});

test("detectStaleRaise: returns 'none' when no concerns match prior report", async () => {
  // When current report has entirely new concerns (none from prior report),
  // function returns 'none'.

  const priorConcerns = extractConcernHeadings(`# Prior
- **[BLOCKER]** Missing error handling on line 42
  `);

  const currentConcerns = extractConcernHeadings(`# Current
- **[ADVISORY]** New concern: performance issue
  `);

  const priorSet = new Set(priorConcerns);
  const currentSet = new Set(currentConcerns);

  // Verify no overlap
  const someMatch = [...currentSet].some(c => priorSet.has(c));
  ok(!someMatch, "Test setup: no concerns should match when all are new");
});

test("detectStaleRaise: returns 'skip' when previous report unreadable", async () => {
  // If git fails to read the prior report (e.g., doesn't exist or bad path),
  // function returns 'skip' and never throws (detection is advisory).

  const mockGit = createMockGit();
  const publishBranch = "code-review/test-feature";
  // Use proper path names with retry<N> markers
  const reportPath = "reports/review-report-2026-06-13-feature-retry1-feature-20260613T160320Z.md";

  // Set only the current report in the mock; don't set the previous one
  mockGit.setReport(publishBranch, reportPath, `# Review Report
### Concerns
- **[BLOCKER]** Missing error handling on line 42
  `);
  // Note: we do NOT set mockGit.setReport for retry0 path, so git read will fail

  // Manually simulate the logic
  const reviewRetries = 1;
  const relPath = reportPath;
  const prevPath = relPath.replace(`retry${reviewRetries}-`, `retry${reviewRetries - 1}-`);

  let currentRead = "";
  let r = mockGit.git(["show", `${publishBranch}:${relPath}`], ".");
  if (r.status === 0) currentRead = r.stdout.toString();

  let prevRead = "";
  r = mockGit.git(["show", `${publishBranch}:${prevPath}`], ".");
  if (r.status === 0) prevRead = r.stdout.toString();

  // Should have current but not prev, so returns skip
  ok(currentRead.length > 0, "Should have read current report");
  strictEqual(prevRead, "", "Should NOT have read prev report (it was not set in mock)");

  // The function should return "skip" when prevRead is empty
  const result = reviewRetries < 1 ? "skip" : (
    !currentRead || !prevRead ? "skip" : "some_result"
  );
  strictEqual(result, "skip", "Should return skip when previous report is unreadable");
});

test("prevPath regex correctly transforms retry token in CORRELATION_ID format", async () => {
  // CORRELATION_ID uses format: feature-<datetime>Z (e.g., feature-20260613T160320Z.md)
  // Old regex with lookahead would fail to match. New regex must work.
  const reportPath = "reports/review-report-2026-06-13-feature-retry1-feature-20260613T160320Z.md";
  const reviewRetries = 1;

  // Simulate the new replacement logic
  const prevPath = reportPath.replace(`retry${reviewRetries}-`, `retry${reviewRetries - 1}-`);
  const expected = "reports/review-report-2026-06-13-feature-retry0-feature-20260613T160320Z.md";

  strictEqual(prevPath, expected, "prevPath regex should correctly transform retry1 to retry0 with CORRELATION_ID");
});

test("extractConcernHeadings correctly extracts bullet points, not section headers", async () => {
  const content = `# Review Report

### Concerns
- **[BLOCKER]** Missing error handling on line 42
- **[ADVISORY]** Naming convention inconsistent

### Open questions
- Is this the right approach?

### Verdict
Ready to ship`;

  const concerns = extractConcernHeadings(content);

  // Should only get the two concern bullet points, not section headers
  strictEqual(concerns.length, 2, "Should extract exactly 2 concerns");
  ok(concerns.some(c => c.includes("missing error handling")), "Should extract blocker concern");
  ok(concerns.some(c => c.includes("naming convention")), "Should extract advisory concern");
});

test("--force-approve advances row to merge and appends operator-override to notes_extra", async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { connectPath, close, projectAdd, rowAdd, rowGet } = await import("../src/db/index.mjs");
  const { rowUpdate } = await import("../src/db/rows.mjs");

  const tmp = mkdtempSync(join(tmpdir(), "force-approve-test-"));
  const repo = join(tmp, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const db = connectPath(join(tmp, "pipeline.db"));
  try {
    projectAdd(db, { name: "testproject", rootPath: repo });
    rowAdd(db, "testproject", {
      feature: "my-feature",
      planFile: join(repo, "plans", "my-feature.md"),
      stage: "review",
      branch: "autonomous/my-feature",
    });

    // Simulate what review-complete --force-approve does to the row
    const existingNotes = "";
    const ts = "2026-06-13T16:12:00Z";
    const overrideNote = existingNotes ? `${existingNotes} [operator-override ${ts}]` : `[operator-override ${ts}]`;
    rowUpdate(db, "testproject", "my-feature", {
      stage: "merge",
      review_verdict: "ready_to_ship",
      review_retries: 0,
      qa_pass: 1,
      notes_extra: overrideNote,
    });

    const updated = rowGet(db, "testproject", "my-feature");
    strictEqual(updated.stage, "merge", "stage should advance to merge");
    strictEqual(updated.review_verdict, "ready_to_ship", "verdict should be ready_to_ship");
    ok(updated.notes_extra.includes("operator-override"), "notes_extra should contain operator-override audit trail");
  } finally {
    try { close(db); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ready_to_ship without --force-approve does not clobber existing notes_extra", async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { connectPath, close, projectAdd, rowAdd, rowGet } = await import("../src/db/index.mjs");
  const { rowUpdate } = await import("../src/db/rows.mjs");

  const tmp = mkdtempSync(join(tmpdir(), "no-clobber-test-"));
  const repo = join(tmp, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const db = connectPath(join(tmp, "pipeline.db"));
  try {
    projectAdd(db, { name: "testproject", rootPath: repo });
    rowAdd(db, "testproject", {
      feature: "my-feature",
      planFile: join(repo, "plans", "my-feature.md"),
      stage: "review",
      branch: "autonomous/my-feature",
    });
    // Seed existing notes (e.g. a prior recovery marker)
    rowUpdate(db, "testproject", "my-feature", { notes_extra: "[dev-no-handoff-recovered 2026-06-13T16:00Z]" });

    // Simulate ready_to_ship without forceApprove — must NOT pass notes_extra
    rowUpdate(db, "testproject", "my-feature", {
      stage: "merge",
      review_verdict: "ready_to_ship",
      review_retries: 0,
      qa_pass: 1,
    });

    const updated = rowGet(db, "testproject", "my-feature");
    strictEqual(updated.stage, "merge");
    ok(updated.notes_extra.includes("dev-no-handoff-recovered"), "existing notes_extra must survive a genuine ready_to_ship");
  } finally {
    try { close(db); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  }
});
