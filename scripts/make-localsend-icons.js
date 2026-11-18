/**
 * 生成 PWA 图标（PNG），避免引入图形库依赖。
 * 图案：emerald 圆角方块 + 白色向下箭头（表示「上传 / 发送」）。
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 画一个 RGBA 像素画布 */
function createCanvas(size) {
  const data = Buffer.alloc(size * size * 4);
  return {
    size,
    data,
    set(x, y, r, g, b, a) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      const i = (y * size + x) * 4;
      // 简单 alpha 混合
      const sa = a / 255;
      const da = data[i + 3] / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) return;
      data[i] = Math.round((r * sa + data[i] * da * (1 - sa)) / outA);
      data[i + 1] = Math.round((g * sa + data[i + 1] * da * (1 - sa)) / outA);
      data[i + 2] = Math.round((b * sa + data[i + 2] * da * (1 - sa)) / outA);
      data[i + 3] = Math.round(outA * 255);
    },
  };
}

/** 圆角矩形内部判定（带 1px 抗锯齿过渡） */
function inRoundedRect(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  return Math.sqrt(dx * dx + dy * dy) <= radius;
}

function drawIcon(size) {
  const c = createCanvas(size);
  const s = size;
  const radius = s * 0.22;
  const bg = [16, 185, 129]; // emerald-500
  const fg = [15, 23, 42]; // slate-900

  // 圆角方块背景
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      if (!inRoundedRect(x + 0.5, y + 0.5, s, radius)) continue;
      c.set(x, y, bg[0], bg[1], bg[2], 255);
    }
  }

  // 向下箭头：竖杆 + 三角头
  const shaftW = s * 0.14;
  const shaftX = (s - shaftW) / 2;
  const shaftTop = s * 0.24;
  const shaftBottom = s * 0.56;
  for (let y = Math.round(shaftTop); y < shaftBottom; y++) {
    for (let x = Math.round(shaftX); x < Math.round(shaftX + shaftW); x++) {
      c.set(x, y, fg[0], fg[1], fg[2], 255);
    }
  }
  const headTop = s * 0.52;
  const headBottom = s * 0.76;
  const headHalf = s * 0.24;
  for (let y = Math.round(headTop); y < headBottom; y++) {
    const t = (y - headTop) / (headBottom - headTop);
    const half = headHalf * (1 - t);
    for (let x = Math.round(s / 2 - half); x < Math.round(s / 2 + half); x++) {
      c.set(x, y, fg[0], fg[1], fg[2], 255);
    }
  }
  return c;
}

function encodePng(canvas) {
  const { size, data } = canvas;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    data.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'src', 'localsend', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const buf = encodePng(drawIcon(size));
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), buf);
  console.log(`icon-${size}.png ${buf.length} bytes`);
}
// 站点图标（浏览器标签页）
fs.writeFileSync(path.join(__dirname, '..', 'src', 'localsend', 'favicon.png'), encodePng(drawIcon(64)));
console.log('favicon.png written');
