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
