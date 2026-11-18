// Draws the dashboard app icons (blue tile, white bolt — the sidebar logo) as PNGs for the PWA.
// Run: node scripts/make-icons.mjs  → client/public/icons/*.png
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const BLUE = [0x2b, 0x4b, 0xff];
const WHITE = [0xff, 0xff, 0xff];
// Lucide "zap" bolt on a 24-unit grid.
const BOLT = [[13, 2], [3, 14], [12, 14], [11, 22], [21, 10], [12, 10], [13, 2]];

function inside(x, y, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// maskable: the bolt sits in the middle 60% so Android can crop the tile into any shape.
function draw(size, { radius = 0.22, boltScale = 0.62 } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * radius;
  const off = (size - size * boltScale) / 2;
  const unit = (size * boltScale) / 24;
  const S = 4; // supersampling for smooth edges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const fx = x + (sx + 0.5) / S;
          const fy = y + (sy + 0.5) / S;
          const cx = Math.min(Math.max(fx, r), size - r);
          const cy = Math.min(Math.max(fy, r), size - r);
          if ((fx - cx) ** 2 + (fy - cy) ** 2 <= r * r) {
            bg += 1;
            if (inside((fx - off) / unit, (fy - off) / unit, BOLT)) fg += 1;
          }
        }
      }
      const a = bg / (S * S);
      const f = bg ? fg / bg : 0;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(BLUE[c] * (1 - f) + WHITE[c] * f);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, px);
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

const dir = new URL('../client/public/icons/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const size of [192, 512]) writeFileSync(new URL(`icon-${size}.png`, dir), draw(size));
writeFileSync(new URL('maskable-512.png', dir), draw(512, { radius: 0, boltScale: 0.5 }));
writeFileSync(new URL('apple-touch-icon.png', dir), draw(180, { radius: 0, boltScale: 0.56 }));
console.log('icons written');
