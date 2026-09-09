// Performance-page widgets: coverage grid, reliability bars, leaders list,
// cost plots.
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
    const fmtMult = (m) => (m >= 10 ? Math.round(m) : Math.round(m * 10) / 10) + "×";
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

  // The cost read-model as two charts: a quality×cost scatter with the
  // frontier emphasised, and a log cost spread that doubles as the table view
  // (every value also written as text beside its mark). Both draw only — the
  // multipliers, bands and frontier verdicts arrive from the server's
  // costView(); nothing here recomputes them. Unmeasured models are a void in
  // their own strip, never a fabricated position on the cost axis; thin
  // evidence is hollow in the mark, not only in a caption.
  function costPlots(data, h) {
    const { esc, enc } = h;
    const { points, spread, bands } = data;
    if (!points.length && !spread.length) return `<div class="empty">no cost history yet — the derivation starts when a live usage fetch banks weekly segments.</div>`;
    // Log axis: multipliers span decades (sub-1× thin readings to ~20×), and
    // ticks at the 1-2-5 decades keep 1× and 2× apart where the reading matters.
    const TICKS = [0.5, 1, 2, 5, 10, 20];
    const LO = Math.log10(0.5), HI = Math.log10(20);
    const fmtMult = (m) => (m >= 10 ? Math.round(m) : Math.round(m * 10) / 10) + "×";
    // One responsive SVG scaled to the phone by its viewBox, as the coverage grid.
    const L = 30, PW = 236, GAP = 12, SW = 30, R = 34, T = 18, B = 22, H = 196;
    const W = L + PW + GAP + SW + R, plotR = L + PW;
    const Y = (w) => T + (1 - w / 10) * (H - B - T);
    const X = (m) => Math.max(L + 3, Math.min(plotR - 3, L + ((Math.log10(m) - LO) / (HI - LO)) * PW));
    const unmX = plotR + GAP + SW / 2;
    const bandEdge = (b) => b > 0.5 && b < 20 ? X(b) : null;
    let svg = `<svg viewBox="0 0 ${W} ${H}" class="costplot" preserveAspectRatio="xMinYMin meet">`;
    for (const t of [0, 5, 10]) {
      svg += `<line x1="${L}" y1="${Y(t)}" x2="${plotR}" y2="${Y(t)}" stroke="var(--rule)" stroke-width="1"/>`;
      svg += `<text x="${L - 4}" y="${Y(t) + 3}" text-anchor="end" font-size="8" fill="var(--faint)">${t}</text>`;
    }
    for (const b of bands || []) {
      const x = bandEdge(b);
      if (x == null) continue;
      svg += `<line x1="${x}" y1="${T}" x2="${x}" y2="${H - B}" stroke="var(--rule)" stroke-width="1"/>`;
      svg += `<text x="${x}" y="${T - 6}" text-anchor="middle" font-size="8" fill="var(--faint)">${esc(fmtMult(b))}</text>`;
    }
    for (const t of TICKS) svg += `<text x="${X(t)}" y="${H - B + 13}" text-anchor="middle" font-size="8" fill="var(--faint)">${esc(fmtMult(t))}</text>`;
    // The unmeasured strip: past a divider, at their true weighted score, void-marked.
    svg += `<line x1="${plotR + GAP / 2}" y1="${T}" x2="${plotR + GAP / 2}" y2="${H - B}" stroke="var(--rule)" stroke-width="1"/>`;
    svg += `<text x="${unmX}" y="${T - 6}" text-anchor="middle" font-size="7.5" fill="var(--faint)">unmeasured</text>`;
    const hit = (cx, cy, tip) => `<circle cx="${cx}" cy="${cy}" r="10" fill="transparent" pointer-events="all"><title>${tip}</title></circle>`;
    for (const p of points.filter((p) => p.multiplier == null)) {
      svg += `<circle cx="${unmX}" cy="${Y(p.wtd)}" r="4" class="unm"><title>${esc(p.model)} · unmeasured · wtd ${p.wtd.toFixed(2)} · n=${p.n}</title></circle>`;
      svg += hit(unmX, Y(p.wtd), `${esc(p.model)} · unmeasured · wtd ${p.wtd.toFixed(2)} · n=${p.n}`);
    }
    for (const p of points.filter((p) => p.multiplier != null)) {
      const cx = X(p.multiplier), cy = Y(p.wtd);
      const tip = `${esc(p.model)} · ${esc(fmtMult(p.multiplier))} · wtd ${p.wtd.toFixed(2)} · n=${p.n}${p.thin ? " · thin" : ""}${p.dominatedBy ? ` · dominated by ${esc(p.dominatedBy)}` : ""}`;
      svg += `<circle cx="${cx}" cy="${cy}" r="4" class="${p.onFrontier ? "fr" : "dom"}${p.thin ? " thin" : ""}"/>`;
      // Selective direct labels: frontier members only — the ones worth naming.
      if (p.onFrontier) {
        const left = cx > plotR * 0.6;
        svg += `<text x="${left ? cx - 7 : cx + 7}" y="${cy + 3}" text-anchor="${left ? "end" : "start"}" font-size="9" fill="var(--muted)">${esc(p.model)}</text>`;
      }
      svg += hit(cx, cy, tip);
    }
    svg += `</svg>`;
    const legend = `<div class="chips" style="padding:0"><span class="chip"><i class="dot" style="background:var(--accent)"></i>frontier</span><span class="chip"><i class="dot" style="background:var(--muted);opacity:.55"></i>dominated</span><span class="chip"><i class="dot dot-thin"></i>thin</span><span class="chip"><i class="dot dot-unm"></i>unmeasured</span></div>`;
    // The spread: the same axis, one row per costed model, the value as text —
    // the table twin. Frontier members keep the accent dot; unmeasured rows sit
    // below a divider with no dot at all, their "—" carrying the absence.
    const SN = 104, SV = 34, SR = 16, SH = 14;
    const X2 = (m) => Math.max(SN + 3, Math.min(W - SV - 3, SN + ((Math.log10(m) - LO) / (HI - LO)) * (W - SN - SV)));
    const H2 = SH + spread.length * SR;
    let s2 = `<svg viewBox="0 0 ${W} ${H2}" class="costspread" preserveAspectRatio="xMinYMin meet">`;
    for (const t of TICKS) s2 += `<text x="${X2(t)}" y="10" text-anchor="middle" font-size="8" fill="var(--faint)">${esc(fmtMult(t))}</text>`;
    for (const b of bands || []) {
      const x = b > 0.5 && b < 20 ? X2(b) : null;
      if (x == null) continue;
      s2 += `<line x1="${x}" y1="${SH}" x2="${x}" y2="${H2}" stroke="var(--rule)" stroke-width="1"/>`;
    }
    const firstUnm = spread.findIndex((r) => r.mult == null);
    if (firstUnm >= 0) s2 += `<line x1="0" y1="${SH + firstUnm * SR}" x2="${W}" y2="${SH + firstUnm * SR}" stroke="var(--rule)" stroke-width="1"/>`;
    const ptOf = new Map(points.map((p) => [p.model, p]));
    spread.forEach((r, i) => {
      const y = SH + i * SR + SR / 2, unm = r.mult == null;
      const p = ptOf.get(r.model);
      s2 += `<text x="4" y="${y + 3.5}" font-size="9.5" fill="${unm ? "var(--faint)" : "var(--muted)"}" data-href="#/perf/model/${enc(r.model)}" style="cursor:pointer"><title>${esc(r.model)} · ${unm ? "unmeasured" : esc(fmtMult(r.mult))} · ${r.measuredRequests} measured of ${r.requests} requests · ${r.measuredWeeks} of ${r.weeks} weeks${r.thin ? " · thin" : ""}</title>${esc(r.model)}</text>`;
      if (!unm) s2 += `<circle cx="${X2(r.mult)}" cy="${y}" r="3.5" class="${p && p.onFrontier ? "fr" : "dom"}${r.thin ? " thin" : ""}"/>`;
      s2 += `<text x="${W - 4}" y="${y + 3.5}" text-anchor="end" font-size="9" fill="${unm ? "var(--faint)" : "var(--muted)"}">${unm ? "—" : esc(fmtMult(r.mult))}</text>`;
    });
    s2 += `</svg>`;
    const scatter = points.length ? `${legend}<div style="height:6px"></div>${svg}` : `<div class="empty">no graded leaves yet — the spread below is the cost axis alone.</div>`;
    return `<div class="cost"><div class="section"><span>quality × cost</span><span class="line"></span></div>${scatter}<div class="section" style="margin-top:12px"><span>cost spread</span><span class="line"></span></div>${s2}</div>`;
  }

  // The chip's inner text, kept out of the dashboard template: a band badge
  // plus the frontier verdict (or the honest "uncompared" for a priced model
  // with no grades).
  function costChipInner(cost, esc, fmtMult) {
    if (cost.band == null) return `<span class="cbadge none">—</span> cost — not yet measured`;
    const verdict = cost.onFrontier ? "on the frontier" : cost.dominatedBy ? `dominated by ${esc(cost.dominatedBy)}` : "not graded — cost only";
    return `<span class="cbadge">${"💲".repeat(cost.band)}</span> ${fmtMult(cost.multiplier)} · ${verdict}${cost.thin ? " · thin evidence" : ""}`;
  }

  window.perfViews = { coverageGrid, reliabilityBars, leadersList, modelDashboard, costPlots };
})();
