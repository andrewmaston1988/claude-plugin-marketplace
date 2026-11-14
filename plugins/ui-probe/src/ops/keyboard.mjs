// Keyboard input: one op over the TV key table, shared by the set and the desktop device.

import { dispatchKey } from "../tv/keys.mjs";
import { StepFailure } from "./common.mjs";

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
