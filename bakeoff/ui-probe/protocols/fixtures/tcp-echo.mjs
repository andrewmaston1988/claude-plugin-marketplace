// The local node:net fixture the TCP contender runs against: a banner on connect, then an
// echo of every line with a 250 prefix. It records every byte the probe sends, which is what
// the write-allowlist proof asserts on.

import { createServer } from "node:net";

export const BANNER = "220 ui-probe-bakeoff fixture ready\r\n";

export async function startTcpFixture({ port = 0, host = "127.0.0.1" } = {}) {
  const received = [];

  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write(BANNER);
    socket.on("data", (chunk) => {
      received.push(chunk);
      socket.write(`250 ${chunk}`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const actual = server.address().port;
  return {
    host,
    port: actual,
    received,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}
