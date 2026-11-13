// Pointer input: hover, click and tap, and the target resolution they all need.

import { evaluate } from "../cdp.mjs";
import { actionAllowed } from "../guard.mjs";
import { StepFailure, q } from "./common.mjs";

// getBoundingClientRect and elementFromPoint are viewport-relative, so a target below the fold
// reads as covered until it is scrolled to.
const SCROLL_JS = (selector) => `(() => {
  const el = document.querySelector(${q(selector)});
  if (!el) return { found: false };
  el.scrollIntoView({ block: "center", inline: "center" });
  return { found: true };
})()`;

const OBSCURED_JS = (selector) => `(() => {
  const el = document.querySelector(${q(selector)});
  if (!el) return { found: false };
  const box = el.getBoundingClientRect();
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  return { found: true, clear: Boolean(hit) && (hit === el || el.contains(hit)) };
})()`;

export async function queryIds(cdp, selector) {
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector });
  return nodeIds || [];
}

export async function boxOf(cdp, nodeId) {
  const { model } = await cdp.send("DOM.getBoxModel", { nodeId });
  const quad = model.border || model.content;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return {
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    width: model.width ?? right - left,
    height: model.height ?? bottom - top,
  };
}

async function isConnected(cdp, nodeId) {
  let objectId = null;
  try {
    ({ object: { objectId } } = await cdp.send("DOM.resolveNode", { nodeId }));
  } catch {
    return false;
  }
  try {
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { return this.isConnected === true; }",
      returnByValue: true,
    });
    return result?.value === true;
  } catch {
    return false;
  } finally {
    try { await cdp.send("Runtime.releaseObject", { objectId }); } catch { /* already collected */ }
  }
}

async function dispatch(cdp, op, point, _sleep) {
  if (op === "hover") {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, pointerType: "mouse", button: "none" });
    return;
  }
  if (op === "click") {
    const base = { x: point.x, y: point.y, button: "left", clickCount: 1, pointerType: "mouse" };
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    return;
  }
  const touchPoints = [{ x: point.x, y: point.y, radiusX: 1, radiusY: 1, force: 1, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints });
  await _sleep(30);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

export async function interact(op, args, state) {
  const nodeIds = await queryIds(state.cdp, args.target);
  if (nodeIds.length === 0) throw new StepFailure("failed", "not_found", `no element for ${args.target}`);
  if (nodeIds.length > 1) throw new StepFailure("failed", "ambiguous_target", `${nodeIds.length} elements match ${args.target}`);

  if (op !== "hover" && !state.allowWrites) {
    const action = await actionAllowed(state.cdp, args.target);
    if (action.found && !action.allowed) {
      const where = action.url ? ` ${action.url}` : "";
      throw new StepFailure("failed", "write_blocked", `${args.target} would submit ${action.method}${where}`);
    }
  }

  await evaluate(state.cdp, SCROLL_JS(args.target));

  let point;
  try {
    point = await boxOf(state.cdp, nodeIds[0]);
  } catch {
    throw new StepFailure("failed", "not_found", `${args.target} has no box to aim at`);
  }
  const hit = await evaluate(state.cdp, OBSCURED_JS(args.target));
  if (hit?.found && !hit.clear) throw new StepFailure("failed", "target_obscured", `${args.target} is covered at its centre`);
  if (!(await isConnected(state.cdp, nodeIds[0]))) throw new StepFailure("failed", "stale_target", `${args.target} left the document before input`);

  await dispatch(state.cdp, op, point, state._sleep);
}
