// Fixture server for the integration rows. One node:http listener on port 0 serves every page the
// tests need and records each request, so a guard test can prove the server never saw a write.

import { createServer } from "node:http";

const page = (body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ui-probe fixture</title>
<style>
  body { font: 16px/1.4 system-ui, sans-serif; margin: 0; padding: 8px; }
  .tile { display: inline-block; width: 111px; height: 40px; background: #ccd; box-sizing: border-box; }
  .bad { display: inline-block; height: 40px; background: #dcc; box-sizing: border-box; }
</style></head>
<body>${body}</body></html>`;

const PAGES = {
  "/tiles-good.html": page(`
    <div class="tile" data-testid="action-tile"></div>
    <div class="tile" data-testid="action-tile"></div>
    <div class="tile" data-testid="action-tile"></div>`),

  "/tiles-bad.html": page(`
    <div class="bad" data-testid="action-tile" style="width:54px"></div>
    <div class="bad" data-testid="action-tile" style="width:55px"></div>
    <div class="bad" data-testid="action-tile" style="width:78px"></div>`),

  "/hover-flip.html": page(`
    <div id="tile" style="width:200px;height:120px;background:#dde"></div>
    <div id="bar" style="display:none;height:20px;background:#9c9">Bar</div>
    <script>
      const bar = document.getElementById("bar");
      let started = false;
      document.getElementById("tile").addEventListener("mousemove", () => {
        if (started) return;
        started = true;
        setTimeout(() => { bar.style.display = "flex"; }, 150);
      });
    </script>`),

  // A real modal <dialog>: the background becomes inert, so the AX tree holds only the dialog.
  "/dialog.html": page(`
    <h1 id="bg-heading">Background heading</h1>
    <button id="bg-button">Background action</button>
    <dialog id="modal" aria-label="Confirm">
      <h2>Delete this torrent?</h2>
      <button id="ok">OK</button>
    </dialog>
    <script>document.getElementById("modal").showModal();</script>`),

  "/aria.html": page(`
    <button id="toggle" aria-pressed="true">Notify me</button>
    <button id="off" aria-pressed="false">Unnotify</button>
    <div id="checkbox" role="checkbox" aria-checked="true" tabindex="0">My list</div>
    <button id="expanded" aria-expanded="false">More</button>
    <button id="delete" disabled>Delete</button>`),

  "/form-post.html": page(`
    <form id="rec" method="post" action="/recommend/action">
      <input type="hidden" name="title" value="603">
      <button id="submit" type="submit">Recommend</button>
    </form>`),

  "/script-post.html": page(`
    <button id="send">Send</button>
    <p id="status">idle</p>
    <script>
      document.getElementById("send").addEventListener("click", async () => {
        try {
          await fetch("/recommend/action", { method: "POST", body: "title=603" });
          document.getElementById("status").textContent = "sent";
        } catch {
          document.getElementById("status").textContent = "blocked";
        }
      });
    </script>`),

  "/covered.html": page(`
    <button id="covered">Covered</button>
    <div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.1)"></div>`),

  // 2000px of spacer puts #deep below a 400px viewport, so only a scroll can reach it.
  "/tall.html": page(`
    <div style="height:1500px"></div>
    <a id="deep" href="/deep-click" style="display:block;width:120px;height:40px;background:#cdc">Deep target</a>
    <div style="height:500px"></div>`),

  "/tall-covered.html": page(`
    <div style="height:1500px"></div>
    <button id="deep" style="display:block;width:120px;height:40px">Deep target</button>
    <div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.1)"></div>`),
};

const DONE = page('<div id="done">saved</div>');
const JSON_DATA = { ok: true, nested: { value: 5 } };

function respond(res, { status = 200, type = "text/html; charset=utf-8", body = "" }) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

async function handle(req, res, log) {
  const url = new URL(req.url, "http://127.0.0.1");
  log.push({ method: req.method, path: url.pathname });

  if (req.method === "POST") {
    // Drain the body so the connection can be reused; nothing here reads it.
    for await (const _chunk of req) { /* discard */ }
    if (url.pathname === "/recommend/action") return respond(res, { body: DONE });
    return respond(res, { status: 404, body: "not found" });
  }

  if (url.pathname === "/json/data") {
    return respond(res, { type: "application/json", body: JSON.stringify(JSON_DATA) });
  }
  if (url.pathname === "/json/error") {
    return respond(res, { status: 500, type: "application/json", body: JSON.stringify({ ok: false }) });
  }
  const html = PAGES[url.pathname];
  if (html) return respond(res, { body: html });
  return respond(res, { status: 404, body: "not found" });
}

/** Start the fixture on an ephemeral port. `log` holds every request the server received. */
export async function startFixtureServer() {
  const log = [];
  const server = createServer((req, res) => { handle(req, res, log).catch(() => respond(res, { status: 500 })); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    log,
    path: (name) => `http://127.0.0.1:${port}${name}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}
