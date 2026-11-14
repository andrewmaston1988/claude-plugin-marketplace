# Web lane — results fragment

Every number below came from one shared harness: the same fixtures, the same tasks, the same reads,
the same repeat count, and the same output columns. The two contenders are thin adapters behind
`web/lib/harness.mjs`; nothing in the harness knows which tool is running.

Contenders:

| key | what it is | how it is loaded | dependencies |
|---|---|---|---|
| `playwright` | scripted Playwright library, the deterministic baseline | `createRequire(<npm root -g>/@playwright/mcp/node_modules/playwright)`, chromium headless shell | 2 npm packages |
| `cdp` | a copy of swarm's `scripts/lib/cdp.mjs`, hand-rolled over the built-in `WebSocket` | copied into `web/lib/cdp.mjs`, two documented extensions (event subscription, Windows launcher grace) | 0 |

Fairness notes that belong with every row:

- Both contenders block `image.tmdb.org` and `cdnjs.cloudflare.com` through the **same** CDP domain
  (`Network.setBlockedURLs`), so both see the same page.
- `cdp`'s observation text is produced by the lane's own ~30-line AX serialiser
  (`web/contenders/cdp.mjs`). Its byte figures are "protocol + this formatter", not a library figure.
- Playwright's observation is `locator("body").ariaSnapshot()`. CDP's is
  `Accessibility.getFullAXTree` through that serialiser.
- Repeats: 3 per row unless stated.

Reproduce everything from the repo root of this worktree:

```bash
python bakeoff/ui-probe/fixtures/hub_fixture.py --check
node   bakeoff/ui-probe/web/run-all.mjs
node   bakeoff/ui-probe/web/run-live.mjs
node   bakeoff/ui-probe/web/run-rq3.mjs
node   bakeoff/ui-probe/web/run-rq9.mjs
node   bakeoff/ui-probe/web/run-rq10.mjs
```

---

## RQ1 — T1 layout and timing

Static fixture (`fixtures/static/detail-sheet.html`): the real sheet markup rendered from the
torrent-hub templates by `fixtures/static/render_sheet.py`.

Command: `node bakeoff/ui-probe/web/run-all.mjs` · Artifact: `results/artifacts/run-all.json`

| contender | viewport | launch ms | warm ms (n=2) | action tiles px | close x | top band px | observation |
|---|---|---|---|---|---|---|---|
| playwright | 390×844 touch | 338.5 | 38 / 38 | 111.3 / 111.3 / 111.3 | 336 | 17 | 1200 B |
| playwright | 1280×900 | 113.5 | 34 / 37 | 90.3 / 91.2 / 116.1 | 996 | 52 | 1200 B |
| cdp | 390×844 touch | 469.5 | 28 / 30 | 111.3 / 111.3 / 111.3 | 336 | 17 | 1342 B |
| cdp | 1280×900 | 456.3 | 28 / 29 | 90.3 / 91.2 / 116.1 | 996 | 52 | 1342 B |

Live hub fixture (`fixtures/hub_fixture.py --tmdb`, port 8001): the real page, real htmx, real
`/media/<id>` partial.

Command: `node bakeoff/ui-probe/web/run-live.mjs` · Artifact: `results/artifacts/run-live.json`

| contender | viewport | warm ms (n=2) | action tiles px | close x,y | top band px | observation |
|---|---|---|---|---|---|---|
| playwright | 390×844 touch | 512 / 471 | 111.3 / 111.3 / 111.3 | 336, 179.3 | 17 | 3526 B |
| playwright | 1280×900 | 477 / 468 | 90.3 / 91.2 / 116.1 | 996, 151 | 52 | 3616 B |
| cdp | 390×844 touch | 560 / 509 | 111.3 / 111.3 / 111.3 | 336, 179.3 | 17 | 3180 B |
| cdp | 1280×900 | 470 / 506 | 90.3 / 91.2 / 116.1 | 996, 151 | 52 | 3156 B |

Reading:

- The static and live sheets measure identically on every T1 value, so the fixture is faithful.
- `launch ms` is cold start (browser process + context). CDP pays ~340 ms more cold; every warm
  task is within a few ms of Playwright's.
- Warm T1 on the live page is ~470–560 ms in both tools; the difference between tools there is
  within the run-to-run spread (Playwright 468–512, CDP 470–560).
- CDP's smaller live observation (3.1–3.2 KB vs 3.5–3.6 KB) is the serialiser dropping structural
  nodes, not a smaller page read. See the RQ10 note on modality.

### RED — the harness measures the real defect

Pre-fix CSS (`e0ac239`) rendered into `fixtures/red/` from the same templates:

```bash
python bakeoff/ui-probe/fixtures/static/render_sheet.py --base-ref e0ac239 \
  --out bakeoff/ui-probe/fixtures/red
node   bakeoff/ui-probe/web/run-all.mjs --dir bakeoff/ui-probe/fixtures/red
```

Exits **1** with 10 assertions, both contenders, on the phone viewport:

| measure | RED (`e0ac239`) | GREEN (current) | expected |
|---|---|---|---|
| action tile widths | 54.3 / 55.1 / 78.1 px | 111.3 / 111.3 / 111.3 | 111 ± 1 |
| close button x | 326 | 336 | 336 ± 1 |
| top band | 56 px | 17 px | 17 ± 1 |

Artifact: `results/artifacts/run-all-red.json`.

### RQ1 (b)-(d) — agent-driven contenders

Each contender ran as a fresh swarm leaf, 3 repeats, plus a no-tool null leaf with the same prompt
frame. **Model: `ollama/deepseek-v4.1-flash:1017-cloud` for every leaf, not `claude-sonnet-5-5` as
the plan specified** — operator, 2026-11-13: "All deepseek / Apples to apples". The same three tasks
on the live hub fixture (`:8001`, first tile of `/recommend`), read-only.

Run: `ui-probe-bakeoff-measure-1` · manifest generator `agents/gen_measure.py` · tabulator
`agents/score_measure.py <results dir>` · Artifact: `results/artifacts/measure-rq1-rq10.json`

| contender | T1 widths + close, both viewports (n=3) | T2 desktop reveal | T2 touch kept hidden | touch `hover:hover` reported false | T3 reached, unrated | wall-clock s (median) | turns (median) | input tok Δ null (median) | output tok Δ null (median) |
|---|---|---|---|---|---|---|---|---|---|
| (b) `playwright-cli` 0.1.24 | 3/3 exact | 3/3 | 3/3 | **3/3** | 3/3 | 233 | 56 | 2.78M | 21k |
| (c) Playwright MCP | 3/3 exact | 3/3 | 3/3 | **2/3** — only via `browser_run_code_unsafe` → CDP `Emulation.setTouchEmulationEnabled`; MCP's own `browser_resize` cannot set touch | 3/3 | 76 | 33 | 1.41M | 9k |
| (d) `agent-browser` 0.43.0 | 3/3 exact (1 run left phone values in notes only) | 3/3 | 3/3 | **0/3** — `set device` sets viewport + UA only; every run reported this itself | 3/3 | 149 | 43 | 2.07M | 18k |
| null control | — | — | — | — | — | 11 | 3 | (69k baseline) | (0) |

Reference: the scripted lane above — phone 111.3 / 111.3 / 111.3, close centre (358, 201.3);
desktop 90.3 / 91.2 / 116.1, close centre (1016, 171). Every measuring run matched to the sub-pixel.

Reading:

- **Layout and the desktop reveal are not discriminating** — all three tools got every number.
- **Touch is.** The hub's reveal is pointer-type gated, so a tool that cannot make the page report
  `hover:none` cannot test the touch half honestly. `.rec-hover` still stayed hidden in every run,
  because no mouse ever entered the tile — not because the page believed it was a touch device.
- **MCP is the cheapest and fastest agent path** (≈ half the CLI's input tokens, a third of its time)
  but needs an escape hatch for touch; the CLI does touch natively at ~2× the tokens.
- Input tokens are dominated by re-sent transcript (`cacheRead` 86–98% of input), so turns drive
  cost: MCP's 33 turns vs the CLI's 56 is most of the gap.
- T3: every run found `form.stars` ("Your rating", unrated). The leaf schema accepted only a number
  for `t3.value` (a harness defect: the swarm schema subset has no nullable union), so runs either
  omitted the value or wrote `0` and said why in `notes`. Scored on the notes, not the field.
- Footer labels varied between runs (`Upload .torrent` is a `<label>`; `Add to qBittorrent` is
  hidden until a file is chosen) — the task wording, not the tools.

---

## RQ2 — hover and pointer reality

Command: `node bakeoff/ui-probe/web/run-all.mjs` (static) and `run-live.mjs` (live) ·
Artifacts: `run-all.json`, `run-live.json`

| contender | page | viewport | `hover:hover` | `pointer:fine` | `maxTouchPoints` | after input |
|---|---|---|---|---|---|---|
| playwright | static | 1280×900 | true | true | 0 | mouse → `display:flex`, `.mouse-over` set, 3/3 buttons visible |
| playwright | static | 390×844 | false | false | 1 | tap → `display:none`, no `.mouse-over`, 0/3 |
| cdp | static | 1280×900 | true | true | 0 | mouse → `display:flex`, `.mouse-over` set, 3/3 buttons visible |
| cdp | static | 390×844 | false | false | 1 | tap → `display:none`, no `.mouse-over`, 0/3 |
| playwright | live | 1280×900 | true | true | 0 | mouse → `display:flex`, `.mouse-over` set, sheet not opened |
| playwright | live | 390×844 | false | false | 1 | tap → `display:none`, `.mouse-over` false, **sheet opened** |
| cdp | live | 1280×900 | true | true | 0 | mouse → `display:flex`, `.mouse-over` set, sheet not opened |
| cdp | live | 390×844 | false | false | 1 | tap → `display:none`, `.mouse-over` false, **sheet opened** |

Both tools reproduce the app's own pointer-type gate exactly: the same `matchMedia` answers, the
same `pointerType`-gated class, and on the live page the tap falls through to the tile's real
action. Neither tool needed a workaround; the harness emulates touch the same way in both
(`hasTouch`/`isMobile` vs `Emulation.setTouchEmulationEnabled`).

---

## RQ3 — temporal capture

Two arms, because the target's own reveal has no animation to sample: `.rec-hover` flips
`display:none → flex` with no transition. The "controlled" arm injects the same 240 ms WAAPI
animation into both tools with `element.animate()`, from the revealed state so it paints.

Command: `node bakeoff/ui-probe/web/run-rq3.mjs` · Artifact: `results/artifacts/rq3.json`
plus `results/artifacts/rq3-trace-playwright.zip`

| contender | real reveal: getAnimations / rAF | controlled: getAnimations | A rAF sampling | B metadata | C filmstrip (median of 3) |
|---|---|---|---|---|---|
| playwright | 0 animations; flip caught at sample 6 of 17 | 1 animation, 240 ms, `transform`+`opacity` | 19 samples, 1986 B | 174 B | 17 frames, 93.6 KB, 444.5 ms |
| cdp | 0 animations; flip caught at sample 6 of 17 | 1 animation, 240 ms, `transform`+`opacity` | 19 samples, 1993 B | 174 B | 17 frames, 203.3 KB, 410.2 ms |

What each instrument detects:

- **Computed-style sampling (A)** is the only one that sees the real reveal: it catches the frame
  where `display` goes `none → flex` and `.mouse-over` appears. It carries the evidence in ~2 KB.
- **`getAnimations()` (B)** sees nothing at all on the real reveal (0 animations) and full metadata
  on the injected one for 174 B, but no frame-by-frame values.
- **Filmstrip (C)** proves a frame existed but carries no property values. Per frame:
  Playwright 5.5 KB, CDP 12.0 KB (JPEG q60 over the raw socket vs the trace's compressed frames).
- Filmstrip wall-clock is ~410–445 ms in both, but 400 ms of that is the fixed capture window, so
  the instruments cost ~10–45 ms around it. Not a discriminating measurement at this scale.

The filmstrip arm had to hover first: a `display:none` element paints no frames, and without that
wait both capture paths filmed an empty rectangle. That wait is applied to both contenders.

---

## RQ9 — can a write be stopped, and proved stopped

Same live page, same action ("Seen it"), same 1.5 s settle, three arms:

- `unguarded` — positive control. The POST must leave and land.
- `network-guard` — every non-GET aborted at the network layer
  (Playwright `context.route()` → `route.abort("blockedbyclient")`; CDP `Fetch.enable` →
  `Fetch.failRequest("BlockedByClient")`).
- `action-allowlist` — no interception at all: the runner reads the target form's declared method
  and refuses to dispatch the click unless it is on the allowlist. Identical code for both tools.

Evidence is two-sided on purpose: the fixture's access log (did a request leave?) and the scratch
DB's `rec_feedback` row count (did it land?). Each arm clears its title's rows first.

Command: `node bakeoff/ui-probe/web/run-rq9.mjs` · Artifact: `results/artifacts/rq9.json`

| contender | arm | POSTs logged | `rec_feedback` rows | button after | guard evidence | end-to-end |
|---|---|---|---|---|---|---|
| playwright | unguarded | 1 | 0 → 1 | Seen (on) | none | 3128 ms |
| playwright | network-guard | 0 | 0 → 0 | Seen it | 1 request aborted | 2971 ms |
| playwright | action-allowlist | 0 | 0 → 0 | Seen it | refused: `POST /recommend/action` | 3024 ms |
| cdp | unguarded | 1 | 0 → 1 | Seen (on) | none | 3080 ms |
| cdp | network-guard | 0 | 0 → 0 | Seen it | 1 request aborted | 3179 ms |
| cdp | action-allowlist | 0 | 0 → 0 | Seen it | refused: `POST /recommend/action` | 3141 ms |

Both tools stop the same write with the same two-sided evidence, at the same cost (within ~200 ms,
which is the spread of the six arms). The scenario-layer allowlist needs no tool support at all and
was the cheapest to reason about — it refuses before any input is dispatched.

One fixture requirement found here: the sheet cannot open without a TMDB key. `/media/<id>` fetches
TMDB detail and answers `401 → 500` without one, so `run-rq9.mjs` and `run-live.mjs` pass `--tmdb`
(read-only metadata; the profile, rows and titles are synthetic).

---

## RQ10 — observation size and model answers

Two arms, same steps:

- `full` — the tool's whole-page observation.
- `delta` — only the subtree the app just swapped (Playwright `ariaSnapshot(selector)`; CDP the
  target's subtree out of `getFullAXTree`, located via `getPartialAXTree`).

Three journeys on the live page, 7–8 steps each. Token figures are the fixed `chars/4` estimate —
no model calls were made here.

Command: `node bakeoff/ui-probe/web/run-rq10.mjs` · Artifacts: `results/artifacts/rq10.json`
and `results/artifacts/rq10-observations.json` (every observation text, both arms, all steps).

| contender | journey | full (bytes / tokens) | delta (bytes / tokens) | saved |
|---|---|---|---|---|
| playwright | J1 open and inspect (7 steps) | 12187 / 3038 | 3316 / 822 | 73% |
| playwright | J2 action loop (8 steps) | 15752 / 3922 | 3794 / 938 | 76% |
| playwright | J3 change outside the delta (8 steps) | 15729 / 3918 | 3346 / 829 | 79% |
| cdp | J1 open and inspect (7 steps) | 11268 / 2809 | 3821 / 949 | 66% |
| cdp | J2 action loop (8 steps) | 12548 / 3122 | 4591 / 1135 | 63% |
| cdp | J3 change outside the delta (8 steps) | 12529 / 3118 | 3928 / 973 | 69% |

### The delta arm is blind, and J3 measures it

J3 presses "My list" inside the open sheet. The app swaps `#detail-rec` **and** rewrites the tile
badge — a different subtree, outside the delta subscription. Ground truth is read from the DOM, not
from either observation.

| contender | tile badge before → after | full observation carries it | swapped subtree carries it |
|---|---|---|---|
| playwright | `""` → `"In list"` | true | false |
| cdp | `""` → `"In list"` | **false** | false |

Playwright's full observation carries the outside change; its delta observation does not. CDP's
**full** observation misses it too, for a reason that is a finding in its own right: with a modal
`<dialog>` open, `Accessibility.getFullAXTree` contains only the dialog — `aria-modal` hides the
background — while Playwright's aria snapshot still lists the page behind it.

Consequences for reading the table:

- The delta saving is real for both tools (63–79%), but it is measured against a full observation
  that is itself incomplete when a modal is open.
- CDP's "full" figures are therefore not comparable to Playwright's on any step with the sheet open;
  its smaller full-observation bytes are partly omitted content, not compression.
- Token counts are `chars/4` estimates over the tool's own text form, so a terser serialiser lowers
  the count without lowering what the agent knows. Only the model-answer half can price that.

### Model-answer half

One fresh leaf per contender × journey × arm (12 leaves), `ollama/deepseek-v4.1-flash:1017-cloud`
(operator, 2026-11-13: "All deepseek / Apples to apples"), reading only that arm's observations
(`results/rq10-inputs/<contender>-<journey>-<arm>.md`, enforced by `mustRead`). Question: the final
badge on the "Harbour Lights" tile, and which actions were on the last time the action block was
observed. Ground truth: `rq10.json` `steps[].state`.

| arm | badge right | pressed set right |
|---|---|---|
| full | 6/6 | 5/6 — `cdp` J2 dropped "Not for me" |
| delta | 6/6 | 6/6 |

Reading:

- At n=1 per cell the delta arm lost **no** accuracy for 63–79% fewer bytes.
- **J3 did not test the blindness it was built for.** Its final step re-reads the grid in both arms,
  so the badge change outside the subscription is visible by the end; the stale-mid-journey case
  (asking *before* the re-read) was never posed. Probe still to run: the same leaves asked at J3
  step 6, where the delta arm has not yet seen the badge.
- The one miss was on a full arm: three toggles, of which "Not for me" changes no label, so
  the model had to infer it from `pressed`/`on`, which `cdp`'s serialiser does not print.

---

## Open items across the lane

- **RQ10 stale-mid-journey question** — ask J3 at step 6 (before the grid re-read); see above.
- **Playwright browser coverage** — only `chromium_headless_shell` is installed under
  `%LOCALAPPDATA%\ui-probe\ms-playwright`; no WebKit/Firefox comparison was asked for or run.
- **Filmstrip pixel diff** — RQ3 reports frame counts and bytes; it does not diff frames pixel-wise.
  The instruments' detection claims (property values vs frame presence) do not depend on that.
- **RQ1 (b)-(d) on `claude-sonnet-5-5`** — the plan's model; this round ran deepseek by operator choice.
- **`formats/score.mjs`** (a test-plan gate) — not present in this worktree; it belongs to another
  lane. Not written here.
- **Fixture safety check** — `python fixtures/hub_fixture.py --check` passes: environment names
  only, scratch `DB_PATH`/`RECOMMEND_DATA_DIR`, sync and stuffing off, dead-loopback
  `PLEX_HOST`/`QB_HOST`/`RECOMMEND_LLM_URL`, no credential-family variable.
