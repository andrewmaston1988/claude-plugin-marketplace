// Everything the desktop layout owns. Loaded lazily like perf.js — a phone never
// needs it, and a failed load degrades to the phone layout rather than sinking boot.
(() => {
  // The breakpoint, read from the stylesheet rather than repeated here: a width in
  // this file would be a second copy to keep in step with desktop.css, and the two
  // drifting apart is invisible in a diff.
  const isDesktop = () => {
    try { return getComputedStyle(document.documentElement).getPropertyValue("--layout").trim() === "desktop"; }
    catch { return false; }
  };

  // Decision 3's route rule is page.html's, not this file's: it has to hold when this
  // asset never arrives, and a rule that lives in the missing file cannot be applied.

  // How many finished runs the hub carries: it is a landing, not the estate — the Runs
  // tab is the place a long history is read.
  const HUB_FINISHED = 5;

  // The Overview: the parts Runs, Usage, Performance and Cost already draw, arranged. Not
  // one of them is re-rendered here (D4/D5) — they are called, so a figure that changes on
  // its own screen changes on the hub in the same commit. `h` carries page.html's
  // closure-bound helpers (runRow, esc, enc, seg, labels, rankBadge, fmtScore), the
  // perfViews helper-bag pattern, for the same reason: this file cannot see page state.
  function overviewScreen(runs, usage, perf, cost, h) {
    const V = window.perfViews;
    const { esc, runRow, labels } = h;
    // Live first, most recently dispatched on top; then the newest finished. `filter`
    // copies, so neither sort touches the payload the commit is holding.
    const live = runs.filter((r) => r.active).sort((a, b) => b.startedMs - a.startedMs);
    const done = runs.filter((r) => !r.active).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, HUB_FINISHED);
    const sec = (label) => `<div class="section"><span>${esc(label)}</span><span class="line"></span></div>`;
    const cols = [];
    if (live.length || done.length) {
      cols.push(`<div class="ovcol ovruns">`
        + (live.length ? sec("live") + `<div class="ovcards">${live.map((r) => runRow(r)).join("")}</div>` : "")
        + (done.length ? sec("finished") + `<ul>${done.map((r) => runRow(r, true, labels)).join("")}</ul>` : "")
        + `</div>`);
    }
    // Usage pins its week reading: the hub has no room for the switcher, and the Usage tab
    // is one tap away for the other window.
    const u = V.usageParts(usage, h, "week");
    cols.push(`<div class="ovcol ovusage">${sec("usage")}${u.empty || u.hero + u.cards.join("")}</div>`);
    cols.push(`<div class="ovcol ovmodels">${sec("top models")}${V.leadersList(perf.views?.leaders ?? [], h)}</div>`);
    // A provider with nothing measured is not on the Cost screen either (costSections),
    // so the hub shows the same providers it does.
    const sections = V.costSections(cost);
    if (sections.length) cols.push(`<div class="ovcol ovcost">${sec("cost")}${sections.map((s) => V.costHero(s, cost, h)).join("")}</div>`);
    return `<div class="ovgrid">${cols.join("")}</div>`;
  }

  window.swarmDesktop = { isDesktop, overviewScreen };
})();
