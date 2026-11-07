// Swarm's own local CA and dashboard leaf certificate, with zero npm
// dependencies. Node can generate keys, sign and parse X.509 but has no API to
// CREATE a certificate, so TBSCertificate is hand-encoded here.
//
// Every certificate is explicitly v3: DER omits the version field for v1,
// extensions are illegal in v1, and BoringSSL (Chrome/Android) rejects a
// v1-with-extensions cert that OpenSSL would happily accept.
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DAY = 86_400_000;
const CA_DAYS = 3650;
const LEAF_DAYS = 397;
const RENEW_BEFORE_DAYS = 30;

// ---------------------------------------------------------------- DER encoder

function lengthBytes(n) {
  if (n < 0x80) return Buffer.from([n]);
  const out = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Buffer.from([0x80 | out.length, ...out]);
}

function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lengthBytes(body.length), body]);
}

const seq = (...parts) => der(0x30, ...parts);
const set = (...parts) => der(0x31, ...parts);
const utf8 = (s) => der(0x0c, Buffer.from(s, "utf8"));
const octet = (b) => der(0x04, b);
const bool = (v) => der(0x01, Buffer.from([v ? 0xff : 0x00]));
const ctx = (n, constructed, b) => der((constructed ? 0xa0 : 0x80) | n, b);

function int(value) {
  let body;
  if (Buffer.isBuffer(value)) {
    body = value;
  } else {
    const bytes = [];
    for (let v = value; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
    body = Buffer.from(bytes.length ? bytes : [0]);
  }
  // A high bit would read as a negative integer; DER pads with 0x00.
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return der(0x02, body);
}

// `unused` is explicit because DER demands the trailing zero bits be dropped.
const bitString = (bytes, unused = 0) => der(0x03, Buffer.from([unused]), bytes);

function oid(dotted) {
  const arcs = dotted.split(".").map(Number);
  const out = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return der(0x06, Buffer.from(out));
}

const pad2 = (n) => String(n).padStart(2, "0");

function time(date) {
  const y = date.getUTCFullYear();
  const tail = `${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;
  // RFC 5280: UTCTime through 2049, GeneralizedTime from 2050.
  if (y < 2050) return der(0x17, Buffer.from(`${pad2(y % 100)}${tail}`, "ascii"));
  return der(0x18, Buffer.from(`${y}${tail}`, "ascii"));
}

// --------------------------------------------------------------- X.509 pieces

const OID_CN = "2.5.4.3";
const OID_O = "2.5.4.10";
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SAN = "2.5.29.17";
const OID_SKI = "2.5.29.14";
const OID_AKI = "2.5.29.35";
const OID_NAME_CONSTRAINTS = "2.5.29.30";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

const distinguishedName = (cn) => seq(set(seq(oid(OID_CN), utf8(cn))), set(seq(oid(OID_O), utf8("swarm (andrewmaston1988)"))));

// { tag, start (content offset), length, end } for one TLV.
function readTlv(buf, offset) {
  const tag = buf[offset];
  let len = buf[offset + 1];
  let start = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + i];
    start += n;
  }
  return { tag, start, length: len, end: start + len };
}

// RFC 5280 method 1: SHA-1 over the subjectPublicKey BIT STRING contents.
function keyId(spkiDer) {
  const spki = readTlv(spkiDer, 0);
  const algorithm = readTlv(spkiDer, spki.start);
  const bits = readTlv(spkiDer, algorithm.end);
  return createHash("sha1").update(spkiDer.subarray(bits.start + 1, bits.end)).digest();
}

const extension = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octet(value));

// The only names the root may ever vouch for. A stolen ca.key cannot fake a
// public site: Chrome, Windows and OpenSSL refuse any leaf outside these.
const PERMITTED_DNS = ["local", "localhost"];
const PERMITTED_IPV4 = [[[10, 0, 0, 0], 8], [[172, 16, 0, 0], 12], [[192, 168, 0, 0], 16], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8]];

const maskOf = (bits) => [0, 1, 2, 3].map((i) => (0xff << (8 - Math.min(8, Math.max(0, bits - 8 * i)))) & 0xff);

function permitted(name) {
  if (isIPv4(name)) {
    const ip = name.split(".").map(Number);
    return PERMITTED_IPV4.some(([net, bits]) => maskOf(bits).every((m, i) => (ip[i] & m) === net[i]));
  }
  return PERMITTED_DNS.some((d) => name === d || name.endsWith(`.${d}`));
}

const nameConstraints = () => seq(ctx(0, true, Buffer.concat([
  ...PERMITTED_DNS.map((d) => seq(der(0x82, Buffer.from(d, "ascii")))),
  ...PERMITTED_IPV4.map(([net, bits]) => seq(der(0x87, Buffer.from([...net, ...maskOf(bits)])))),
])));

const caExtensions = (ski) => seq(
  extension(OID_BASIC_CONSTRAINTS, true, seq(bool(true), int(0))),
  extension(OID_NAME_CONSTRAINTS, true, nameConstraints()),
  // bit 5 keyCertSign + bit 6 cRLSign
  extension(OID_KEY_USAGE, true, bitString(Buffer.from([0x06]), 1)),
  extension(OID_SKI, false, octet(ski)),
);

const leafExtensions = (ski, aki, sans) => seq(
  extension(OID_BASIC_CONSTRAINTS, false, seq()),
  // bit 0 digitalSignature
  extension(OID_KEY_USAGE, true, bitString(Buffer.from([0x80]), 7)),
  extension(OID_EXT_KEY_USAGE, false, seq(oid(OID_SERVER_AUTH))),
  extension(OID_SAN, false, seq(...sans)),
  extension(OID_SKI, false, octet(ski)),
  extension(OID_AKI, false, seq(ctx(0, false, aki))),
);

function buildCertificate({ subject, issuer, spki, signingKey, serial, notBefore, notAfter, extensions }) {
  const algorithm = seq(oid(OID_ECDSA_SHA256));
  const tbs = seq(
    ctx(0, true, int(2)), // [0] EXPLICIT version v3
    int(serial),
    algorithm,
    issuer,
    seq(time(notBefore), time(notAfter)),
    subject,
    spki,
    ctx(3, true, extensions), // [3] EXPLICIT Extensions
  );
  return seq(tbs, algorithm, bitString(sign("sha256", tbs, signingKey)));
}

function toPem(derBytes, label) {
  const b64 = derBytes.toString("base64");
  return `-----BEGIN ${label}-----\n${(b64.match(/.{1,64}/g) || [b64]).join("\n")}\n-----END ${label}-----\n`;
}

function newSerial() {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] & 0x7f) || 1; // positive and non-leading-zero
  return bytes;
}

// ------------------------------------------------------------ names and SANs

const isIPv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split(".").every((p) => Number(p) <= 255);

// The SAN covers everything the launcher prints plus the loopback names a PC
// browser uses — minus any name outside the CA's constraints (a public IP),
// which would otherwise make the whole leaf invalid rather than just that name.
function expandNames(names, permits = permitted) {
  const out = [];
  const add = (n) => {
    const v = String(n).toLowerCase();
    if (v && permits(v) && !out.includes(v)) out.push(v);
  };
  for (const n of names) add(n);
  add("localhost");
  add("127.0.0.1");
  return out;
}

const sanEntries = (names) => names.map((n) =>
  isIPv4(n) ? der(0x87, Buffer.from(n.split(".").map(Number))) : der(0x82, Buffer.from(n, "ascii")));

const bareHost = (names) => {
  const local = names.map((n) => /^([^.]+)\.local$/i.exec(n)).find(Boolean);
  if (local) return local[1].toLowerCase();
  const dns = names.find((n) => !isIPv4(n));
  return (dns || "localhost").toLowerCase();
};

// ------------------------------------------------------------- files and keys

function writeAtomic(file, data, mode, rename) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode); // writeFileSync's mode only applies when the file is created
  rename(tmp, file);
}

const asTime = (now) => (typeof now === "function" ? now() : now);

function loadCa(dir) {
  try {
    const certPem = readFileSync(join(dir, "ca.crt"), "utf8");
    const keyPem = readFileSync(join(dir, "ca.key"), "utf8");
    const cert = new X509Certificate(certPem);
    const key = createPrivateKey(keyPem);
    if (!cert.checkPrivateKey(key)) return null;
    return { certPem, keyPem, cert, key, spki: cert.publicKey.export({ type: "spki", format: "der" }) };
  } catch {
    // A key without its cert (or the reverse) is regenerated, never patched.
    return null;
  }
}

function createCa(dir, at, generate) {
  const { privateKey, publicKey } = generate("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const subject = distinguishedName("swarm dashboard CA");
  const derBytes = buildCertificate({
    subject,
    issuer: subject,
    spki,
    signingKey: privateKey,
    serial: newSerial(),
    notBefore: new Date(at - 60_000),
    notAfter: new Date(at + CA_DAYS * DAY),
    extensions: caExtensions(keyId(spki)),
  });
  const certPem = toPem(derBytes, "CERTIFICATE");
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  return { certPem, keyPem, cert: new X509Certificate(certPem), key: privateKey, spki };
}

function loadLeaf(dir, ca, names, at, permits) {
  try {
    const certPem = readFileSync(join(dir, "server.crt"), "utf8");
    const keyPem = readFileSync(join(dir, "server.key"), "utf8");
    const cert = new X509Certificate(certPem);
    const key = createPrivateKey(keyPem);
    const notAfter = Date.parse(cert.validTo);
    const usable = cert.checkPrivateKey(key)
      && cert.verify(ca.cert.publicKey)
      && notAfter - at > RENEW_BEFORE_DAYS * DAY
      && leafCovers(cert, names, permits);
    return usable ? { certPem, keyPem, cert, notAfter } : null;
  } catch {
    return null;
  }
}

function issueLeaf(ca, names, at, generate, permits) {
  const { privateKey, publicKey } = generate("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const sans = expandNames(names, permits);
  const derBytes = buildCertificate({
    subject: distinguishedName(`${bareHost(names)} swarm dashboard`),
    issuer: distinguishedName("swarm dashboard CA"),
    spki,
    signingKey: ca.key,
    serial: newSerial(),
    notBefore: new Date(at - 60_000),
    notAfter: new Date(at + LEAF_DAYS * DAY),
    extensions: leafExtensions(keyId(spki), keyId(ca.spki), sanEntries(sans)),
  });
  const certPem = toPem(derBytes, "CERTIFICATE");
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const cert = new X509Certificate(certPem);
  // Parse rather than reuse `at + LEAF_DAYS`: the stored value must match what
  // a later reuse-pass reads back from the PEM's second-precision validTo.
  return { certPem, keyPem, cert, notAfter: Date.parse(cert.validTo) };
}

// ----------------------------------------------------------------- public API

// Load or create ~/.swarm/tls/{ca,server}.{key,crt}; re-issue the leaf whenever
// it is missing, near expiry, missing a name, or chained to another CA.
// `now` may be a timestamp or a function returning one (cmd-serve passes Date.now).
export function ensureTls({ home, names, now = Date.now, _generateKeyPair = generateKeyPairSync, _renameSync = renameSync, _permits = permitted }) {
  const at = asTime(now);
  const dir = join(home, "tls");
  mkdirSync(dir, { recursive: true });

  let ca = loadCa(dir);
  const caCreated = !ca;
  if (!ca) {
    ca = createCa(dir, at, _generateKeyPair);
    writeAtomic(join(dir, "ca.key"), ca.keyPem, 0o600, _renameSync);
    writeAtomic(join(dir, "ca.crt"), ca.certPem, 0o644, _renameSync);
  }

  let leaf = loadLeaf(dir, ca, names, at, _permits);
  const leafIssued = !leaf;
  if (!leaf) {
    leaf = issueLeaf(ca, names, at, _generateKeyPair, _permits);
    writeAtomic(join(dir, "server.key"), leaf.keyPem, 0o600, _renameSync);
    writeAtomic(join(dir, "server.crt"), leaf.certPem, 0o644, _renameSync);
  }

  return {
    key: leaf.keyPem,
    cert: leaf.certPem,
    caCertPem: ca.certPem,
    caCreated,
    leafIssued,
    leafNotAfter: leaf.notAfter,
  };
}

// Does this certificate's SAN cover every name the dashboard answers to?
export function leafCovers(cert, names, permits = permitted) {
  const x509 = typeof cert === "string" ? new X509Certificate(cert) : cert;
  return expandNames(names, permits).every((n) => isIPv4(n) ? Boolean(x509.checkIP(n)) : Boolean(x509.checkHost(n)));
}

// Doctor's TLS row. `unknown` when a CA exists but no leaf has been issued yet;
// unknown never fails the run.
export function certStatus({ home, names, now = Date.now }) {
  const at = asTime(now);
  const dir = join(home, "tls");
  let caPem;
  try {
    caPem = readFileSync(join(dir, "ca.crt"), "utf8");
  } catch {
    return { status: "fail", detail: `no CA at ${join(dir, "ca.crt")} — start the dashboard with dashboard.https to create one` };
  }
  let leafPem;
  try {
    leafPem = readFileSync(join(dir, "server.crt"), "utf8");
  } catch {
    return { status: "unknown", detail: `CA present at ${join(dir, "ca.crt")}, no leaf issued yet — start the dashboard to issue one` };
  }
  let ca, leaf;
  try {
    ca = new X509Certificate(caPem);
    leaf = new X509Certificate(leafPem);
  } catch (e) {
    return { status: "fail", detail: `certificate unreadable: ${e.message}` };
  }
  const notAfter = Date.parse(leaf.validTo);
  if (!leaf.verify(ca.publicKey)) {
    return { status: "fail", detail: "the leaf is not signed by the current CA — restart the dashboard to re-issue it", notAfter };
  }
  if (notAfter <= at) {
    return { status: "fail", detail: `the leaf expired ${new Date(notAfter).toISOString()} — restart the dashboard to re-issue it`, notAfter };
  }
  if (!leafCovers(leaf, names)) {
    return { status: "fail", detail: "the leaf does not cover the current names — restart the dashboard to re-issue it", notAfter };
  }
  return {
    status: "pass",
    detail: `valid ${Math.floor((notAfter - at) / DAY)} days until ${new Date(notAfter).toISOString()}`,
    notAfter,
  };
}
