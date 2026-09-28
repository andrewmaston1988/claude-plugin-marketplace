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

  // The hub: the Runs screen's own run feed at the width main gives it, and — when a
  // reader wants them — Usage and Cost in a flyout beside it. The parts are the other
  // screens' own markup, called rather than re-rendered (D4/D5), so a figure that
  // changes on its own screen changes here in the same commit. The hub draws no
  // ranking: leadersList belonged to a column this redesign dropped.
  function overviewScreen(runs, usage, cost, h) {
    const V = window.perfViews;
    const { esc, runRow, labels, expanded, flyout } = h;
    // Live first, most recently dispatched on top; then the newest finished. `filter`
    // copies, so neither sort touches the payload the commit is holding.
    const live = runs.filter((r) => r.active).sort((a, b) => b.startedMs - a.startedMs);
    const done = runs.filter((r) => !r.active).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, HUB_FINISHED);
    const sec = (label) => `<div class="section"><span>${esc(label)}</span><span class="line"></span></div>`;
    const keyOf = (r) => esc(`${r.project}/${r.name}`);
    // Every widget in the panel is perf.js's, so a /perf.js that never arrived
    // (loadPerfJs swallows its onerror) leaves the run feed as the whole hub — which is
    // why the feed needs nothing from it, and why a toggle for a panel that cannot open
    // is worse than no toggle. A source that failed is null: its section goes, the rest
    // stay, and the run feed is never held hostage to a read it does not use.
    const panel = V && (usage || cost);
    const open = panel && flyout;
    let feed = "";
    if (live.length) feed += sec("live") + live.map((r) => runRow(r)).join("");
    if (done.length) {
      // The open run is injected straight after its own row, in the same list, so it
      // re-renders with the feed the poll rebuilds — never as a second screen.
      feed += sec("finished") + `<ul>${done.map((r) => runRow(r, true, labels, false, true)
        + (expanded && expanded.key === `${r.project}/${r.name}` ? `<li class="${expanded.leaf ? "ovleaf" : "ovrun"}" data-key="ov:${keyOf(r)}">${expanded.html}</li>` : "")).join("")}</ul>`;
    }
    if (!feed) feed = h.noRuns;
    // The toggle heads the sidebar's own column, open or shut, so it reads as the panel's
    // handle rather than a control floating at the feed's edge.
    const bar = panel ? `<div class="ovbar"><button type="button" class="ovtoggle${open ? " on" : ""}" data-flyout="1" aria-expanded="${open ? "true" : "false"}">usage and cost</button></div>` : "";
    feed = bar + `<div class="ovfeed${open ? "" : " shut"}">` + feed + `</div>`;
    if (!open) return feed;
    // Usage pins its week reading — the hub has no room for the switcher, and the Usage
    // tab is one tap away for the other window. A provider with nothing measured is not
    // on the Cost screen either (costSections), so the panel shows the same providers it
    // does — and when that is none of them, the Cost screen's own empty state.
    // Each panel section heads with the way through to its full screen.
    const head = (label, href, go) => `<div class="phead"><span>${esc(label)}</span><a href="${href}">${esc(go)}</a></div>`;
    let side = "";
    if (usage) {
      const u = V.usageParts(usage, h, "week");
      side += head("usage", "#/usage", "view all →") + (u.empty || u.hero + u.cards.join(""));
    }
    if (cost) {
      const sections = V.costSections(cost);
      side += head("best value", "#/cost", "cost →") + (sections.length ? sections.map((s) => V.costHero(s, h)).join("") : V.noCost());
    }
    return feed + `<aside class="ovpanel">${side}</aside>`;
  }

  window.swarmDesktop = { isDesktop, overviewScreen };
})();
