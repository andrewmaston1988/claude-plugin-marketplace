// report.md → report.html — a MECHANICAL projection of the markdown, never a
// second artifact the model authors. Zero-dep: standard markdown → HTML plus five
// semantic upgrades the report prompt documents (verdict badges, operator-feel
// chip, path:line citations, coverage callout, provenance strip) and a confidence
// tally synthesised by counting the verdict badges. The CSS is lifted verbatim from
// the design-of-record (plans/swarm-report-design-reference.html); do not re-derive.
//
// Load-bearing invariants (pinned in tests/md-to-html.test.mjs):
//  - escape < > & BEFORE any regex upgrade — leaf output can contain <script>.
//  - a verdict word only badges when it LEADS a ledger row, never mid-prose.
//  - a path:line inside a ``` fence is code, never a citation.
//  - a malformed report (no ledger, no footnote) still renders — degrade, never throw.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERDICTS = {
  PROVEN: "b-proven", CONFIRMED: "b-confirmed", OPEN: "b-open",
  REFUTED: "b-refuted", OVERCLAIM: "b-overclaim", UNVERIFIED: "b-unverif",
};
// citation shape: a source path with an extension, then :line (optionally a range).
const CITE_RE = /\b[\w./-]+\.[A-Za-z]{1,5}:\d+(?:-\d+)?\b/g;

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isCitation(s) {
  CITE_RE.lastIndex = 0;
  const m = CITE_RE.exec(s);
  return !!m && m[0] === s.trim();
}

function citeSpan(text, { strike = false } = {}) {
  return `<cite class="cite${strike ? " strike" : ""}">${text}</cite>`;
}

const FEEL_CHIP = `<span class="feel">operator-feel, unresolved</span>`;

// Inline formatting for a run of prose. Escape first; protect code spans, citations
// and the feel chip behind placeholders so bold/italic can't reach into them; then
// emphasis; then restore. Everything here operates on already-escaped text.
function inlineFmt(text) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let t = escapeHtml(text);
  // inline `code` — a backticked path:line is a citation, everything else is code.
  t = t.replace(/`([^`]+)`/g, (_m, c) => hold(isCitation(c) ? citeSpan(c) : `<code>${c}</code>`));
  // the playtest chip (optionally italic-wrapped in the source)
  t = t.replace(/\*?operator-feel,?\s+unresolved\*?/gi, () => hold(FEEL_CHIP));
  // bare path:line citations
  t = t.replace(CITE_RE, (m) => hold(citeSpan(m)));
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i) => held[+i]);
  return t;
}

// A list item may LEAD with a bold verdict word — that, and only that, badges.
function liHtml(raw) {
  const m = /^\*\*(PROVEN|OPEN|REFUTED|UNVERIFIED|CONFIRMED|OVERCLAIM)\b([^*]*)\*\*\s*/i.exec(raw);
  if (m) {
    const cls = VERDICTS[m[1].toUpperCase()];
    const badge = `<span class="badge ${cls}">${m[1].toUpperCase()}</span>`;
    const qualifier = m[2].trim() ? " " + inlineFmt(m[2].trim()) : "";
    const rest = raw.slice(m[0].length).trim();
    return badge + qualifier + (rest ? " " + inlineFmt(rest) : "");
  }
  return inlineFmt(raw);
}

function isBlockStart(line) {
  return /^(#{1,6}\s|```|>|\s*[-*]\s|-{3,}\s*$)/.test(line) || /^\*Run:.*\*\s*$/.test(line.trim());
}

function parseBlocks(md) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    if (/^```/.test(line.trim())) {
      i++;
      const code = [];
      while (i < lines.length && !lines[i].trim().startsWith("```")) { code.push(lines[i]); i++; }
      i++;
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    let m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) { blocks.push({ type: "heading", level: m[1].length, text: m[2].trim() }); i++; continue; }
    if (/^\*Run:.*\*\s*$/.test(line.trim())) { blocks.push({ type: "run", text: line.trim() }); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ type: "hr" }); i++; continue; }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, "")); i++; }
      blocks.push({ type: "quote", text: quote.join(" ") });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length &&
        lines[i + 1].includes("-") && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const rows = [line, lines[i + 1]]; i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") { rows.push(lines[i]); i++; }
      blocks.push({ type: "table", rows });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
        while (i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) {
          items[items.length - 1] += " " + lines[i].trim(); i++;
        }
      }
      blocks.push({ type: "list", items });
      continue;
    }
    const para = [line]; i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) { para.push(lines[i]); i++; }
    blocks.push({ type: "paragraph", text: para.join(" ") });
  }
  return blocks;
}

function renderTable(rows) {
  const cells = (r) => r.replace(/^\s*\|?/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  const thead = `<thead><tr>${head.map((c) => `<th>${inlineFmt(c)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inlineFmt(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<div class="tbl-wrap"><table>${thead}${tbody}</table></div>`;
}

function renderHeading(b) {
  if (b.level === 2) {
    const num = /^(\d+)\.\s+(.*)$/.exec(b.text);
    if (num) return `<h2><span class="n">${String(num[1]).padStart(2, "0")}</span> ${inlineFmt(num[2])}</h2>`;
    return `<h2>${inlineFmt(b.text)}</h2>`;
  }
  return `<h${b.level}>${inlineFmt(b.text)}</h${b.level}>`;
}

function renderBlock(b) {
  switch (b.type) {
    case "heading": return renderHeading(b);
    case "hr": return "<hr>";
    case "code": return `<pre><code>${escapeHtml(b.text)}</code></pre>`;
    case "quote": return `<blockquote>${inlineFmt(b.text)}</blockquote>`;
    case "table": return renderTable(b.rows);
    case "list": return `<ul>${b.items.map((it) => `<li>${liHtml(it)}</li>`).join("")}</ul>`;
    case "paragraph":
      // a ⚠ line is a coverage callout, not a paragraph.
      if (/^\s*⚠/.test(b.text)) return `<div class="callout">${inlineFmt(b.text.replace(/^\s*⚠\s*/, ""))}</div>`;
      return `<p>${inlineFmt(b.text)}</p>`;
    default: return "";
  }
}

// The PROVEN / OPEN ledger renders as a two-track board when the structure is
// there (a **PROVEN** paragraph + list, a **OPEN** paragraph + list); otherwise it
// degrades to the section's normal block rendering.
function renderLedger(blocks) {
  let settled = null, unsettled = null, pending = null;
  for (const b of blocks) {
    if (b.type === "paragraph" && /^\*\*PROVEN/i.test(b.text)) { pending = "settled"; continue; }
    if (b.type === "paragraph" && /^\*\*OPEN/i.test(b.text)) { pending = "unsettled"; continue; }
    if (b.type === "list" && pending === "settled") { settled = b.items; pending = null; continue; }
    if (b.type === "list" && pending === "unsettled") { unsettled = b.items; pending = null; continue; }
  }
  if (!settled || !unsettled) return blocks.map(renderBlock).join("\n");
  const track = (cls, dot, label, items) =>
    `<div class="track ${cls}"><h4><span class="dot" style="background:var(--${dot})"></span> ${label}</h4>` +
    `<ul>${items.map((it) => `<li>${liHtml(it)}</li>`).join("")}</ul></div>`;
  return `<div class="ledger">` +
    track("settled", "proven", "Proven · verifier-confirmed", settled) +
    track("unsettled", "open", "Open · unverified / refuted", unsettled) +
    `</div>`;
}

function renderProvenance(runText) {
  const inner = runText.replace(/^\*Run:\s*/i, "").replace(/\*\s*$/, "").trim();
  const parts = inner.split(/\s*·\s*/).filter(Boolean);
  const leaves = parts.map((p) => {
    const m = /^(\S+)\s+(.+?)\s*\(([^)]+)\)\s*$/.exec(p);
    const name = escapeHtml(m ? m[1] : p);
    const model = m ? escapeHtml(m[2]) : "";
    const dur = m ? escapeHtml(m[3]) : "";
    const sub = model ? `${model}${dur ? ` · ${dur}` : ""}` : escapeHtml(p);
    return `<div class="leaf"><span class="lname"><span class="sd"></span>${name}</span>` +
      `<span class="lmodel">${sub}</span></div>`;
  });
  return `<div class="prov"><div class="plbl">What made this — cross-examined</div>` +
    `<div class="leaves">${leaves.join('<span class="arrow">→</span>')}</div></div>`;
}

// The confidence tally is DERIVED — count the verdict badges the body emitted.
function renderTally(bodyHtml) {
  const count = (cls) => (bodyHtml.match(new RegExp(`class="badge ${cls}"`, "g")) || []).length;
  const cats = [
    { key: "proven", n: count("b-proven") + count("b-confirmed"), label: "proven" },
    { key: "open", n: count("b-open"), label: "open" },
    { key: "refuted", n: count("b-refuted"), label: "refuted" },
    { key: "overclaim", n: count("b-overclaim"), label: "overclaim" },
    { key: "unverif", n: count("b-unverif"), label: "unverified" },
  ].filter((c) => c.n > 0);
  if (!cats.length) return "";
  const bar = cats.map((c) => `<span style="flex:${c.n}; background:var(--${c.key})"></span>`).join("");
  const legend = cats.map((c) =>
    `<span class="k"><span class="dot" style="background:var(--${c.key})"></span> <b>${c.n}</b>&nbsp;${c.label}</span>`
  ).join("");
  const aria = cats.map((c) => `${c.n} ${c.label}`).join(", ");
  return `<div class="tally"><div class="tally-bar" role="img" aria-label="${aria}">${bar}</div>` +
    `<div class="tally-legend">${legend}</div></div>`;
}

// The masthead eyebrow names which document you are reading — the digest is a
// compressed handoff, the report a write-up; the operator ruled them distinct.
const EYEBROWS = {
  digest: "Swarm digest · compressed handoff",
  report: "Swarm source review · cross-examined",
};

function renderMasthead(h1, eyebrow) {
  const raw = h1 ? h1.text : "Swarm report";
  const parts = raw.split(/\s+—\s+/);
  const title = inlineFmt(parts[0]);
  const dek = parts.length > 1 ? `<p class="dek">${inlineFmt(parts.slice(1).join(" — "))}</p>` : "";
  return `<div class="eyebrow">${eyebrow}</div>` +
    `<h1 class="title">${title}</h1>${dek}`;
}

export function mdToHtml(md, { title, kind } = {}) {
  const blocks = parseBlocks(md || "");
  const h1 = blocks.find((b) => b.type === "heading" && b.level === 1) || null;
  const run = blocks.find((b) => b.type === "run") || null;
  const flow = blocks.filter((b) => b !== h1 && b !== run);

  // group into sections at each h1/h2; h3+ ride inside a section.
  const sections = [];
  let cur = { heading: null, blocks: [] };
  for (const b of flow) {
    if (b.type === "heading" && b.level <= 2) { sections.push(cur); cur = { heading: b, blocks: [] }; }
    else cur.blocks.push(b);
  }
  sections.push(cur);

  const isLedger = (h) => h && /proven\s*\/\s*open\s+ledger/i.test(h.text);
  const bodyHtml = sections.map((s) => {
    if (!s.heading && !s.blocks.length) return "";
    const inner = (s.heading ? renderHeading(s.heading) + "\n" : "") +
      (isLedger(s.heading) ? renderLedger(s.blocks) : s.blocks.map(renderBlock).join("\n"));
    return s.heading ? `<section>${inner}</section>` : inner;
  }).filter(Boolean).join("\n");

  const tally = renderTally(bodyHtml);
  const prov = run ? renderProvenance(run.text) : "";
  const docTitle = escapeHtml(title || (h1 ? h1.text.split(/\s+—\s+/)[0] : "Swarm report"));
  const eyebrow = EYEBROWS[kind] || EYEBROWS.report;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${docTitle}</title>
<style>${CSS}</style>
</head>
<body>
<div class="doc"><div class="wrap">
${renderMasthead(h1, eyebrow)}
${tally}
${bodyHtml}
${prov}
</div></div>
</body>
</html>`;
}

// The run's own HTML pages: digest.md → digest.html, report.md → report.html,
// each only when its source exists, each atomic (tmp + rename) so a reader never
// sees a half-written page. One helper, two callers — the scheduler (every
// finished run) and `swarm report` (the backfill); nothing else writes HTML.
// A page that cannot land is skipped without taking the healthy one down;
// sources existing but nothing landing is an error, an empty dir is not.
export function renderRunPages(resultsDir, { runName }) {
  const pages = [
    ["digest.md", "digest.html", "digest"],
    ["report.md", "report.html", "report"],
  ];
  const written = [];
  const failures = [];
  for (const [src, dst, kind] of pages) {
    const srcPath = join(resultsDir, src);
    if (!existsSync(srcPath)) continue;
    const dstPath = join(resultsDir, dst);
    const tmpPath = dstPath + ".tmp";
    try {
      writeFileSync(tmpPath, mdToHtml(readFileSync(srcPath, "utf8"), { title: `${runName} · ${kind}`, kind }));
      renameSync(tmpPath, dstPath);
      written.push(dstPath);
    } catch (e) {
      rmSync(tmpPath, { force: true }); // never leave a half-written tmp behind
      failures.push(`${src}: ${e.message}`);
    }
  }
  if (!written.length && failures.length) {
    throw new Error(`could not render ${resultsDir}: ${failures.join("; ")}`);
  }
  return written;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS lifted verbatim from plans/swarm-report-design-reference.html. Single source
// of the visual system; a change to the look edits the reference, then re-copies.
const CSS = `
  :root {
    --ground:   #e9ebf2;
    --surface:  #f7f8fb;
    --surface-2:#eef0f6;
    --ink:      #191b22;
    --muted:    #565b6b;
    --faint:    #8a8fa0;
    --rule:     #d3d7e2;
    --accent:   #5b4bd6;
    --accent-soft:#e7e4fb;

    --proven:   #1c7a4a;  --proven-bg:#dff1e6;
    --open:     #9d6a12;  --open-bg:#f7ecd2;
    --refuted:  #b5362a;  --refuted-bg:#f6dcd8;
    --overclaim:#b85e16;  --overclaim-bg:#f7e4d1;
    --unverif:  #5f6576;  --unverif-bg:#e5e7ee;

    --serif: "Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;
    --sans:  system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --mono:  "SF Mono","Cascadia Code","JetBrains Mono","Consolas",ui-monospace,monospace;

    --measure: 68ch;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground:#101219; --surface:#181b24; --surface-2:#1e222d;
      --ink:#e7e9f1; --muted:#9aa0b1; --faint:#6b7181; --rule:#2b3040;
      --accent:#8e7ff2; --accent-soft:#241f3d;
      --proven:#4fc98a; --proven-bg:#123324;
      --open:#e0aa4e; --open-bg:#33280f;
      --refuted:#e8776a; --refuted-bg:#341916;
      --overclaim:#e39457; --overclaim-bg:#33210f;
      --unverif:#a8aebf; --unverif-bg:#232733;
    }
  }
  :root[data-theme="light"]{
    --ground:#e9ebf2;--surface:#f7f8fb;--surface-2:#eef0f6;--ink:#191b22;--muted:#565b6b;--faint:#8a8fa0;--rule:#d3d7e2;--accent:#5b4bd6;--accent-soft:#e7e4fb;
    --proven:#1c7a4a;--proven-bg:#dff1e6;--open:#9d6a12;--open-bg:#f7ecd2;--refuted:#b5362a;--refuted-bg:#f6dcd8;--overclaim:#b85e16;--overclaim-bg:#f7e4d1;--unverif:#5f6576;--unverif-bg:#e5e7ee;
  }
  :root[data-theme="dark"]{
    --ground:#101219;--surface:#181b24;--surface-2:#1e222d;--ink:#e7e9f1;--muted:#9aa0b1;--faint:#6b7181;--rule:#2b3040;--accent:#8e7ff2;--accent-soft:#241f3d;
    --proven:#4fc98a;--proven-bg:#123324;--open:#e0aa4e;--open-bg:#33280f;--refuted:#e8776a;--refuted-bg:#341916;--overclaim:#e39457;--overclaim-bg:#33210f;--unverif:#a8aebf;--unverif-bg:#232733;
  }

  * { box-sizing: border-box; }
  body { margin:0; }
  html, body { background: var(--ground); color: var(--ink); }
  .doc {
    background: var(--ground);
    color: var(--ink);
    overflow-wrap: anywhere;
    font-family: var(--serif);
    font-size: 18px;
    line-height: 1.62;
    min-height: 100vh;
    padding: clamp(1.2rem, 4vw, 4rem) 1.2rem 5rem;
  }
  .wrap { max-width: 52rem; margin: 0 auto; }

  .eyebrow {
    font-family: var(--mono);
    font-size: .72rem; letter-spacing:.18em; text-transform:uppercase;
    color: var(--accent); font-weight:600;
    display:flex; align-items:center; gap:.6rem; margin-bottom:1.1rem;
  }
  .eyebrow::before{ content:""; width:1.6rem; height:2px; background:var(--accent); display:inline-block; }
  h1.title {
    font-family: var(--serif); font-weight:700;
    font-size: clamp(2rem, 5.5vw, 3.1rem); line-height:1.08;
    letter-spacing:-.015em; text-wrap:balance; margin:0 0 .5rem;
  }
  .dek { color:var(--muted); font-size:1.05rem; margin:0 0 2rem; }

  .tally { margin: 0 0 2.6rem; }
  .tally-bar {
    display:flex; height:14px; border-radius:7px; overflow:hidden;
    box-shadow: inset 0 0 0 1px var(--rule);
  }
  .tally-bar span { display:block; }
  .tally-legend {
    display:flex; flex-wrap:wrap; gap:1.1rem 1.5rem; margin-top:.85rem;
    font-family:var(--mono); font-size:.78rem; letter-spacing:.02em;
  }
  .tally-legend b { font-weight:600; }
  .tally-legend .k { display:inline-flex; align-items:center; gap:.45rem; color:var(--muted); }
  .dot { width:.62rem; height:.62rem; border-radius:2px; display:inline-block; }

  section { margin: 2.6rem 0; }
  /* prose spans the full column so its right margin aligns with the data widgets
     (tables, ledger, tally, provenance) — operator-directed, 2026-07-15. */
  h2 {
    font-family:var(--sans); font-weight:700; font-size:1.34rem;
    letter-spacing:-.01em; margin:0 0 .9rem; padding-top:.4rem;
    display:flex; align-items:baseline; gap:.7rem;
  }
  h2 .n {
    font-family:var(--mono); font-size:.82rem; color:var(--accent);
    font-weight:600; letter-spacing:0;
  }
  h3 { font-family:var(--sans); font-weight:650; font-size:1.02rem; margin:1.7rem 0 .5rem; }
  h4 { margin:0 0 .8rem; }
  p { margin: .8rem 0; }
  ul { padding-left:1.3rem; }
  li { margin:.3rem 0; }
  strong { font-weight:700; }
  em { color: var(--muted); }
  hr { border:none; border-top:1px solid var(--rule); margin:2.4rem 0; }
  blockquote { border-left:3px solid var(--rule); margin:1.2rem 0; padding:.2rem 0 .2rem 1.1rem; color:var(--muted); }
  pre { background:var(--surface); border:1px solid var(--rule); border-radius:8px; padding:.9rem 1.1rem; overflow-x:auto; font-family:var(--mono); font-size:.82rem; }
  pre code { background:none; border:none; padding:0; }
  code { font-family:var(--mono); font-size:.85em; background:var(--surface); border:1px solid var(--rule); border-radius:4px; padding:.05em .35em; }

  cite, .cite {
    font-family:var(--mono); font-style:normal; font-size:.82em;
    background:var(--surface); color:var(--accent);
    border:1px solid var(--rule); border-radius:5px;
    padding:.05em .42em;
    box-decoration-break: clone;
  }
  .cite.strike { color:var(--refuted); text-decoration:line-through; text-decoration-color:var(--refuted); opacity:.85; }

  .badge {
    font-family:var(--mono); font-size:.68rem; font-weight:700;
    letter-spacing:.09em; text-transform:uppercase;
    padding:.16em .5em; border-radius:4px; white-space:nowrap;
    vertical-align:.08em;
  }
  .b-proven   { color:var(--proven);   background:var(--proven-bg); }
  .b-open     { color:var(--open);     background:var(--open-bg); }
  .b-refuted  { color:var(--refuted);  background:var(--refuted-bg); }
  .b-overclaim{ color:var(--overclaim);background:var(--overclaim-bg); }
  .b-unverif  { color:var(--unverif);  background:var(--unverif-bg); }
  .b-confirmed{ color:var(--proven);   background:var(--proven-bg); }

  .feel {
    font-family:var(--mono); font-size:.72rem; font-weight:600;
    color:var(--open); background:var(--open-bg);
    border-radius:20px; padding:.12em .62em .12em .5em;
    letter-spacing:.02em; white-space:nowrap; display:inline-flex; align-items:center; gap:.35rem;
  }
  .feel::before{ content:"◆"; font-size:.6em; opacity:.7; }

  .callout {
    border-left:3px solid var(--open);
    background:var(--open-bg);
    padding:.85rem 1.1rem; border-radius:0 8px 8px 0;
    margin:1.4rem 0; font-size:.94rem; color:var(--ink); max-width:none;
  }
  .callout b { color:var(--open); }

  .tbl-wrap { overflow-x:auto; margin:1.2rem 0; }
  table { border-collapse:collapse; width:100%; font-family:var(--sans); font-size:.9rem; }
  th, td { text-align:left; padding:.55rem .8rem; border-bottom:1px solid var(--rule); vertical-align:top; }
  th { font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; color:var(--faint); font-weight:600; }
  td { font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom:none; }

  .ledger { display:grid; grid-template-columns:1fr 1fr; gap:1.4rem; margin:1.4rem 0; max-width:none; }
  @media (max-width:640px){ .ledger { grid-template-columns:1fr; } }
  .track { border-radius:12px; padding:1.15rem 1.2rem; }
  .track.settled   { background:var(--surface); border:1px solid var(--rule); }
  .track.unsettled { background:transparent; border:1px dashed var(--rule); }
  .track h4 {
    font-family:var(--mono); font-size:.74rem; letter-spacing:.1em; text-transform:uppercase;
    margin:0 0 .8rem; display:flex; align-items:center; gap:.5rem;
  }
  .track.settled h4   { color:var(--proven); }
  .track.unsettled h4 { color:var(--open); }
  .track ul { list-style:none; margin:0; padding:0; font-family:var(--sans); font-size:.86rem; line-height:1.5; }
  .track li { padding:.5rem 0; border-bottom:1px solid var(--rule); color:var(--muted); }
  .track.settled li { border-left:2px solid var(--proven); padding-left:.7rem; margin-bottom:.1rem; }
  .track.unsettled li { border-left:2px dashed var(--open); padding-left:.7rem; }
  .track li:last-child { border-bottom:none; }
  .track li b { color:var(--ink); font-weight:650; }

  .prov { margin-top:3.5rem; padding-top:1.4rem; border-top:1px solid var(--rule); }
  .prov .plbl {
    font-family:var(--mono); font-size:.66rem; letter-spacing:.16em; text-transform:uppercase;
    color:var(--faint); margin-bottom:.9rem; display:flex; align-items:center; gap:.5rem;
  }
  .prov .plbl::before{ content:""; width:1rem; height:2px; background:var(--faint); }
  .prov .leaves { display:flex; flex-wrap:wrap; gap:.6rem; align-items:stretch; }
  .prov .leaf {
    background:var(--surface); border:1px solid var(--rule); border-radius:9px;
    padding:.5rem .75rem; display:flex; flex-direction:column; gap:.12rem;
    flex:1 1 9.5rem;  /* grow to fill the full column width (operator-directed) */
  }
  .prov .leaf .lname { font-family:var(--mono); font-weight:700; font-size:.8rem; color:var(--ink); display:flex; align-items:center; gap:.4rem; }
  .prov .leaf .lname .sd { width:.5rem; height:.5rem; border-radius:50%; background:var(--proven); }
  .prov .leaf .lmodel { font-family:var(--mono); font-size:.66rem; color:var(--faint); }
  .prov .arrow { align-self:center; color:var(--faint); font-family:var(--mono); }

  @media (prefers-reduced-motion:no-preference){
    .tally-bar span { animation: grow .7s cubic-bezier(.2,.7,.3,1) both; transform-origin:left; }
    @keyframes grow { from{ transform:scaleX(0); } to{ transform:scaleX(1); } }
  }
`;
