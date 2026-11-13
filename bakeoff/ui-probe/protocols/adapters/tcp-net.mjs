// TCP contender: node:net, banner read, and a write-allowlist.
//
// The socket may send two things and no others: nothing at all (the banner read) and the
// single fixture line (the echo round-trip). Everything else is refused in the guard, before
// it reaches the socket. `net` is injected at call time so the smoke test drives it offline.

import { InputError, tcpPolicy } from "../allow.mjs";

export const ECHO_LINE = "HELLO ui-probe\r\n";

function lineReader(socket) {
  let buffer = "";
  let waiter = null;
  const pump = () => {
    const at = buffer.indexOf("\r\n");
    if (at < 0 || waiter === null) return;
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 2);
    const resolve = waiter;
    waiter = null;
    resolve(line);
  };
  socket.on("data", (chunk) => {
    buffer += chunk;
    pump();
  });
  return () =>
    new Promise((resolve) => {
      waiter = resolve;
      pump();
    });
}

function withTimeout(promise, ms, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function createTcpAdapter({ net, host, port, timeoutMs = 2000, clock = () => performance.now() }) {
  const policy = tcpPolicy({ host, port, writes: ["", ECHO_LINE] });

  async function session({ write }) {
    if (!policy.allow({ host, port, write })) {
      throw new InputError(`tcp: write ${JSON.stringify(write)} is off the allowlist (${policy.describe()})`);
    }

    const lines = [`CONNECT ${host}:${port}`];
    const started = clock();

    const socket = net.connect({ host, port });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);

    const nextLine = lineReader(socket);
    await withTimeout(
      new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
        socket.once("timeout", () => reject(new Error(`tcp: ${host}:${port} timed out`)));
      }),
      timeoutMs,
      `tcp: ${host}:${port} connect timed out`,
    );

    const banner = await withTimeout(nextLine(), timeoutMs, "tcp: no banner");
    lines.push(`< ${banner}`);

    let echo = null;
    if (write !== "") {
      socket.write(write);
      lines.push(`> ${write.replace(/\r\n$/, "")}`);
      echo = await withTimeout(nextLine(), timeoutMs, "tcp: no echo");
      lines.push(`< ${echo}`);
    }

    socket.destroy();
    const ms = clock() - started;
    lines.push(`# closed by probe, ${ms.toFixed(1)} ms`);

    return { transcript: lines.join("\n"), meta: { banner, echo, ms } };
  }

  return {
    id: "tcp-net",
    label: "node:net (raw TCP)",
    tasks: ["tcp.banner", "tcp.echo"],
    guard: {
      mechanism: "exact write-allowlist on the socket, enforced before connect()",
      describe: () => policy.describe(),
      bite: async () => {
        try {
          await session({ write: "QUIT\r\n" });
          return { attempt: "write QUIT", blocked: false, message: "the write reached the socket" };
        } catch (err) {
          return { attempt: "write QUIT", blocked: err instanceof InputError, message: err.message };
        }
      },
    },
    async probe(task) {
      if (task.id === "tcp.banner") return session({ write: "" });
      if (task.id === "tcp.echo") return session({ write: ECHO_LINE });
      throw new InputError(`tcp: no probe for ${task.id}`);
    },
  };
}
