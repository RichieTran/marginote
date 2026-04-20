// Generate Marginote toolbar icons (16/48/128 PNG) using Node built-ins only.
//
// Icons are solid-color squares with a thin inner bevel so the brand color
// reads at 16px. Re-run with `node assets/generate-icons.mjs` any time the
// palette changes.

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BRAND = { r: 0x11, g: 0x18, b: 0x27 }; // slate-900
const BEVEL = { r: 0xf9, g: 0xfa, b: 0xfb }; // gray-50

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function buildPng(size) {
  const bevel = Math.max(1, Math.round(size / 16));
  // Row: 1 filter byte + size * 3 RGB bytes
  const rowBytes = 1 + size * 3;
  const raw = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // no filter
    for (let x = 0; x < size; x++) {
      const onBevel =
        x < bevel || y < bevel || x >= size - bevel || y >= size - bevel;
      const c = onBevel ? BEVEL : BRAND;
      const off = rowStart + 1 + x * 3;
      raw[off] = c.r;
      raw[off + 1] = c.g;
      raw[off + 2] = c.b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = deflateSync(raw);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  const outPath = join(__dirname, `icon-${size}.png`);
  writeFileSync(outPath, buildPng(size));
  console.log('wrote', outPath);
}
