// Newline-delimited JSON-RPC 2.0 over a pair of streams — the framing Claude
// Code's stdio MCP transport speaks. stdout must carry protocol lines only.
export function createRpcEndpoint({ input, output, onRequest, onNotification = async () => {}, log = () => {} }) {
  let buf = "";

  const write = (obj) => output.write(JSON.stringify(obj) + "\n");

  async function handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    if (typeof msg.method !== "string") return; // a response to us — we never send requests
    if (msg.id === undefined || msg.id === null) {
      try {
        await onNotification(msg.method, msg.params ?? {});
      } catch (e) {
        log(`notification handler failed (${msg.method}): ${e.message}`);
      }
      return;
    }
    try {
      const result = await onRequest(msg.method, msg.params ?? {});
      write({ jsonrpc: "2.0", id: msg.id, result });
    } catch (e) {
      write({ jsonrpc: "2.0", id: msg.id, error: { code: e.rpcCode ?? -32603, message: e.message } });
    }
  }

  input.setEncoding?.("utf8");
  input.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) handleLine(line);
    }
  });

  return {
    notify: (method, params) => write({ jsonrpc: "2.0", method, params }),
  };
}
