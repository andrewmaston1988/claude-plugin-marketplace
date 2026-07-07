import { test } from "node:test";
import { equal, deepEqual, ok, rejects } from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { discoverModels, writeModelsCache, scrapeDiscoverCmd } from "../src/discovery.mjs";

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

test("recommendations endpoint (stub http server): :cloud filter keeps descriptions", async () => {
  const { server, url } = await stubServer((req, res) => {
    if (req.url === "/api/experimental/model-recommendations") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(RECOMMENDATIONS_FIXTURE));
    } else {
      res.writeHead(404).end();
    }
  });
  try {
    const models = await discoverModels(cfg(url));
    deepEqual(models, [
      { model: "glm-5.2:cloud", description: "Frontier open reasoning model" },
      { model: "minimax-m3:cloud", description: "Fast agentic model" },
    ]); // qwen3-coder:480b filtered — not :cloud
  } finally {
    server.close();
  }
});

test("fallback chain: local 404 -> ollama.com recommendations", async () => {
  const fetched = [];
  const fakeFetch = async (url) => {
    fetched.push(url);
    if (url.startsWith("http://local.test")) return { ok: false, status: 404 };
    if (url === "https://ollama.com/api/experimental/model-recommendations") {
      return { ok: true, json: async () => RECOMMENDATIONS_FIXTURE };
    }
    throw new Error("unexpected fetch " + url);
  };
  const models = await discoverModels(cfg("http://local.test:11434"), fakeFetch);
  equal(models.length, 2);
  equal(fetched.length, 2);
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
