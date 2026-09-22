// The realModel stamp at scheduler.mjs:1233. Sibling of scheduler.test.mjs,
// which is over the 500-line bar and may not grow.
//
// A Claude leaf records the REAL model id the init event reports, keeping the
// manifest name as `modelAlias` — grade rows resolve the model from here, so a
// leaf seated on the `opus` alias must not be recorded against the alias.
// Non-Claude models keep the manifest name verbatim: a ':cloud' id is a
// routing/governance identity an init-reported bare name must not clobber.
//
// The predicate asks "is this a Claude model" and nothing narrower.
// `swarm-claude-adapter-surface` swapped it to `claudeFamilyOf`, which asks
// "which family" — positional, so a `claude-` id whose next token is not a
// family token reads null and silently stops being stamped. Every launchable id
// happens to match, so the whole suite stayed green under the swap: 1573/1573
// with it reverted. These rows are what makes the line guarded at all.
import { test } from "node:test";
import { equal } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPlan } from "../src/scheduler.mjs";
import { fakeSpawnFactory, makeIo } from "./helpers/fake-io.mjs";

const CFG = {
  concurrency: 4, timeoutMs: 600000, resultInlineCap: 4000, worktreeBranchPrefix: "swarm/",
  providers: { claude: { enabled: true }, ollama: { enabled: true } },
};

// An init event carrying `model` is the only source of realModel (stream.mjs:406).
function streamReporting(realModel) {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s-stamp", model: realModel }),
    JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: "done",
      usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 2,
    }),
  ].join("\n") + "\n";
}

async function runOne({ provider, model, realModel }) {
  const dir = mkdtempSync(join(tmpdir(), "swarm-model-stamp-"));
  try {
    const spawn = fakeSpawnFactory(() => ({ output: streamReporting(realModel) }));
    const io = makeIo(spawn, { env: { PATH: process.env.PATH, SWARM_HOME: join(dir, "home") } });
    const resultsDir = join(dir, "run");
    await runPlan(
      { cwd: dir, resultsDir, concurrency: 4, goal: "", tasks: [{
        id: "leaf", prompt: "do leaf", provider, model, allowedTools: "Read",
        cwd: dir, originalCwd: dir, timeoutMs: 5000, after: [],
      }] },
      { ...CFG, allowedRoots: [dir] },
      io,
    );
    return JSON.parse(readFileSync(join(resultsDir, "results", "leaf.json"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The decisive row: a Claude id whose family token is NOT positional. Reddens
// the moment the predicate narrows from "is Claude" to "which family" — under
// claudeFamilyOf this id resolves null and the stamp never happens.
test("a Claude id with no positional family token is still stamped with its real model", async () => {
  const r = await runOne({ provider: "claude", model: "claude-3-5-sonnet-20241022", realModel: "claude-sonnet-5" });
  equal(r.model, "claude-sonnet-5", "the init-reported real model is what grade rows resolve");
  equal(r.modelAlias, "claude-3-5-sonnet-20241022", "the manifest name is kept as the alias");
});

// The case the stamp exists for, and the one every current id exercises: a tier
// id the CLI resolves to a dated snapshot. A bare alias cannot appear here —
// validateModel rejects one outright ("aliases are not accepted") — so the
// difference always arrives from the init event, never from the manifest.
test("a Claude tier id is stamped with the dated snapshot the run resolved", async () => {
  const r = await runOne({ provider: "claude", model: "claude-opus-5", realModel: "claude-opus-5-20260101" });
  equal(r.model, "claude-opus-5-20260101");
  equal(r.modelAlias, "claude-opus-5");
});

// The negative half, and it is not decorative: widening the predicate to stamp
// everything reddens here. A ':cloud' name is a routing identity, and the bare
// name a provider reports at init must not overwrite it.
test("a non-Claude model keeps its manifest name verbatim, never the init-reported one", async () => {
  const r = await runOne({ provider: "ollama", model: "deepseek-v4.1-flash:cloud", realModel: "deepseek-v4.1-flash" });
  equal(r.model, "deepseek-v4.1-flash:cloud", "the ':cloud' routing identity survives");
  equal(r.modelAlias, undefined, "nothing was aliased, so no alias is recorded");
});

// Stamping is a DIFFERENCE, not a presence: a Claude leaf whose reported model
// already equals its manifest name records no alias. Reddens if the predicate
// drops its `r.realModel !== task.model` clause.
test("a Claude leaf reporting the model it was asked for records no alias", async () => {
  const r = await runOne({ provider: "claude", model: "claude-opus-5", realModel: "claude-opus-5" });
  equal(r.model, "claude-opus-5");
  equal(r.modelAlias, undefined);
});
