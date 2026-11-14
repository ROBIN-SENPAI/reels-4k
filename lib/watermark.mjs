// Builds the copyright mark as a PNG (pure Node: own 5x7 pixel font + PNG encoder, no fonts or
// image libraries needed) and checks that it really ended up in an output video.
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { CREDIT, sha256 } from './credit.mjs';

// 5x7 glyphs, only the characters the credit needs. The table is hashed (GLYPHS_SHA256).
const GLYPHS = {
  S: '.####|#....|#....|.###.|....#|....#|####.',
  E: '#####|#....|#....|####.|#....|#....|#####',
  N: '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#',
  P: '####.|#...#|#...#|####.|#....|#....|#....',
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#',
  I: '#####|..#..|..#..|..#..|..#..|..#..|#####',
  C: '.####|#....|#....|#....|#....|#....|.####',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  M: '#...#|##.##|#.#.#|#...#|#...#|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
  R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  '-': '.....|.....|.....|#####|.....|.....|.....',
  ' ': '.....|.....|.....|.....|.....|.....|.....',
};
const GLYPHS_SHA256 = '1496ea63bfbafd0a0284ec0678b869dd46b1c71ccd91b51700c4d5dd3eead047';
export const ORANGE = [255, 106, 0];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Mark geometry for an output of width outW (scales with the video so it is always readable).
export function markGeometry(outW, outH) {
  const s = Math.max(2, Math.round(outW / 540));       // pixel size of one font cell
  const o = Math.max(1, Math.round(s / 3));            // black outline thickness
  const cols = CREDIT.length * 6 - 1;
  const w = cols * s + 2 * o, h = 7 * s + 2 * o;
  const m = Math.round(Math.min(outW, outH) * 0.035);  // margin from the corner
  return { s, o, w, h, m, main: { x: m, y: m }, second: { x: outW - w - m, y: outH - h - m } };
}

export function buildMarkPng(outW, outH) {
  if (sha256(JSON.stringify(GLYPHS)) !== GLYPHS_SHA256) throw new Error('Integrity check failed: watermark font was modified.');
  const { s, o, w, h } = markGeometry(outW, outH);
  const fill = new Uint8Array(w * h);
  [...CREDIT].forEach((ch, i) => {
    const rows = GLYPHS[ch].split('|');
    rows.forEach((row, ry) => [...row].forEach((c, rx) => {
      if (c !== '#') return;
      for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) fill[(o + ry * s + dy) * w + o + (i * 6 + rx) * s + dx] = 1;
    }));
  });
  const out = Buffer.alloc(w * h * 4);
  let fillCount = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4;
    if (fill[y * w + x]) { out[p] = ORANGE[0]; out[p + 1] = ORANGE[1]; out[p + 2] = ORANGE[2]; out[p + 3] = 255; fillCount++; continue; }
    let near = false;                                   // black outline around orange pixels
    for (let dy = -o; dy <= o && !near; dy++) for (let dx = -o; dx <= o; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < h && xx >= 0 && xx < w && fill[yy * w + xx]) { near = true; break; }
    }
    if (near) out[p + 3] = 255;
  }
  return { png: encodePng(w, h, out), fillCount, ...markGeometry(outW, outH) };
}

// After encoding: grab the middle frame, cut out the main mark area and count orange pixels.
// If the mark is not there (pipeline tampered with), the output is rejected.
export function verifyMark(ffmpeg, file, durationSec, outW, outH, fillCount) {
  const g = markGeometry(outW, outH);
  const r = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(Math.max(0, durationSec / 2)), '-i', file, '-frames:v', '1',
    '-vf', `format=rgb24,crop=${g.w}:${g.h}:${g.main.x}:${g.main.y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  { maxBuffer: g.w * g.h * 3 + 1024 });
  if (r.status !== 0 || r.stdout.length < g.w * g.h * 3) return false;
  let hits = 0;
  for (let i = 0; i < g.w * g.h; i++) {
    const R = r.stdout[i * 3], G = r.stdout[i * 3 + 1], B = r.stdout[i * 3 + 2];
    if (R > 200 && G > 60 && G < 170 && B < 90) hits++;
  }
  return hits >= fillCount * 0.3;
}
