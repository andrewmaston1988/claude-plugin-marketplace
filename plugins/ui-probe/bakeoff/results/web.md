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
python plugins/ui-probe/bakeoff/fixtures/hub_fixture.py --check
node   plugins/ui-probe/bakeoff/web/run-all.mjs
node   plugins/ui-probe/bakeoff/web/run-live.mjs
node   plugins/ui-probe/bakeoff/web/run-rq3.mjs
node   plugins/ui-probe/bakeoff/web/run-rq9.mjs
node   plugins/ui-probe/bakeoff/web/run-rq10.mjs
```

---

## RQ1 — T1 layout and timing

Static fixture (`fixtures/static/detail-sheet.html`): the real sheet markup rendered from the
torrent-hub templates by `fixtures/static/render_sheet.py`.

Command: `node plugins/ui-probe/bakeoff/web/run-all.mjs` · Artifact: `results/artifacts/run-all.json`

| contender | viewport | launch ms | warm ms (n=2) | action tiles px | close x | top band px | observation |
|---|---|---|---|---|---|---|---|
| playwright | 390×844 touch | 338.5 | 38 / 38 | 111.3 / 111.3 / 111.3 | 336 | 17 | 1200 B |
| playwright | 1280×900 | 113.5 | 34 / 37 | 90.3 / 91.2 / 116.1 | 996 | 52 | 1200 B |
| cdp | 390×844 touch | 469.5 | 28 / 30 | 111.3 / 111.3 / 111.3 | 336 | 17 | 1342 B |
| cdp | 1280×900 | 456.3 | 28 / 29 | 90.3 / 91.2 / 116.1 | 996 | 52 | 1342 B |

Live hub fixture (`fixtures/hub_fixture.py --tmdb`, port 8001): the real page, real htmx, real
`/media/<id>` partial.

Command: `node plugins/ui-probe/bakeoff/web/run-live.mjs` · Artifact: `results/artifacts/run-live.json`

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
python plugins/ui-probe/bakeoff/fixtures/static/render_sheet.py --base-ref e0ac239 \
  --out plugins/ui-probe/bakeoff/fixtures/red
node   plugins/ui-probe/bakeoff/web/run-all.mjs --dir plugins/ui-probe/bakeoff/fixtures/red
```

Exits **1** with 10 assertions, both contenders, on the phone viewport:

| measure | RED (`e0ac239`) | GREEN (current) | expected |
|---|---|---|---|
| action tile widths | 54.3 / 55.1 / 78.1 px | 111.3 / 111.3 / 111.3 | 111 ± 1 |
| close button x | 326 | 336 | 336 ± 1 |
| top band | 56 px | 17 px | 17 ± 1 |

Artifact: `results/artifacts/run-all-red.json`.

---

## RQ2 — hover and pointer reality

Command: `node plugins/ui-probe/bakeoff/web/run-all.mjs` (static) and `run-live.mjs` (live) ·
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

Command: `node plugins/ui-probe/bakeoff/web/run-rq3.mjs` · Artifact: `results/artifacts/rq3.json`
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

Command: `node plugins/ui-probe/bakeoff/web/run-rq9.mjs` · Artifact: `results/artifacts/rq9.json`

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

## RQ10 — observation size (the model-answer half is OPEN)

Two arms, same steps:

- `full` — the tool's whole-page observation.
- `delta` — only the subtree the app just swapped (Playwright `ariaSnapshot(selector)`; CDP the
  target's subtree out of `getFullAXTree`, located via `getPartialAXTree`).

Three journeys on the live page, 7–8 steps each. Token figures are the fixed `chars/4` estimate —
no model calls were made here.

Command: `node plugins/ui-probe/bakeoff/web/run-rq10.mjs` · Artifacts: `results/artifacts/rq10.json`
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

### OPEN — model-answer half

Not run here (this lane owns the size half only). The exact probe still to run:

> Take `results/artifacts/rq10-observations.json`. For each contender × journey, ask a model the
> same fixed question against the `fullText` arm and against the `deltaText` arm alone, then score
> the answers against the ground truth recorded in `rq10.json` (`steps[].state`, which holds the
> tile badges and sheet state read from the DOM). Report accuracy per arm alongside the byte and
> token totals above, and state the model and prompt used.

Until that runs, RQ10 has **size only**. The J3 rows above bound the risk: a delta arm can be 63–79%
smaller and still be unable to answer a question the full arm can.

---

## Open items across the lane

- **RQ10 model-answer half** — probe named above; observations are on disk.
- **Playwright browser coverage** — only `chromium_headless_shell` is installed under
  `%LOCALAPPDATA%\ui-probe\ms-playwright`; no WebKit/Firefox comparison was asked for or run.
- **Filmstrip pixel diff** — RQ3 reports frame counts and bytes; it does not diff frames pixel-wise.
  The instruments' detection claims (property values vs frame presence) do not depend on that.
- **`agent-browser` and `playwright-cli`** — not part of this lane's RQ1 contenders (a) and (e); they
  are other lanes' rows.
- **`formats/score.mjs`** (a test-plan gate) — not present in this worktree; it belongs to another
  lane. Not written here.
- **Fixture safety check** — `python fixtures/hub_fixture.py --check` passes: environment names
  only, scratch `DB_PATH`/`RECOMMEND_DATA_DIR`, sync and stuffing off, dead-loopback
  `PLEX_HOST`/`QB_HOST`/`RECOMMEND_LLM_URL`, no credential-family variable.
