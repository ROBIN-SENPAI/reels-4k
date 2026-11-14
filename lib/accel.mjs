// Finds the ffmpeg binaries and detects which hardware H.264 encoders really work on this PC.
// "Listed in ffmpeg" is not enough (e.g. NVENC is compiled in but fails without a new driver),
// so each candidate does a real test encode at 4K portrait size before it is offered.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Looks next to the program (./ffmpeg/ or same folder) first, then PATH.
export function tool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const base = path.dirname(process.execPath);
  for (const p of [path.join(base, exe), path.join(base, 'ffmpeg', exe), path.join(process.cwd(), exe)]) {
    if (fs.existsSync(p)) return p;
  }
  return name;
}

export function checkFfmpeg() {
  const r = spawnSync(tool('ffmpeg'), ['-version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? r.stdout.split('\n')[0] : null;
}

// Quality-based (constant quality) settings for each hardware encoder.
const CANDIDATES = [
  { id: 'h264_qsv', name: 'Intel Quick Sync', args: (q) => ['-c:v', 'h264_qsv', '-preset', 'slow', '-global_quality', String(q), '-look_ahead', '0', '-profile:v', 'high'] },
  { id: 'h264_nvenc', name: 'NVIDIA NVENC', args: (q) => ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(q), '-b:v', '0', '-profile:v', 'high'] },
  { id: 'h264_amf', name: 'AMD AMF', args: (q) => ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q), '-qp_b', String(q)] },
];

function testEncoder(c) {
  return new Promise((resolve) => {
    const p = spawn(tool('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=2160x3840:r=30:d=0.3',
      '-frames:v', '4', '-pix_fmt', 'yuv420p', ...c.args(20), '-f', 'null', '-'], { stdio: 'ignore' });
    const timer = setTimeout(() => { p.kill(); resolve(false); }, 25000);
    p.on('error', () => { clearTimeout(timer); resolve(false); });
    p.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

// Returns the list of working GPU encoders (first = preferred).
export async function detectEncoders() {
  const listed = spawnSync(tool('ffmpeg'), ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '';
  const found = [];
  for (const c of CANDIDATES) {
    if (listed.includes(c.id) && (await testEncoder(c))) found.push(c);
  }
  return found;
}
