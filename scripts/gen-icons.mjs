import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../public/icons');

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (width * 4 + 1);
    raw[rowOffset] = 0;
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, rowOffset + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function insideRoundRect(x, y, left, top, right, bottom, r) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = x < left + r ? left + r : x > right - r ? right - r : x;
  const cy = y < top + r ? top + r : y > bottom - r ? bottom - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const mix = (a, b, t) => a + (b - a) * t;

function render(size) {
  const ss = 4;
  const S = size * ss;
  const hi = new Float32Array(S * S * 4);

  const margin = S * 0.035;
  const radius = S * 0.235;
  const glowX = S * 0.78;
  const glowY = S * 0.18;
  const glowR = S * 0.58;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!insideRoundRect(x + 0.5, y + 0.5, margin, margin, S - margin, S - margin, radius)) continue;
      const u = x / S;
      const v = y / S;
      let r = mix(24, 9, v * 0.85 + u * 0.15);
      let g = mix(32, 28, v * 0.8);
      let b = mix(42, 30, v * 0.75);
      const d = Math.hypot(x - glowX, y - glowY) / glowR;
      const glow = clamp01(1 - d) ** 2 * 0.55;
      r = mix(r, 66, glow);
      g = mix(g, 201, glow);
      b = mix(b, 170, glow);
      const i = (y * S + x) * 4;
      hi[i] = r;
      hi[i + 1] = g;
      hi[i + 2] = b;
      hi[i + 3] = 255;
    }
  }

  const bars = [
    { x: 0.21, y: 0.475, w: 0.58, h: 0.076, color: [248, 250, 248] },
    { x: 0.21, y: 0.625, w: 0.4, h: 0.076, color: [141, 232, 211] },
  ];

  for (const bar of bars) {
    const l = bar.x * S;
    const t = bar.y * S;
    const r = (bar.x + bar.w) * S;
    const bm = (bar.y + bar.h) * S;
    const br = (bar.h / 2) * S;
    for (let y = Math.floor(t); y < Math.ceil(bm); y++) {
      for (let x = Math.floor(l); x < Math.ceil(r); x++) {
        if (!insideRoundRect(x + 0.5, y + 0.5, l, t, r, bm, br)) continue;
        const i = (y * S + x) * 4;
        hi[i] = bar.color[0];
        hi[i + 1] = bar.color[1];
        hi[i + 2] = bar.color[2];
        hi[i + 3] = 255;
      }
    }
  }

  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const i = ((y * ss + sy) * S + (x * ss + sx)) * 4;
          const alpha = hi[i + 3] / 255;
          a += alpha;
          r += hi[i] * alpha;
          g += hi[i + 1] * alpha;
          b += hi[i + 2] * alpha;
        }
      }
      const n = ss * ss;
      const o = (y * size + x) * 4;
      if (a === 0) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      } else {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return encodePng(out, size, size);
}

export async function generateIcons() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    await writeFile(path.join(OUT_DIR, `icon${size}.png`), render(size));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateIcons();
  console.log('Icons written to public/icons');
}
