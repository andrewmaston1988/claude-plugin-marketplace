import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, statSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { X509Certificate, createPrivateKey } from "node:crypto";
import https from "node:https";
import { ensureTls, leafCovers, certStatus } from "../src/serve/tls-ca.mjs";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const LAN = ["192.168.1.20", "10.0.0.5"];
const NAMES = ["desktop-x.local", ...LAN];
const DAY = 86_400_000;
const tmpHome = () => mkdtempSync(join(tmpdir(), "swarm-tls-"));
const tlsDir = (home) => join(home, "tls");
const FILES = ["ca.key", "ca.crt", "server.key", "server.crt"];

function pemToDer(pem) {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
}

// Minimal TLV walker: { tag, start (content offset), length, end }.
function tlv(buf, off) {
  const tag = buf[off];
  let len = buf[off + 1];
  let start = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + i];
    start += n;
  }
  return { tag, start, length: len, end: start + len };
}

// X509Certificate exposes no version accessor, and OpenSSL accepts v1-with-
// extensions where BoringSSL does not — so the version is read from the DER.
function versionField(pem) {
  const der = pemToDer(pem);
  const cert = tlv(der, 0);          // Certificate ::= SEQUENCE
  const tbs = tlv(der, cert.start); // TBSCertificate ::= SEQUENCE
  assert.equal(tbs.tag, 0x30, "TBSCertificate is a SEQUENCE");
  const first = tlv(der, tbs.start);
  return { tag: first.tag, inner: der.subarray(first.start, first.end) };
}

function assertV3(pem, label) {
  const { tag, inner } = versionField(pem);
  assert.equal(tag, 0xa0, `${label}: TBSCertificate starts with [0] EXPLICIT`);
  assert.deepEqual([...inner], [0x02, 0x01, 0x02], `${label}: version INTEGER is 2 (v3)`);
}

// The extnValue bytes and critical flag of one extension, by its DER-encoded OID.
function extension(pem, oidHex) {
  const der = pemToDer(pem);
  const tbs = tlv(der, tlv(der, 0).start);
  let off = tbs.start;
  while (off < tbs.end) {
    const field = tlv(der, off);
    if (field.tag === 0xa3) {
      const exts = tlv(der, field.start);
      for (let e = exts.start; e < exts.end;) {
        const ext = tlv(der, e);
        const id = tlv(der, ext.start);
        let next = tlv(der, id.end);
        let critical = false;
        if (next.tag === 0x01) { critical = der[next.start] === 0xff; next = tlv(der, next.end); }
        if (der.subarray(id.start, id.end).toString("hex") === oidHex) {
          return { critical, value: der.subarray(next.start, next.end).toString("hex") };
        }
        e = ext.end;
      }
    }
    off = field.end;
  }
  return null;
}

function get(opts) {
  return new Promise((resolve) => {
    const req = https.get({ ...opts, rejectUnauthorized: true }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on("error", (e) => resolve({ error: e.code || e.message, message: e.message }));
  });
}

test("row 1: the CA is self-signed, has ca:true, its key matches, and both CA and leaf are v3", () => {
  const home = tmpHome();
  try {
    const t = ensureTls({ home, names: NAMES, now: NOW });
    const ca = new X509Certificate(t.caCertPem);
    const caKey = createPrivateKey(readFileSync(join(tlsDir(home), "ca.key"), "utf8"));
    assert.equal(ca.verify(ca.publicKey), true, "the CA verifies against its own key");
    assert.equal(ca.ca, true, "basicConstraints CA:TRUE");
    assert.equal(ca.checkPrivateKey(caKey), true, "ca.key matches ca.crt");
    const leaf = new X509Certificate(t.cert);
    assert.equal(leaf.verify(ca.publicKey), true, "the leaf verifies against the CA");
    assertV3(t.caCertPem, "CA");
    assertV3(t.cert, "leaf");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("row 1b: the CA is pathlen:0 and name-constrained to local names and private IPs; O names the publisher", () => {
  const home = tmpHome();
  try {
    const t = ensureTls({ home, names: NAMES, now: NOW });
    const bc = extension(t.caCertPem, "551d13");
    assert.equal(bc.critical, true, "basicConstraints is critical");
    assert.equal(bc.value, "30060101ff020100", "basicConstraints is CA:TRUE, pathlen:0");
    const nc = extension(t.caCertPem, "551d1e");
    assert.ok(nc, "the CA carries nameConstraints");
    assert.equal(nc.critical, true, "nameConstraints is critical");
    // permittedSubtrees [0]: dNSName local, localhost; iPAddress 10/8, 172.16/12, 192.168/16, 100.64/10, 127/8
    const hex = (s) => Buffer.from(s).toString("hex");
    const subtree = (gn) => `30${(gn.length / 2).toString(16).padStart(2, "0")}${gn}`;
    const dns = (s) => subtree(`82${s.length.toString(16).padStart(2, "0")}${hex(s)}`);
    const ip = (addr, mask) => subtree(`8708${Buffer.from([...addr, ...mask]).toString("hex")}`);
    const subtrees = [
      dns("local"), dns("localhost"),
      ip([10, 0, 0, 0], [255, 0, 0, 0]), ip([172, 16, 0, 0], [255, 240, 0, 0]), ip([192, 168, 0, 0], [255, 255, 0, 0]),
      ip([100, 64, 0, 0], [255, 192, 0, 0]), ip([127, 0, 0, 0], [255, 0, 0, 0]),
    ].join("");
    const permitted = `a0${(subtrees.length / 2).toString(16).padStart(2, "0")}${subtrees}`;
    assert.equal(nc.value, `30${(permitted.length / 2).toString(16).padStart(2, "0")}${permitted}`, "exact permitted subtrees");
    assert.match(new X509Certificate(t.caCertPem).subject, /O=swarm \(andrewmaston1988\)/);
    assert.match(new X509Certificate(t.cert).subject, /O=swarm \(andrewmaston1988\)/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("row 1c: a leaf naming a public host is refused by a real handshake, even with the CA trusted", async () => {
  const home = tmpHome();
  let server;
  try {
    // _permits lets the probe smuggle a public name past the SAN filter, so the
    // CA's own constraints are the only thing left to refuse it.
    const t = ensureTls({ home, names: ["example.com", "8.8.8.8"], now: NOW, _permits: () => true });
    assert.ok(new X509Certificate(t.cert).checkHost("example.com"), "the probe leaf really names example.com");
    server = https.createServer({ key: t.key, cert: t.cert }, (req, res) => { res.writeHead(200); res.end(); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const r = await get({ host: "127.0.0.1", port: server.address().port, path: "/", ca: t.caCertPem });
    assert.equal(r.status, undefined, `the handshake must fail, got ${JSON.stringify(r)}`);
    // Node surfaces OpenSSL's X509_V_ERR_PERMITTED_VIOLATION as code UNSPECIFIED; the message names it.
    assert.match(String(r.message), /permitted subtree violation/, `refused for the name constraint, got ${JSON.stringify(r)}`);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    rmSync(home, { recursive: true, force: true });
  }
});

test("row 1d: a leaf re-issued under a retained CA with a different subject still chains to it", async () => {
  // The fixture CA was issued by an earlier build (O=swarm, no constraints). The
  // leaf's issuer must be copied from the CA it is signed by, never rebuilt from
  // today's name format, or every upgrade breaks the chain at the next re-issue.
  const home = tmpHome();
  let server;
  try {
    const dir = tlsDir(home);
    mkdirSync(dir, { recursive: true });
    copyFileSync(new URL("./fixtures/tls-legacy-ca.crt", import.meta.url), join(dir, "ca.crt"));
    copyFileSync(new URL("./fixtures/tls-legacy-ca.key", import.meta.url), join(dir, "ca.key"));
    const t = ensureTls({ home, names: NAMES, now: NOW });
    assert.equal(t.caCreated, false, "the retained CA is reused, not replaced");
    const ca = new X509Certificate(t.caCertPem);
    assert.equal(new X509Certificate(t.cert).checkIssued(ca), true, "leaf issuer matches the retained CA's subject");
    server = https.createServer({ key: t.key, cert: t.cert }, (req, res) => { res.writeHead(200); res.end(); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const r = await get({ host: "127.0.0.1", port: server.address().port, path: "/", ca: t.caCertPem });
    assert.equal(r.status, 200, `a trusted handshake succeeds, got ${JSON.stringify(r)}`);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    rmSync(home, { recursive: true, force: true });
  }
});

test("row 2: the leaf covers the host, localhost, 127.0.0.1 and every LAN IPv4, and nothing outside the set", () => {
  const home = tmpHome();
  try {
    const t = ensureTls({ home, names: [...NAMES, "8.8.8.8"], now: NOW });
    const leaf = new X509Certificate(t.cert);
    for (const host of ["desktop-x.local", "localhost"]) {
      assert.ok(leaf.checkHost(host), `checkHost("${host}") matches`);
    }
    assert.equal(leaf.checkHost("desktop-x"), undefined, "the bare hostname is not a SAN: no name constraint can cover it");
    assert.equal(leaf.checkIP("8.8.8.8"), undefined, "a public IP is dropped from the SAN, not left to break the chain");
    assert.equal(leafCovers(leaf, [...NAMES, "8.8.8.8"]), true, "a dropped public name does not force a re-issue every start");
    for (const ip of ["127.0.0.1", ...LAN]) {
      assert.ok(leaf.checkIP(ip), `checkIP("${ip}") matches`);
    }
    assert.equal(leaf.checkIP("192.168.1.99"), undefined, "an IP outside the set does not match");
    assert.equal(leafCovers(leaf, NAMES), true, "leafCovers accepts the issued names");
    assert.equal(leafCovers(t.cert, [...NAMES, "192.168.1.99"]), false, "leafCovers rejects a new name");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("row 3: a real handshake returns 200 only when the client trusts the issued CA", async () => {
  const home = tmpHome();
  let server;
  try {
    const t = ensureTls({ home, names: NAMES, now: NOW });
    server = https.createServer({ key: t.key, cert: t.cert }, (req, res) => {
      if (req.url === "/manifest.webmanifest") {
        res.writeHead(200, { "content-type": "application/manifest+json" });
        res.end("{}");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    // IP connect, no SNI — the SAN iPAddress is what verifies the peer.
    const trusted = await get({ host: "127.0.0.1", port, path: "/manifest.webmanifest", ca: t.caCertPem });
    assert.equal(trusted.status, 200, "a client carrying the CA gets 200");
    const untrusted = await get({ host: "127.0.0.1", port, path: "/manifest.webmanifest" });
    assert.ok(
      ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN"].includes(untrusted.error),
      `a client without the CA is rejected, got ${JSON.stringify(untrusted)}`,
    );
  } finally {
    if (server) await new Promise((r) => server.close(r));
    rmSync(home, { recursive: true, force: true });
  }
});

test("row 4: ensureTls is idempotent — a second call with the same names and now reuses every file byte-for-byte", () => {
  const home = tmpHome();
  try {
    const a = ensureTls({ home, names: NAMES, now: NOW });
    const snapshot = () => FILES.map((f) => readFileSync(join(tlsDir(home), f)));
    const before = snapshot();
    const b = ensureTls({ home, names: NAMES, now: NOW });
    assert.equal(b.caCreated, false, "the CA is reused");
    assert.equal(b.leafIssued, false, "the leaf is reused");
    assert.deepEqual(snapshot(), before, "every file is untouched");
    assert.equal(b.key, a.key, "the same key PEM comes back");
    assert.equal(b.cert, a.cert, "the same cert PEM comes back");
    assert.equal(b.leafNotAfter, a.leafNotAfter, "the same expiry comes back");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("row 5a: the leaf is re-issued inside 30 days of expiry, and the CA is not regenerated", () => {
  const home = tmpHome();
  try {
    const first = ensureTls({ home, names: NAMES, now: NOW });
    const caBefore = readFileSync(join(tlsDir(home), "ca.crt"), "utf8");
    const second = ensureTls({ home, names: NAMES, now: first.leafNotAfter - 29 * DAY });
    assert.equal(second.caCreated, false, "no CA rotation");
    assert.equal(second.leafIssued, true, "the expiring leaf is re-issued");
    assert.equal(readFileSync(join(tlsDir(home), "ca.crt"), "utf8"), caBefore, "ca.crt is untouched");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("row 5b: adding a name re-issues the leaf, and the CA is not regenerated", () => {
  const home = tmpHome();
  try {
    ensureTls({ home, names: NAMES, now: NOW });
    const caBefore = readFileSync(join(tlsDir(home), "ca.crt"), "utf8");
    const next = ensureTls({ home, names: [...NAMES, "192.168.1.77"], now: NOW });
    assert.equal(next.caCreated, false, "no CA rotation");
    assert.equal(next.leafIssued, true, "the new name forces a re-issue");
    assert.ok(new X509Certificate(next.cert).checkIP("192.168.1.77"), "the new SAN is present");
    assert.equal(readFileSync(join(tlsDir(home), "ca.crt"), "utf8"), caBefore, "ca.crt is untouched");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("row 5c: replacing the CA re-issues the leaf against the new CA", () => {
  const home = tmpHome();
  const other = tmpHome();
  try {
    ensureTls({ home, names: NAMES, now: NOW });
    ensureTls({ home: other, names: NAMES, now: NOW });
    copyFileSync(join(tlsDir(other), "ca.key"), join(tlsDir(home), "ca.key"));
    copyFileSync(join(tlsDir(other), "ca.crt"), join(tlsDir(home), "ca.crt"));
    const next = ensureTls({ home, names: NAMES, now: NOW });
    assert.equal(next.caCreated, false, "the replaced CA files are reused");
    assert.equal(next.leafIssued, true, "the leaf no longer chains to the current CA");
    assert.equal(
      new X509Certificate(next.cert).verify(new X509Certificate(next.caCertPem).publicKey),
      true,
      "the re-issued leaf verifies against the new CA",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("row 6: files land at their final path only via rename, with no .tmp leftovers; key files are 0600", () => {
  const home = tmpHome();
  try {
    ensureTls({ home, names: NAMES, now: NOW });
    const dir = tlsDir(home);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no tmp leftovers");
    if (process.platform !== "win32") {
      for (const f of ["ca.key", "server.key"]) {
        assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, `${f} is 0600`);
      }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }

  // A direct write would leave a final-path file behind even when the rename
  // never happens; the tmp+rename contract leaves the final path untouched.
  const home2 = tmpHome();
  try {
    assert.throws(
      () => ensureTls({ home: home2, names: NAMES, now: NOW, _renameSync: () => { throw new Error("rename blocked"); } }),
      /rename blocked/,
    );
    for (const f of FILES) {
      assert.equal(existsSync(join(tlsDir(home2), f)), false, `${f} was never written in place`);
    }
  } finally { rmSync(home2, { recursive: true, force: true }); }
});

test("certStatus: pass for a fresh leaf, fail when there is no CA", () => {
  const home = tmpHome();
  try {
    const empty = certStatus({ home, names: NAMES, now: NOW });
    assert.equal(empty.status, "fail", "no CA yet");
    const t = ensureTls({ home, names: NAMES, now: NOW });
    const fresh = certStatus({ home, names: NAMES, now: NOW });
    assert.equal(fresh.status, "pass", "a fresh leaf covering the names passes");
    assert.equal(fresh.notAfter, t.leafNotAfter, "the status reports the leaf expiry");
    const stale = certStatus({ home, names: [...NAMES, "192.168.1.99"], now: NOW });
    assert.equal(stale.status, "fail", "an uncovered name fails");
    const expired = certStatus({ home, names: NAMES, now: t.leafNotAfter + DAY });
    assert.equal(expired.status, "fail", "an expired leaf fails");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
