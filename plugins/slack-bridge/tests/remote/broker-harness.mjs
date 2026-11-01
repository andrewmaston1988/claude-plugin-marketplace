// Shared harness for the broker test files: a real broker on an ephemeral port
// and the HTTP helpers the tests drive it with. Fake-free — the broker is the
// unit under test; nothing here touches the network beyond 127.0.0.1.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBroker } from "../../src/remote/broker.mjs";

export function tmpState() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "slack-remote-broker-")), "state.json");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startBroker(t, opts = {}) {
  const broker = createBroker({ stateFile: opts.stateFile ?? tmpState(), ...opts });
  t.after(() => broker.close());
  const port = await broker.listen(0);
  const call = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { broker, port, call };
}

export const REG = { pid: process.pid, cwd: "C:/work/a", git_root: "C:/work/a", tty: null, summary: "live session" };
