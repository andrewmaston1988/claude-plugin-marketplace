// Everything the desktop layout owns: the breakpoint read, the Overview screen and
// the Performance composition. Loaded lazily like perf.js — a phone never needs it,
// and a failed load degrades to the phone layout rather than sinking boot.
(() => {
})();
