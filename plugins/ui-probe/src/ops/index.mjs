// The op dispatch table. Adding an op: one entry here plus its judge module.

import { expectCss, expectHidden, expectText, expectVisible, expectWidths } from "./assertions.mjs";
import { interact } from "./interaction.mjs";

export const OPS = {
  hover: (args, state) => interact("hover", args, state),
  click: (args, state) => interact("click", args, state),
  tap: (args, state) => interact("tap", args, state),
  expect_visible: expectVisible,
  expect_hidden: expectHidden,
  expect_widths: expectWidths,
  expect_css: expectCss,
  expect_text: expectText,
};
