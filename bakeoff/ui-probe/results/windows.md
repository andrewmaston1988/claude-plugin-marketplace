# Windows lane results (RQ4, RQ5)

*Measured 2026-11-13 on Windows 11 Pro 10.0.26200, Windows PowerShell 5.1 (5.1.26100).*

All numbers below come from one shared harness (`windows/harness.mjs`), one command shape per action, and
one output schema; every contender is a thin adapter behind that interface (`windows/adapters.mjs`). Each
contender ran the same tasks, the same fixtures, the same `REPEATS=10`, `WARMUPS=2`, and the same
verification predicate. Workarounds needed by a contender are recorded in its own row, not applied to others.

## Environment and reproduction

| Thing | Value |
|---|---|
| `winapp` | `winapp ui` 0.8.0, on PATH (`where winapp`) |
| PowerShell | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` (5.1 — required; the WinRT OCR projection does not load under pwsh 7) |
| pywinauto | 0.6.9, `uia` backend, Python 3.14 |
| .NET SDK | 8.0.428 (`dotnet --list-sdks`) — **present**, so contender (e) is built, not OPEN |
| FlaUI | 4.0.0 from NuGet; `dotnet build -c Release` in `bakeoff/ui-probe/windows/flaui` (2.4 s) |
| Tesseract | **not installed** — see OPEN rows |
| Fixtures | `powershell.exe -File bakeoff/ui-probe/fixtures/windows_fixtures.ps1 -Kind WinForms\|Wpf\|OwnerDrawn -ReadyFile <tmp>` |

Every run below is from the worktree root:

```
node bakeoff/ui-probe/windows/run.mjs --contender <id>            # latency + every probe
node bakeoff/ui-probe/windows/run.mjs --contender <id> --probes   # probes only, keeps prior latency
node bakeoff/ui-probe/ocr/run-ocr.mjs --repeats 10                # RQ5
```

Latency statistics are `p50/p95 [min–max]` in milliseconds over the 10 measured runs (2 warmups discarded).
`ok` is the shared verification predicate: get = value equals `fixture-value-42`, click = the fixture log
gained a `save-clicked` line, list = exactly 5 items, tree = node count > 0, find = name or PID matches.
All rows verified 10/10 unless stated.

---

## RQ4 — Windows backends

### 4.1 Per-action latency, cold

Cold = a fresh adapter per run, including process start. Artifact: `results/raw/<id>.json`.

| Contender | Command | find | tree | tree_cached | get | click | list |
|---|---|---|---|---|---|---|---|
| `ps-cold` (PowerShell per call) | `run.mjs --contender ps-cold` | 495.5/543.2 | 576/665.6 | 2013/2260 | 520/656.8 | 508/537.8 | 765/914.1 |
| `ps-warm` (first call after start) | `run.mjs --contender ps-warm` | 608.5/881.6 | 666.5/767.6 | 1962/2348.7 | 595/687.8 | 584.5/672.2 | 596/609.7 |
| `flaui-cold` (helper per call) | `run.mjs --contender flaui-cold` | 215/258.2 | 226.5/230.1 | 217.5/255.2 | 186.5/208.6 | 203/239 | 215/249.4 |
| `flaui-warm` (first call after start) | `run.mjs --contender flaui-warm` | 205.5/250.7 | 228.5/252.4 | 236.5/251.5 | 198/239.4 | 199/293.5 | 221.5/236.2 |
| `winapp` (CLI per call) | `run.mjs --contender winapp` | 156/168.9 | 283/372.8 | **UNSUPPORTED** | 243.5/340.2 | 305.5/331.3 | 275/289.2 |
| `pywinauto-call` | `run.mjs --contender pywinauto-call` | 11992.5/12206.7 | 7352.5/7449.2 | **UNSUPPORTED** | 10306.5/15637.2 | 7666/8255.8 | 10266.5/10449.5 |
| `pywinauto-warm` (first call after import) | `run.mjs --contender pywinauto-warm` | 11954/12313.5 | 7201.5/7537.9 | **UNSUPPORTED** | 10219.5/10536.4 | 7655.5/7810.2 | 8961.5/10520.9 |

### 4.2 Per-action latency, warm

Warm = one adapter, 2 warmups, then 10 measured calls. For the two per-call contenders "warm" still pays
process start every time, which is the point of the comparison.

| Contender | Command | find | tree | tree_cached | get | click | list |
|---|---|---|---|---|---|---|---|
| `ps-cold` | `run.mjs --contender ps-cold` | 491/627.6 | 620.5/711 | 1797.5/2092.1 | 489.5/531.6 | 520/749.5 | 752.5/804.3 |
| `ps-warm` | `run.mjs --contender ps-warm` | **1/1** | **53.5/70.2** | **1230.5/1359.1** | **7.5/8** | **16.5/18.5** | **32.5/39** |
| `flaui-cold` | `run.mjs --contender flaui-cold` | 201/260.8 | 226.5/256.8 | 214/251.6 | 185.5/217.2 | 197.5/250.8 | 215/236.4 |
| `flaui-warm` | `run.mjs --contender flaui-warm` | **1/1** | **37.5/39.6** | **112.5/137.2** | **4/6** | **6.5/7** | **31/35.1** |
| `winapp` | `run.mjs --contender winapp` | 165/192.2 | 259/363.3 | **UNSUPPORTED** | 229.5/260.8 | 316.5/350.7 | 270.5/315.3 |
| `pywinauto-call` | `run.mjs --contender pywinauto-call` | 11947.5/12490.2 | 7403.5/8435.9 | **UNSUPPORTED** | 10142/11052.1 | 7709.5/8137.8 | 10030/10384.3 |
| `pywinauto-warm` | `run.mjs --contender pywinauto-warm` | 9591/10527.2 | 4918/9153.5 | **UNSUPPORTED** | 7310/7463.1 | 4746.5/5225.1 | 6807.5/7199.2 |

`tree_cached` UNSUPPORTED rows: winapp exposes no `CacheRequest` surface; pywinauto has no `CacheRequest`
API at all. Recorded as capability gaps, not measured as slow failures.

### 4.3 Tree size and time — with and without `CacheRequest`

Same WinForms fixture, `tree` = plain `FindAll(TreeScope.Descendants)` walk, `tree_cached` = one
`CacheRequest` with `Subtree` + `Push/Pop`. Times are warm p50/p95 ms.

| Contender | tree (uncached) | nodes / bytes | tree_cached | nodes / bytes | CacheRequest saving | Artifact |
|---|---|---|---|---|---|---|
| `ps-warm` | 53.5/70.2 | 17 / 1921 | 1230.5/1359.1 | 17 / 1951 | **-23× (slower)** | `results/raw/ps-warm.json` |
| `flaui-warm` | 37.5/39.6 | 17 / 1884 | 112.5/137.2 | **16** / 1790 | **-3× (slower)** | `results/raw/flaui-warm.json` |
| `ps-cold` | 620.5/711 | 17 / 1911 | 1797.5/2092.1 | 17 / 1938 | -2.9× | `results/raw/ps-cold.json` |
| `flaui-cold` | 226.5/256.8 | 17 / 1871 | 214/251.6 | 16 / 1776 | ~1.06× (noise) | `results/raw/flaui-cold.json` |

Command for every row: `node bakeoff/ui-probe/windows/run.mjs --contender <id>`. Node counts measured
by a direct `tree` / `tree_cached` call on the same fixture (bytes are the row's `bytes_p50`).
`CacheRequest` did not reduce the walk on this fixture for any contender; on the warm workers it is a
straight 3–23× regression, and FlaUI's cached walk returns **16 nodes where the plain walk returns 17** —
one element is dropped, so the cache is also lossy here. (WinForms is 17 descendants; WPF 25 and
OwnerDrawn 8 — see 4.5.)

### 4.4 UIA event delivery

`subscribe` to the fixture window, click `RemoveTarget` (which disposes the checkbox), then poll the
adapter's queue for 2 s. Artifact: `results/raw/<id>.json` → `events`.
Command: `node bakeoff/ui-probe/windows/run.mjs --contender <id> --probes`.

| Contender | structure-changed | property-changed | First event | Notes |
|---|---|---|---|---|
| `ps-warm` | 0 | 2 | 107 ms | Both are `ValuePatternIdentifiers.ValueProperty` |
| `flaui-warm` | 0 | 1 | 100 ms | `Value [#30045]` |
| `flaui-cold` | 0 | 0 | — | Per-call helper: the click costs 4243 ms and the process ends before the event arrives |
| `ps-cold` | not supported | — | — | New process per call, nothing to deliver to |
| `winapp` | not supported | — | — | No event API |
| `pywinauto-call` / `pywinauto-warm` | not supported | — | — | No event API in the uia backend |

**No contender observed a structure-changed event from a WinForms control being disposed** — the click
succeeded and the element was gone on the next `get`, but no removal event reached the queue in 2 s. Only
property changes were delivered.

### 4.5 What each exposes per fixture

`run.mjs --contender <id> --probes`; each row is a fresh adapter (cold) against the listed fixture.
`bytes` is the adapter's stdout payload for that one call. Artifact: `results/raw/<id>.json` → `exposure`.

| Fixture / action | ps-cold | ps-warm | flaui-cold | flaui-warm | winapp | pywinauto-call | pywinauto-warm |
|---|---|---|---|---|---|---|---|
| WPF `find` | ok | ok | ok | ok | ok | ok | ok |
| WPF `tree` nodes / bytes | 25 / 2671 | 25 / 2685 | 25 / 2616 | 25 / 2629 | 25 / 12298 | 25 / 3026 | 25 / 2583 |
| WPF `get` `fixture-value-42` | ok | ok | ok | ok | ok | ok | ok |
| WPF `list` 5 items | ok | ok | ok | ok | ok | ok | ok |
| OwnerDrawn `find` | ok | ok | ok | ok | ok | ok | ok |
| OwnerDrawn `tree` nodes / bytes | 8 / 945 | 8 / 958 | 8 / 903 | 8 / 916 | 8 / **4043** | 8 / 1006 | 8 / 869 |
| OwnerDrawn `get` "Alpha 17" | **not found** | **not found** | **not found** | **not found** | **not found** | **not found** | **not found** |
| Notepad `tree` nodes / bytes | 118 / 12940 | 120 / 13170 | 122 / 13121 | 124 / 13314 | 126 / **79875** | 130 / 16306 | 128 / 13757 |
| Notepad `get` | ok (text) | ok (text) | ok (text) | ok (text) | ok (text) | **"Text editor"** | **"Text editor"** |

Three findings that matter for the output plan:

1. **The owner-drawn window's painted text is invisible to all seven contenders.** Its UIA tree is 8 nodes
   (form + panel + title-bar chrome); `Alpha 17` / `Bravo 42` / `Charlie 99` are absent from every tree and
   `get` fails everywhere. This is the case RQ5 exists for.
2. **winapp's Notepad tree is 6× the bytes of anyone else's** (79,875 vs 13–16 k) for the same node count —
   pretty-printed multi-line JSON plus extra per-node fields. That is agent-context cost, not a latency win.
3. **pywinauto's `get` on Notepad returns the control name `"Text editor"`, not the document text** — it
   resolves the wrong element. Recorded as a pywinauto row result; the workaround below is what makes its
   WPF hits work at all.

Notepad's own node count drifts 118→130 between runs (it varies with its own chrome, and each contender ran
in a separate run). WPF (25) and OwnerDrawn (8) were identical across all seven contenders, so those
columns are directly comparable; treat the Notepad node count as ±10 and the byte counts as the signal.

### 4.6 Failure behaviour

`--probes` runs two probes on the WinForms fixture. Artifact: `results/raw/<id>.json` → `failures`.

**Element gone** — click `RemoveTarget` (disposes the checkbox), then `get 'Enable sync'`:

| Contender | Result | Time | Error text |
|---|---|---|---|
| `ps-warm` | typed failure | 45 ms | `element not found` |
| `flaui-warm` | typed failure | 29 ms | `element not found` |
| `flaui-cold` | typed failure | 152 ms | `element not found` |
| `winapp` | typed failure | 209 ms | `{"code":"element_not_found","message":"No element found matching 'Enable sync'","selector":"Enable sync"}` |
| `ps-cold` | typed failure | 431 ms | `element not found` |
| `pywinauto-warm` | typed failure | 7242 ms | `element not found` |
| `pywinauto-call` | typed failure | 9767 ms | `element not found` |

**Window closed mid-call** — kill the fixture, then `find`, then `tree`:

| Contender | `find` after close | `tree` after close |
|---|---|---|
| `ps-warm` | fails in 13 ms: `element not found` | **returns `ok:true` in 39 ms** — a stub tree for a dead window |
| `ps-cold` | fails in 431 ms: `window not found` | fails in 433 ms: `window not found` |
| `flaui-warm` | fails in 2310 ms: `window not found` | fails in 2316 ms: `window not found` |
| `flaui-cold` | fails in 2530 ms: `window not found` | fails in 2423 ms: `window not found` |
| `winapp` | fails in 165 ms: `AppNotFoundException` | fails in 162 ms: `AppNotFoundException` |
| `pywinauto-warm` | fails in 11757 ms, error is the raw window-spec dict, not a message | fails in 7108 ms, same raw dict |
| `pywinauto-call` | fails in 2639 ms: `window not found` | fails in 2638 ms: `window not found` |

The `ps-warm` stub-tree behaviour is a real hazard for an agent: after the target dies, `tree` still says
`ok`, so a caller that only checks `ok` gets a plausible-looking tree for a window that no longer exists.
FlaUI and the per-call contenders are honest; winapp's error is the most machine-readable of the seven.

### 4.7 Verdict input (this lane only)

- **Long-running worker over per-call, decisively.** Warm p50 for `get`: ps-warm 7.5 ms, flaui-warm 4 ms,
  vs 229.5 ms (winapp), 489.5 ms (ps-cold), 10142 ms (pywinauto-call). The 4–7 ms band is the difference
  between an agent that can afford a perceive-act loop and one that cannot.
- **FlaUI is the fastest and most compact** (find 1 ms, get 4 ms, click 6.5 ms, and the smallest WPF tree
  payload), and it is the only contender whose cold path is under 250 ms for every action.
- **PowerShell UIA needs no install and is competitive warm** (get 7.5 ms, click 16.5 ms) but costs ~600 ms
  to start and its `CacheRequest` is a 23× regression, so it must be a worker, never per call.
- **winapp is the best per-call CLI** (156–317 ms, machine-readable errors) but has no events, no cache, and
  6× the tree bytes.
- **pywinauto is not viable for an interactive loop** at 4.7–12 s per action on this machine.

---

## RQ5 — No-a11y fallback: `PrintWindow` + `Windows.Media.Ocr`

Method ported from `C:/code/vehicle-audio-visual-experience/tools/dhu-ocr.ps1` (2× cubic upscale, WinRT
async awaited through `WindowsRuntimeSystemExtensions.AsTask`). Copied, not imported — that repo was not
touched.

Command: `node bakeoff/ui-probe/ocr/run-ocr.mjs --repeats 10`
Artifact: `results/raw/rq5.json`; PNG: `results/owner-drawn-capture.png`
(`capture.ps1` = `PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT 0x2)`, `ocr-json.ps1` = PNG → OCR JSON.)

### 5.1 Cost

| Measure | p50 | p95 | Range | Notes |
|---|---|---|---|---|
| Capture (PrintWindow → PNG) | 25 ms | 33.9 ms | 21–38 ms | 560×420, 10,893 bytes |
| OCR (`Windows.Media.Ocr`, 2× cubic) | 165.5 ms | 179.6 ms | 160–185 ms | en-GB engine from user profile |
| Full round trip, in-process | — | — | 490 ms | Two `powershell.exe` starts (capture + OCR) dominate; the measured work is 190 ms |

10/10 runs produced both a capture and an OCR result.

### 5.2 Accuracy on the three known labels

Labels painted with GDI `TextRenderer.DrawText` on a panel — no child controls, absent from every UIA tree
(see 4.5).

| Label | Exact match | Word boxes (window px) | Words returned | Artifact |
|---|---|---|---|---|
| `Alpha 17` | **10/10** | x 78, y 109, w 158, h 38 | `Alpha`, `17` | `results/raw/rq5.json` |
| `Bravo 42` | **10/10** | x 80, y 200, w 152, h 31 | `Bravo`, `42` | `results/raw/rq5.json` |
| `Charlie 99` | **10/10** | x 76, y 289, w 176, h 32 | `Charlie`, `99` | `results/raw/rq5.json` |

Boxes are reported back in window pixels (the OCR result is in 2× upscaled space and divided by the scale).
Painted label origins are y=70/160/250 in client coordinates; measured tops land 39 px lower, which is the
title bar plus the line box — consistent across all three, so the boxes are usable for click targeting.

### 5.3 Real-world check — Blender (already running, never launched by the bake-off)

| Measure | Value |
|---|---|
| Window | PID 35696, 2576×1408, `PrintWindow` capture 537,243 bytes |
| OCR | 47 lines in 213 ms |
| Sample | `* perpart•.'16-painted - Blender 5.1.2` / `File Edit Render Window Help` / `Layout Modeling Sculpting …` |
| Artifact | `results/raw/rq5.json` → `blender`; the capture is written to `results/blender-capture.png` locally and is **not committed** (it is the operator's screen, regenerated by `run-ocr.mjs` whenever Blender is running) |

Blender's UIA tree is title-bar only, and OCR recovered the title, the menu bar and the workspace tabs
from the same capture — the fallback works on a real no-a11y application, not just the fixture.

---

## OPEN rows — exact probe still to run

| Row | Why it is OPEN | Exact probe |
|---|---|---|
| RQ5 Tesseract cross-check | Tesseract is not installed and the lane must not install anything | `winget install UB-Mannheim.TesseractOCR`, then `tesseract results/owner-drawn-capture.png stdout --psm 6` and score the same three labels with `ocr/run-ocr.mjs`'s `score()` |
| RQ4 `CacheRequest` on a large tree | The fixtures are 8–25 nodes; the cached/uncached comparison was only measured there, where the request overhead dominates | Re-run `--contender ps-warm --actions tree,tree_cached` and `--contender flaui-warm --actions tree,tree_cached` against a 500+ node window (e.g. Blender's outliner or a File Explorer window) to see whether `CacheRequest` ever pays |
| RQ4 structure-changed delivery | 0 events from all seven contenders; only a WinForms control disposal was exercised | `subscribe`, then open a modal dialog or add a control in the fixture, and poll `events` for a `structure` entry |

---

## Harness caveats

1. **PowerShell 5.1 stdout defaults to code page 850.** cp850's best-fit table maps `•` (U+2022, which
   appears in Blender's window title and therefore in its OCR text) to byte `0x07`, producing a raw BEL
   inside the JSON string and making the document unparseable. `ocr-json.ps1` now sets
   `[Console]::OutputEncoding` and `$OutputEncoding` to UTF-8 before emitting. The UIA contender scripts
   (`uia-script.ps1`, `uia-worker.ps1`) were measured without that line — harmless for the ASCII fixtures,
   but any non-ASCII element name would be mangled the same way. Add the line before re-running them against
   a non-ASCII target.
2. **pywinauto workaround (recorded in its row, not applied to other contenders).** `child_window()` does not
   reach the WPF fixture's `Fixture Text` through the nested panes (TimeoutError for title, auto_id and
   title+control_type), while `descendants()` sees it. `pywinauto_cli.py` therefore falls back to a full
   descendant scan on a miss, which costs a whole-tree walk on every miss and is why pywinauto's `find` and
   `get` rows are 10–12 s. It also explains the Notepad `get` miss ("Text editor"): the scan returns the
   first name/auto_id match, not the value-bearing element.
3. **Fixtures must be launched visible.** `spawn(..., { windowsHide: true })` makes a hosted WinForms/WPF
   window start hidden (SW_HIDE is inherited), so the harness launches fixtures without it.
4. **Owner-drawn fixture paint handler needs script scope.** A `Paint` handler reading function-local
   variables throws once per paint and leaves the window blank behind a WinForms exception dialog; the
   labels are held in `$script:ownerLabels`. The first RQ5 run measured 0/3 and OCR read the exception text
   back out of the dialog. Fixed before the numbers above were taken.
5. **Split runs merge.** `--actions` keeps the other actions' rows and every probe; `--probes` keeps every
   latency row and refreshes only exposure/events/failures. The `results/raw/*.json` files are the merge of
   both.
