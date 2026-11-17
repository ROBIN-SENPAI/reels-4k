// Cloud flow with a FAKE kaggle CLI (test/fake-kaggle.cjs): no real Kaggle account is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudCaps, prepareForCloud, runCloud } from '../lib/cloud.mjs';
import { probeVideo, upscale, planSize } from '../lib/upscale.mjs';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-kaggle.cjs');

test('cloud flow end to end with a fake kaggle CLI', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4k-cloud-'));
  process.env.KAGGLE_CLI = fake; process.env.FAKE_KAGGLE_DIR = path.join(dir, 'state');
  const src = path.join(dir, 'in.mp4');
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=540x960:r=30:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', src]).status, 0);
  const caps = await cloudCaps();
  assert.equal(caps.available, true); assert.equal(caps.user, 'tester');
  const info = probeVideo(src), size = planSize(info.width, info.height);
  const prepared = path.join(dir, 'prepared.mp4');
  await prepareForCloud(src, prepared, info);
  const phases = [];
  const cloudVideo = await runCloud({ bin: caps.bin, user: caps.user, preparedVideo: prepared, outW: size.width, outH: size.height, workDir: dir, onPhase: (t) => phases.push(t) });
  assert.ok(fs.existsSync(cloudVideo)); assert.ok(phases.length >= 2);
  const out = path.join(dir, 'out.mp4');
  await upscale(src, out, { speed: 'balanced', cloudVideo }).done;
  const o = probeVideo(out);
  assert.equal(o.width, 1080); assert.equal(o.height, 1920); assert.ok(o.hasAudio);
  const calls = fs.readFileSync(path.join(dir, 'state', 'calls.log'), 'utf8');
  assert.match(calls, /kernels delete/); assert.match(calls, /datasets delete/);   // remote cleanup happened
  fs.rmSync(dir, { recursive: true, force: true });
});
