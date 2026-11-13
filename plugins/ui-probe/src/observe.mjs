import { evaluate } from "./cdp.mjs";
import { DEFAULT_FOCUS_SELECTOR } from "./config.mjs";

// CDP emits structural wrappers that carry no name and no information an agent can act on.
const STRUCTURAL = new Set(["none", "generic", "presentation", "InlineTextBox"]);
const STATES = ["pressed", "checked", "expanded", "selected", "disabled"];
const DOM_MARKER = "-- dom --";

function state(n) {
  return STATES
    .map((name) => {
      const property = (n.properties || []).find((candidate) => candidate.name === name);
      return property && property.value?.value != null ? `${name}=${property.value.value}` : null;
    })
    .filter(Boolean)
    .join(" ");
}

function label(n) {
  const role = n.role?.value || "";
  const name = n.name?.value || "";
  const value = n.value?.value;
  const flags = state(n);
  let out = `${role}${name ? ` "${name}"` : ""}`;
  if (value != null && value !== "") out += ` = ${JSON.stringify(value)}`;
  return flags ? `${out} [${flags}]` : out;
}

function axTextFromTree(tree) {
  const nodes = tree.nodes || [];
  const children = new Map();
  for (const n of nodes) {
    const parent = n.parentId ?? null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(n);
  }
  const root = nodes.find((n) => (n.parentId ?? null) === null) || nodes[0];
  if (!root) return "";

  const lines = [];
  const walk = (n, depth) => {
    const role = n.role?.value || "";
    const keep = !n.ignored && role && !STRUCTURAL.has(role);
    if (keep) lines.push(`${"  ".repeat(depth)}${label(n)}`);
    const next = keep ? depth + 1 : depth;
    for (const child of children.get(n.nodeId) || []) walk(child, next);
  };
  walk(root, 0);
  return lines.join("\n");
}

export async function axText(cdp) {
  return axTextFromTree(await cdp.send("Accessibility.getFullAXTree"));
}

// A DOM read, for the two cases the AX tree cannot serve: `aria-modal` hides the page behind a
// dialog, and Chromium before M70 has no getFullAXTree.
const DOM_WALK_JS = (selector, focusSelector) => `(() => {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "HEAD", "TITLE"]);
  const root = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.body"};
  if (!root) return "";
  // A remote-driven app moves a class rather than DOM focus, so its marker wins over activeElement.
  const matched = document.querySelector(${JSON.stringify(focusSelector)});
  const active = document.activeElement;
  const focused = matched || (active && active !== document.body ? active : null);
  const ATTRS = [["aria-pressed", "pressed"], ["aria-checked", "checked"], ["aria-expanded", "expanded"],
    ["aria-selected", "selected"], ["aria-disabled", "disabled"], ["disabled", "disabled"]];
  const label = (el) => {
    let out = el.tagName.toLowerCase();
    if (el.id) out += "#" + el.id;
    for (const name of el.classList) out += "." + name;
    const role = el.getAttribute("role");
    if (role) out += " role=" + role;
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) out += " aria-label=" + JSON.stringify(ariaLabel);
    const flags = new Map();
    for (const [attribute, name] of ATTRS) {
      const value = el.getAttribute(attribute);
      if (value != null) flags.set(name, value === "" ? "true" : value);
    }
    if (flags.size) out += " [" + [...flags].map(([name, value]) => name + "=" + value).join(" ") + "]";
    return out;
  };
  const mark = (el) => (el === focused ? " [focused]" : "");
  const lines = [];
  const walk = (el, depth) => {
    const children = Array.from(el.children).filter((child) => !SKIP.has(child.tagName));
    const pad = "  ".repeat(depth);
    if (children.length) {
      lines.push(pad + label(el) + mark(el));
    } else {
      const text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80);
      lines.push(pad + label(el) + (text ? " " + JSON.stringify(text) : "") + mark(el));
    }
    for (const child of children) walk(child, children.length ? depth + 1 : depth);
  };
  walk(root, 0);
  return lines.join("\\n");
})()`;

export async function domWalk(cdp, root, { focusSelector = DEFAULT_FOCUS_SELECTOR } = {}) {
  return evaluate(cdp, DOM_WALK_JS(root, focusSelector));
}

// M69 has no getFullAXTree; the 39-domain protocol is the evidence, not the device name.
function axTreeAvailable(protocol, tvScope) {
  // A null protocol is a modern browser on the web, but an unreadable target on the set.
  if (!protocol) return !tvScope;
  if (!Array.isArray(protocol.domains)) return true;
  const accessibility = protocol.domains.find((domain) => domain.domain === "Accessibility");
  return (accessibility?.commands || []).some((command) => command.name === "getFullAXTree");
}

export async function observe(cdp, { includeBackground = false, focusSelector, protocol, tvScope = false } = {}) {
  if (!axTreeAvailable(protocol, tvScope)) return domWalk(cdp, undefined, { focusSelector });
  const tree = await axText(cdp);
  if (!includeBackground) return tree;
  const dom = await domWalk(cdp, undefined, { focusSelector });
  return `${tree}\n\n${DOM_MARKER}\n${dom}`;
}
