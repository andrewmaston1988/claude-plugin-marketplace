// Fixture servers for the format lane: static sheet, HTTP health check, TCP banner.
// Fixed ports so an authored scenario can write literal URLs and identical steps.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PORTS = { static: 18771, http: 18772, tcp: 18773 };

export const URLS = {
  sheet: `http://127.0.0.1:${PORTS.static}/sheet.html`,
  health: `http://127.0.0.1:${PORTS.http}/health`,
};

export const BANNER = 'HELLO ui-probe';

const SHEET = fs.readFileSync(path.join(HERE, 'sheet.html'));

function listenStatic() {
  const server = http.createServer((req, res) => {
    if (req.url === '/sheet.html' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(SHEET);
      return;
    }
    res.writeHead(404).end();
  });
  return listen(server, PORTS.static);
}

function listenHttp() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });
  return listen(server, PORTS.http);
}

function listenTcp() {
  const server = net.createServer((socket) => {
    socket.write(`${BANNER}\r\n`);
    socket.on('error', () => {});
  });
  return listen(server, PORTS.tcp);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// Starts all three. Rejects loudly if a port is taken: a silent rebind would
// hand authors a URL that points at someone else's process.
export async function startFixtures() {
  const servers = [];
  try {
    servers.push(await listenStatic());
    servers.push(await listenHttp());
    servers.push(await listenTcp());
  } catch (err) {
    for (const s of servers) s.close();
    throw new Error(`fixture port busy (expected ${JSON.stringify(PORTS)}): ${err.message}`);
  }
  return {
    ports: PORTS,
    urls: URLS,
    banner: BANNER,
    close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fx = await startFixtures();
  process.stdout.write(`${JSON.stringify({ urls: fx.urls, ports: fx.ports, banner: fx.banner })}\n`);
  const stop = async () => { await fx.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdin.resume();
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
}
