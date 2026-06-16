# Review: pipeline-config-parse-error-abort

*Reviewer: minimax-m3:cloud (deep inline) — 2026-06-16*
*Diff: `master...HEAD` = 2 files, +86/-2*

---

## Summary

The diff closes the silent-write hole in `updatePipelineConfig` (catch-and-fall-back to `{}` would let `pipeline stage-set` wipe the `proxy` block on the next save) and adds a stderr warning to `loadPipelineConfig`'s parse-error path. Four tests pin the new contract. The behavioural change is correct and the tests are pointed.

Three grounded findings: one BLOCKER-class (silent-drift on missing file — contradicts the new code comment), two ADVISORY (plan-slug reference in test file; dead-code throw in test 1's mutator closure). Both ADVISORYs are mechanical and small.

---

### Concerns

- **[BLOCKER]** `loadPipelineConfig` silently returns defaults when the file is *missing* (`existsSync` returns false at `plugins/pipeline/src/pipeline-config.mjs:24`) — no stderr warning. The new comment at `plugins/pipeline/src/pipeline-config.mjs:20-21` says *"On parse failure, fall back to defaults and warn to stderr so the operator notices the file is unreadable"* — but the unreadable-missing case is also a real operator-facing condition and is silent. §1 Boy Scout (drift between comment and code normalises future misses), §22 observability (silent fallback is the failure mode the rule's example calls out by name). Fix: either warn on missing too, or trim the comment to match the actual behaviour. Either resolution is one line; the asymmetry itself is the defect.

- **[ADVISORY]** The new test file's preamble comment is a plan-slug ref: `// Plan: pipeline-config-parse-error-abort — abort on parse error instead of / silently resetting to `{}` on the write path…` (`plugins/pipeline/tests/config-parse-error.test.mjs:3-5`). §16 plan-slug-ref grep: rot; tests assert current behaviour, plans are requirements docs that move. Strip the plan reference; the test name already carries the intent.

- **[ADVISORY]** The mutator in test 1 contains unreachable code: `() => { throw new Error("mutator should not run"); }` (`plugins/pipeline/tests/config-parse-error.test.mjs:27`). On parse failure, the mutator never runs — the closure body is dead. If parse succeeded, the test would fail on a different assertion (the `match` for "could not parse" wouldn't match), so the throw contributes no signal. The "mutator must not run" guarantee is already covered by test 2's `equal(mutatorRan, false, ...)`. §6 cognitive load budget (the throw is a misleading tripwire). Fix: replace with `() => { mutatorRan = true; }` and assert on the flag, matching the pattern in test 2.

### Open questions

- The plan's Files Changed table says `process.stderr.write(...)` in one place and `console.warn` in another; the implementation uses `process.stderr.write` in both. Identical observable behaviour (both write to fd 2). No action, just confirming the divergence is benign.

### Pride

- The throw is the load-bearing fix and the test 1 / test 2 pair pins both halves of the contract: (a) the file is unchanged on disk (`plugins/pipeline/tests/config-parse-error.test.mjs:32` reads the original bytes back) and (b) the mutator is never invoked (`plugins/pipeline/tests/config-parse-error.test.mjs:45`). The first-order guarantee and the second-order guard are both present.
- Test 3 is a load-bearing regression guard, not a "did it work" test: it asserts both the returned value (`out.orch.max_concurrent === 7`) and the reloaded value (`reloaded.orch.max_concurrent === 7`), catching a class of bugs where the return and the on-disk state diverge.
- The stderr capture in test 4 binds the prototype rather than replacing the function (`process.stderr.write = (chunk) => ...` after `bind(process.stderr)`), so the finally-block restore is exact. `bind` is the right primitive here — `process.stderr.write = original` would have been a no-op since `write` is non-writable in some Node configurations.
- The error message format `pipeline-config: could not parse ${configPath} — ${e.message}` carries the path *and* the underlying parse error, which is what the operator needs to fix it. §10 (log resolved values, not inputs).

### Verdict

**Needs work**

The BLOCKER (silent missing-file fallback contradicts the new comment) is a one-line fix; once it lands the change is mergeable. The two ADVISORYs are mechanical trims that should land in the same commit.
