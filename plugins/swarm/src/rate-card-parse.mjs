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
 * Rows from every table whose column header matches AND whose enclosing `#` heading
 * passes `sectionTest`. Both filters are needed: OpenAI repeats one identical column
 * header across five tables that are *service tiers*, not model families, so matching
 * on columns alone silently overwrites standard rates with batch or fast ones — and
 * matching on the first table alone just as silently drops the models that only
 * appear in a later one. Where a model appears twice the first table wins.
 */
function tableRows(md, headerTest, sectionTest = () => true) {
  const lines = md.split(/\r?\n/);
  const rows = [];
  let section = "";
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith("#")) section = lines[i].replace(/^#+\s*/, "").trim();
    if (!lines[i].startsWith("|") || !headerTest(lines[i]) || !sectionTest(section)) continue;
    // +2 skips the header and its `| --- |` separator.
    for (let j = i + 2; j < lines.length && lines[j].startsWith("|"); j += 1)
      rows.push(lines[j].split("|").slice(1, -1).map((c) => c.trim()));
  }
  return rows;
}

function price(input, cachedInput, output) {
  if (input == null || output == null) return null;
  return { input, ...(cachedInput == null ? {} : { cachedInput }), output };
}

// The page's service-tier sections, of which swarm dispatches only the standard one:
// "Batch", "Flex" and "Fast" republish the same models at multiples of it. This is an
// allow-list rather than a deny-list so a tier OpenAI adds later is dropped until
// someone looks at it, instead of quietly overwriting the standard rates.
const OPENAI_STANDARD_SECTIONS = /^(standard|grouped)\b/i;

/**
 * developers.openai.com/api/docs/pricing.md.
 * Columns: model, short input, short cached, short cache-write, short output, then
 * the long-context repeat. Short context is the standard tier; the long columns are
 * the >272k breakpoint and are deliberately dropped, because a leaf billed at the
 * breakpoint is a leaf that has already gone wrong.
 */
export function parseOpenAiPricing(md) {
  const out = {};
  const rows = tableRows(md, (l) => /short context input/i.test(l), (s) => OPENAI_STANDARD_SECTIONS.test(s));
  for (const cells of rows) {
    // `gpt-5.5 (<272K context length)` — the qualifier is prose, not part of the id.
    const model = cells[0].replace(/\s*\(.*$/, "").trim();
    if (!/^gpt-/i.test(model) || Object.hasOwn(out, model)) continue;
    const row = price(money(cells[1]), money(cells[2]), money(cells[4]));
    if (row) out[model] = row;
  }
  return out;
}

// Anthropic's table is keyed on display names, so the id is derived. The date
// suffix on a dated id (`claude-haiku-4-5-20251001`) has no column to come from —
// resolveRatePrice below matches it by prefix rather than inventing a key here.
function anthropicModelId(name) {
  const clean = name.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\(.*$/, "").trim();
  const match = clean.match(/^Claude\s+([A-Za-z]+)\s+([\d.]+)$/);
  if (!match) return null;
  return `claude-${match[1].toLowerCase()}-${match[2].replace(/\./g, "-")}`;
}

/**
 * platform.claude.com/docs/en/about-claude/pricing.md — the model pricing table.
 * Columns: model, base input, 5m cache write, 1h cache write, cache hit, output.
 * The cache-hit column is the one swarm cares about: its runs are cache-read
 * dominated, and the multiplier is not uniform (0.1x, but 0.05x on Opus 5.5 and
 * 0.025x on Fable 5.1), so it is read rather than derived from the input column.
 */
export function parseAnthropicPricing(md) {
  const out = {};
  for (const cells of tableRows(md, (l) => /cache hits and refreshes/i.test(l))) {
    const id = anthropicModelId(cells[0]);
    if (!id) continue;
    const row = price(money(cells[1]), money(cells[4]), money(cells[5]));
    if (row) out[id] = row;
  }
  return out;
}

/**
 * The id swarm dispatches may carry a suffix the published table has no column
 * for — `claude-haiku-4-5-20251001` against the table's `Claude Haiku 4.5`. An
 * exact key wins; otherwise the longest key the id extends does, so a future
 * `claude-opus-5-5-20261101` prices as Opus 5.5 rather than reading `unpriced`.
 * Nothing shorter than a full segment matches, so `claude-opus-5` never claims
 * `claude-opus-5-5`.
 */
export function resolveRatePrice(prices, model) {
  if (Object.hasOwn(prices, model)) return { key: model, price: prices[model] };
  const key = Object.keys(prices)
    .filter((k) => model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? { key, price: prices[key] } : null;
}
