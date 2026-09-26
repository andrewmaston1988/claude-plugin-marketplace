// Stratified, deterministic sample of typed turns for distillation.
const BUCKETS = [
  ["short (<15 words)", r => r.words < 15, 120],
  ["mid (15-50 words)", r => r.words >= 15 && r.words < 50, 120],
  ["long (50-150 words)", r => r.words >= 50 && r.words < 150, 120],
  ["longest (150+ words)", r => r.words >= 150, 30],
];

function lcg(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

export function buildSample(turns, { seed = 42 } = {}) {
  const rnd = lcg(seed);
  const typed = turns.filter(r => r.kind === "typed");
  const sections = [];
  let words = 0, count = 0;
  for (const [name, f, n] of BUCKETS) {
    const pool = typed.filter(f);
    const a = [...pool];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    const picked = a.slice(0, n).sort((x, y) => (x.ts || "").localeCompare(y.ts || ""));
    words += picked.reduce((s, r) => s + r.words, 0);
    count += picked.length;
    sections.push(`# ${name} — ${picked.length} of ${pool.length}\n\n` +
      picked.map(r => `- [${(r.ts || "").slice(0, 10)}] ${r.text.replace(/\n/g, "\n  ")}`).join("\n\n"));
  }
  return { markdown: sections.join("\n\n"), words, count };
}
