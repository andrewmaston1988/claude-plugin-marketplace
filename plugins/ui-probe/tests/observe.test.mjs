import { test } from "node:test";
import assert from "node:assert/strict";
import { axText, domWalk, observe } from "../src/observe.mjs";

const NODES = [
  { nodeId: "1", parentId: null, role: { value: "RootWebArea" }, name: { value: "Detail sheet" } },
  {
    nodeId: "2",
    parentId: "1",
    role: { value: "button" },
    name: { value: "Not for me" },
    properties: [{ name: "pressed", value: { type: "tristate", value: "true" } }],
  },
  {
    nodeId: "3",
    parentId: "1",
    role: { value: "checkbox" },
    name: { value: "My list" },
    properties: [
      { name: "checked", value: { type: "tristate", value: "true" } },
      { name: "focusable", value: { type: "boolean", value: true } },
    ],
  },
  {
    nodeId: "4",
    parentId: "1",
    role: { value: "DisclosureTriangle" },
    name: { value: "More" },
    properties: [{ name: "expanded", value: { type: "boolean", value: false } }],
  },
  {
    nodeId: "5",
    parentId: "1",
    role: { value: "button" },
    name: { value: "Delete" },
    properties: [{ name: "disabled", value: { type: "boolean", value: true } }],
  },
  {
    nodeId: "6",
    parentId: "1",
    role: { value: "option" },
    name: { value: "One" },
    properties: [{ name: "selected", value: { type: "boolean", value: true } }],
  },
  { nodeId: "7", parentId: "1", ignored: true, role: { value: "button" }, name: { value: "hidden" } },
  { nodeId: "8", parentId: "1", role: { value: "none" }, name: { value: "" } },
  { nodeId: "9", parentId: "2", role: { value: "StaticText" }, name: { value: "Not for me" } },
  { nodeId: "10", parentId: "1", role: { value: "InlineTextBox" }, name: { value: "boxed" } },
];

function stubCdp({ nodes = NODES, value = "" } = {}) {
  return {
    sent: [],
    async send(method, params = {}) {
      this.sent.push({ method, params });
      if (method === "Accessibility.getFullAXTree") return { nodes };
      if (method === "Runtime.evaluate") return { result: { value } };
      return {};
    },
  };
}

test("the AX text prints the ARIA state beside role and name", async () => {
  const text = await axText(stubCdp());
  assert.match(text, /^ {2}button "Not for me" \[pressed=true\]$/m);
  assert.match(text, /^ {2}checkbox "My list" \[checked=true\]$/m);
  assert.match(text, /^ {2}DisclosureTriangle "More" \[expanded=false\]$/m);
  assert.match(text, /^ {2}button "Delete" \[disabled=true\]$/m);
  assert.match(text, /^ {2}option "One" \[selected=true\]$/m);
});

test("the AX text prints only the ARIA states, not every AX property", async () => {
  const text = await axText(stubCdp());
  assert.doesNotMatch(text, /focusable|invalid/);
});

test("ignored and structural nodes are dropped without losing their children", async () => {
  const text = await axText(stubCdp());
  assert.doesNotMatch(text, /hidden|InlineTextBox|boxed|^ {2}none$/m);
  assert.match(text, /^ {4}StaticText "Not for me"$/m);
});

test("a node's name and value are printed, and its children indent under it", async () => {
  const nodes = [
    { nodeId: "1", parentId: null, role: { value: "RootWebArea" }, name: { value: "" } },
    { nodeId: "2", parentId: "1", role: { value: "textbox" }, name: { value: "Search" }, value: { value: "tiles" } },
    { nodeId: "3", parentId: "2", role: { value: "StaticText" }, name: { value: "inner" } },
  ];
  const text = await axText(stubCdp({ nodes }));
  assert.match(text, /^ {2}textbox "Search" = "tiles"$/m);
  assert.match(text, /^ {4}StaticText "inner"$/m);
});

test("an empty AX tree serialises to an empty string", async () => {
  assert.equal(await axText(stubCdp({ nodes: [] })), "");
});

test("the DOM walk evaluates a walk of the given root", async () => {
  const cdp = stubCdp({ value: "body\n  div#app" });
  const text = await domWalk(cdp, "[data-testid=grid]");
  assert.equal(text, "body\n  div#app");
  const expression = cdp.sent.find((call) => call.method === "Runtime.evaluate").params.expression;
  assert.ok(expression.includes('document.querySelector("[data-testid=grid]")'), expression);
});

test("the DOM walk defaults to the whole body", async () => {
  const cdp = stubCdp({ value: "div#app" });
  await domWalk(cdp);
  const expression = cdp.sent.find((call) => call.method === "Runtime.evaluate").params.expression;
  assert.ok(expression.includes("document.body"), expression);
});

test("observation is the AX text alone, and adds the DOM walk on request", async () => {
  const only = await observe(stubCdp({ value: "div#app" }));
  assert.match(only, /RootWebArea/);
  assert.doesNotMatch(only, /-- dom --/);

  const both = await observe(stubCdp({ value: "div#app" }), { includeBackground: true });
  assert.match(both, /RootWebArea/);
  assert.match(both, /-- dom --\ndiv#app/);
});

// --- the walk as the sole observation, and its focus mark ---

const NO_AX = { domains: [{ domain: "Accessibility", commands: [{ name: "getPartialAXTree" }] }] };
const WITH_AX = { domains: [{ domain: "Accessibility", commands: [{ name: "getFullAXTree" }] }] };

function element(tagName, { id = "", classes = [], children = [], text = "" } = {}) {
  return { tagName: tagName.toUpperCase(), id, classList: classes, children, textContent: text, getAttribute: () => null };
}

// Just enough document for the walk's own expression: a body tree and a selector lookup.
function fakePage(body, activeElement = body) {
  const all = [];
  const collect = (node) => { all.push(node); node.children.forEach(collect); };
  collect(body);
  const matches = (node, selector) => {
    if (selector.startsWith(".")) return node.classList.includes(selector.slice(1));
    if (selector.startsWith("#")) return node.id === selector.slice(1);
    return node.tagName.toLowerCase() === selector.toLowerCase();
  };
  return { body, activeElement, querySelector: (selector) => all.find((node) => matches(node, selector)) ?? null };
}

// A stub CDP that evaluates Runtime.evaluate against the fake document, so the walk itself runs.
function pageCdp(page) {
  return {
    sent: [],
    async send(method, params = {}) {
      this.sent.push({ method, params });
      if (method === "Accessibility.getFullAXTree") return { nodes: NODES };
      if (method === "Runtime.evaluate") {
        return { result: { value: new Function("document", `return ${params.expression};`)(page) } };
      }
      return {};
    },
  };
}

// Two tiles in one row; the `.focused` class is the app's focus marker, as torrent-hub's grid has it.
function gridPage(focusedId) {
  const tiles = ["tile-a", "tile-b"].map((id) => element("div", {
    id,
    classes: id === focusedId ? ["tv-card", "focused"] : ["tv-card"],
  }));
  return fakePage(element("body", { children: [element("div", { classes: ["tv-row"], children: tiles })] }));
}

const markedLines = (text) => text.split("\n").filter((line) => line.endsWith(" [focused]")).map((line) => line.trim());

test("observation is the DOM walk alone when the protocol has no getFullAXTree", async () => {
  const cdp = pageCdp(gridPage("tile-a"));
  const text = await observe(cdp, { protocol: NO_AX });
  assert.equal(cdp.sent.some((call) => call.method === "Accessibility.getFullAXTree"), false);
  assert.deepEqual(markedLines(text), ["div#tile-a.tv-card.focused [focused]"]);
  assert.doesNotMatch(text, /-- dom --/);

  const withBackground = await observe(pageCdp(gridPage("tile-a")), { protocol: NO_AX, includeBackground: true });
  assert.doesNotMatch(withBackground, /-- dom --/);
  assert.match(withBackground, /div#tile-a\.tv-card\.focused \[focused\]/);
});

test("a protocol that lists getFullAXTree keeps the AX tree and never walks the DOM", async () => {
  const cdp = pageCdp(gridPage("tile-a"));
  const text = await observe(cdp, { protocol: WITH_AX });
  assert.match(text, /RootWebArea/);
  assert.deepEqual(markedLines(text), []);
  assert.equal(cdp.sent.some((call) => call.method === "Runtime.evaluate"), false);
});

test("the walk marks the element matching focusSelector, and only that one", async () => {
  const text = await domWalk(pageCdp(gridPage("tile-a")), undefined, { focusSelector: ".focused" });
  assert.deepEqual(markedLines(text), ["div#tile-a.tv-card.focused [focused]"]);
});

test("focusSelector defaults to .focused", async () => {
  const text = await domWalk(pageCdp(gridPage("tile-b")));
  assert.deepEqual(markedLines(text), ["div#tile-b.tv-card.focused [focused]"]);
});

test("a custom focusSelector is used in place of the default", async () => {
  const page = gridPage(null);
  page.body.children[0].children[0].classList = ["tv-card", "current"];
  const text = await domWalk(pageCdp(page), undefined, { focusSelector: ".current" });
  assert.deepEqual(markedLines(text), ["div#tile-a.tv-card.current [focused]"]);
});

test("the walk falls back to a non-body activeElement when nothing matches focusSelector", async () => {
  const page = gridPage(null);
  page.activeElement = page.body.children[0].children[1];
  const text = await domWalk(pageCdp(page));
  assert.deepEqual(markedLines(text), ["div#tile-b.tv-card [focused]"]);
});

test("body is never marked as focused", async () => {
  const text = await domWalk(pageCdp(gridPage(null)));
  assert.deepEqual(markedLines(text), []);
});

test("the mark follows a class move while activeElement stays body", async () => {
  const page = gridPage("tile-a");
  assert.deepEqual(markedLines(await domWalk(pageCdp(page))), ["div#tile-a.tv-card.focused [focused]"]);

  const [a, b] = page.body.children[0].children;
  a.classList = ["tv-card"];
  b.classList = ["tv-card", "focused"];

  const moved = await domWalk(pageCdp(page));
  assert.deepEqual(markedLines(moved), ["div#tile-b.tv-card.focused [focused]"]);
});

test("the DOM half of a combined observation carries the focus mark", async () => {
  const text = await observe(pageCdp(gridPage("tile-a")), { includeBackground: true, focusSelector: ".focused" });
  assert.match(text, /-- dom --\nbody/);
  assert.match(text, /div#tile-a\.tv-card\.focused \[focused\]/);
});
