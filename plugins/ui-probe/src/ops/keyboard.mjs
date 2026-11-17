// Keyboard input: one op over the TV key table, plus text typed into a focused field, shared by the
// set and the desktop device.

import { evaluate } from "../cdp.mjs";
import { dispatchKey } from "../tv/keys.mjs";
import { StepFailure, q } from "./common.mjs";
import { queryIds } from "./interaction.mjs";

// The set's Chromium 69 has no optional chaining and no nullish coalescing: every expression here
// must parse there. A focus that did not take would type nowhere and pass, so the active element is
// compared rather than assumed.
const FOCUS_JS = (selector) => `(() => {
  const el = document.querySelector(${q(selector)});
  if (!el) return false;
  el.focus();
  return document.activeElement === el;
})()`;

const VALUE_JS = `(() => {
  const el = document.activeElement;
  return el && typeof el.value === "string" ? el.value : null;
})()`;

export async function pressKey(args, state) {
  try {
    await dispatchKey(state.cdp, args.key, {
      repeat: args.repeat,
      gapMs: args.gapMs,
      autoRepeat: args.autoRepeat,
      _sleep: state._sleep,
    });
  } catch (error) {
    throw new StepFailure("failed", "unknown_key", error.message);
  }
  return { measured: args.key };
}

/**
 * Type `text` into the page, one `Input.insertText` per character so each fires its own `input`
 * event — the path an IME commit takes. With `target` the element is focused first.
 */
export async function typeText(args, state) {
  if (args.target) {
    const nodeIds = await queryIds(state.cdp, args.target);
    if (nodeIds.length === 0) throw new StepFailure("failed", "not_found", `no element for ${args.target}`);
    if (nodeIds.length > 1) throw new StepFailure("failed", "ambiguous_target", `${nodeIds.length} elements match ${args.target}`);
    if (!(await evaluate(state.cdp, FOCUS_JS(args.target)))) {
      throw new StepFailure("failed", "focus_failed", `${args.target} did not take focus`);
    }
  }
  const gapMs = args.gapMs ?? 0;
  for (const [index, char] of Array.from(args.text).entries()) {
    if (index > 0 && gapMs > 0) await state._sleep(gapMs);
    try {
      await state.cdp.send("Input.insertText", { text: char });
    } catch (error) {
      throw new StepFailure("failed", "insert_failed", error.message);
    }
  }
  return { measured: await evaluate(state.cdp, VALUE_JS) };
}
