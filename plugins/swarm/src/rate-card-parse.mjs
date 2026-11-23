// Both vendors publish their price table as markdown at `<page URL>.md`, so a
// refresh is a fetch and a table parse — never an HTML scrape and never a
// transcription. These two functions are the whole parse, kept pure so they can
// be pinned against a saved page: the fixtures in tests/fixtures are what stands
// between a silent vendor-side table change and a permanent mis-rank.

/** A markdown table cell → a number, or null where the vendor printed no rate. */
function money(cell) {
  const text = String(cell)
    .replace(/<sup>.*?<\/sup>/g, "")     // Anthropic footnote markers
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/\/\s*MTok/i, "")
    .trim();
  if (!text || text === "-" || text === "—") return null;
  const match = text.match(/\$\s*([\d.]+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Every table whose column header matches AND whose enclosing `#` heading passes
 * `sectionTest`, as `{ header, rows }` — each with its own header, because the
 * vendors reshuffle columns between tables and one table's order applied to
 * another silently shifts every field. Both filters are needed: OpenAI repeats one
 * identical column header across five tables that are *service tiers*, not model
 * families, so matching on columns alone silently overwrites standard rates with
 * batch or fast ones — and matching on the first table alone just as silently drops
 * the models that only appear in a later one. Where a model appears twice the first
 * table wins.
 */
function tableRows(md, headerTest, sectionTest = () => true) {
  const lines = md.split(/\r?\n/);
  const tables = [];
  let section = "";
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith("#")) section = lines[i].replace(/^#+\s*/, "").trim();
    if (!lines[i].startsWith("|") || !headerTest(lines[i]) || !sectionTest(section)) continue;
    const header = lines[i].split("|").slice(1, -1).map((c) => c.trim());
    const rows = [];
    // +2 skips the header and its `| --- |` separator.
    for (let j = i + 2; j < lines.length && lines[j].startsWith("|"); j += 1)
      rows.push(lines[j].split("|").slice(1, -1).map((c) => c.trim()));
    tables.push({ header, rows });
  }
  return tables;
}

// A missing header is a page change, and guessing the column by position is how
// a reshuffled table banks wrong prices in silence. Name the field that went.
function col(header, re, label, vendor) {
  const index = header.findIndex((cell) => re.test(cell));
  if (index < 0) throw new Error(`missing column '${label}' in ${vendor} price table`);
  return index;
}

function price(input, cachedInput, output, cacheWrite) {
  if (input == null || output == null) return null;
  return { input, ...(cachedInput == null ? {} : { cachedInput }), ...(cacheWrite == null ? {} : { cacheWrite }), output };
}

// The page's service-tier sections, of which swarm dispatches only the standard one:
// "Batch", "Flex" and "Fast" republish the same models at multiples of it. This is an
// allow-list rather than a deny-list so a tier OpenAI adds later is dropped until
// someone looks at it, instead of quietly overwriting the standard rates.
const OPENAI_STANDARD_SECTIONS = /^(standard|grouped)\b/i;

/**
 * developers.openai.com/api/docs/pricing.md.
 * Columns: model, short input, short output, short cached input, short 30m write,
 * short 12h write, then the long-context repeat. Short context is the standard
 * tier; the long columns are the >272k breakpoint and are deliberately dropped,
 * because a leaf billed at the breakpoint is a leaf that has already gone wrong.
 * The write column is the 30m tier and optional: a `-` cell already means no price.
 */
export function parseOpenAiPricing(md) {
  const out = {};
  const tables = tableRows(md, (l) => /short context input/i.test(l), (s) => OPENAI_STANDARD_SECTIONS.test(s));
  if (!tables.length) throw new Error("no openai price table found");
  for (const { header, rows } of tables) {
    const i = col(header, /^model\b/i, "model", "openai");
    const input = col(header, /^short context input\b/i, "input", "openai");
    const output = col(header, /^short context output\b/i, "output", "openai");
    const cachedInput = col(header, /^short context cached input\b/i, "cached input", "openai");
    const write = header.findIndex((cell) => /^short context (30m write|cache writes?)\b/i.test(cell));
    for (const cells of rows) {
      // `gpt-5.5 (<272K context length)` — the qualifier is prose, not part of the id.
      const model = String(cells[i] ?? "").replace(/\s*\(.*$/, "").trim();
      if (!/^gpt-/i.test(model) || Object.hasOwn(out, model)) continue;
      const row = price(money(cells[input]), money(cells[cachedInput]), money(cells[output]), write < 0 ? null : money(cells[write]));
      if (row) out[model] = row;
    }
  }
  return out;
}

// Anthropic's table is keyed on display names, so the id is derived. The date
// suffix on a dated id (`claude-haiku-4-5-20251001`) has no column to come from —
// resolveRatePrice below strips a trailing date rather than inventing a key here.
function anthropicModelId(name) {
  const clean = name.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\(.*$/, "").trim();
  const match = clean.match(/^Claude\s+([A-Za-z]+)\s+([\d.]+)$/);
  if (!match) return null;
  return `claude-${match[1].toLowerCase()}-${match[2].replace(/\./g, "-")}`;
}

/**
 * platform.claude.com/docs/en/about-claude/pricing.md — the model pricing table.
 * Columns: model, base input, 5m cache write, 1h cache write, cache hit, output;
 * resolved by header, because their order is not a promise either.
 * The 5m write is the one read: it is what a default Claude Code cache write is billed at.
 * The cache-hit column is the one swarm cares about: its runs are cache-read
 * dominated, and the multiplier is not uniform (0.1x, but 0.05x on Opus 5.5 and
 * 0.025x on Fable 5.1), so it is read rather than derived from the input column.
 */
export function parseAnthropicPricing(md) {
  const out = {};
  const tables = tableRows(md, (l) => /cache hits and refreshes/i.test(l));
  if (!tables.length) throw new Error("no anthropic price table found");
  for (const { header, rows } of tables) {
    const model = col(header, /^model\b/i, "model", "anthropic");
    const input = col(header, /^base input/i, "input", "anthropic");
    const cacheWrite = col(header, /^5m cache write/i, "cache write", "anthropic");
    const cachedInput = col(header, /^cache hits/i, "cached input", "anthropic");
    const output = col(header, /^output/i, "output", "anthropic");
    for (const cells of rows) {
      const id = anthropicModelId(String(cells[model] ?? ""));
      if (!id) continue;
      const row = price(money(cells[input]), money(cells[cachedInput]), money(cells[output]), money(cells[cacheWrite]));
      if (row) out[id] = row;
    }
  }
  return out;
}

// The only suffix the fallback strips: a published date, in either spelling.
const DATED_SUFFIX = /^-(\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * The id swarm dispatches may carry a DATE the published table has no column for —
 * `claude-haiku-4-5-20251001` against the table's `Claude Haiku 4.5`. An exact key
 * wins; otherwise the longest key the id extends by a trailing date does, so
 * `claude-opus-5-5-20261101` prices as Opus 5.5 rather than reading `unpriced`.
 *
 * Only a date is stripped. A version segment is a different model at a different
 * price — `claude-sonnet-5-5` borrowing sonnet-5's rate would rank it a third
 * cheaper than it bills, and `unpriced` is the honest answer there.
 */
export function resolveRatePrice(prices, model) {
  if (Object.hasOwn(prices, model)) return { key: model, price: prices[model] };
  const key = Object.keys(prices)
    .filter((k) => model.startsWith(`${k}-`) && DATED_SUFFIX.test(model.slice(k.length)))
    .sort((a, b) => b.length - a.length)[0];
  return key ? { key, price: prices[key] } : null;
}
