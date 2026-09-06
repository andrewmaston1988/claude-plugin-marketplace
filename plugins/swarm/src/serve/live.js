// Pure client-side ticking decisions: same shape as perf.js — an IIFE assigning
// window.swarmLive, served as a static and loaded once at boot. `now` is a
// parameter on every time function, never a module-level clock, which is what
// makes a 1 s re-render (and this file) testable without a clock stub.
(function () {
  // Mirrors page.html's fmtDur exactly — the format the run/leaf views render.
  const fmtDur = (ms) => {
    if (ms == null) return "—";
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };

  // (c) a wave is expanded unless manually collapsed — no `big`/`settled` override.
  const waveOpen = (wave, closedWaves) => !closedWaves.has(wave);

  // (d) a project's finished stack is collapsed unless manually opened — the
  // inversion of waveOpen: opt-in, not opt-out.
  const projectOpen = (project, openProjects) => openProjects.has(project);

  function elapsedText(task, now) {
    if (task.state === "running") return fmtDur(now - (task.startedMs || now));
    if (task.durationMs != null) return fmtDur(task.durationMs);
    return null;
  }

  // Client-side derivation from lastEventMs rather than a server-computed quietMs,
  // so it ticks on the 1 s clock instead of freezing at whatever the last fetch reported.
  function quietSecs(task, now) {
    if (task.state !== "running" || task.lastEventMs == null) return null;
    return Math.round((now - task.lastEventMs) / 1000);
  }

  // page.html's existing ago() thresholds, verbatim, with `now` injected in place
  // of Date.now() — the boundaries (59s/61s/3601s/86401s) are pinned by test L5.
  function agoText(ms, now) {
    const s = Math.round((now - ms) / 1000);
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
  }

  // Group order: a project with a live run ranks by that run's newest startedMs —
  // stable across polls, unlike sorting by mtimeMs (whichever engine last appended
  // an event). Finished-only projects trail, ordered by their first row's mtimeMs.
  function projectOrder(byProject) {
    const newestLiveStart = (rows) => {
      const live = rows.filter((r) => r.active);
      return live.length ? Math.max(...live.map((r) => r.startedMs)) : null;
    };
    return [...byProject.keys()].sort((a, b) => {
      const la = newestLiveStart(byProject.get(a));
      const lb = newestLiveStart(byProject.get(b));
      if (la != null && lb != null) return lb - la;
      if (la != null) return -1;
      if (lb != null) return 1;
      return byProject.get(b)[0].mtimeMs - byProject.get(a)[0].mtimeMs;
    });
  }

  const runEnded = (run) => !!(run && (run.finishedMs || run.abortedMs || run.stoppedMs));

  // The runs list has no single run to end, so it always polls; a run/leaf view
  // polls only while its run is still open, and never for a run not yet fetched.
  function shouldPoll(view, run, now) {
    if (view && view.name === "runs") return true;
    if (!run) return false;
    return !runEnded(run);
  }

  // The one DOM-touching export here, and the exception to "no DOM access" above:
  // page.html's boot sequence needs a script loader before live.js itself is
  // guaranteed loaded, so it cannot depend on this copy for THAT first load — but
  // it is the contract page.html's own loader must satisfy (reject on error, never
  // swallow it the way the old loadPerfJs did), pinned here so the two cannot drift.
  function loadScript(path, doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    return new Promise((resolve, reject) => {
      const s = d.createElement("script");
      s.src = path;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`failed to load ${path}`));
      d.head.appendChild(s);
    });
  }

  window.swarmLive = { waveOpen, projectOpen, elapsedText, quietSecs, agoText, projectOrder, runEnded, shouldPoll, loadScript };
})();
