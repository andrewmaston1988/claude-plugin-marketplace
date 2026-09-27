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

  // Decision 3's routes, in one place because three callers ask: the route builder,
  // boot and the resize listener. A bare load lands on Overview where there is room
  // for it; #/overview is a dead end below the breakpoint; #/ is Runs in both.
  const resolveHash = (hash, desktop) => {
    const h = hash || "";
    if (desktop) return h === "" || h === "#" ? "#/overview" : h;
    return /^#\/overview\/?$/.test(h) ? "#/" : h;
  };

  // The Overview's contents are the next chunk's. A skeleton is the one screen that
  // cannot invent a figure the source tabs do not have (D5).
  const overviewScreen = () => `<div class="skeleton"><div class="sk hero"></div><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>`;

  window.swarmDesktop = { isDesktop, resolveHash, overviewScreen };
})();
