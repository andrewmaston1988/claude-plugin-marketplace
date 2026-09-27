// Render primitives shared by every screen: closure-free, so phone and desktop
// builders draw the same markup. Inlined into the page by page-assets.mjs.
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const COLOR = { ok: "var(--ok)", run: "var(--accent)", warn: "var(--warn)", bad: "var(--bad)", pend: "var(--rule)" };

  const fmtTok = (n) => !n ? "—" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
  const fmtDur = (ms) => { if (ms == null) return "—"; const s = Math.max(0, Math.round(ms / 1000)); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

  const countsHtml = (byState) => {
    const n = (...ks) => ks.reduce((a, k) => a + (byState[k] || 0), 0);
    const parts = [["ok", n("ok", "skipped"), "✓"], ["run", n("running", "retrying"), "◐"], ["warn", n("rate-limited") + n("quota"), "⧖"], ["bad", n("failed", "failed:timeout", "failed:stopped", "blocked"), "✗"], ["pend", n("pending"), "·"], ["pend", n("aborted"), "✕"]];
    return `<span class="counts">${parts.filter(([, v]) => v).map(([c, v, g]) => `<span class="c-${c}">${v}${g}</span>`).join("")}</span>`;
  };
  const barHtml = (byState, total) => {
    const seg = (ks, color) => { const v = ks.reduce((a, k) => a + (byState[k] || 0), 0); return v ? `<span style="flex:${v};background:${color}"></span>` : ""; };
    const done = ["ok", "skipped", "failed", "failed:timeout", "failed:stopped", "blocked", "running", "retrying", "rate-limited", "quota"].reduce((a, k) => a + (byState[k] || 0), 0);
    return `<div class="bar">${seg(["ok", "skipped"], "var(--ok)")}${seg(["failed", "failed:timeout", "failed:stopped", "blocked"], "var(--bad)")}${seg(["running", "retrying"], "var(--accent)")}${seg(["rate-limited", "quota"], "var(--warn)")}<span style="flex:${Math.max(0, total - done)};background:transparent"></span></div>`;
  };

  const dot = (c, ring) => `<svg class="rail" viewBox="0 0 56 56" width="56" height="56" preserveAspectRatio="none"><path d="M12 0v56" stroke="var(--rule)" stroke-width="2"/><circle cx="12" cy="28" r="5" fill="${COLOR[c]}"/>${ring ? '<circle class="ring" cx="12" cy="28" r="9"/>' : ""}</svg>`;

  // The rail's running glyph — same geometry and .ring animation as dot() — sized into a banner circle.
  const SPIN = `<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="var(--accent)"/><circle class="ring" cx="12" cy="12" r="9"/></svg>`;
  const tile = (kind, icon, title, sub, href, subHtml = false) =>
    `<div class="banner ${kind}${href ? " tap" : ""}"${href ? ` role="link" data-key="banner" data-href="${esc(href)}"` : ""}>`
    + `<span class="ic${icon === SPIN ? " bare" : ""}">${icon}</span><div class="txt"><div class="t">${esc(title)}</div><div class="s">${subHtml ? sub : esc(sub)}</div></div>`
    + (href ? `<span class="go">›</span>` : "") + `</div>`;

  // The cost badge — 💲 by band, — unmeasured — belongs where models are
  // COMPARED: the perf rank lists and the model's dashboard. Never on leaf or
  // run rows: a run is being read, not compared, and badges there are clutter
  // (operator's correction, 2026-09-09). An unmeasured tier shows —, never a
  // blank that would read as dominated; absence is not evidence.
  // Cost is a stack of 1–5 coins, scaled within the provider (server-side `coins`) (the symbol in the page's hidden defs), each
  // coin 21 units above the last with a little hand-stacked jitter.
  const COIN_JITTER = [[88, -1], [84, 1.4], [93, -1.7], [86, 1], [94, -1.2]];
  // The podium trophy: one figure, a palette per metal (operator-supplied), drawn
  // once into #trophy-art and <use>d per card.
  const TROPHY_METALS = { gold: {"metal":["#8a4300","#ffd12a","#fff170","#d68100","#ffe04a","#7a3500"],"face":["#fff8b0","#ffd52a","#b65f00"],"line":"#713500","rim":"#ffcf27","top":"#ffe45a","visorLine":"#854100","visor":"#ffdd4d","glass":"#fff29a","eye":"#683000","medLine":"#c97600","screen":"#8b4300","screenLit":"#ffd94a","pupil":"#653000","shine":"#ffe66a","numeral":"#542600"}, silver: {"metal":["#555d63","#d9e0e5","#ffffff","#8e989f","#e8edf0","#4a5055"],"face":["#ffffff","#dfe5e9","#737d84"],"line":"#4e565b","rim":"#cbd2d8","top":"#eef3f6","visorLine":"#626b71","visor":"#dce3e7","glass":"#f8fbfc","eye":"#444b50","medLine":"#7d878e","screen":"#5b646a","screenLit":"#e7ecef","pupil":"#41484d","shine":"#ffffff","numeral":"#4f585e"}, bronze: {"metal":["#5f2d16","#d98a4a","#f4bd82","#8e421f","#d98243","#4b2111"],"face":["#ffd2a0","#c9793e","#713218"],"line":"#572813","rim":"#a85d28","top":"#e2a05f","visorLine":"#6d3219","visor":"#c77a42","glass":"#efbd8c","eye":"#4c2212","medLine":"#8f4825","screen":"#6c3219","screenLit":"#d28a50","pupil":"#4e2413","shine":"#f3c08a","numeral":"#542600"} };
  const trophyDefs = (m, c) => `<linearGradient id="tr-${m}-metal" x1="0" x2="1">${c.metal.map((col, i) => `<stop offset="${[0, .18, .35, .58, .78, 1][i]}" stop-color="${col}"/>`).join("")}</linearGradient>
      <radialGradient id="tr-${m}-face" cx=".3" cy=".2">${c.face.map((col, i) => `<stop offset="${[0, .35, 1][i]}" stop-color="${col}"/>`).join("")}</radialGradient>
      <g id="trophy-${m}">
        <ellipse cx="150" cy="409" rx="105" ry="9" opacity=".18" filter="url(#tr-blur)"/>
        <ellipse cx="150" cy="389" rx="91" ry="15" fill="${c.rim}" stroke="${c.line}" stroke-width="4"/>
        <path d="M59 389 L59 402 C59 412 100 419 150 419 C200 419 241 412 241 402 L241 389 C241 398 200 405 150 405 C100 405 59 398 59 389Z" fill="url(#tr-${m}-metal)" stroke="${c.line}" stroke-width="4"/>
        <path d="M82 329 L91 389 C108 394 128 397 150 397 C172 397 192 394 209 389 L218 329 C196 336 174 339 150 339 C126 339 104 336 82 329Z" fill="url(#tr-black)" stroke="#080808" stroke-width="4"/>
        <path d="M105 350 Q150 355 195 350 L191 380 Q150 387 109 380Z" fill="url(#tr-${m}-metal)" stroke="${c.line}" stroke-width="3"/>
        <ellipse cx="150" cy="316" rx="79" ry="14" fill="${c.top}" stroke="${c.line}" stroke-width="4"/>
        <path d="M150 48V30" stroke="${c.line}" stroke-width="8"/><circle cx="150" cy="22" r="11" fill="url(#tr-${m}-face)" stroke="${c.line}" stroke-width="3"/>
        <rect x="69" y="48" width="162" height="94" rx="42" fill="url(#tr-${m}-face)" stroke="${c.line}" stroke-width="4"/>
        <rect x="53" y="78" width="25" height="39" rx="12" fill="url(#tr-${m}-metal)" stroke="${c.line}" stroke-width="4"/><rect x="222" y="78" width="25" height="39" rx="12" fill="url(#tr-${m}-metal)" stroke="${c.line}" stroke-width="4"/>
        <rect x="91" y="67" width="118" height="56" rx="18" fill="${c.visor}" stroke="${c.visorLine}" stroke-width="4"/>
        <rect x="99" y="75" width="102" height="40" rx="13" fill="${c.glass}" opacity=".72"/>
        <circle cx="125" cy="95" r="9" fill="${c.eye}"/><circle cx="175" cy="95" r="9" fill="${c.eye}"/>
        <rect x="128" y="141" width="44" height="20" rx="7" fill="url(#tr-${m}-metal)" stroke="${c.line}" stroke-width="4"/>
        <path d="M104 161Q150 145 196 161L207 236Q150 258 93 236Z" fill="url(#tr-${m}-face)" stroke="${c.line}" stroke-width="4"/>
        <circle cx="92" cy="178" r="20" fill="url(#tr-${m}-metal)" stroke="${c.line}" stroke-width="4"/><circle cx="208" cy="178" r="20" fill="url(#tr-${m}-metal)" stroke="${c.line}" stroke-width="4"/>
        <path d="M80 187Q62 209 82 231Q94 242 112 232" fill="none" stroke="${c.line}" stroke-width="24" stroke-linecap="round"/><path d="M80 187Q62 209 82 231Q94 242 112 232" fill="none" stroke="url(#tr-${m}-metal)" stroke-width="17" stroke-linecap="round"/>
        <path d="M220 187Q238 209 218 231Q206 242 188 232" fill="none" stroke="${c.line}" stroke-width="24" stroke-linecap="round"/><path d="M220 187Q238 209 218 231Q206 242 188 232" fill="none" stroke="url(#tr-${m}-metal)" stroke-width="17" stroke-linecap="round"/>
        <circle cx="150" cy="207" r="48" fill="url(#tr-${m}-metal)" stroke="${c.line}" stroke-width="4"/><circle cx="150" cy="207" r="39" fill="url(#tr-${m}-face)" stroke="${c.medLine}" stroke-width="2"/>
        <rect x="128" y="193" width="44" height="28" rx="7" fill="${c.screen}"/><rect x="135" y="200" width="30" height="14" rx="4" fill="${c.screenLit}"/><circle cx="143" cy="207" r="3" fill="${c.pupil}"/><circle cx="157" cy="207" r="3" fill="${c.pupil}"/><path d="M150 193v-9" stroke="${c.screen}" stroke-width="4"/><circle cx="150" cy="181" r="4" fill="${c.screen}"/>
        <path d="M111 245Q150 260 189 245L181 267Q150 278 119 267Z" fill="url(#tr-${m}-metal)" stroke="${c.line}" stroke-width="4"/>
        <path d="M126 263Q116 286 120 304H143L148 268Z" fill="url(#tr-${m}-metal)" stroke="${c.line}" stroke-width="4"/><path d="M174 263Q184 286 180 304H157L152 268Z" fill="url(#tr-${m}-metal)" stroke="${c.line}" stroke-width="4"/>
        <path d="M120 296Q103 301 102 315H145Q145 299 133 296Z" fill="url(#tr-${m}-metal)" stroke="${c.line}" stroke-width="4"/><path d="M180 296Q197 301 198 315H155Q155 299 167 296Z" fill="url(#tr-${m}-metal)" stroke="${c.line}" stroke-width="4"/>
        <path d="M71 316 L71 331 C71 340 106 346 150 346 C194 346 229 340 229 331 L229 316 C229 324 194 330 150 330 C106 330 71 324 71 316Z" fill="url(#tr-${m}-metal)" stroke="${c.line}" stroke-width="4"/>
        <path d="M74 324 C94 334 118 337 150 337 C182 337 206 334 226 324" fill="none" stroke="${c.shine}" stroke-width="2.5" opacity=".8"/>
      </g>`;

  const TROPHY_OF = { 1: "gold", 2: "silver", 3: "bronze" };
  const trophy = (place) => `<svg viewBox="48 6 204 418" aria-label="${["first", "second", "third"][place - 1]}"><use href="#trophy-${TROPHY_OF[place]}"/><text x="150" y="377" text-anchor="middle" font-family="Georgia,serif" font-size="27" font-weight="bold" fill="${TROPHY_METALS[TROPHY_OF[place]].numeral}">${"I".repeat(place)}</text></svg>`;
  const rankBadge = (pos, place) => place ? `<span class="rk trophy">${trophy(place)}</span>` : `<span class="rk">${pos}</span>`;
  const COIN_SCALE = 0.17;
  const stackTop = (n) => 108 - 21 * (n - 1) - 26;
  const coinStack = (n, scale = COIN_SCALE) => {
    const top = stackTop(n), h = 152 - top;
    const uses = COIN_JITTER.slice(0, n).map(([x, r], i) => `<use href="#coin" transform="translate(${x} ${108 - 21 * i}) rotate(${r})"/>`).join("");
    return `<svg viewBox="26 ${top} 128 ${h}" width="${Math.round(128 * scale)}" height="${Math.round(h * scale)}"><ellipse cx="90" cy="140" rx="62" ry="9" fill="#6b4300" opacity=".22" filter="url(#coin-shadow)"/>${uses}</svg>`;
  };
  // Every badge box is a full five-stack tall, coins grounded at its foot, so
  // stacks side by side share a baseline and read as different heights.
  const MAX_COINS = 5;
  const modelBadge = (c, scale) => c && c.coins != null
    ? `<span class="cbadge coins${c.provider ? ` ${esc(c.provider)}` : ""}" data-coins="${c.coins}" style="height:${Math.round((152 - stackTop(MAX_COINS)) * (scale ?? COIN_SCALE))}px" title="cost ${c.coins} of 5 within ${esc(c.provider || "its provider")}" aria-label="cost ${c.coins} of 5">${coinStack(c.coins, scale)}</span>`
    : `<span class="cbadge none">—</span>`;

  const fmtScore = (v) => (v == null ? "—" : v.toFixed(2));

  window.swarmUI = { esc, COLOR, fmtTok, fmtDur, countsHtml, barHtml, dot, SPIN, tile, TROPHY_METALS, trophyDefs, TROPHY_OF, trophy, rankBadge, COIN_SCALE, stackTop, coinStack, MAX_COINS, modelBadge, fmtScore };
})();
