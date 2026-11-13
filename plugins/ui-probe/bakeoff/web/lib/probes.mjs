// The page-side expressions. Both contenders evaluate these exact strings, so every number in the
// results table came from the same read of the same page.

const R1 = `(n) => Math.round(n * 10) / 10`;
const RECT = `(el) => { if (!el) return null; const b = el.getBoundingClientRect();
  return { x: r1(b.x), y: r1(b.y), w: r1(b.width), h: r1(b.height), right: r1(b.right), bottom: r1(b.bottom) }; }`;

export const READY_SHEET = `!!document.querySelector('#detail-sheet[open] .detail-rec')`;
export const READY_TILES = `document.querySelectorAll('.rec-tile').length >= 3`;
export const READY_SHEET_CLOSED = `!document.querySelector('#detail-sheet[open]')`;

/** T1: every box the sheet is judged on, in one read so nothing moves between them. */
export const READ_LAYOUT = `(() => {
  const r1 = ${R1}, rect = ${RECT};
  const all = (sel) => [...document.querySelectorAll(sel)].map(rect);
  const grid = document.querySelector('.detail-grid');
  const sheet = document.querySelector('#detail-sheet');
  return {
    sheet: rect(sheet), open: !!(sheet && sheet.open),
    top: rect(document.querySelector('.detail-top')),
    handle: rect(document.querySelector('.detail-handle')),
    close: rect(document.querySelector('.detail-close')),
    poster: rect(document.querySelector('.detail-poster')),
    head: rect(document.querySelector('.detail-head')),
    grid: rect(grid),
    gridCols: grid ? getComputedStyle(grid).gridTemplateColumns : null,
    acts: all('.detail-rec .act'),
    actLabels: [...document.querySelectorAll('.detail-rec .act')].map((b) => b.textContent.trim()),
    stars: rect(document.querySelector('.detail-rec .stars')),
    chips: all('.detail-rec .chip'),
    foot: all('.detail-foot button:not([hidden]), .detail-foot label'),
    footLabels: [...document.querySelectorAll('.detail-foot button:not([hidden]), .detail-foot label')].map((b) => b.textContent.trim()),
    find: rect(document.querySelector('.detail-find')),
    synopsis: rect(document.querySelector('.detail-synopsis')),
    scrollTop: (document.querySelector('.detail-scroll') || {}).scrollTop ?? null,
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vw: innerWidth, vh: innerHeight,
  };
})()`;

/** RQ2: what the tool's environment claims about hover and pointer. */
export const READ_ENV = `(() => {
  const m = (q) => matchMedia(q).matches;
  return {
    hover_hover: m('(hover: hover)'), hover_none: m('(hover: none)'),
    pointer_fine: m('(pointer: fine)'), pointer_coarse: m('(pointer: coarse)'),
    any_hover: m('(any-hover: hover)'), any_pointer_fine: m('(any-pointer: fine)'),
    maxTouchPoints: navigator.maxTouchPoints,
    touchEvent: 'ontouchstart' in window,
    innerWidth: innerWidth, innerHeight: innerHeight,
    dpr: devicePixelRatio,
    ua: navigator.userAgent,
  };
})()`;

/** T2: the hover bar's rendered state, plus the tile class the sheet script sets. */
export const READ_HOVER = `(() => {
  const tile = document.querySelectorAll('.rec-tile')[0];
  if (!tile) return { missing: 'no .rec-tile' };
  const bar = tile.querySelector('.rec-hover');
  const cs = bar && getComputedStyle(bar);
  const rect = bar ? bar.getBoundingClientRect() : null;
  return {
    tileClass: tile.className,
    mouseOver: tile.classList.contains('mouse-over'),
    display: cs ? cs.display : null,
    visibility: cs ? cs.visibility : null,
    opacity: cs ? cs.opacity : null,
    transform: cs ? cs.transform : null,
    pointerEvents: cs ? cs.pointerEvents : null,
    barW: rect ? Math.round(rect.width * 10) / 10 : null,
    barH: rect ? Math.round(rect.height * 10) / 10 : null,
    buttons: bar ? bar.querySelectorAll('button').length : 0,
    buttonVisible: bar ? [...bar.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0).length : 0,
    pointer: { fine: matchMedia('(pointer: fine)').matches, hover: matchMedia('(hover: hover)').matches },
  };
})()`;

/** RQ3: everything the animation APIs will admit to. */
export const READ_ANIM = `(() => {
  const anims = document.getAnimations ? document.getAnimations() : [];
  return {
    supported: typeof document.getAnimations === 'function',
    count: anims.length,
    animations: anims.map((a) => ({
      id: a.id || null,
      playState: a.playState,
      currentTime: typeof a.currentTime === 'number' ? Math.round(a.currentTime * 10) / 10 : null,
      duration: a.effect && a.effect.getTiming ? a.effect.getTiming().duration : null,
      target: a.effect && a.effect.target ? (a.effect.target.tagName + '.' + (a.effect.target.className || '')) : null,
      properties: a.effect && a.effect.getKeyframes ? [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k)))].filter((k) => !['offset', 'easing', 'composite', 'computedOffset'].includes(k)) : [],
    })),
  };
})()`;

/** A controlled animation, injected identically into both tools, so RQ3 has a real signal on a
 *  target whose own reveal is a discrete display flip (no transition to sample). */
export const INJECT_ANIM = `(() => {
  const tile = document.querySelectorAll('.rec-tile')[0];
  const bar = tile && tile.querySelector('.rec-hover');
  if (!bar) return 'no .rec-hover';
  window.__probeAnim = bar.animate(
    [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'translateY(0)' }],
    { duration: 240, easing: 'ease-out', fill: 'both' }
  );
  return 'started';
})()`;

/** rAF sampler: computed style once per frame for `ms`. Run it across the hover and it catches
 *  the discrete `display` flip that `getAnimations()` has no record of. */
export const sampleFor = (ms) => `(async () => {
  const tile = document.querySelectorAll('.rec-tile')[0];
  const bar = tile && tile.querySelector('.rec-hover');
  if (!bar) return { missing: 'no .rec-hover' };
  const out = [];
  const t0 = performance.now();
  await new Promise((done) => {
    function frame(now) {
      const cs = getComputedStyle(bar);
      out.push({
        t: Math.round((now - t0) * 10) / 10,
        display: cs.display, opacity: cs.opacity, transform: cs.transform,
        mouseOver: tile.classList.contains('mouse-over'),
      });
      if (now - t0 < ${ms}) requestAnimationFrame(frame); else done();
    }
    requestAnimationFrame(frame);
  });
  return { samples: out, n: out.length, elapsed: Math.round((performance.now() - t0) * 10) / 10 };
})()`;

/** RQ10 journey state: what the page currently shows, as an answerable fact set. */
export const READ_JOURNEY = `(() => {
  const sheet = document.querySelector('#detail-sheet');
  const open = !!(sheet && sheet.open);
  const acts = [...document.querySelectorAll('.detail-rec .act')].map((b) => ({
    label: b.textContent.trim(), pressed: b.getAttribute('aria-pressed'), on: b.className.replace('act', '').trim(),
  }));
  const tiles = [...document.querySelectorAll('.rec-tile')].map((t) => ({
    ck: t.getAttribute('data-ck'),
    badge: (t.querySelector('.rec-badge') || {}).textContent || '',
    badgeState: (t.querySelector('.rec-badge') || { dataset: {} }).dataset.state || '',
    title: (t.querySelector('.carousel-card-title') || {}).textContent || '',
  }));
  return {
    open, acts, tiles,
    rating: (document.querySelector('.detail-rec .sv') || {}).textContent || null,
    why: [...document.querySelectorAll('.detail-rec .chip')].map((c) => c.textContent.trim()),
    h1: (document.querySelector('.detail-head h1') || {}).textContent || null,
  };
})()`;
