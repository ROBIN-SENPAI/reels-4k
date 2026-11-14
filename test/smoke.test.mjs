// Run: node --test test/   (needs ffmpeg for the video tests)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSize, probeVideo, upscale } from '../lib/upscale.mjs';
import { getCredit } from '../lib/credit.mjs';
import { buildMarkPng, markPlacement } from '../lib/watermark.mjs';

test('planSize: 9:16, 4:5, 16:9, already-4K', () => {
  assert.deepEqual(planSize(1080, 1920), { scale: 2, width: 2160, height: 3840 });
  assert.equal(planSize(1080, 1350).width, 2160); assert.equal(planSize(1080, 1350).height, 2700);
  assert.equal(planSize(1920, 1080).width, 3840);
  assert.ok(planSize(3840, 2160).scale <= 1.001);
});
test('credit is verified and contains both lines', () => {
  const c = getCredit();
  assert.match(c.a.mark, /^ROBIN ABU IBRAHIM - T\.ME\//); assert.match(c.b.mark, /^SENPAI ACADEMY - T\.ME\//);
});
test('watermark PNG is generated and stays inside the frame', () => {
  const p = markPlacement(2160, 3840);
  assert.ok(p.a.x >= 0 && p.a.y >= 0 && p.b.x + p.b.w <= 2160 && p.b.y + p.b.h <= 3840);
  const m = buildMarkPng(p.a.text, 2160, 3840);
  assert.equal(m.png.subarray(1, 4).toString(), 'PNG'); assert.ok(m.fillCount > 1000);
});
test('end to end: 1080x1920 clip -> 2160x3840 with audio kept, mark verified', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4k-test-'));
  const src = path.join(dir, 'in.mp4'), out = path.join(dir, 'out.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', src]);
  assert.equal(r.status, 0);
  const job = upscale(src, out, { speed: 'balanced', strength: 'normal' });
  await job.done;
  const info = probeVideo(out);
  assert.equal(info.width, 2160); assert.equal(info.height, 3840); assert.ok(info.hasAudio); assert.ok(Math.abs(info.duration - 2) < 0.1);
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-']).status, 0);
  assert.throws(() => upscale(out, path.join(dir, 'x.mp4'), {}), /already/);
  fs.rmSync(dir, { recursive: true, force: true });
});
