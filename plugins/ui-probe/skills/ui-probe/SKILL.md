---
name: ui-probe
description: >-
  Use when a session needs evidence about a running web app or Tizen TV app — layout measurements, responsive
  behavior, remote-key behavior, a JSON endpoint, or a platform probe. Triggers — "check the UI", "capture the
  page", "test the remote", "probe the TV". SKIP for: desktop windows or OCR targets.
---

# ui-probe

Observe a running web app by measuring it, not by asking the operator and not by reading a picture. Two verbs
do the observing: `capture` records the state of a page, `run` judges a claim against a scenario file.

Every command goes through `/ui-probe`. The command file resolves the plugin's own location, so never build
a path to the binary yourself — a relative path resolves against the user's cwd and breaks.

## The Iron Law

```
NO IMAGE IS EVER READ, AND NO UI CLAIM IS MADE WITHOUT A ui-probe OUTPUT.
```

**Violating the letter of the rules is violating the spirit of the rules.**

No exceptions:

- not "just a glance to check the screenshot rendered";
- not "the observation text was ambiguous, the picture would settle it";
- not "I'll look once before handing it to the operator";
- not "it's a tiny thumbnail".

An image read can kill a cloud-run session outright. `screenshot.png` is a deliverable for the operator: name
its path and stop.

## Capture, or run a scenario?

| | `capture` | `run` |
|---|---|---|
| answers | "what is this page doing right now" | "does this claim hold" |
| needs | a config screen, or `--url` | a scenario file on disk |
| output | `screenshot.png`, `measure.json`, `env.json`, `observation.txt`, `dom.html`, `console.json`, `network.json`, `assets.json` | `results.json` with one record per step |
| verdict | none — you read the numbers | `passed` / `failed` / `inconclusive` / `needs_review`, plus an exit code |
| lives on | nothing; the out dir dies with the session | the repo — a regression stays checked |

Pick `capture` for one question about one page: "how wide are the action tiles at phone width", "is the sheet
open", "what does the action block say".

Pick `run` when the answer must stay true across changes, or when the question is behavioural: "does hovering
reveal the bar", "does a tap open the sheet", "does this endpoint still answer 200". A hand-rolled probe dies
with its session; a scenario does not.

## The read-only default

Both guards are on unless you pass `--allow-writes`:

1. Every non-GET, non-HEAD, non-OPTIONS request is failed at the network layer and recorded in `network.json`.
2. A `click` or `tap` whose target submits a non-GET form is refused before any input is dispatched — the step
   records the failure type `write_blocked`.

Neither layer stops a **GET that has a side effect**. So point the probe at a fixture or a local dev server,
never at a live service. `--allow-writes` turns both layers off for one run: use it only on a page you own and
can reset.

## Tizen TV

Use `--device tv` when the question needs the installed app on a real Tizen set: the TV's browser, remote input, or platform behavior. Use `--device desktop` (the default) to run a `backend: tv` journey in desktop Chromium at TV dimensions with the same key events. Desktop iteration is faster, but it does not prove the TV browser behaves the same. Configure `tv.host` and `tv.appid` in `.ui-probe.json`, then run `/ui-probe doctor` before attaching.

A TV capture attaches to the app already running on the set. Its DOM observation marks the app's configured focus element (default selector `.focused`) with `[focused]`; many TV apps move this marker while `document.activeElement` stays on `body`. Capture writes under `<outDir>/tv/`. `--screenshot` is opt-in because replay is slow and uses TV CPU. `screenshot.png` is for the operator only: give them its path when requested, and never Read it.

`/ui-probe tv probe --navigate http://127.0.0.1:8001` writes `platform.json` and reports Tizen API availability, video behavior, injected keys, and whether the page reached the test URL. After a launch it waits for the app's page to settle (bounded at 20 s), and every step and the verdict name the page they measured. Its final verdict line names that page, or says it could not be read: `shell: plan A` when it is an `http(s)` page and both `registerKey("1")` returned and `getCurrentApplication()` returned an object, `shell: plan B` when it is a widget-local (non-`http(s)`) page with the same two calls working, `shell: no tizen` when the calls are absent or threw, or `shell: undetermined` when the page itself could not be read, so neither plan can be claimed. Presence alone is never a plan. `--fetch <url>` makes one credentialed GET from the settled page and records its status and CORS headers; `--exit` exits the app last and reports whether the inspector closed within 3 s.

`--listen` is a guided physical-press check, one key at a time. For each key the TV shows a full-width banner — "Press 1 on the remote" — then either ticks the press with the `key`, `code` and `keyCode` it received, or says "not received" after `--listen-wait <seconds>` (default 8), holds that for about a second, and moves on. The CLI prints the key list and the per-key wait before the banner appears, so the operator at the remote knows what to press and how long they have. Matching is by `keyCode`; every event is recorded, so a press that was not asked for still shows in `platform.json`'s `listen.events`, while `listen.results` holds one `{key, received, register, event?, unregister?}` per key. Each non-mandatory key is registered with `tizen.tvinputdevice.registerKey` just before its banner and unregistered after its result, because only the arrows, Enter and Back reach a Tizen page unregistered; a miss whose register did not return carries `(registerKey absent)` or `(registerKey threw)` in both the digest and the TV banner. This is the only check that proves a physical press reaches the page: CDP input bypasses `registerKey`, so injected keys cannot settle it.

The remote key names are `Left`, `Up`, `Right`, `Down`, `Enter`, `Back`, `Digit0` through `Digit9`, and `MediaPlay`, `MediaPause`, `MediaPlayPause`, `MediaStop`, `MediaRewind`, `MediaFastForward`. Use these names in `key` steps, and as the comma-separated list `--listen` takes. During `tv probe`, Back and Enter are withheld until navigation reaches the test URL, because either can leave or act on the installed app; the `--listen` prompts follow the same gate — the defaults are `Left`, `Right`, `Digit1` and `MediaPlay`, gaining `Enter` and `Back` only on the fixture grid. A key list you pass yourself overrides that default, so name Back only when the app's root can survive it.

A `--device tv` run or capture has no action guard — a key press targets no form — so the network guard is the only one. There, `--allow-writes` allows writes to `tv.testOrigin` only: every write to another origin is still blocked and recorded. When the target offers no interception at all, a TV run or capture starts only with `--allow-writes` and every `open` naming `tv.testOrigin`.

### Flags worth knowing

- `--viewport phone,desktop` — `capture` runs both built-ins when you name none. `phone` is 390×844 with touch,
  `desktop` 1280×900.
- `--out <dir>` — write the run somewhere you can find later. The default is a timestamped folder under the OS
  temp dir: right for a one-off, wrong for anything you will refer to again.
- `--include-background` — add the page behind an open `aria-modal` dialog to `observation.txt`.
- `--var k=v` — fills `{name}` placeholders in the config's auth cookie commands. A value containing a path
  separator or a shell metacharacter is rejected, and the error names the variable, never the value. Both
  `capture` and `run` set those cookies before their first navigation: a scenario against a signed-in page needs
  them as much as a capture does.

## Reading the outputs

**`measure.json`** — the numbers. One array per `measure` selector, one `{x, y, width, height}` entry per
matched element in document order. CSS pixels, fractions kept: `111.3` is a real reading, `111` is a
rounded one. Count the array to learn how many elements matched. Never round before comparing, and never
compare without the scenario's `tolerance`.

**`env.json`** — what the page reports about itself: `hover`, `pointer`, `maxTouchPoints`, and the viewport it
actually got. Read it **before trusting any hover or tap result**. A viewport alone does not make a page a
touch device; if `hover` reads `hover` at a 390×844 viewport, the emulation did not take and every pointer
result from that run is void.

**`observation.txt`** — the accessibility tree, with each node's ARIA state (`pressed`, `checked`, `expanded`,
`selected`, `disabled`) beside its role and name. Read it when the question is what the app *says* is there.
State is what changes when a label does not: a toggle whose text stays "Not for me" is only visible as
`pressed`. With an `aria-modal` dialog open the default tree holds **only the dialog** — capture again with
`--include-background` to see the page behind it.

**`screenshot.png`** — operator only. Path in the report, never `Read`.

**`network.json`** — method, URL, status and blocked-or-not, with no headers, so it never carries a cookie.
Read it to prove a request was stopped or never left.

**`dom.html`, `console.json`, `assets.json`** — when the tree is not enough: the raw markup to find a
selector, a JavaScript error the page threw, or a request the page made.

## Outcomes and exit codes

Per step: `passed`, `failed`, `inconclusive`. Per run the worst step wins, and a step after the first
`failed` or `inconclusive` one does not run — it is reported as not run.

| outcome | means | what you do |
|---|---|---|
| `passed` | the probe saw the app, the claim held | report `measured` beside `expected` |
| `failed` | the probe saw the app, the app was wrong | quote `measured` beside `expected` — that is the defect |
| `inconclusive` | the probe could not judge | fix the target or the fixture; never report it as a pass |
| `needs_review` | the scenario asserts nothing, so no browser launched | add an assertion step |

A `failed` step may carry a failure type when the target itself was the problem:

- `not_found` — 0 elements matched. Tighten or correct the selector. (`expect_hidden` treats it as a pass.)
- `ambiguous_target` — more than one match where one action needs one. Narrow the selector.
- `stale_target` — the node resolved at step start was gone by dispatch. The page re-rendered; assert on the
  new state first.
- `target_obscured` — the runner scrolls the target into view first, so this means something covers its
  centre, usually a modal or a sticky bar — not that the target is off screen. Close it, or pick another
  target.
- `write_blocked` — the target submits a non-GET form and the guard refused it. That is the guard working.

Exit codes, which tell you what to do next:

| code | meaning | next move |
|---|---|---|
| 0 | every step passed | report it |
| 1 | a step failed | the app is wrong; quote measured vs expected |
| 2 | a step was inconclusive | the probe or the fixture is wrong, not the app |
| 3 | `needs_review` | the scenario asserts nothing — add an assertion |
| 64 | invalid scenario, config or arguments | `validate` names the field, the fix and a correct example |

## Workflow

1. **`/ui-probe doctor`** — browser found and launchable, config valid, `baseUrl` reachable. Run it on a new
   setup; it exits non-zero naming the first failing check. The config is `.ui-probe.json`, found by walking
   up from the cwd, so work from inside the project.
2. **`/ui-probe screens`** — does this page already have a name? A named screen carries its `url` and its
   `measure` selectors, so the capture command is one word.
3. **Pick the verb** — see *Capture, or run a scenario?* above.
4. **A scenario: write it, then `/ui-probe validate <file>` until it exits 0, then `/ui-probe run <file>`.**
   Never run an unvalidated file; exit 64 is cheaper to fix than a half-run.
5. **Read the digest lines first**, then only the output files that answer the question. Do not open the whole
   out dir.
6. **Report the measurement.** One line per assertion, `measured` beside `expected`, with `<file>:<step>`. For
   a capture the digest lines already are the report — copy them, and hand the operator the
   `screenshot.png` path.

## Worked examples

Every example names its URL and its selectors. A scenario whose target is vague cannot be caught by
`validate` — the file is syntactically fine and asserts nothing useful.

### A named screen, captured at two viewports

`.ui-probe.json` beside the app:

```json
{
  "baseUrl": "http://127.0.0.1:8001",
  "screens": {
    "detail-sheet": {
      "url": "/media/900001",
      "measure": ["[data-testid=action-tile]"]
    }
  }
}
```

```
/ui-probe capture detail-sheet --viewport phone,desktop
```

A screen may also carry `steps` — IR steps that run before the capture, for a page you have to click into.

The digest comes back in one block per viewport. Each block ends with its own `out:` line, the directory
holding that viewport's eight files:

```
phone 390×844 hover:none pointer:coarse
[data-testid=action-tile] widths=111.3,111.3,111.3
blocked: 0
out: <outDir>/phone
desktop 1280×900 hover:hover pointer:fine
[data-testid=action-tile] widths=90.3,91.2,116.1
blocked: 0
out: <outDir>/desktop
```

Three widths on one line means three matches. The same page lays out differently at each viewport, and the
same config produces both readings in one command. Add selectors to `measure` and each gets its own line;
`measure.json` holds every box either way.

When the screen's `steps` do not all pass, the block carries `steps: <outcome>` and then the first failing
step's line in the run digest's form:

```
[data-testid=action-tile] widths=54,111,111
steps: failed
FAILED detail-sheet:2 expect_widths [data-testid=action-tile] measured=[54,111,111] expected=111
blocked: 0
```

That line names the step, its op, its target and both values, so a failed screen step is diagnosed from the
digest — never by re-running the capture as a scenario.

### Widths, at one viewport

```yaml
id: detail-sheet-tiles
backend: browser
steps:
  - viewport: { width: 390, height: 844, touch: true }
  - open: { url: "/media/900001" }
  - expect_widths:
      target: "[data-testid=action-tile]"
      equals: [111, 111, 111]
      tolerance: 1
```

A `url` starting with `/` is prefixed with the config's `baseUrl`. `equals` is one width per match, or a single
number every match must equal.

### The pointer gate: hover reveals, tap does not

```yaml
id: hover-bar-desktop
backend: browser
steps:
  - viewport: { width: 1280, height: 900 }
  - open: { url: "/media/900001" }
  - hover: { target: ".rec-tile" }
  - expect_css: { target: "[data-testid=hover-bar]", property: opacity, equals: "1" }
```

```yaml
id: hover-bar-touch
backend: browser
steps:
  - viewport: { width: 390, height: 844, touch: true }
  - open: { url: "/media/900001" }
  - tap: { target: ".rec-tile" }
  - expect_css: { target: "[data-testid=hover-bar]", property: opacity, equals: "0" }
```

Two files, not one: each run gets one pointer type, and each exit code then belongs to one viewport. Confirm the
emulation took by reading `hover` in `env.json` after the run.

### A reveal that arrives late

```yaml
id: hover-bar-late
backend: browser
steps:
  - viewport: { width: 1280, height: 900 }
  - open: { url: "/media/900001" }
  - hover: { target: ".rec-tile" }
  - expect_css: { target: "[data-testid=hover-bar]", property: display, equals: flex, over: 400 }
```

`over` samples the computed value every animation frame for that many milliseconds and passes if any frame
matches, carrying that frame's index and time into the result. A window that never matches records
`frame.index: -1` and `frame.frames` — the number of frames sampled, not a time. Without it the assertion
polls until `timeoutMs` (default 5000) — use `timeoutMs: 0` for a single deliberate sample. A `display` flip
has no animation to query; the frames are the only instrument that sees it.

### A page with no browser at all

```yaml
id: health
backend: http
steps:
  - expect_json: { url: "/health", path: ok, equals: true }
```

`backend: http` launches no browser and allows only `expect_json`. A network error or a non-2xx is
`inconclusive`, not `failed`.

## Anti-patterns

- **Asking the operator how it looks** when a capture would answer it. That is the question this plugin exists
  to remove.
- **Reading `screenshot.png`**, or handing the operator a description of it. The path is the deliverable.
- **Reading `dom.html` whole** when `observation.txt` answers the question. The markup is for finding a
  selector, not for reasoning about layout.
- **Running before validating.** `validate <file>` first, every time.
- **Re-running a `failed` step hoping for a pass.** A failed step means the app was measured and was wrong;
  only `inconclusive` is worth re-running, and only after you find out why the probe could not judge.
- **Asserting on what a screenshot looks like.** Pixels are not a measurement; `measure.json` is.
- **Writing a scenario from a vague ask.** "The action row looks right" names no selector. Open `dom.html`,
  find the element, name it.

## Rationalisations — rejected

| excuse | reality |
|---|---|
| "The operator is right there — I'll just ask them how it looks." | One command answers it with numbers. Asking costs a turn and returns an opinion you then have to trust. |
| "I'll Read the screenshot to confirm it rendered." | An image read can kill a cloud-run session. `measure.json` and `observation.txt` are the evidence; the path goes to the operator. |
| "The viewport was set, so touch is on." | Read `hover` and `pointer` in `env.json`. One real tool reported `hover:hover` at 390×844 — the viewport took, the pointer did not. |
| "The step failed, so the app is broken." | `inconclusive` and the typed failures mean the probe could not judge. Check the target before blaming the app. |
| "It's only a GET, the guard can't stop it anyway." | Correct — which is why the URL must be a fixture or a local dev server, never a live service. |
| "`--allow-writes` will get past the refusal." | It turns off both layers for the whole run. Only on a page you own and can reset. |
| "The tree has no button, so the button is missing." | With an `aria-modal` dialog open the tree holds only the dialog. Re-capture with `--include-background`. |
| "The scenario validates, so it tests something." | `validate` checks shape, not intent. A run returns `needs_review` when no step asserts. |

## Red Flags — STOP

- about to `Read` a `.png`, `.jpg`, `.webp` or anything in the out dir with an image extension
- "I'll just ask the operator how it looks"
- quoting a width with no `measure.json` behind it
- calling an `inconclusive` run a pass, or "probably fine"
- `--allow-writes` on a URL you did not check
- pointing `capture` at anything that is not a fixture or a local dev server
- running a scenario file you have not validated
- writing a step whose `target` you never confirmed matches an element

## Known limitations

- Chromium-family browsers only (Edge, Chrome, Brave).
- CSS selectors only. A `role=` target is rejected as not in this version — find the element in `dom.html` and
  use a CSS selector.
- One fresh browser per run: no warm session, no delta observation, no `compare`.
- Neither guard stops a GET with a side effect.
- `hover` needs a non-touch viewport. At a touch viewport the page reports `hover:none` and nothing reveals —
  that is the app behaving correctly, not a probe failure.
