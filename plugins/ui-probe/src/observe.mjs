import { evaluate } from "./cdp.mjs";

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

export function axTextFromTree(tree) {
  const nodes = tree.nodes || [];
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
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
    if (keep) lines.push(`${"  ".repeat(depth)}${label(byId.get(n.nodeId) || n)}`);
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
const DOM_WALK_JS = (selector) => `(() => {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "HEAD", "TITLE"]);
  const root = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.body"};
  if (!root) return "";
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
  const lines = [];
  const walk = (el, depth) => {
    const children = Array.from(el.children).filter((child) => !SKIP.has(child.tagName));
    const pad = "  ".repeat(depth);
    if (children.length) {
      lines.push(pad + label(el));
    } else {
      const text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80);
      lines.push(pad + label(el) + (text ? " " + JSON.stringify(text) : ""));
    }
    for (const child of children) walk(child, children.length ? depth + 1 : depth);
  };
  walk(root, 0);
  return lines.join("\\n");
})()`;

export async function domWalk(cdp, root) {
  return evaluate(cdp, DOM_WALK_JS(root));
}

export async function observe(cdp, { includeBackground = false } = {}) {
  const tree = await axText(cdp);
  if (!includeBackground) return tree;
  const dom = await domWalk(cdp);
  return `${tree}\n\n${DOM_MARKER}\n${dom}`;
}
