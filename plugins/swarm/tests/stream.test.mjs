import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import {
  createStreamParser, createUsageAccumulator,
  usageTokens, addTokens, tokenTotal, pickFinalTokens, emptyTokens,
} from "../src/stream.mjs";

const asst = (id, usage) => JSON.stringify({ type: "assistant", message: { id, role: "assistant", usage } });
const RESULT = JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: "final answer",
  usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 900 },
  total_cost_usd: 0.0123, num_turns: 3,
});

function collect() {
  const usages = [];
  let result = null;
  const parser = createStreamParser({
    onUsage: (id, u) => usages.push([id, u]),
    onResult: (evt) => { result = evt; },
  });
  return { parser, usages, result: () => result };
}

test("parser: events split across arbitrary chunk boundaries", () => {
  const { parser, usages, result } = collect();
  const stream = asst("m1", { input_tokens: 5, output_tokens: 2 }) + "\n" + RESULT + "\n";
  // Feed one byte at a time — worst-case chunking.
  for (const ch of stream) parser.feed(ch);
  parser.end();
  equal(usages.length, 1);
  deepEqual(usages[0], ["m1", { input_tokens: 5, output_tokens: 2 }]);
  equal(result().result, "final answer");
  equal(result().total_cost_usd, 0.0123);
});

test("parser: plain-text stream produces no events", () => {
  const { parser, usages, result } = collect();
  parser.feed("just ordinary\nleaf output\n{not json}\n");
  parser.end();
  equal(usages.length, 0);
  equal(result(), null);
});

test("parser: trailing line without newline is flushed by end()", () => {
  const { parser, result } = collect();
  parser.feed(RESULT); // no trailing \n
  equal(result(), null); // not yet — could still be partial
  parser.end();
  equal(result().result, "final answer");
});

test("parser: assistant event without usage is ignored", () => {
  const { parser, usages } = collect();
  parser.feed(JSON.stringify({ type: "assistant", message: { id: "m1" } }) + "\n");
  equal(usages.length, 0);
});

test("accumulator: latest usage per message id wins, totals sum across ids", () => {
  const acc = createUsageAccumulator();
  acc.record("m1", { input_tokens: 10, output_tokens: 1 });
  acc.record("m1", { input_tokens: 10, output_tokens: 7 }); // re-emit replaces
  acc.record("m2", { input_tokens: 20, output_tokens: 3, cache_creation_input_tokens: 4, cache_read_input_tokens: 100 });
  deepEqual(acc.totals(), { input: 30, output: 10, cacheCreation: 4, cacheRead: 100 });
});

test("usageTokens tolerates missing fields; addTokens and tokenTotal math", () => {
  deepEqual(usageTokens({}), emptyTokens());
  deepEqual(usageTokens(undefined), emptyTokens());
  const t = addTokens(usageTokens({ input_tokens: 1, output_tokens: 2 }), usageTokens({ cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }));
  deepEqual(t, { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 });
  // Headline total counts work tokens (input + output + cache writes), not cache reads.
  equal(tokenTotal(t), 6);
  equal(tokenTotal(null), 0);
});

test("pickFinalTokens: result-event usage is authoritative when present", () => {
  const accumulated = { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 };
  const final = pickFinalTokens({ input_tokens: 100, output_tokens: 50 }, accumulated);
  deepEqual(final, { input: 100, output: 50, cacheCreation: 0, cacheRead: 0 });
  // absent or empty usage falls back to the live accumulation
  deepEqual(pickFinalTokens(undefined, accumulated), accumulated);
  deepEqual(pickFinalTokens({}, accumulated), accumulated);
});
