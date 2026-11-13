#!/usr/bin/env python
"""Render torrent-hub's detail sheet to a self-contained static page.

Reads the sheet's real templates, its `<style>` block and its sheet script straight out of a
torrent-hub checkout — nothing is copied by hand, so a re-render after the sheet changes picks the
change up. Synthetic title data only: no household data, no external image, no network.

    python plugins/ui-probe/bakeoff/fixtures/static/render_sheet.py
    python .../render_sheet.py --hub C:/code/.worktrees/torrent-hub/ui-probe-fixture --out <path>

`--view sheet` (default) opens the dialog through the sheet script's own htmx:afterSwap path;
`--view tiles` renders the same page with the dialog closed, for the T2 hover probe. Both views are
written in one pass because they share one stylesheet and one script.
"""
import argparse
import re
import sys
from pathlib import Path

DEFAULT_HUB = Path("C:/code/.worktrees/torrent-hub/ui-probe-fixture")
HERE = Path(__file__).resolve().parent

# Synthetic: no real title, no real person, no household data.
MOVIE = {
    "id": 900001,
    "title": "Harbour Lights",
    "release_date": "2019-03-08",
    "first_air_date": None,
    "media_type": "movie",
    "vote_average": 7.4,
    "poster_url": None,          # the no-image branch: keeps the page fully offline
    "overview": (
        "A lighthouse keeper trades weather reports with a radio operator she has never met. "
        "Over one winter the two build a map of each other out of shipping forecasts and static."
    ),
}
REC = {
    "ck": "movie:900001",
    "dom_id": "movie_900001",
    "tmdb_id": 900001,
    "kind": "movie",
    "title": MOVIE["title"],
    "year": 2019,
    "row_key": "row-quiet-drama",
    "why": ["Quiet drama", "Slow burn", "Coastal"],
    "recommended": True,
    "mylist": False,
    "state": {"watchlist": False, "seen": False, "dismissed": False, "stars": None},
}
# Three tiles so a hover bar's neighbours are visible and the row is not degenerate.
TILE_IDS = [900001, 900002, 900003]
TILE_TITLES = ["Harbour Lights", "The Long Static", "Winter Ferry"]

# The two blocks lifted from base.html. Marker-anchored, so a change upstream either comes along
# or fails loudly here rather than silently rendering a stale sheet.
STYLE_OPEN, STYLE_CLOSE = "<style>", "</style>"
SCRIPT_MARKER = "// Detail sheet — open after the swap"


def extract(text: str, start: str, end: str, label: str) -> str:
    i = text.find(start)
    j = text.find(end, i + 1) if i >= 0 else -1
    if i < 0 or j < 0:
        sys.exit(f"render_sheet: {label} not found in base.html ({start!r}..{end!r})")
    return text[i + len(start):j]


def sheet_script(base: str) -> str:
    """The one <script> holding the sheet: open/close, rec-state, and the mouse-only hover bar."""
    at = base.find(SCRIPT_MARKER)
    if at < 0:
        sys.exit("render_sheet: the detail-sheet script marker is gone from base.html")
    open_at = base.rfind("<script>", 0, at)
    close_at = base.find("</script>", at)
    if open_at < 0 or close_at < 0:
        sys.exit("render_sheet: the detail-sheet <script> could not be delimited")
    return base[open_at + len("<script>"):close_at]


def card_context(ck_id: int, title: str) -> dict:
    return {
        "ck": f"movie:{ck_id}", "dom_id": f"movie_{ck_id}", "tmdb_id": ck_id, "kind": "movie",
        "title": title, "year": 2019, "poster_url": None, "why": [], "watched": False,
        "state": REC["state"], "row_key": REC["row_key"], "hide": None, "mylist": False,
        "grab": None, "picker_url": None, "kids": False,
    }


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>ui-probe fixture — detail sheet</title>
<link rel="stylesheet" href="theme.css">
<style>
/* The fixture's own chrome only. Everything the sheet is measured on comes from base.html. */
body{{background:var(--bg-darker);color:var(--text-bright);font-family:system-ui,sans-serif;margin:0}}
.fixture-page{{max-width:56rem;margin:0 auto;padding:1.5rem 1rem}}
.fixture-row{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.75rem}}
.poster-wrap{{position:relative;display:block;aspect-ratio:2/3;background:var(--bg-card-alt);border-radius:.375rem;overflow:hidden}}
.no-img{{display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-dim);font-size:.75rem}}
</style>
<style>
{base_style}
</style>
</head>
<body data-view="{view}">
<main class="fixture-page">
  <div class="carousel-row fixture-row">
{cards}
  </div>
</main>
<dialog id="detail-sheet" aria-label="Title details">
  <div id="detail-sheet-body">{sheet}</div>
</dialog>
<script>
{script}
</script>
<script>
// The fixture's only addition: stand in for htmx's swap so the sheet opens through the real
// handler (open() pushes history, sets `opened`, moves the toast) instead of a fixture-only path.
(function () {{
  var body = document.getElementById('detail-sheet-body');
  if (!body) return;
  if (document.body.dataset.view === 'sheet') {{
    body.dispatchEvent(new CustomEvent('htmx:afterSwap', {{bubbles: true}}));
  }}
  window.__fixtureReady = true;
}})();
</script>
</body>
</html>
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hub", default=str(DEFAULT_HUB), help="torrent-hub checkout holding the sheet")
    ap.add_argument("--out", default=str(HERE), help="directory to write the fixtures into")
    ap.add_argument(
        "--base-ref",
        default=None,
        help="read base.html from this git ref instead of the working tree — the RED run's "
             "route to the pre-fix CSS (e.g. e0ac239)",
    )
    args = ap.parse_args()

    hub = Path(args.hub)
    tpl_dir = hub / "src" / "templates"
    if args.base_ref:
        import subprocess  # noqa: PLC0415

        base_html = subprocess.run(
            ["git", "-C", str(hub), "show", f"{args.base_ref}:src/templates/base.html"],
            check=True, capture_output=True, text=True, encoding="utf-8",
        ).stdout
    else:
        base_html = (tpl_dir / "base.html").read_text(encoding="utf-8")
    theme_css = (hub / "static" / "theme.css").read_text(encoding="utf-8")

    from jinja2 import Environment, FileSystemLoader, StrictUndefined  # noqa: PLC0415 — optional dep, fail with a message

    env = Environment(loader=FileSystemLoader(str(tpl_dir)), undefined=StrictUndefined, autoescape=True)
    env.globals["rec_linked"] = lambda *a, **k: True
    sheet = env.get_template("_detail_dialog.html").render(
        media=MOVIE, rec=REC, current_profile={"is_kids": False},
    )
    # `_recommend_card.html` is what T2 hovers. Rendered from the same template the page uses,
    # so the tile carries the real .rec-tile / .rec-hover markup rather than a hand copy.
    card_tpl = env.get_template("_recommend_card.html")
    cards = "\n".join(
        card_tpl.render(card=card_context(cid, title))
        for cid, title in zip(TILE_IDS, TILE_TITLES)
    )

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "theme.css").write_text(theme_css, encoding="utf-8")
    for view in ("sheet", "tiles"):
        html = PAGE.format(
            base_style=extract(base_html, STYLE_OPEN, STYLE_CLOSE, "the <style> block"),
            sheet=sheet, cards=cards, script=sheet_script(base_html), view=view,
        )
        suffix = "" if view == "sheet" else "-tiles"
        (out / f"detail-sheet{suffix}.html").write_text(html, encoding="utf-8")
        print(f"wrote {out / f'detail-sheet{suffix}.html'} ({len(html)} bytes)")
    print(f"sheet markup {len(sheet)} bytes, {len(cards.splitlines())} tile lines, from {hub}")


if __name__ == "__main__":
    main()
