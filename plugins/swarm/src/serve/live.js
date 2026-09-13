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

  // The Show-all row renders at the foot of an expanded stack only while it hides
  // something and has not already been expanded — never under a complete or
  // collapsed stack, where it would be a useless or dead control.
  const showAllRow = (group, { open, total, shown, expanded }) => !!open && total > shown && !expanded.has(group);

  // The `expand=` params the runs fetch carries for the groups the user expanded,
  // spliced into the path BEFORE q() appends the token ("" or "?expand=g&…"), so
  // the token and the params both survive — never concatenated on after q().
  const expandQuery = (expanded) => {
    const parts = [...(expanded || [])].map((g) => `expand=${encodeURIComponent(g)}`);
    return parts.length ? `?${parts.join("&")}` : "";
  };

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

  // D6: the backoff a CLOSED EventSource reconnects with — 1s, doubling, capped
  // at 30s. The browser's own retry already covers the CONNECTING case; this is
  // only reached once it has given up.
  const reconnectDelay = (attempt) => Math.min(30_000, 1_000 * 2 ** attempt);

  // The runs list has no single run to end, so it always polls; a run/leaf view
  // polls only while its run is still open, and never for a run not yet fetched.
  function shouldPoll(view, run, now) {
    if (view && view.name === "runs") return true;
    if (!run) return false;
    return !runEnded(run);
  }

  // A build commits only while it is still the newest route — the generation
  // token's whole predicate, extracted so tests pin it off the page. `latest`
  // is what the page's counter says NOW; anything but exact equality discards,
  // including a sequence equal to a superseded latest.
  function routeGuard(seq, latest) {
    return seq === latest;
  }

  // One route build in flight; requests during it earn exactly one trailing
  // build. A per-microtask latch was not enough: with no in-flight guard every
  // SSE event started its own fetch, each response landed already superseded,
  // routeGuard discarded them all, and the page went quiet under live runs.
  // The trailing build re-reads the hash, so it never misses a navigation.
  function singleFlight(fn) {
    let running = false;
    let dirty = false;
    const run = () => {
      running = true;
      Promise.resolve().then(fn).catch(() => {}).finally(() => {
        running = false;
        if (dirty) { dirty = false; run(); }
      });
    };
    return () => { if (running) { dirty = true; return; } run(); };
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

  // Transitive reduction: drop U->N when U is already an ancestor of another of N's
  // upstreams. `visiting` keeps a malformed cycle finite.
  function reduceEdges(targetsByKey) {
    const cache = new Map();
    function ancestorsOf(key, visiting) {
      if (cache.has(key)) return cache.get(key);
      if (visiting.has(key)) return new Set();
      visiting.add(key);
      const result = new Set();
      for (const u of targetsByKey.get(key) || []) {
        result.add(u);
        for (const a of ancestorsOf(u, visiting)) result.add(a);
      }
      visiting.delete(key);
      cache.set(key, result);
      return result;
    }
    const reduced = new Map();
    for (const [key, ups] of targetsByKey) {
      const keep = new Set(ups);
      for (const u of ups) {
        for (const v of ups) {
          if (v !== u && ancestorsOf(v, new Set()).has(u)) { keep.delete(u); break; }
        }
      }
      reduced.set(key, keep);
    }
    return reduced;
  }

  // One colour for a set of tasks: any live → run, any failed → bad, any held on a
  // limit → warn, all done → ok, else pending. The page's dot strips and the rail share it.
  const stateOfGroup = (kids) => kids.some((k) => k.state === "running" || k.state === "retrying") ? "run" : kids.some((k) => /failed|blocked/.test(k.state)) ? "bad" : kids.some((k) => k.state === "rate-limited" || k.state === "quota") ? "warn" : kids.every((k) => k.state === "ok" || k.state === "skipped") ? "ok" : "pend";

  // Pitch narrows as the rail widens so a wide wave still reads one lane per line;
  // past 24 lanes the surplus shares the last one, and can pass behind dots.
  const MAX_RAIL_LANES = 24;
  function railPitch(maxLane) {
    const laneW = maxLane > 12 ? 5 : maxLane > 5 ? 8 : 14;
    const x0 = 12;
    const last = Math.min(maxLane, MAX_RAIL_LANES - 1);
    return {
      laneW, x0, r: maxLane > 12 ? 2.5 : maxLane > 5 ? 3.5 : 5,
      width: Math.max(56, x0 + last * laneW + 19), // last lane + ring radius + breathing room
      x: (lane) => x0 + Math.min(lane, MAX_RAIL_LANES - 1) * laneW,
    };
  }

  // buildRows' rows → railLayout's input: one entry per drawn row, its parents as DRAWN
  // keys. A parent hidden inside a collapsed wave or a manifest node maps to that row;
  // a forEach member, seen from outside its block, maps to the forEach row (its trunk);
  // a clone's first session branches off that trunk. Reduced last, so the digest (after
  // every row) holds one line open, not one per row.
  function railRows(rows) {
    const keyOf = new Map();
    const drawn = [];
    rows.forEach((r, index) => {
      let own;
      let key = r.id;
      if (r.type === "wave") { if (r.open) return; key = `wave:${r.wave}`; own = r.tasks; }
      else if (r.type === "node") own = [r.task, ...r.kids];
      else own = [r.task];
      for (const t of own) keyOf.set(t.id, key);
      drawn.push({ key, index, own, kind: r.type === "label" ? "label" : "node", block: r.type === "task" ? r.block : undefined });
    });
    const blockOf = new Map(drawn.filter((e) => e.block).map((e) => [e.key, e.block]));
    const inBlock = (e) => (e.own[0].after || []).filter((a) => blockOf.get(a) === e.block);
    const dependedOn = new Set(drawn.filter((e) => e.block).flatMap(inBlock));
    const targetsByKey = new Map();
    for (const e of drawn) {
      const parents = new Set();
      if (e.block) {
        const local = inBlock(e);
        e.root = !local.length;
        e.sink = !dependedOn.has(e.key);
        if (e.root) parents.add(e.block);
        for (const a of local) parents.add(a);
      } else {
        for (const t of e.own) for (const a of t.after || []) {
          const k = blockOf.get(a) ?? keyOf.get(a);
          if (k && k !== e.key) parents.add(k);
        }
      }
      targetsByKey.set(e.key, parents);
    }
    const reduced = reduceEdges(targetsByKey);
    return drawn.map((e) => ({ key: e.key, index: e.index, kind: e.kind, block: e.block, root: e.root, sink: e.sink, parents: [...reduced.get(e.key)], states: e.own.map((t) => t.state) }));
  }

  // The git-graph router. A line (a row's outgoing edges) owns its lane from its row
  // until its last target lands, so it never runs behind an unrelated dot. A row
  // continues the lane of a parent line that ends on it, else takes the lowest free
  // lane. A forEach clone branches one lane right of its trunk — a line in the way
  // steps aside just above that row — and its last session merges back into the trunk,
  // which carries it on. Segments and curves carry the keys whose state colours them:
  // `upstream` (what the line brings down) plus `merged` (sinks folded in below).
  // Offsets are pixels from a row's measured centre. Pure: no DOM, no pixels of x.
  function railLayout(rows) {
    const kids = new Map();
    for (const r of rows) for (const p of r.parents) (kids.get(p) || kids.set(p, []).get(p)).push(r.key);
    let slots = [];
    const segments = [], curves = [], nodes = [], landed = [];
    const lanes = new Map(), trunks = new Map();
    let maxLane = 0;
    const carriesOf = (s) => [...s.upstream, ...s.merged];
    const open = (s, lane, row, off) => { s.lane = lane; s.seg = { lane, row, off }; };
    const close = (s, row, off) => segments.push({ lane0: s.seg.lane, row0: s.seg.row, off0: s.seg.off, lane1: s.lane, row1: row, off1: off, carries: carriesOf(s) });
    const freeFrom = (i) => { while (slots[i]) i++; return i; };
    for (const r of rows) {
      const i = r.index;
      const trunk = r.block ? trunks.get(r.block) : null;
      let L;
      if (r.root && trunk) {
        L = trunk.lane + 1;
        if (slots[L]) {
          slots = [...slots.slice(0, L), null, ...slots.slice(L)];
          slots.forEach((s, k) => {
            if (!s || s.lane === k) return;
            close(s, i, -40);
            segments.push({ lane0: s.lane, row0: i, off0: -40, lane1: k, row1: i, off1: -26, carries: carriesOf(s), step: true });
            open(s, k, i, -26);
          });
        }
      }
      const incoming = [];
      slots.forEach((s, k) => { if (s && s.targets.has(r.key)) incoming.push(k); });
      if (L === undefined) {
        const cont = incoming.find((k) => slots[k].targets.size === 1);
        L = cont !== undefined ? cont : freeFrom(trunk ? trunk.lane + 1 : 0);
      }
      const inherited = new Set();
      for (const k of incoming) {
        const s = slots[k];
        s.targets.delete(r.key);
        landed.push([s.from, r.key]);
        for (const c of carriesOf(s)) inherited.add(c);
        if (k === L) { close(s, i, 0); slots[k] = null; continue; } // a continuation: r was its only target
        curves.push({ from: k, to: L, row: i, kind: "in", carries: r.root ? [...s.upstream] : carriesOf(s) });
        if (!s.targets.size) { close(s, i, -22); slots[k] = null; }
      }
      lanes.set(r.key, L);
      if (r.kind !== "label") nodes.push({ key: r.key, lane: L, row: i });
      if (r.sink && trunk && slots[trunk.lane] === trunk) {
        curves.push({ from: L, to: trunk.lane, row: i, kind: "out", carries: [r.key] });
        close(trunk, i, 22);
        trunk.merged.add(r.key);
        open(trunk, trunk.lane, i, 22);
      }
      const targets = new Set(kids.get(r.key) || []);
      if (targets.size) {
        const s = { from: r.key, targets, upstream: r.kind === "label" ? inherited : new Set([r.key]), merged: new Set() };
        open(s, L, i, 0);
        slots[L] = s;
        if (r.kind === "label") trunks.set(r.key, s);
      }
      slots.forEach((s, k) => { if (s) maxLane = Math.max(maxLane, k); });
      maxLane = Math.max(maxLane, L);
    }
    const last = rows.length ? rows[rows.length - 1].index : 0;
    for (const s of slots) if (s) close(s, last, 0);
    return { lanes, segments, curves, nodes, landed, maxLane };
  }

  // The header's third figure: the disk total of runs, never the rendered set.
  // `finishedTotals` is built by server.mjs from EVERY disk run (the `all` list,
  // not the capped `picked`), so summing it gives the lifetime-per-disk total.
  // Active runs are folded in here — the server-side map only holds finished.
  const headerRunCount = (finishedTotals, active) => {
    let n = active.length;
    for (const k in finishedTotals) n += finishedTotals[k] | 0;
    return n;
  };

  window.swarmLive = { waveOpen, projectOpen, showAllRow, expandQuery, elapsedText, quietSecs, agoText, projectOrder, runEnded, shouldPoll, routeGuard, singleFlight, loadScript, headerRunCount, reconnectDelay, reduceEdges, stateOfGroup, railPitch, railRows, railLayout };
})();
