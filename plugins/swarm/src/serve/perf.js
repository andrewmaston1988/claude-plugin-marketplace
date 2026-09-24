// Performance-page widgets: coverage grid, reliability bars, leaders list,
// cost screen, usage screen.
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

  // Top-k per aspect, in the report's own weighted order, as the Rank screen's podium
  // cards; a provisional entry takes the dashed bar (page.html's .crow .cbar.thin).
  function leadersList(data, h) {
    const { esc, enc, fmtScore } = h;
    if (!data.length) return `<div class="empty">no graded leaves yet.</div>`;
    return data.map((a) => {
      if (!a.top.length) {
        return `<div class="section dim"><span>${esc(a.aspect)}</span><span class="line"></span></div><div class="empty">n=0 — nothing graded on ${esc(a.aspect)} yet.</div>`;
      }
      const rows = a.top.map((t, i) => `<div class="card crow p${i + 1}" data-key="${esc(a.aspect + ":" + t.model)}" data-href="#/perf/model/${enc(t.model)}">`
        + `<div class="top"><span class="who">${h.rankBadge(i + 1, i + 1)}<span class="nm">${esc(t.model)}</span></span><span class="val">${fmtScore(t.weighted)}</span></div>`
        + `<div class="cbar${t.provisional ? " thin" : ""}"><span style="width:${Math.max(0, Math.min(100, ((t.weighted ?? 0) / 10) * 100))}%"></span></div>`
        + `<div class="sub">n=${t.n}${t.provisional ? ` · <span class="tag">provisional n&lt;5</span>` : ""}</div></div>`).join("");
      return `<div class="section"><span>${esc(a.aspect)}</span><span class="line"></span></div><div class="rlist${h.compact ? " compact" : ""}">${rows}</div>`;
    }).join("");
  }

  // One model's page as a dashboard: a hero card (graded, completed, overall, its cost coins, trophy or #n), compressed
  // aspect bars (with the domain picker in the widget header), its coverage
  // row, its reliability bar.
  function modelDashboard(data, h) {
    const { esc, enc, fmtScore } = h;
    const { model, overall, rank, aspects, coverage, reliability, domainSelect, domain, cost } = data;
    const place = rank && rank.position <= 3 ? rank.position : 0;
    const rel = reliability[0];
    const total = rel ? rel.total : 0;
    const done = rel ? (rel.byOutcome.completed || 0) : 0;
    // Cost is the model's coins within its provider plus one verdict chip — a bare
    // multiplier means nothing without its neighbours, so that stays on the Cost screen.
    const verdict = cost?.value === "best" ? ["best value", "good"] : cost?.value === "worst" ? ["worst value", "bad"] : cost?.onFrontier ? ["frontier", "front"] : null;
    // The bottom row is chips: the provider(s) first, in brand colour, then the value verdict.
    const providers = cost?.provider ? [cost.provider] : overall?.providers || [];
    const chips = providers.map((p) => `<span class="pchip ${esc(p)}">${esc(p)}</span>`).join("") + (verdict ? `<span class="vchip ${verdict[1]}">${verdict[0]}</span>` : "");
    // Below the podium the position reads RAG: 4th green, amber midway, last red.
    const rag = (pos, of) => {
      const t = of > 4 ? Math.max(0, Math.min(1, (pos - 4) / (of - 4))) : 0;
      return t <= 0.5
        ? `color-mix(in oklab, var(--warn) ${Math.round(t * 200)}%, var(--ok))`
        : `color-mix(in oklab, var(--bad) ${Math.round((t - 0.5) * 200)}%, var(--warn))`;
    };
    const hero = `<div class="card mhero${place ? ` p${place}` : rank ? ` rag" style="--rag:${rag(rank.position, rank.of)}` : ""}">
      <div class="stats"><div class="figs">
        <div><label>graded</label><b>${total}</b></div>
        <div><label>completed</label><b>${total ? Math.round((done / total) * 100) + "%" : "—"}</b></div>
        <div><label>overall</label><b>${fmtScore(overall ? overall.combined : null)}</b></div>
        <div class="cost">${cost == null ? "" : h.badge(cost, 0.25)}</div>
      </div>${chips ? `<div class="chipsl">${chips}</div>` : ""}</div>
      <div class="show">${place ? h.trophy(place) : rank ? `<span class="no">${rank.position}</span>` : ""}</div>
    </div>`;
    const rows = aspects.map((a) => {
      const c = a.cell;
      const w = c && c.weighted != null ? Math.max(0, Math.min(100, (c.weighted / 10) * 100)) : 0;
      const none = !c || c.weighted == null;
      return `<div class="arow${none ? " none" : ""}" data-href="#/perf/aspect/${enc(a.aspect)}"><span class="alabel">${esc(a.aspect)}</span><div class="bar${c && c.provisional ? " prov" : ""}"><span style="width:${w}%"></span></div><span class="aval">${none ? "—" : fmtScore(c.weighted)}<small>${c ? " n=" + c.n : ""}</small></span></div>`;
    }).join("");
    const aspectWidget = `<div class="section"><span>aspects</span><span class="line"></span>${domainSelect ? `<span class="secsel">${domainSelect}</span>` : ""}</div><div class="aspects">${rows}</div>`;
    const covWidget = `<div class="section"><span>coverage</span><span class="line"></span></div>${coverageGrid(coverage, h)}`;
    const relWidget = `<div class="section"><span>reliability</span><span class="line"></span></div>${reliabilityBars(reliability, h)}`;
    return hero + aspectWidget + covWidget + relWidget;
  }

  // The cost read-model as the mockup's Cost screen (prototype.html 922–983): one
  // provider per page from the slide control — multipliers only compare within a
  // provider — then its value hero, then a ranked card per model, or one
  // fact card when nothing is measured. Draws only: multipliers, bands and verdicts
  // arrive from the server's costView().
  function costScreen(data, h, pick) {
    const { esc, enc, seg } = h;
    const all = data.sections?.length ? data.sections : [{
      provider: null, points: data.points || [], spread: data.spread || [], best: data.best, worst: data.worst,
    }];
    const sections = all.filter((s) => s.points.length || s.spread.length);
    if (!sections.length) {
      return `<div class="empty">no cost history yet — the derivation starts when a live usage fetch banks weekly segments.</div>`;
    }
    const name = (s) => s.provider || "unqualified";
    const section = sections.find((s) => name(s) === pick) || sections[0];
    // Never "0×" for a missing multiplier — that would read as free.
    const fmtMult = (m) => m == null ? "—" : (m >= 10 ? Math.round(m) : Math.round(m * 10) / 10) + "×";
    // One page per provider, switched like Performance's views — multipliers never
    // compare across providers. The card names this provider's best value; without
    // one it says why, never the cheapest instead.
    const switcher = seg(sections.map((s) => ({ label: name(s), href: `#/cost/${enc(name(s))}` })), sections.indexOf(section));
    const whyNone = (s) => (s.points || []).some((p) => p.wtd != null) ? "no clear best yet" : "not graded yet";
    // Log-scaled over 0.5×–20×: multipliers span decades, so a linear bar makes every
    // cheap model a stub and hides the 1×-vs-2× difference that decides a seat.
    const LO = Math.log10(0.5), HI = Math.log10(20);
    const pct = (m) => Math.max(2, Math.min(100, ((Math.log10(m) - LO) / (HI - LO)) * 100));
    // The value case against this provider's top scorer: how close to its score, at what
    // share of its cost. The cost bar shares the cards' log scale below.
    const b = section.best, cl = `<div class="cl"><span>best value</span><span>${esc(name(section))}</span></div>`;
    const hero = !b ? `<div class="card chero none">${cl}<div class="claim">${whyNone(section)}</div></div>` : (() => {
      const lead = section.points.reduce((m, p) => (p.wtd ?? -1) > (m.wtd ?? -1) ? p : m, b);
      const q = lead.wtd > 0 && b.wtd != null ? Math.round((b.wtd / lead.wtd) * 100) : null;
      const c = b.multiplier > 0 ? Math.round(pct(b.multiplier)) : null;
      const vbar = (label, w, val, cls) => `<div class="vbar"><span class="k">${label}</span><div class="bar ${cls}"><span style="width:${w ?? 0}%"></span></div><b>${val}</b></div>`;
      const claim = lead === b || lead.model === b.model ? "the top score here, at the lowest cost that reaches it"
        : lead.multiplier > 0 && q != null ? `${q}% of ${esc(lead.model)}'s score at ${Math.round((b.multiplier / lead.multiplier) * 100)}% of its cost` : "on the value frontier";
      return `<div class="card chero" data-href="#/perf/model/${enc(b.model)}">${cl}<div class="fig">${esc(b.model)}</div><div class="claim">${claim}</div>`
        + vbar("score", q, b.wtd == null ? "—" : b.wtd.toFixed(1), "q") + vbar("cost", c, esc(fmtMult(b.multiplier)), "c") + `</div>`;
    })();
    const tabs = switcher + hero;
    const { points, spread, best } = section;
    const isMeter = (r) => !r.unit || r.unit === "meter-points" || r.unit === "quota-weight" || r.unit === "meter-points/request";
    const head = tabs;
    if (!spread.some((r) => r.mult != null)) {
      return head + `<div class="card cfact"><b>Not measured yet</b><div class="sub">no ${esc(name(section))} model has a price or banked history yet — a live usage fetch starts it.</div></div>`;
    }
    const ptOf = new Map(points.map((p) => [p.model, p]));
    const verdict = (r) => {
      const p = ptOf.get(r.model);
      if (best && best.model === r.model) return `best value${data.valueMargin == null ? "" : ` · within ${data.valueMargin} of the best`}`;
      if (p && p.dominatedBy) return `beaten by ${esc(p.dominatedBy)}`;
      if (p && p.onFrontier) return "on the frontier";
      return "not graded — cost only";
    };
    let rank = 0;
    const cards = spread.map((r) => {
      const top = (rk, val) => `<div class="top"><span class="who"><span class="rk">${rk}</span><span class="nm">${esc(r.model)}</span></span><span class="val">${val}</span></div>`;
      const href = `data-href="#/perf/model/${enc(r.model)}"`;
      if (r.mult == null) return `<div class="card crow unm" ${href}>${top("·", "—")}<div class="sub">unmeasured — no price or banked history</div></div>`;
      const evidence = [verdict(r), r.thin ? "thin evidence" : null, isMeter(r) && r.measuredRequests != null ? `${r.measuredRequests} measured requests` : null].filter(Boolean).join(" · ");
      return `<div class="card crow" ${href}>${top(++rank, esc(fmtMult(r.mult)))}`
        + `<div class="cbar${r.thin ? " thin" : ""}"><span style="width:${pct(r.mult).toFixed(1)}%"></span></div>`
        + `<div class="sub">${evidence}</div></div>`;
    }).join("");
    return head + cards;
  }

  // The Usage screen (mockup 403–484): a Session/Week switch, a hero naming the
  // provider with the least headroom, then a card per provider. A limit's percent
  // is USED; every figure drawn is what is LEFT.
  function usageScreen(data, h, w) {
    const { esc } = h;
    const LOW = 20, WARN = LOW * 2;
    const week = w !== "session";
    // Anthropic reports weekly_all/weekly_scoped; codex's primary/secondary match neither, by design.
    const fits = (k) => (week ? k === "weekly" || k.startsWith("weekly_") : k === "session");
    // Several buckets of one window: the most-consumed is the one that stops work.
    const limitOf = (u) => (u.limits || []).filter((l) => fits(l.kind || "")).sort((a, b) => b.percent - a.percent)[0] || null;
    const tone = (n) => (n <= LOW ? "bad" : n <= WARN ? "warn" : "ok");
    const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const pad = (n) => String(n).padStart(2, "0");
    const resets = (iso) => {
      const d = new Date(iso);
      if (Number.isNaN(+d)) return null;
      const day = +d - Date.now() < 6 * 86_400_000 ? DAYS[d.getDay()] : `${d.getDate()}/${d.getMonth() + 1}`;
      return `resets ${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    // The roster is what the read named — answered or failed — alphabetical; the hero ranks.
    const seen = new Set();
    const rows = [];
    for (const u of data.usages || []) if (!seen.has(u.provider)) { seen.add(u.provider); rows.push({ provider: u.provider, usage: u }); }
    for (const [provider, error] of Object.entries(data.errors || {})) if (!seen.has(provider)) { seen.add(provider); rows.push({ provider, error }); }
    rows.sort((a, b) => a.provider.localeCompare(b.provider));
    const reading = (p) => {
      // Exhausted is dead in every window: 0% left. The note is when it is back — the LAST
      // spent limit to reset; red 0% already says it ran out.
      if (p.usage?.state === "exhausted") {
        const back = (p.usage.limits || []).filter((l) => l.percent >= 100 && l.resetsAt).map((l) => l.resetsAt).sort().pop();
        return { left: 0, note: back ? resets(back) : "" };
      }
      const l = p.usage && limitOf(p.usage);
      if (!l) return null;
      const left = Math.max(0, Math.min(100, Math.round(100 - l.percent)));
      return { left, note: l.resetsAt ? resets(l.resetsAt) : "" };
    };
    // No figure is not a zero: the card stays, dim, saying why.
    const whyNot = (p) => {
      if (p.error) return p.error;
      const kinds = [...new Set((p.usage.limits || []).map((l) => l.kind).filter(Boolean))];
      return p.usage.reason || (kinds.length ? `reports ${kinds.join(", ")} — no ${week ? "weekly" : "session"} window` : "no reading");
    };
    const bar = (n) => `<div class="ubar"><span class="${tone(n)}" style="width:${n}%"></span></div>`;
    const tabs = h.seg([{ label: "Week", href: "#/usage/week" }, { label: "Session", href: "#/usage/session" }], week ? 0 : 1);
    if (!rows.length) return tabs + `<div class="empty">no provider answered — run swarm usage to read them once.</div>`;
    // The hero is where the next run goes: the provider with the most left.
    const best = rows.map((p) => ({ p, r: reading(p) })).filter((x) => x.r)
      .reduce((a, b) => (a && a.r.left >= b.r.left ? a : b), null);
    // "Every provider" is only true when every provider was read.
    const unread = rows.filter((p) => !reading(p)).map((p) => p.provider);
    const heroNote = (n) => (n <= LOW ? "Every provider is low — throttle before the next big run."
      : n <= WARN ? "Enough for a medium run, not a full swarm."
        : unread.length ? `Room for a full swarm — ${unread.join(", ")} not read.` : "Room for a full swarm.");
    const hero = best
      ? `<div class="uhero ${tone(best.r.left)}"><div class="lbl">MOST LEFT THIS ${week ? "WEEK" : "SESSION"} · ${esc(best.p.provider.toUpperCase())}</div>`
        + `<div class="fig"><b>${best.r.left}%</b><span>left</span></div>${bar(best.r.left)}<div class="sub">${esc(heroNote(best.r.left))}</div></div>`
      : "";
    const cards = rows.map((p) => {
      const r = reading(p);
      // A held-over reading (the endpoint refused a fresh one) keeps its figures, tagged.
      const nm = `<span class="nm">${esc(p.provider)}${p.usage?.provenance === "stale" ? '<span class="chip warn stale">stale</span>' : ""}</span>`;
      if (!r) return `<div class="card upc unread"><div class="top">${nm}</div><div class="sub">${esc(`not read — ${whyNot(p)}`)}</div></div>`;
      return `<div class="card upc ${tone(r.left)}"><div class="top">${nm}<span class="val ${tone(r.left)}">${r.left}%</span></div>${bar(r.left)}`
        + (r.note ? `<div class="sub">${esc(r.note)}</div>` : "") + "</div>";
    }).join("");
    return tabs + hero + `<div class="section"><span>providers</span><span class="line"></span></div>` + cards;
  }

  window.perfViews = { coverageGrid, reliabilityBars, leadersList, modelDashboard, costScreen, usageScreen };
})();
