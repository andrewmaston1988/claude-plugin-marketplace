# RQ8 — scenario-format authorability (format lane)

**Status: harness built and green; the authoring sweep ran (10 attempts per format, one model).**
Every number below is reproducible from a committed script.

## RQ8 table — one row per format

| Format | Validator (the contract) | Shipped examples valid / correct | Broken scenario rejected | Run ms (5 examples, 1 pass) | Artifact |
|---|---|---|---|---|---|
| Playwright Test (TS) | `playwright test --list` collection + structural rules (import, `test(`, `expect(`, no `.only`/skip) on comment-stripped source | 5 / 5 · 5 / 5 | yes | 2016 · 2216 · 2659 · 2002 · 2453 | `plugins/ui-probe/bakeoff/results/formats-selfcheck.json` |
| Flat YAML step list | Compile to the shared 13-op IR, then op/param/type checks | 5 / 5 · 5 / 5 | yes | 23 · 778 · 726 · 2 · 382 | same |
| Gherkin + step bindings | Feature parse → binding resolve → IR checks; an unbound step is an error | 5 / 5 · 5 / 5 | yes | 3 · 426 · 742 · 1 · 394 | same |
| **Authoring sweep — Playwright Test** | same | **10 / 10 valid · 9 / 10 correct** | — | — | `plugins/ui-probe/bakeoff/results/formats-attempts.json` |
| **Authoring sweep — Flat YAML** | same | **10 / 10 valid · 8 / 10 correct** | — | — | same |
| **Authoring sweep — Gherkin** | same | **10 / 10 valid · 8 / 10 correct** | — | — | same |

Run ms caveats, stated because they are not a scored quantity: one pass each, no repeats,
and the order is alphabetical — the first browser scenario in sequence pays Chromium
launch, so flat's 778 ms for T1 includes what Gherkin's 426 ms does not. Playwright's ~2 s
floor is per-spec process startup, which is a real cost of that format but is measured
inside the harness's own process model, not a like-for-like step time.

## Authoring sweep — what it measured

Run `ui-probe-bakeoff-measure-1`, 30 fresh leaves: 3 formats × 5 tasks × 2 repeats, one task and one
format per leaf, one example of a *different* task, no tools. **One model —
`ollama/deepseek-v4.1-flash:1017-cloud` — not the plan's `claude-haiku-5-5` + `minimax-m3.1-flash:cloud`**:
minimax was denylisted and the operator chose one model for every leaf (2026-11-13: "All deepseek /
Apples to apples"). So the sweep is 10 attempts per format, and the plan's fixed rule scales to
**reject below 6/10 first-try-valid or 5/10 correct**. No format is rejected; per the rule the counts
are feasibility, not a ranking.

```bash
python plugins/ui-probe/bakeoff/agents/gen_measure.py      # writes the manifest beside it
node   plugins/ui-probe/bakeoff/formats/score.mjs --dir plugins/ui-probe/bakeoff/formats/attempts        --out plugins/ui-probe/bakeoff/results/formats-attempts.json
```

Every miss, by cause:

| attempt | verdict | cause |
|---|---|---|
| flat-yaml t2-hover ×2, gherkin t2-hover ×2 | valid / WRONG | **Task-spec gap, not format**: the t2-hover ask names the hover bar's test id but neither the tile's (`rec-tile`) nor the sheet URL, and its example was a different task. Attempts guessed `recommendation-tile` or `:18772/detail`. |
| playwright-test http-health #1 | valid / WRONG | authoring: ran the `.mjs` probe CLI through `execFileSync` directly (`EFTYPE` on Windows) instead of through `node` |

- Playwright Test's t2-hover attempts passed because TypeScript let the author hedge — a selector
  union of three plausible test ids. The two IR formats have no such escape, so the same gap cost them
  both attempts.
- **Scorer defect found and fixed in this round:** the Playwright validator required a literal
  `expect(`, so both t2-hover specs — which assert through `expect.poll(...)` — first scored INVALID.
  It now also accepts `expect.poll(` / `expect.soft(`; a bare `expect` reference is still rejected.
- No Gherkin attempt shipped a custom `.steps.mjs`: all 10 used the library's steps. Sixteen leaves
  returned a `steps` value anyway (the string `"null"`, or one for a non-Gherkin format); all were
  discarded, not scored.
- Output tokens per authored scenario (median, range; 2–3 turns each): Playwright Test 989 (443–8195),
  Flat YAML 667 (306–2058), Gherkin 735 (317–1745).

## The five pinned tasks

Reference values live in `plugins/ui-probe/bakeoff/formats/tasks.json` and are what both
validity (does a step address the check) and correctness (does the run observe it) score
against.

| Task | Backend | Reference value | Fixture |
|---|---|---|---|
| `t1-layout` | browser | action-tile widths `[111, 111, 111]` ±1 at 390×844 | static sheet |
| `t2-hover` | browser | hover-bar `opacity` `"1"` desktop, `"0"` touch | static sheet, two contexts |
| `http-health` | network | `GET http://127.0.0.1:18772/health` → `ok: true` | `node:http` |
| `win-textbox` | desktop | `ValueBox` in window `ui-probe-fixture` = `fixture-value-42` | WinForms |
| `tcp-banner` | network | port 18773 banner = `HELLO ui-probe` | `node:net` echo |

## Commands

```bash
# self-check: validate + run every shipped example, and prove every broken one is rejected
node plugins/ui-probe/bakeoff/formats/score.mjs --out plugins/ui-probe/bakeoff/results/formats-selfcheck.json

# validity only, no fixtures started (cheap, no browser, no WinForms window)
node plugins/ui-probe/bakeoff/formats/score.mjs --validate-only

# score authored attempts laid out as attempts/<format>/<model>/<task>/attempt-<n>.<ext>
node plugins/ui-probe/bakeoff/formats/score.mjs --dir plugins/ui-probe/bakeoff/formats/attempts
```

Exit codes: 0 when every broken scenario was rejected and every shipped example is valid
and correct; 1 when a broken scenario passes validation, a shipped example is invalid or
wrong, or a scenario cannot be scored (harness error, reported as such rather than as a
verdict); 2 when the directory holds no scenarios.

## Broken-scenario RED

One deliberately broken scenario per format, all three rejected on the shipped run:

| Format | File | Rejection |
|---|---|---|
| Playwright Test | `scenarios/playwright-test/broken/broken-t2-hover.spec.ts` | `no expect(...) assertion — a scenario that asserts nothing is not a scenario`; `missing required marker "hover-bar"`; `missing required marker "opacity"` |
| Flat YAML | `scenarios/flat-yaml/broken/broken-t2-hover.yaml` | `steps[2]: unknown op "action"; allowed: open, viewport, hover, tap, click, expect_visible, expect_hidden, expect_widths, expect_css, expect_text, expect_json, tcp_banner, uia_text`; `no step asserts reference check "hoverbar_touch" (expected expect_css on [data-testid=hover-bar] = "0")` |
| Gherkin | `scenarios/gherkin/broken/broken-t2-hover.feature` | `line 7: no binding for step "the user hovers the first recommendation tile"`; `no step asserts reference check "hoverbar_touch" (…)` |

Four further bites were run against the scorer itself, each producing the expected verdict:

1. Copying a valid scenario into a `broken/` bucket → exit 1, naming the file.
2. A wrong reference value → `valid: true`, one coverage problem (correctness fails, validity does not).
3. Deleting the assertion step → `valid: false`, `no assertion step`.
4. A desktop-only T2 scenario → runs green, not correct; coverage names `hoverbar_touch`.

## Format differences observed while building

- **Validity and correctness are separate quantities, in all three formats.** Validity is
  the format contract; correctness is observing the pinned values. A scenario can be
  perfectly written and assert the wrong number — collapsing the two would score that as
  a format failure rather than an authoring one. `score.mjs` reports them separately and
  only counts `valid && ran && passed && coverage.length === 0` as correct.
- **Playwright Test cannot be compiled to the shared IR**, so it is the one format whose
  coverage is checked by markers (does the source mention `hover-bar`, `opacity`) rather
  than by the ops it emits. This is an honest asymmetry, not a free pass: it makes
  Playwright's *correctness* check weaker than the other two, which the score table will
  show if it matters. Validity for Playwright is still real — `playwright test --list` is
  the format's own parser and rejects malformed specs before scoring.
- **Retry semantics differ and the harness was levelled for it.** Playwright's web-first
  assertions retry; a one-shot IR read of `opacity` mid-transition observed `0.139242`.
  The IR runner gained a 50 ms poll until its step deadline so both formats assert on the
  same settled condition rather than one being handicapped by read timing.
- **Non-browser fixtures reach every format through one implementation.** `probe-cli.mjs`
  (`http` / `tcp` / `uia`) is what the Playwright spec shells out to, what the IR runner
  calls in-process, and what the Gherkin bindings compile to. A Windows or TCP task
  therefore measures the format, not three different ways of reading a window.
- **The Gherkin step library is a shared artifact, and that is a real property of the
  format.** 14 bindings cover the five tasks; a format that needs a bespoke binding per
  new assertion amortises better than one that needs none, and the sweep should show it.
- **Comments cannot satisfy a check.** The Playwright validator strips comments with a
  quote-aware scanner before looking for `expect(` — a spec whose only assertion is in a
  comment asserts nothing and is rejected as such.

## Fairness ledger

Every contender is driven by the same tasks, the same fixture ports, the same reference
values, the same output schema and the same scorer. Where a contender needed a workaround
it is recorded here rather than absorbed silently:

| Contender | Workaround / asymmetry | Why |
|---|---|---|
| Playwright Test | `@playwright/test` is not installed; a temp project supplies a one-line shim `export * from 'playwright/test'` plus a `node_modules/playwright` junction to the library the MCP server already ships | the format is the contender, the missing package is an environment fact |
| Playwright Test | validated by structure + markers, not by IR compilation | TS cannot be compiled to the IR without writing a compiler, which would be testing the compiler |
| Flat YAML | `expect_widths` accepts a single value that applies to all matches | keeps `[111]` from being scored wrong against `[111,111,111]` on a layout that is uniform by construction |
| Gherkin | authors may ship a `<name>.steps.mjs` beside the feature | the format's own extension point; without it any assertion outside the 14 bindings is unwritable, which would measure the library, not the format |
| All three | the IR assertions poll; Playwright retries natively | equalising read timing across formats |

## OPEN

| Row | Exact probe still to run |
|---|---|
| RQ8 on the plan's two models | This round ran one model by operator choice. To add the second model: set `MODELS` in `agents/gen_measure.py` to two entries, re-dispatch only the `author-*` leaves, re-score; the rule returns to 12/20 · 10/20. |
| t2-hover with the tile selector named | Add `rec-tile` and the sheet URL to the t2-hover ask in `formats/tasks.json`, re-run those 6 leaves: separates the task-spec gap from format authorability. |
| Per-format run time with repeats | Re-run `score.mjs` N=5 with `--out` per pass and report median + spread per format. One pass only so far; the browser-launch cost is currently attributed to whichever scenario ran first. |
| Whether a weak model can author a Gherkin binding when the library lacks the step | Not exercised: no attempt needed or shipped a binding. Needs a task whose step the library lacks. |
