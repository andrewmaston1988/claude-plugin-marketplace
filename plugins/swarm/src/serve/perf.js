// Performance-page widgets: coverage grid, reliability bars, leaders list,
// cost screen.
// Loaded as a served static <script>, not bundled with page.html, so each
// widget takes its data and the page's own helpers as parameters — no
// closure over page.html's IIFE. window.perfViews is the whole contract.
(function () {
  // Six-outcome palette, fixed order (never cycled), validated dark-mode
  // categorical set against this dashboard's surface (#181b24) via the
  // dataviz skill's validate_palette.js.
  const OUTCOME_COLOR = {
    completed: "#3987e5",
    wrong: "#d95926",
    failed: "#199e70",
    timeout: "#c98500",
    "session-died": "#d55181",
    "not-capable": "#008300",
  };
  const OUTCOME_ORDER = Object.keys(OUTCOME_COLOR);
  const HATCH_ID = "perf-hatch";
  const HATCH_DEFS = `<defs><pattern id="${HATCH_ID}" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="var(--accent-soft)"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--accent)" stroke-width="2"/></pattern></defs>`;

  // Void (n=0) draws no fill — absence of evidence is never disguised as a
  // pale data point. Provisional (0<n<5) gets the hatch, not a lighter shade.
  function coverageGrid(data, h) {
    const { esc, enc } = h;
    const { aspects, models, cells } = data;
    if (!models.length) return `<div class="empty">no graded leaves yet — nothing to cover.</div>`;
    // One responsive SVG scaled to the phone by its viewBox. Each model gets a
    // small label line ABOVE its tile row, so the tiles take the full width and
    // the name never truncates. Tap a label → the model's page; tap an aspect
    // header → that aspect's ranking.
    const shortModel = (m) => m.replace(/(:|-)cloud$/, "");
    const keyOf = (model, aspect) => JSON.stringify([model, aspect]);
    const byKey = new Map(cells.map((c) => [keyOf(c.model, c.aspect), c]));
    const CW = 34, TILE = 22, LBL = 15, GAP = 2, HEAD = 16;
    // horizontal captions: the first five letters fit a 34px column; the full aspect name is one tap away
    const caption = (a) => a.slice(0, 5);
    const ROW = LBL + TILE;
    const w = aspects.length * CW, hgt = HEAD + models.length * ROW;
    let svg = `<svg viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="xMinYMin meet" class="covgrid">${HATCH_DEFS}`;
    aspects.forEach((a, i) => {
      const x = i * CW + CW / 2;
      svg += `<text x="${x}" y="${HEAD - 5}" text-anchor="middle" font-size="9" fill="var(--muted)" data-href="#/perf/aspect/${enc(a)}" style="cursor:pointer"><title>${esc(a)}</title>${esc(caption(a))}</text>`;
    });
    models.forEach((m, r) => {
      const y = HEAD + r * ROW;
      svg += `<text x="2" y="${y + 11}" font-size="10" fill="var(--muted)" data-href="#/perf/model/${enc(m)}" style="cursor:pointer">${esc(shortModel(m))}</text>`;
      aspects.forEach((a, c) => {
        const cell = byKey.get(keyOf(m, a)) || { n: 0, provisional: true };
        const x = c * CW + GAP / 2, cy = y + LBL + GAP / 2, cw = CW - GAP, ch = TILE - GAP;
        const fill = cell.n === 0 ? "none" : cell.provisional ? `url(#${HATCH_ID})` : "var(--accent)";
        const stroke = cell.n === 0 ? "var(--rule)" : "none";
        svg += `<rect x="${x}" y="${cy}" width="${cw}" height="${ch}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="1"><title>${esc(m)} · ${esc(a)} · n=${cell.n}${cell.provisional && cell.n ? " (provisional)" : ""}</title></rect>`;
        if (cell.n > 0) svg += `<text x="${x + cw / 2}" y="${cy + ch / 2 + 3.5}" text-anchor="middle" font-size="10" fill="#fff">${cell.n}</text>`;
      });
    });
    svg += `</svg>`;
    return `<div class="cov">${svg}</div>`;
  }

  // A legend row always accompanies >=2 series (six outcome buckets here) —
  // identity never rides on color alone. Rendered here, not duplicated in
  // page.html, since this file is the one place the palette is defined.
  function reliabilityBars(data, h) {
    const { esc } = h;
    if (!data.length) return `<div class="empty">no graded leaves yet.</div>`;
    const legend = `<div class="chips">${OUTCOME_ORDER.map((o) => `<span class="chip"><i class="dot" style="background:${OUTCOME_COLOR[o]}"></i>${esc(o)}</span>`).join("")}</div>`;
    const rows = data.map((m) => {
      const segs = OUTCOME_ORDER.map((o) => {
        const v = m.byOutcome[o] || 0;
        return v ? `<span style="flex:${v};background:${OUTCOME_COLOR[o]}"></span>` : "";
      }).join("");
      return `<li class="row" data-key="${esc(m.model)}"><div class="rail" style="width:16px"></div><div class="body"><div class="head"><span class="name">${esc(m.model)}</span><span class="val">${m.total}</span></div><div class="bar">${segs}</div></div></li>`;
    }).join("");
    return `${legend}<div style="height:8px"></div><ul class="rank">${rows}</ul>`;
  }

  // Top-k per aspect, in the report's own weighted order. Provisional entries
  // reuse the page's existing dashed-bar treatment (page.html's .rank .bar.prov).
  function leadersList(data, h) {
    const { esc, enc, fmtScore } = h;
    if (!data.length) return `<div class="empty">no graded leaves yet.</div>`;
    return data.map((a) => {
      if (!a.top.length) {
        return `<div class="section dim"><span>${esc(a.aspect)}</span><span class="line"></span></div><div class="empty">n=0 — nothing graded on ${esc(a.aspect)} yet.</div>`;
      }
      const rows = a.top.map((t, i) => `<li class="row tap p${i + 1}${i === 0 ? " lead" : ""}" data-key="${esc(a.aspect + ":" + t.model)}" data-href="#/perf/model/${enc(t.model)}"><div class="rail" style="width:16px"></div><div class="body"><div class="head"><span class="name">${esc(t.model)}</span><span class="val">${fmtScore(t.weighted)}</span></div><div class="meta">n=${t.n}${t.provisional ? ` · <span class="tag">provisional n&lt;5</span>` : ""}</div><div class="bar${t.provisional ? " prov" : ""}"><span style="width:${Math.max(0, Math.min(100, ((t.weighted ?? 0) / 10) * 100))}%"></span></div></div></li>`).join("");
      return `<div class="section"><span>${esc(a.aspect)}</span><span class="line"></span></div><ul class="rank">${rows}</ul>`;
    }).join("");
  }

  // One model's page as a dashboard: stat tiles, its cost chip, compressed
  // aspect bars (with the domain picker in the widget header), its coverage
  // row, its reliability bar.
  function modelDashboard(data, h) {
    const { esc, enc, fmtScore } = h;
    const { model, overall, rank, aspects, coverage, reliability, domainSelect, domain, cost } = data;
    const medal = rank ? (["🏆", "🥈", "🥉"][rank.position - 1] || `#${rank.position}`) : "—";
    const rel = reliability[0];
    const total = rel ? rel.total : 0;
    const done = rel ? (rel.byOutcome.completed || 0) : 0;
    const tiles = `<div class="kv dash4">
      <div><label>overall</label><span>${fmtScore(overall ? overall.combined : null)} <small>${esc(medal)}${rank ? ` of ${rank.of}` : ""}</small></span></div>
      <div><label>graded leaves</label><span>${total}</span></div>
      <div><label>completed</label><span>${total ? Math.round((done / total) * 100) + "%" : "—"}</span></div>
      <div><label>domain</label><span>${esc(domain || "all")}</span></div>
    </div>`;
    // This is one of the two places a cost badge may appear (the perf rank
    // lists are the other). Unmeasured reads as an em dash, never blank.
    // Null-safe: `costView` only ever picks frontier participants, which always
    // carry a multiplier — but this function is public on window.perfViews, so a
    // caller passing an unmeasured pick must get an em dash, never a "0×" that
    // would read as free.
    const fmtMult = (m) => m == null ? "—" : (m >= 10 ? Math.round(m) : Math.round(m * 10) / 10) + "×";
    const costChip = cost == null ? "" : `<div class="chips" style="padding-bottom:0"><span class="chip">${costChipInner(cost, esc, fmtMult)}</span></div>`;
    const rows = aspects.map((a) => {
      const c = a.cell;
      const w = c && c.weighted != null ? Math.max(0, Math.min(100, (c.weighted / 10) * 100)) : 0;
      const none = !c || c.weighted == null;
      return `<div class="arow${none ? " none" : ""}" data-href="#/perf/aspect/${enc(a.aspect)}"><span class="alabel">${esc(a.aspect)}</span><div class="bar${c && c.provisional ? " prov" : ""}"><span style="width:${w}%"></span></div><span class="aval">${none ? "—" : fmtScore(c.weighted)}<small>${c ? " n=" + c.n : ""}</small></span></div>`;
    }).join("");
    const aspectWidget = `<div class="section"><span>aspects</span><span class="line"></span>${domainSelect ? `<span class="secsel">${domainSelect}</span>` : ""}</div><div class="aspects">${rows}</div>`;
    const covWidget = `<div class="section"><span>coverage</span><span class="line"></span></div>${coverageGrid(coverage, h)}`;
    const relWidget = `<div class="section"><span>reliability</span><span class="line"></span></div>${reliabilityBars(reliability, h)}`;
    return tiles + costChip + aspectWidget + covWidget + relWidget;
  }

  // The cost read-model as a phone screen: two verdict cards, then a ranked
  // list. It replaced a quality×cost scatter and a log spread — two SVGs in a
  // 342-unit viewBox that read as a sales report on a phone and were, in the
  // operator's words, "far too cramped". The spread was already a ranking
  // wearing a chart costume; the scatter's real payload was the frontier
  // verdict, which every row now carries in words. Draws only: the multipliers,
  // bands, verdicts and both card picks arrive from the server's costView().
  function costScreen(data, h) {
    const { esc, enc } = h;
    const { points, spread, best, worst, valueMargin } = data;
    if (!points.length && !spread.length) return `<div class="empty">no cost history yet — the derivation starts when a live usage fetch banks weekly segments.</div>`;
    // Null-safe: `costView` only ever picks frontier participants, which always
    // carry a multiplier — but this function is public on window.perfViews, so a
    // caller passing an unmeasured pick must get an em dash, never a "0×" that
    // would read as free.
    const fmtMult = (m) => m == null ? "—" : (m >= 10 ? Math.round(m) : Math.round(m * 10) / 10) + "×";
    const badge = (b) => b == null ? `<span class="cbadge none">—</span>` : `<span class="cbadge">${"💲".repeat(b)}</span>`;
    // A card with no pick shows an em dash AND why — a blank reads as a broken
    // render, and a 0× would read as free. Same rule as an unmeasured row.
    const card = (label, pick, why, note) => {
      // Name the rule under the pick: a threshold the reader cannot see is one
      // they have to trust, and "why that model" is the question this card exists
      // to answer.
      const rule = pick && (pick.dominatedBy ? ` · beaten by ${esc(pick.dominatedBy)}` : note ? ` · ${esc(note)}` : "");
      const detail = pick
        ? `${esc(fmtMult(pick.multiplier))} · wtd ${pick.wtd == null ? "—" : pick.wtd.toFixed(1)}${rule}`
        : why;
      return `<div><label>${esc(label)}</label><span>${pick ? esc(pick.model) : "—"}</span><small>${detail}</small></div>`;
    };
    const cards = `<div class="kv dash4 costcards">${card("best value", best, "nothing priced and graded yet", valueMargin == null ? "" : `within ${valueMargin} of the best`)}${card("worst value", worst, "nothing is beaten on both axes")}</div>`;
    // Log-scaled over the same 0.5×–20× domain the deleted plots used:
    // multipliers span decades, so a linear bar makes every cheap model a stub
    // and hides the 1×-vs-2× difference that actually decides a seat.
    const LO = Math.log10(0.5), HI = Math.log10(20);
    const pct = (m) => Math.max(2, Math.min(100, ((Math.log10(m) - LO) / (HI - LO)) * 100));
    const ptOf = new Map(points.map((p) => [p.model, p]));
    const firstUnm = spread.findIndex((r) => r.mult == null);
    const rows = spread.map((r, i) => {
      const p = ptOf.get(r.model);
      const verdict = r.mult == null ? "unmeasured"
        : p && p.onFrontier ? "best value"
        : p && p.dominatedBy ? `beaten by ${esc(p.dominatedBy)}`
        : "cost only";
      const tip = `${esc(r.model)} · ${r.mult == null ? "unmeasured" : esc(fmtMult(r.mult))} · ${r.measuredRequests} measured of ${r.requests} requests · ${r.measuredWeeks} of ${r.weeks} weeks${r.thin ? " · thin" : ""}`;
      const bar = r.mult == null ? `<div class="bar"></div>`
        : `<div class="bar${r.thin ? " prov" : ""}"><span style="width:${pct(r.mult).toFixed(1)}%"></span></div>`;
      return `<div class="arow costrow${i === firstUnm && firstUnm > 0 ? " unmfirst" : ""}${r.mult == null ? " unm" : ""}" data-href="#/perf/model/${enc(r.model)}" title="${tip}">`
        + `<span class="alabel">${esc(r.model)}</span>${bar}`
        + `<span class="aval valside">${badge(r.band)}${r.mult == null ? "—" : esc(fmtMult(r.mult))}</span>`
        + `<small class="costverdict">${verdict}</small></div>`;
    }).join("");
    return `${cards}<div class="section"><span>cost ranking</span><span class="line"></span></div><div class="cost">${rows}</div>`;
  }

  // The chip's inner text, kept out of the dashboard template: a band badge
  // plus the frontier verdict (or the honest "uncompared" for a priced model
  // with no grades).
  function costChipInner(cost, esc, fmtMult) {
    if (cost.band == null) return `<span class="cbadge none">—</span> cost — not yet measured`;
    const verdict = cost.onFrontier ? "on the frontier" : cost.dominatedBy ? `dominated by ${esc(cost.dominatedBy)}` : "not graded — cost only";
    return `<span class="cbadge">${"💲".repeat(cost.band)}</span> ${fmtMult(cost.multiplier)} · ${verdict}${cost.thin ? " · thin evidence" : ""}`;
  }

  window.perfViews = { coverageGrid, reliabilityBars, leadersList, modelDashboard, costScreen };
})();
