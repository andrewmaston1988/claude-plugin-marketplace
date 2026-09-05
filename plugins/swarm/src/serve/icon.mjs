// The home-screen icon, rasterised here because iOS wants a PNG apple-touch-icon
// and Android wants PNG manifest icons, and a plugin ships no image library.
// The mark is the dashboard's own rail: three nodes fanning into one.
import { deflateSync } from "node:zlib";

const BG = [0x10, 0x12, 0x19];
const OK = [0x4f, 0xc9, 0x8a];
const ACCENT = [0x8e, 0x7f, 0xf2];
const INK = [0xe7, 0xe9, 0xf1];

// Crockford-style CRC-32 table; node:zlib's crc32 exists only on newer Nodes.
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

// Geometry in unit space (0..1); rasterised with 3×3 supersampling.
const mark = (s) => {
  const nodes = [
    { x: 0.28, y: 0.30, r: 0.075, c: OK },
    { x: 0.50, y: 0.30, r: 0.075, c: ACCENT },
    { x: 0.72, y: 0.30, r: 0.075, c: OK },
    { x: 0.50, y: 0.74, r: 0.095, c: INK },
  ];
  // Lanes: outer nodes curve into the centre lane; the centre lane runs straight.
  const bez = (p0, p1, p2, p3, t) => {
    const u = 1 - t;
    return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]];
  };
  const polyline = (pts) => pts.slice(1).map((p, i) => [pts[i], p]);
  const curve = (x0) => polyline(Array.from({ length: 24 }, (_, i) => bez([x0, 0.30], [x0, 0.55], [0.50, 0.50], [0.50, 0.74], i / 23)));
  const lanes = [
    { segs: curve(0.28), w: 0.045, c: ACCENT },
    { segs: curve(0.72), w: 0.045, c: ACCENT },
    { segs: [[[0.50, 0.30], [0.50, 0.74]]], w: 0.045, c: ACCENT },
  ];
  return { nodes, lanes, radius: 0.22 * s };
};

const distSeg = (px, py, [ax, ay], [bx, by]) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

export function renderIconPng(size) {
  const { nodes, lanes, radius } = mark(size);
  const SS = 3;
  const px = Buffer.alloc(size * size * 4);
  const sample = (x, y) => {
    // rounded-square background
    const rx = Math.max(0, Math.abs(x - size / 2) - (size / 2 - radius));
    const ry = Math.max(0, Math.abs(y - size / 2) - (size / 2 - radius));
    if (Math.hypot(rx, ry) > radius) return null;
    const ux = x / size, uy = y / size;
    for (const n of nodes) if (Math.hypot(ux - n.x, uy - n.y) <= n.r) return n.c;
    for (const l of lanes) for (const seg of l.segs) if (distSeg(ux, uy, seg[0], seg[1]) <= l.w / 2) return l.c;
    return BG;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
      }
      const i = (y * size + x) * 4;
      if (a) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; px[i + 3] = (255 * a) / (SS * SS); }
    }
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const ICON_SIZES = [180, 192, 512];
