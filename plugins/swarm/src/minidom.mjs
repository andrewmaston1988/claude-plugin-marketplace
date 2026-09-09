// The plugin's only HTML parser — ~70 lines, zero dependencies, element TREE
// (not a pattern match). Node ships no DOM (DOMParser/Document/Element are all
// undefined) and the plugin bans npm runtime deps, so the question was never
// "can JavaScript parse HTML" but who writes the parser: this file, or four
// vendored packages. Cross-checked field-by-field against the operator-side
// node-html-parser on a captured live page: 49 of 49 fields identical.
//
// What it is FOR: descendant scoping. A flat string walk returns every
// [data-usage-segment] in one list, so splitting them per usage bar needs
// positional offset reasoning — the fragility that broke parseUsage's
// predecessor twice. Asking each bar for its own descendants makes the split
// structural.
//
// Supports [attr] and [attr="value"] selectors only — anything else throws
// rather than silently matching everything. Known limits, accepted for the
// pages this parses: an unquoted `>` inside an attribute value ends the tag
// early, and `<script>`/`<style>` bodies are skipped wholesale to their close
// tag (which is exactly what keeps the live page's inline-template
// segment-lookalike out of the tree).

// Elements that never have children, so an opening form must not open a scope.
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
// Raw-text elements: their body is text until the close tag, never markup.
const RAW_TEXT = { script: "</script", style: "</style" };

const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(src) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(src))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return attrs;
}

class El {
  constructor(tag, attrs, parent) {
    this.tag = tag;
    this.attrs = attrs;
    this.parent = parent ?? null;
    this.children = [];
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  // Descendants only, never the element itself — the scoping primitive.
  querySelectorAll(sel) {
    const m = /^\[([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]$/.exec(sel);
    if (!m) throw new Error(`minidom: unsupported selector ${JSON.stringify(sel)} — use [attr] or [attr="value"]`);
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        const v = c.getAttribute(m[1]);
        if (v != null && (m[2] === undefined && m[3] === undefined ? true : v === (m[2] ?? m[3]))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

// An element tree over arbitrary HTML: void/self-closing tags never open a
// scope, an unmatched close tag is ignored (never unwinds past where it is),
// and comments/declarations/raw-text bodies produce no nodes.
export function parseHtml(html) {
  const root = new El("#root", {}, null);
  let cur = root;
  const text = String(html ?? "");
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<!", lt) || text.startsWith("<?", lt)) {
      const end = text.indexOf(">", lt);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    const end = text.indexOf(">", lt);
    if (end === -1) break;
    if (text.startsWith("</", lt)) {
      const tag = text.slice(lt + 2, end).trim().toLowerCase();
      // Walk up to the nearest matching open tag; a close tag with no opener
      // on the chain is ignored — popping a level that was never pushed
      // attaches every later element to the wrong parent.
      let n = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n?.parent) cur = n.parent;
      i = end + 1;
      continue;
    }
    let inner = text.slice(lt + 1, end);
    const selfClosing = inner.endsWith("/");
    if (selfClosing) inner = inner.slice(0, -1);
    const tag = (inner.match(/^[^\s/>]+/) || [""])[0].toLowerCase();
    if (!tag) { i = end + 1; continue; }
    const el = new El(tag, parseAttrs(inner.slice(tag.length)), cur);
    cur.children.push(el);
    const raw = RAW_TEXT[tag];
    if (raw && !selfClosing) {
      // Skip the body wholesale — a segment-lookalike inside a script template
      // must yield no element, not an element filtered out later.
      const closeAt = text.toLowerCase().indexOf(raw, end + 1);
      i = closeAt === -1 ? text.length : closeAt;
      continue;
    }
    if (!selfClosing && !VOID.has(tag)) cur = el;
    i = end + 1;
  }
  return root;
}