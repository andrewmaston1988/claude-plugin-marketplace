# ui-probe bake-off — web lane

Two contenders, one harness. Everything here measures the **tool**, not the builder: the fixtures,
tasks, timings, repeat counts, reads and output columns live in `web/lib/`, and each contender is a
thin adapter under `web/contenders/`.

Results live in `results/web.md`. Artifacts (JSON + the Playwright trace) live in
`results/artifacts/`.

## Layout

```
fixtures/
  static/render_sheet.py     renders the real torrent-hub sheet from the real templates
  static/detail-sheet.html   T1: the sheet, open
  static/detail-sheet-tiles.html  T2: the rec tiles, so the hover bar can be driven
  static/phone-bottom-sheet.html  the design mockup, for reference
  red/                       the same page rendered from e0ac239's CSS — the RED fixture
  hub_fixture.py             the live app on :8001 with a scratch env, DB and profile
web/
  lib/harness.mjs            shared constants, fixtures, assertions, metering
  lib/probes.mjs             the page-side expressions both tools evaluate verbatim
  lib/hub.mjs               live-fixture lifecycle, access-log and DB evidence
  lib/cdp.mjs               swarm's cdp.mjs, copied (swarm is never edited)
  contenders/playwright.mjs the scripted Playwright library
  contenders/cdp.mjs        swarm's zero-dependency CDP client
  run-all.mjs                T1 + T2 + RQ2 on the static fixture; the automated gate
  run-live.mjs               T1 + T2 + RQ2 on the live app
  run-rq3.mjs                temporal capture comparison
  run-rq9.mjs                guard ON/OFF, with access-log and DB evidence
  run-rq10.mjs               observation size over three journeys
results/
  web.md                     this lane's results fragment
  artifacts/                 every JSON the runs wrote
```

## Prerequisites

Already installed on the operator's machine; nothing is installed by these scripts.

| need | where it comes from |
|---|---|
| Node 24 | `node` on PATH (`node:sqlite`, built-in `WebSocket`) |
| Python + jinja2 + the torrent-hub venv | `python` on PATH with the hub's dependencies |
| Playwright | the library inside `@playwright/mcp`, loaded by absolute path — never a top-level dep |
| Playwright browsers | `%LOCALAPPDATA%\ui-probe\ms-playwright` (set by `lib/harness.mjs`) |
| Chrome or Edge | for the CDP contender |
| torrent-hub fixture checkout | `C:/code/.worktrees/torrent-hub/ui-probe-fixture` (never the prod checkout) |

## Running

From the marketplace worktree root:

```bash
# the automated gate — exits non-zero on any layout mismatch
node plugins/ui-probe/bakeoff/web/run-all.mjs

# the same gate against the pre-fix CSS (must fail)
python plugins/ui-probe/bakeoff/fixtures/static/render_sheet.py --base-ref e0ac239 \
  --out plugins/ui-probe/bakeoff/fixtures/red
node   plugins/ui-probe/bakeoff/web/run-all.mjs --dir plugins/ui-probe/bakeoff/fixtures/red

# the live app (spawns and kills its own fixture on :8001)
node plugins/ui-probe/bakeoff/web/run-live.mjs
node plugins/ui-probe/bakeoff/web/run-rq9.mjs
node plugins/ui-probe/bakeoff/web/run-rq10.mjs

# temporal capture
node plugins/ui-probe/bakeoff/web/run-rq3.mjs
```

Useful flags: `--only playwright|cdp`, `--repeats N` (`run-all`, `run-live`, `run-rq3`).

## The live fixture

`fixtures/hub_fixture.py` runs the app from the fixture checkout with an **allowlisted**
environment: a scratch `DB_PATH` and `RECOMMEND_DATA_DIR` under
`%LOCALAPPDATA%\ui-probe\hub-fixture`, a scratch `SECRET_KEY`, `RECOMMEND_SYNC=0`,
`STUFFING_ENABLED=0`, dead-loopback pointers for Plex/qBittorrent/LLM, and no registry credentials.
The scratch DB is reset on every start.

It seeds one profile linked to a fake Plex id, synthetic `rows.json` and titles, and a session
cookie written to `<scratch>/session.json` (mode 0600). The runners read that file; nothing prints a
secret.

```bash
python plugins/ui-probe/bakeoff/fixtures/hub_fixture.py --check   # prints env NAMES only
```

`--check` fails if any credential-family variable is present, any path is outside the scratch dir,
or either pinned host is not `http://127.0.0.1:1`.

`--tmdb` is required for the sheet: `/media/<id>` fetches TMDB detail and answers 401 → 500 without
a key. The key is read from `HKCU\Environment` inside the fixture process and never printed.
TMDB is the only network call; it is read-only and carries synthetic title ids.

## Notes for whoever reads the numbers

- `cdp`'s observation text is the lane's own AX serialiser — its bytes are protocol + formatter.
- With a modal `<dialog>` open, CDP's full AX tree contains only the dialog; Playwright's aria
  snapshot still lists the page behind it. Any byte comparison with the sheet open is affected.
- `.rec-hover` has no transition: the reveal is a discrete `display` flip. RQ3 therefore reports
  both the real reveal and a controlled WAAPI animation injected into both tools.
- `run-live.mjs`, `run-rq9.mjs` and `run-rq10.mjs` refuse to start if something already answers on
  `:8001`, so a stale fixture can never silently serve the wrong page.
