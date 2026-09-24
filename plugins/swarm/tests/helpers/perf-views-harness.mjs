// perf.js is a browser IIFE that assigns `window.perfViews` — a plain node
// import throws `ReferenceError: window is not defined`. So evaluate it in a vm
// against a stub window, the same trick page-harness.mjs uses for page.html.
// That is what lets a test run the REAL renderer: a test that stubs a view and
// then asserts on the stub's markup asserts nothing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PERF_JS = readFileSync(fileURLToPath(new URL("../../src/serve/perf.js", import.meta.url)), "utf8");

export function loadPerfViews() {
  const sandbox = { window: {}, Math, JSON, Object, Array, Number, String, Map, Set, console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(PERF_JS, sandbox, { filename: "perf.js" });
  return sandbox.window.perfViews;
}

export const H = {
  esc: (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
  enc: encodeURIComponent,
  fmtScore: (v) => (v == null ? "—" : v.toFixed(2)),
  chip: (label) => `<span class="chip">${label}</span>`,
};
