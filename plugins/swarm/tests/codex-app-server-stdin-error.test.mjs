import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createCodexAppServerClient } from "../src/codex-app-server.mjs";

function childWithAsyncStdinError() {
  const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      setImmediate(() => callback(error));
    },
  });
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {},
  });
}

test("Codex app-server routes async stdin errors to pending requests", async () => {
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  const client = createCodexAppServerClient({
    timeoutMs: 30,
    spawnImpl: childWithAsyncStdinError,
  });
  let requestError;
  try {
    await client.request("account/usage/read").catch((error) => { requestError = error; });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("uncaughtException", onUncaught);
    client.close();
  }
  deepEqual({ requestError: requestError?.code, uncaught: uncaught.map((error) => error.code) }, {
    requestError: "EPIPE",
    uncaught: [],
  });
});