// Performance-page widgets: coverage grid, reliability bars, leaders list.
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
    const { esc } = h;
    const { aspects, models, cells } = data;
    if (!models.length) return `<div class="empty">no graded leaves yet — nothing to cover.</div>`;
    // One responsive SVG: labels live inside it, so a viewBox scales the whole
    // grid to the phone's width — no horizontal scroll, no HTML/SVG row drift.
    // mild truncation: drop the provider suffix, then cap at 18 chars — the full name stays in the <title>
    const shortModel = (m) => { const s = m.replace(/(:|-)cloud$/, ""); return s.length > 18 ? s.slice(0, 17) + "…" : s; };
    const keyOf = (model, aspect) => JSON.stringify([model, aspect]);
    const byKey = new Map(cells.map((c) => [keyOf(c.model, c.aspect), c]));
    const LABEL = 128, CW = 22, CH = 24, GAP = 2, HEAD = 84;
    const w = LABEL + aspects.length * CW, hgt = HEAD + models.length * CH;
    let svg = `<svg viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="xMinYMin meet" class="covgrid">${HATCH_DEFS}`;
    aspects.forEach((a, i) => {
      // vertical header, bottom-anchored so every column's word ends at the grid edge
      const x = LABEL + i * CW + CW / 2 + 4;
      svg += `<text transform="translate(${x},${HEAD - 6}) rotate(-90)" font-size="11" fill="var(--muted)">${esc(a)}</text>`;
    });
    models.forEach((m, r) => {
      const y = HEAD + r * CH;
      svg += `<text x="${LABEL - 8}" y="${y + CH / 2 + 4}" text-anchor="end" font-size="11" fill="var(--muted)"><title>${esc(m)}</title>${esc(shortModel(m))}</text>`;
      aspects.forEach((a, c) => {
        const cell = byKey.get(keyOf(m, a)) || { n: 0, provisional: true };
        const x = LABEL + c * CW + GAP / 2, cy = y + GAP / 2, cw = CW - GAP, ch = CH - GAP;
        const fill = cell.n === 0 ? "none" : cell.provisional ? `url(#${HATCH_ID})` : "var(--accent)";
        const stroke = cell.n === 0 ? "var(--rule)" : "none";
        svg += `<rect x="${x}" y="${cy}" width="${cw}" height="${ch}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="1"><title>${esc(m)} · ${esc(a)} · n=${cell.n}${cell.provisional && cell.n ? " (provisional)" : ""}</title></rect>`;
        if (cell.n > 0) svg += `<text x="${x + cw / 2}" y="${cy + ch / 2 + 3.5}" text-anchor="middle" font-size="9" fill="#fff">${cell.n}</text>`;
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

  window.perfViews = { coverageGrid, reliabilityBars, leadersList };
})();
