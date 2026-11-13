# ui-probe bake-off — results

One table per Research Question. Each row carries a headline number from a lane fragment
under `results/`. The fragment holds the full table, the command that produced it and its artifact
path, so the numbers live there and this page only indexes them. Plan: `ui-probe-0-bakeoff.md` in
the CLAUDE repo (`repos/claude-plugin-marketplace/plans/`).

**Model deviation, recorded once:** every agent-driven leaf (RQ1 b–d, RQ8, RQ10's answer half) ran
on `ollama/deepseek-v4.1-flash:1017-cloud`. The plan specified `claude-sonnet-5-5` for RQ1 and RQ10,
and `claude-haiku-5-5` + `minimax-m3.1-flash:cloud` for RQ8. Minimax was denylisted, and the
operator chose one model for every leaf (2026-11-13: "All deepseek / Apples to apples").

## RQ1 — web observation, agent-facing → [`results/web.md` § RQ1](results/web.md)

| contender | T1 layout | T2 touch reported as touch | median wall-clock | median input tokens Δ null | notes |
|---|---|---|---|---|---|
| (a) Playwright library | exact | yes | ~470 ms warm | n/a (model-free) | deterministic baseline |
| (e) `cdp.mjs` | exact | yes | ~470–560 ms warm | n/a (model-free) | 0 dependencies; ~340 ms more cold start |
| (b) `playwright-cli` | 3/3 exact | **3/3** | 233 s | 2.78M | native touch emulation |
| (c) Playwright MCP | 3/3 exact | **2/3**, via a CDP escape hatch | 76 s | 1.41M | cheapest agent path; `browser_resize` cannot set touch |
| (d) `agent-browser` | 3/3 exact | **0/3** | 149 s | 2.07M | cannot emulate a touch pointer |

## RQ2 — hover and pointer reality → [`results/web.md` § RQ2](results/web.md)

| finding | evidence |
|---|---|
| A real mouse path (Playwright `mouse.move`, CDP `Input.dispatchMouseEvent`) triggers the hub's pointer-type reveal; a touch-emulated viewport keeps it hidden and reports `hover:none` | both scripted tools, static and live pages, 8/8 rows |
| Among the agent CLIs, only `playwright-cli` makes the page report `hover:none` without a workaround | RQ1 (b)–(d) table |

## RQ3 — temporal capture → [`results/web.md` § RQ3](results/web.md)

| instrument | sees the real reveal | bytes |
|---|---|---|
| computed-style rAF sampling | **yes** (frame 6 of 17) | ~2 KB |
| `getAnimations()` | no (0 animations on a `display` flip) | 174 B |
| filmstrip | proves a frame, carries no values | 94–203 KB |

## RQ4 — Windows backend → [`results/windows.md` § RQ4](results/windows.md)

| verdict | headline |
|---|---|
| **Long-running worker, not per-call** | warm `get` p50: FlaUI worker 4 ms, PowerShell UIA worker 7.5 ms vs `winapp` 229.5 ms, cold PowerShell 489.5 ms, pywinauto 10142 ms |
| PowerShell UIA `CacheRequest` | a 23× regression on the small fixtures; the large-tree case is OPEN |

## RQ5 — no-a11y fallback → [`results/windows.md` § RQ5](results/windows.md)

| measure | value |
|---|---|
| `PrintWindow` + `Windows.Media.Ocr` on painted labels | 30/30 exact; boxes usable for click targeting |
| cost | capture 25 ms + OCR 165.5 ms (p50); two process starts take the round trip to 490 ms |
| real-world (Blender) | 47 lines in 213 ms: title, menus and tabs recovered |
| Tesseract cross-check | OPEN (not installed) |

## RQ6 — TV → [`results/protocols-tv.md` § RQ6](results/protocols-tv.md)

| finding | evidence |
|---|---|
| `cdp.mjs` attaches and evaluates on Tizen 5.5 / Chromium M69 unchanged | `1+1 = 2`, 29.6 ms |
| **`Accessibility.getFullAXTree` is absent on M69**; `getPartialAXTree` returns 1 node at the root | `/json/protocol` |
| A `Runtime.evaluate` DOM walk works as the TV observation | 282 elements, 1517 chars in one call |
| The debug port is dynamic | 43411 this run; not 9222 |

## RQ7 — protocols → [`results/protocols-tv.md` § RQ7](results/protocols-tv.md)

| layer | verified | read-only guard |
|---|---|---|
| HTTP (`fetch`) | PASS, ~1 ms | method/host/path allowlist; off-list POST refused, 0 writes |
| TCP (`node:net`) | PASS, <1 ms | exact write allowlist; off-list write refused |
| SSH | OPEN (no local sshd) | argv allowlist; off-list command refused before spawn |
| Hurl, qBittorrent | OPEN | not installed; credentials out of scope |

## RQ8 — scenario-format authorability → [`results/formats.md`](results/formats.md)

| format | first-try valid | correct | verdict (rule scaled to 6/10 · 5/10) |
|---|---|---|---|
| Playwright Test (TS) | 10/10 | 9/10 | feasible |
| Flat YAML | 10/10 | 8/10 | feasible |
| Gherkin | 10/10 | 8/10 | feasible |

4 of the 5 misses come from one task-spec gap: t2-hover named no tile selector. The plan's rule makes
these counts feasibility, not a ranking.

## RQ9 — read-only boundary → [`results/web.md` § RQ9](results/web.md)

| arm | POST reached the app | `rec_feedback` row |
|---|---|---|
| unguarded (RED) | 1 | 0 → 1 |
| network guard (`route()` / `Fetch`) | 0 | 0 → 0 |
| scenario action allowlist | 0, refused before dispatch | 0 → 0 |

Both tools, same evidence. The allowlist needs no tool support.

## RQ10 — delta vs full observation → [`results/web.md` § RQ10](results/web.md)

| arm | bytes saved | answers right (badge · pressed set) |
|---|---|---|
| full | — | 6/6 · 5/6 |
| delta | 63–79% | 6/6 · 6/6 |

The hidden-change journey (J3) is answered from a final grid re-read, so it never posed the stale
question. That probe is OPEN in the fragment. With a modal `<dialog>` open, CDP's full AX tree
contains only the dialog.

## Typed-failure evidence (plan Deliverable 2)

None of `not_found`, `ambiguous_target`, `stale_target` or `target_obscured` was detected as such in
T3 or RQ4: every T3 run reached the rating control. The closest RQ4 cases (element gone, window
closed mid-call) are in `results/windows.md` § 4.6.

## OPEN, across lanes

Each fragment's OPEN table holds the exact probe for every item below:

- RQ1 / RQ10 on the plan's Claude models
- RQ10 stale-mid-journey question
- RQ8 second model, and t2-hover with the selector named
- RQ4 large-tree `CacheRequest` and structure-changed events
- RQ5 Tesseract
- RQ7 SSH, Hurl and qBittorrent
