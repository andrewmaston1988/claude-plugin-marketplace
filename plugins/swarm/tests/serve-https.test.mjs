// The dashboard's https surface: the CA route, with and without TLS, and the
// maskable icons Chrome needs to mint a WebAPK whose icon fills the launcher.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { inflateSync } from "node:zlib";
import { ensureTls } from "../src/serve/tls-ca.mjs";
import { cfg, seedHome, withServer } from "./helpers/serve-fixture.mjs";

function iconPixels(png) {
  const size = png.readUInt32BE(16);
  const chunks = [];
  for (let i = 8; i < png.length;) {
    const length = png.readUInt32BE(i);
    if (png.toString("ascii", i + 4, i + 8) === "IDAT") chunks.push(png.subarray(i + 8, i + 8 + length));
    i += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  return { size, pixel: (x, y) => raw.subarray(y * (size * 4 + 1) + 1 + x * 4, y * (size * 4 + 1) + 5 + x * 4) };
}

test("CA route with HTTP follows ordinary token and not-found handling", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ get }) => assert.equal((await get("/swarm-ca.crt")).status, 404));
    await withServer({ home, cfg: cfg({ token: "secret" }) }, async ({ get }) => assert.equal((await get("/swarm-ca.crt")).status, 401));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("CA route serves the root over HTTPS without the dashboard token", async () => {
  const { home } = seedHome();
  try {
    const tls = ensureTls({ home, names: ["127.0.0.1"] });
    await withServer({ home, cfg: cfg({ token: "secret" }), seams: { tls } }, async ({ port }) => {
      const result = await new Promise((resolve, reject) => {
        https.get({ host: "127.0.0.1", port, path: "/swarm-ca.crt", ca: tls.caCertPem }, (res) => {
          const chunks = []; res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body: Buffer.concat(chunks).toString() }));
        }).on("error", reject);
      });
      assert.equal(result.status, 200);
      assert.equal(result.type, "application/x-x509-ca-cert");
      assert.equal(result.body, tls.caCertPem);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("manifest declares ordinary and maskable icons", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ get }) => {
      const { body } = await get("/manifest.webmanifest");
      for (const size of [192, 512]) for (const purpose of ["any", "maskable"]) {
        assert.ok(body.icons.some((i) => i.src === `/icon-${purpose === "maskable" ? "maskable-" : ""}${size}.png` && i.sizes === `${size}x${size}` && i.type === "image/png" && i.purpose === purpose), `${size} ${purpose}`);
      }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("maskable icon route returns a 512 PNG", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ port }) => {
      const result = await new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: "/icon-maskable-512.png" }, (res) => {
          const chunks = []; res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body: Buffer.concat(chunks) }));
        }).on("error", reject);
      });
      assert.equal(result.status, 200);
      assert.equal(result.type, "image/png");
      assert.deepEqual([...result.body.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(result.body.readUInt32BE(16), 512);
      assert.equal(result.body.readUInt32BE(20), 512);
      const ordinaryPng = await new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: "/icon-512.png" }, (res) => {
          const chunks = []; res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        }).on("error", reject);
      });
      const maskable = iconPixels(result.body);
      const ordinary = iconPixels(ordinaryPng);
      for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) assert.equal(maskable.pixel(x, y)[3], 255, `alpha at ${x},${y}`);
      for (const [x, y] of [[256, 154], [256, 256], [256, 379]]) assert.deepEqual(maskable.pixel(x, y), ordinary.pixel(x, y), `mark at ${x},${y}`);
      assert.equal(ordinary.pixel(0, 0)[3], 0);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
