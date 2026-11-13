// The op dispatch table. Adding an op: one entry here plus its judge module.

import { interact } from "./interaction.mjs";

export const OPS = {
  hover: (args, state) => interact("hover", args, state),
  click: (args, state) => interact("click", args, state),
  tap: (args, state) => interact("tap", args, state),
};
