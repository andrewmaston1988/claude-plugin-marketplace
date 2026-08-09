import { test } from "node:test";
import { equal, deepEqual, ok, rejects } from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import {
  discoverModels, writeModelsCache, scrapeDiscoverCmd,
  deriveCloudName, enrichWithShow, sortModelsBySize,
  collapseFamilies, visibleModels, removeCachedModel, probeTopModels,
} from "../src/discovery.mjs";

// User-confirmed live schema of the recommendations endpoint (2026-07-07),
// verbatim — the fixture the engine is contract-tested against.
const RECOMMENDATIONS_FIXTURE = {
  recommendations: [
    { model: "glm-5.2:cloud", description: "Frontier open reasoning model", context_length: 1000000, max_output_tokens: 131072, required_plan: "pro" },
    { model: "minimax-m3:cloud", description: "Fast agentic model", context_length: 200000, max_output_tokens: 65536, required_plan: "free" },
    { model: "qwen3-coder:480b", description: "Local-only build", context_length: 131072, max_output_tokens: 32768, required_plan: null },
  ],
};

function cfg(url) {
  return {
    provider: {
      url,
      cloudSuffix: ":cloud",
      discoverCmd: "ollama launch claude",
    },
  };
}

function stubServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test("recommendations endpoint (stub http server): :cloud filter keeps metadata", async () => {
  const { server, url } = await stubServer((req, res) => {
    if (req.url === "/api/experimental/model-recommendations") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(RECOMMENDATIONS_FIXTURE));
    } else if (req.url === "/api/show") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    } else {
      res.writeHead(404).end();
    }
  });
  // Real fetch for the stub only — the union always tries the WAN catalog too,
  // and tests must never reach ollama.com.
  const routedFetch = (u, init) =>
    u.startsWith(url) ? fetch(u, init) : Promise.reject(new Error("WAN disabled in test"));
  try {
    const models = await discoverModels(cfg(url), routedFetch);
    deepEqual(models, [
      { model: "glm-5.2:cloud", description: "Frontier open reasoning model", contextLength: 1000000, requiredPlan: "pro", source: "recommendations" },
      { model: "minimax-m3:cloud", description: "Fast agentic model", contextLength: 200000, requiredPlan: "free", source: "recommendations" },
    ]); // qwen3-coder:480b filtered — not :cloud
  } finally {
    server.close();
  }
});

test("fallback chain: local 404 -> ollama.com recommendations", async () => {
  const fetched = [];
  const fakeFetch = async (url) => {
    fetched.push(url);
    if (url.startsWith("http://local.test") && !url.endsWith("/api/show")) return { ok: false, status: 404 };
    if (url === "https://ollama.com/api/experimental/model-recommendations") {
      return { ok: true, json: async () => RECOMMENDATIONS_FIXTURE };
    }
    throw new Error("unexpected fetch " + url); // tags + show fail open
  };
  const models = await discoverModels(cfg("http://local.test:11434"), fakeFetch);
  equal(models.length, 2);
  ok(fetched.includes("https://ollama.com/api/experimental/model-recommendations"));
});

test("fallback chain: local recommendations down -> ollama.com recommendations + tags still union", async () => {
  const fakeFetch = async (url) => {
    if (url.startsWith("http://local.test") && !url.endsWith("/api/show")) throw new Error("ECONNREFUSED");
    if (url === "https://ollama.com/api/experimental/model-recommendations") {
      return { ok: true, json: async () => RECOMMENDATIONS_FIXTURE };
    }
    if (url === "https://ollama.com/api/tags") {
      return { ok: true, json: async () => ({ models: [{ name: "kimi-k3" }, { name: "glm-5.2" }] }) };
    }
    if (url.endsWith("/api/show")) return { ok: true, json: async () => ({}) };
    throw new Error("unexpected fetch " + url);
  };
  const models = await discoverModels(cfg("http://local.test:11434"), fakeFetch);
  const byName = Object.fromEntries(models.map((m) => [m.model, m]));
  equal(models.length, 3); // rec 2 ∪ tags 2, overlap glm-5.2
  equal(byName["glm-5.2:cloud"].source, "recommendations");
  equal(byName["kimi-k3:cloud"].source, "catalog");
});

test("fallback chain: ECONNREFUSED everywhere except tags -> :cloud suffix appended", async () => {
  const fakeFetch = async (url) => {
    if (url === "https://ollama.com/api/tags") {
      return { ok: true, json: async () => ({ models: [{ name: "glm-4.6" }, { name: "deepseek-v3.1:cloud" }] }) };
    }
    throw new Error("ECONNREFUSED");
  };
  const models = await discoverModels(cfg("http://127.0.0.1:1"), fakeFetch);
  deepEqual(models.map((m) => m.model), ["glm-4.6:cloud", "deepseek-v3.1:cloud"]);
});

test("discoverModels stamps supersededBy — collapse is wired in, so the cache carries it", async () => {
  const fakeFetch = async (url) => {
    if (url === "https://ollama.com/api/tags") {
      return { ok: true, json: async () => ({ models: [{ name: "glm-5.1" }, { name: "glm-5.2" }] }) };
    }
    if (url.endsWith("/api/show")) return { ok: true, json: async () => ({}) };
    throw new Error("ECONNREFUSED");
  };
  const models = await discoverModels(cfg("http://127.0.0.1:1"), fakeFetch);
  const byName = Object.fromEntries(models.map((m) => [m.model, m]));
  equal(byName["glm-5.1:cloud"].supersededBy, "glm-5.2:cloud");
  equal(byName["glm-5.2:cloud"].supersededBy, undefined);
});

test("discoverCmd scrape is the last resort", async () => {
  const failFetch = async () => { throw new Error("down"); };
  const fakeSpawn = (cmd, args) => {
    equal(cmd, "ollama");
    deepEqual(args, ["launch", "claude"]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      child.stdout.emit("data", "pick a model:\n> glm-5.2:cloud\n  minimax-m3:cloud\n  glm-5.2:cloud\n");
      child.emit("close", 0);
    }, 5);
    return child;
  };
  const models = await discoverModels(cfg("http://127.0.0.1:1"), failFetch, { spawnImpl: fakeSpawn });
  deepEqual(models.map((m) => m.model), ["glm-5.2:cloud", "minimax-m3:cloud"]); // deduped
});

test("all sources exhausted -> clear error", async () => {
  const failFetch = async () => { throw new Error("down"); };
  const deadSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => child.emit("close", 1), 5);
    return child;
  };
  await rejects(
    () => discoverModels(cfg("http://127.0.0.1:1"), failFetch, { spawnImpl: deadSpawn }),
    /model discovery failed/,
  );
});

test("scrapeDiscoverCmd tolerates a spawn that errors", async () => {
  const throwingSpawn = () => { throw new Error("ENOENT"); };
  deepEqual(await scrapeDiscoverCmd(cfg("x"), throwingSpawn), []);
});

test("writeModelsCache lands in SWARM_HOME/models-cache.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-cache-"));
  try {
    const p = writeModelsCache([{ model: "glm-5.2:cloud", description: "d" }], { SWARM_HOME: dir });
    equal(p, join(dir, "models-cache.json"));
    const cache = JSON.parse(readFileSync(p, "utf8"));
    ok(cache.updated);
    deepEqual(cache.models, [{ model: "glm-5.2:cloud", description: "d" }]);
    ok(!existsSync(p + ".tmp")); // atomic: tmp renamed away
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveCloudName: bare gets :cloud, tagged gets -cloud, cloud forms pass through", () => {
  equal(deriveCloudName("glm-5.2"), "glm-5.2:cloud");
  equal(deriveCloudName("qwen3.5:397b"), "qwen3.5:397b-cloud");
  equal(deriveCloudName("glm-5.2:cloud"), "glm-5.2:cloud");
  equal(deriveCloudName("qwen3.5:397b-cloud"), "qwen3.5:397b-cloud");
});

test("union: recommendations metadata + tags breadth, keyed on derived cloud name", async () => {
  const TAGS = { models: [
    { name: "glm-5.2" }, { name: "minimax-m3" },
    { name: "kimi-k3" }, { name: "kimi-k2.7-code" }, { name: "qwen3.5:397b" },
  ] };
  const fakeFetch = async (url, init) => {
    if (url.endsWith("/api/experimental/model-recommendations")) return { ok: true, json: async () => RECOMMENDATIONS_FIXTURE };
    if (url === "https://ollama.com/api/tags") return { ok: true, json: async () => TAGS };
    if (url.endsWith("/api/show")) return { ok: true, json: async () => ({}) };
    throw new Error("unexpected fetch " + url);
  };
  const models = await discoverModels(cfg("http://local.test:11434"), fakeFetch);
  equal(models.length, 5);
  const byName = Object.fromEntries(models.map((m) => [m.model, m]));
  equal(byName["glm-5.2:cloud"].description, "Frontier open reasoning model");
  equal(byName["glm-5.2:cloud"].contextLength, 1000000);
  equal(byName["glm-5.2:cloud"].requiredPlan, "pro");
  equal(byName["glm-5.2:cloud"].source, "recommendations");
  equal(byName["kimi-k3:cloud"].source, "catalog");
  equal(byName["kimi-k2.7-code:cloud"].source, "catalog");
  ok(byName["qwen3.5:397b-cloud"]); // tagged name derived, not blind-append
});

test("enrichWithShow harvests capabilities, context_length (any arch prefix), parameter_count", async () => {
  const SHOW = {
    "kimi-k3:cloud": { capabilities: ["vision", "thinking", "completion", "tools"], model_info: { "kimi-k3.context_length": 1048576, "general.parameter_count": 2810000000000 } },
    "glm-5.2:cloud": { capabilities: ["completion"], model_info: { "glm5.2.context_length": 1000000, "general.parameter_count": 756000000000 } },
  };
  const fakeFetch = async (url, init) => {
    const { model } = JSON.parse(init.body);
    return { ok: true, json: async () => SHOW[model] };
  };
  const out = await enrichWithShow([{ model: "kimi-k3:cloud" }, { model: "glm-5.2:cloud" }], "http://x", fakeFetch);
  equal(out[0].parameterCount, 2810000000000);
  equal(out[0].contextLength, 1048576);
  deepEqual(out[0].capabilities, ["vision", "thinking", "completion", "tools"]);
  equal(out[1].parameterCount, 756000000000);
  equal(out[1].contextLength, 1000000);
});

test("enrichWithShow: HTTP error response drops the candidate", async () => {
  const fakeFetch = async (url, init) => {
    const { model } = JSON.parse(init.body);
    if (model === "bogus:cloud") return { ok: false, status: 404 };
    return { ok: true, json: async () => ({}) };
  };
  const out = await enrichWithShow([{ model: "glm-5.2:cloud" }, { model: "bogus:cloud" }], "http://x", fakeFetch);
  deepEqual(out.map((m) => m.model), ["glm-5.2:cloud"]);
});

test("enrichWithShow: fetch throw keeps the candidate unvalidated (fail open)", async () => {
  const fakeFetch = async () => { throw new Error("ECONNREFUSED"); };
  const out = await enrichWithShow([{ model: "glm-5.2:cloud", description: "d" }], "http://x", fakeFetch);
  deepEqual(out, [{ model: "glm-5.2:cloud", description: "d" }]);
});

test("sortModelsBySize: parameterCount desc, contextLength tiebreak, missing last", () => {
  const sorted = sortModelsBySize([
    { model: "minimax-m3:cloud" },
    { model: "glm-5.1:cloud", parameterCount: 756000000000, contextLength: 202000 },
    { model: "kimi-k3:cloud", parameterCount: 2810000000000, contextLength: 1048576 },
    { model: "glm-5.2:cloud", parameterCount: 756000000000, contextLength: 1000000 },
  ]);
  deepEqual(sorted.map((m) => m.model),
    ["kimi-k3:cloud", "glm-5.2:cloud", "glm-5.1:cloud", "minimax-m3:cloud"]);
});

test("collapseFamilies: segment split marks elders superseded within a lineage", () => {
  const out = collapseFamilies([
    { model: "glm-5.2:cloud" }, { model: "glm-5.1:cloud" },
    { model: "kimi-k3:cloud" }, { model: "kimi-k2.6:cloud" },
    { model: "qwen3.6:cloud" }, { model: "qwen3.5:cloud" },
    { model: "gemma5:31b-cloud" }, { model: "gemma4:31b-cloud" },
  ]);
  const byName = Object.fromEntries(out.map((m) => [m.model, m]));
  equal(byName["glm-5.1:cloud"].supersededBy, "glm-5.2:cloud");
  equal(byName["glm-5.2:cloud"].supersededBy, undefined);
  equal(byName["kimi-k2.6:cloud"].supersededBy, "kimi-k3:cloud"); // lineage kimi-k
  equal(byName["qwen3.5:cloud"].supersededBy, "qwen3.6:cloud"); // multi-letter stem splits
  equal(byName["gemma4:31b-cloud"].supersededBy, "gemma5:31b-cloud"); // size tag joins the lineage
});

test("collapseFamilies: variant tags and size tags are lineage, not versions", () => {
  const out = collapseFamilies([
    { model: "kimi-k3:cloud" }, { model: "kimi-k2.7-code:cloud" },
    { model: "gpt-oss:20b-cloud" }, { model: "gpt-oss:120b-cloud" },
    { model: "deepseek-v4-flash:0830-cloud" }, { model: "deepseek-v4-flash:0731-cloud" },
    { model: "deepseek-v4-flash:preview-cloud" },
  ]);
  const byName = Object.fromEntries(out.map((m) => [m.model, m]));
  equal(byName["kimi-k2.7-code:cloud"].supersededBy, undefined); // -code is its own lineage
  equal(byName["gpt-oss:20b-cloud"].supersededBy, undefined);
  equal(byName["gpt-oss:120b-cloud"].supersededBy, undefined);
  equal(byName["deepseek-v4-flash:0731-cloud"].supersededBy, "deepseek-v4-flash:0830-cloud");
  equal(byName["deepseek-v4-flash:preview-cloud"].supersededBy, undefined); // :preview is its own lineage
});

test("collapseFamilies: prefix-extension versions are incomparable — both kept", () => {
  const out = collapseFamilies([{ model: "kimi-k3:cloud" }, { model: "kimi-k3:0901-cloud" }]);
  deepEqual(out.map((m) => m.supersededBy), [undefined, undefined]);
});

test("visibleModels: elder hidden only while its superseder is usable", () => {
  const roster = [
    { model: "glm-5.2:cloud" },
    { model: "glm-5.1:cloud", supersededBy: "glm-5.2:cloud" },
  ];
  deepEqual(visibleModels(roster).map((m) => m.model), ["glm-5.2:cloud"]);
  // superseder removed from the cache (402 entitlement) → elder resurfaces
  deepEqual(visibleModels(roster.slice(1)).map((m) => m.model), ["glm-5.1:cloud"]);
  // superseder denylisted → elder resurfaces; the denylist itself filters at print, not here
  deepEqual(
    visibleModels(roster, { isDenylisted: (name) => name === "glm-5.2:cloud" }).map((m) => m.model),
    ["glm-5.2:cloud", "glm-5.1:cloud"],
  );
});

test("visibleModels: supersededBy chains walk to any usable newer entry", () => {
  const roster = [
    { model: "glm-5.2:cloud" },
    { model: "glm-5.1:cloud", supersededBy: "glm-5.2:cloud" },
    { model: "glm-5.0:cloud", supersededBy: "glm-5.1:cloud" },
  ];
  // 5.2 denylisted: 5.1 resurfaces and still hides 5.0
  deepEqual(
    visibleModels(roster, { isDenylisted: (n) => n === "glm-5.2:cloud" }).map((m) => m.model),
    ["glm-5.2:cloud", "glm-5.1:cloud"],
  );
});

// Live 402 body from ollama for an unfunded extra-usage model.
const PROBE_402_BODY = `{"error":"this model uses extra usage only (not included plan usage) and your extra usage balance is empty, add extra usage or turn on auto reload at https://ollama.com/settings (ref: ...)"}`;

// Fake /api/generate endpoint: records each probed model, answers per verdicts.
function probeFetch(verdicts, calls) {
  return async (url, init) => {
    ok(url.endsWith("/api/generate"));
    const { model } = JSON.parse(init.body);
    calls.push(model);
    const v = verdicts[model];
    if (v === "throw") throw new Error("ECONNREFUSED");
    if (v === 402) return { ok: false, status: 402, text: async () => PROBE_402_BODY };
    if (v === 500) return { ok: false, status: 500, text: async () => "internal error" };
    return { ok: true, status: 200, text: async () => "{}" };
  };
}

test("probeTopModels: 402 removes the row, 200 keeps it, other errors fail open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-probe-"));
  try {
    const env = { SWARM_HOME: dir };
    const roster = [
      { model: "kimi-k3:cloud" },
      { model: "deepseek-v4-pro:cloud" },
      { model: "kimi-k2.7-code:cloud" },
    ];
    writeModelsCache(roster, env);
    const calls = [];
    const live = await probeTopModels(roster, "http://x", probeFetch({
      "kimi-k3:cloud": 402,
      "deepseek-v4-pro:cloud": 200,
      "kimi-k2.7-code:cloud": 500,
    }, calls), { env });
    deepEqual(calls, ["kimi-k3:cloud", "deepseek-v4-pro:cloud", "kimi-k2.7-code:cloud"]);
    const cached = JSON.parse(readFileSync(join(dir, "models-cache.json"), "utf8")).models;
    deepEqual(cached.map((m) => m.model), ["deepseek-v4-pro:cloud", "kimi-k2.7-code:cloud"]);
    deepEqual(live.map((m) => m.model), ["deepseek-v4-pro:cloud", "kimi-k2.7-code:cloud"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeTopModels: fetch throw keeps the row (fail open)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-probe-"));
  try {
    const env = { SWARM_HOME: dir };
    const roster = [{ model: "glm-5.2:cloud" }];
    writeModelsCache(roster, env);
    const before = readFileSync(join(dir, "models-cache.json"), "utf8");
    const live = await probeTopModels(roster, "http://x", probeFetch({ "glm-5.2:cloud": "throw" }, []), { env });
    equal(readFileSync(join(dir, "models-cache.json"), "utf8"), before);
    deepEqual(live.map((m) => m.model), ["glm-5.2:cloud"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeTopModels: only the top 3 visible entries; non-cloud names never probed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-probe-"));
  try {
    const env = { SWARM_HOME: dir };
    const roster = [
      { model: "qwen3-coder:480b" }, // local name in the top 3 — occupies the slot, never probed
      { model: "kimi-k3:cloud" },
      { model: "glm-5.2:cloud" },
      { model: "minimax-m3:cloud" }, // 4th — outside the top 3
    ];
    writeModelsCache(roster, env);
    const calls = [];
    await probeTopModels(roster, "http://x", probeFetch({}, calls), { env });
    deepEqual(calls, ["kimi-k3:cloud", "glm-5.2:cloud"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeTopModels: denylisted entries neither probed nor occupying a slot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-probe-"));
  try {
    const env = { SWARM_HOME: dir };
    const roster = [
      { model: "nemotron-3-super:cloud" }, // denylisted — never offered, so never probed
      { model: "glm-5.2:cloud" },
      { model: "kimi-k2.7-code:cloud" },
      { model: "minimax-m3:cloud" }, // takes the freed third slot
    ];
    writeModelsCache(roster, env);
    const calls = [];
    await probeTopModels(roster, "http://x", probeFetch({}, calls), {
      env, isDenylisted: (n) => n.includes("nemotron"),
    });
    deepEqual(calls, ["glm-5.2:cloud", "kimi-k2.7-code:cloud", "minimax-m3:cloud"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeTopModels: a removal cascades to the resurfaced elder, capped at 6 probes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-probe-"));
  try {
    // Scenario 1: k3 removed -> k2.6 resurfaces into the top 3 and is probed too.
    const env = { SWARM_HOME: dir };
    const roster = [
      { model: "kimi-k3:cloud" },
      { model: "deepseek-v4-pro:cloud" },
      { model: "kimi-k2.7-code:cloud" },
      { model: "kimi-k2.6:cloud", supersededBy: "kimi-k3:cloud" },
    ];
    writeModelsCache(roster, env);
    const calls = [];
    const live = await probeTopModels(roster, "http://x", probeFetch({ "kimi-k3:cloud": 402 }, calls), { env });
    deepEqual(calls, ["kimi-k3:cloud", "deepseek-v4-pro:cloud", "kimi-k2.7-code:cloud", "kimi-k2.6:cloud"]);
    deepEqual(live.map((m) => m.model),
      ["deepseek-v4-pro:cloud", "kimi-k2.7-code:cloud", "kimi-k2.6:cloud"]);

    // Scenario 2: an all-402 supersession chain stops at the 6-probe cap.
    const chain = [];
    for (let v = 9; v >= 2; v--) {
      chain.push({ model: `glm-5.${v}:cloud`, ...(v < 9 ? { supersededBy: `glm-5.${v + 1}:cloud` } : {}) });
    }
    writeModelsCache(chain, env);
    const chainCalls = [];
    const verdicts = Object.fromEntries(chain.map((m) => [m.model, 402]));
    await probeTopModels(chain, "http://x", probeFetch(verdicts, chainCalls), { env });
    equal(chainCalls.length, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeCachedModel deletes the row atomically; missing cache/entry are no-ops", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-remove-"));
  try {
    const env = { SWARM_HOME: dir };
    const p = join(dir, "models-cache.json");
    // missing cache -> silent no-op
    removeCachedModel("glm-5.2:cloud", env);
    ok(!existsSync(p));
    writeModelsCache([{ model: "kimi-k3:cloud" }, { model: "glm-5.2:cloud" }], env);
    // missing entry -> no write (compact hand-written JSON survives byte-identical;
    // a rewrite would re-indent)
    const compact = JSON.stringify(JSON.parse(readFileSync(p, "utf8")));
    writeFileSync(p, compact);
    removeCachedModel("nope:cloud", env);
    equal(readFileSync(p, "utf8"), compact);
    // removal lands atomically and leaves the rest of the roster intact
    removeCachedModel("kimi-k3:cloud", env);
    ok(!existsSync(p + ".tmp"));
    deepEqual(JSON.parse(readFileSync(p, "utf8")).models.map((m) => m.model), ["glm-5.2:cloud"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
