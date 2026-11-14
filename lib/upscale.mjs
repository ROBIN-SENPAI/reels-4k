// Core of Reels4K: probe a video, plan the 4K size, run ffmpeg safely.
// Used by both cli.mjs and server.mjs. Plain Node, needs ffmpeg + ffprobe.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CREDIT, APP_NAME, assertCredit } from './credit.mjs';
import { buildMarkPng, markGeometry, verifyMark } from './watermark.mjs';
import { tool } from './accel.mjs';

// Sharpness presets (measured in the README): hqdn3d = light denoise, unsharp = luma-only sharpen.
export const STRENGTHS = {
  soft:   { dn: null,              sharp: 0.4 },
  normal: { dn: '0.8:0.6:2.0:2.0', sharp: 0.7 },
  strong: { dn: '1.2:1.0:3.0:3.0', sharp: 1.0 },
};
// Speed presets. "turbo" uses a verified GPU encoder when there is one.
export const SPEEDS = {
  turbo:    { label: 'Turbo (GPU encoder)', x264: { preset: 'veryfast', crf: 21 }, hwQ: 19 },
  balanced: { label: 'Balanced',            x264: { preset: 'medium',   crf: 19 } },
  max:      { label: 'Max quality',         x264: { preset: 'slow',     crf: 17 } },
};

export function probeVideo(file) {
  const p = spawnSync(tool('ffprobe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (p.error) throw new Error('ffprobe not found. Put ffmpeg.exe and ffprobe.exe next to this program or on PATH.');
  if (p.status !== 0) throw new Error('Not a readable video file.');
  const info = JSON.parse(p.stdout);
  const v = info.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = info.streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('No video stream found.');
  // Phones store portrait video as landscape + rotation metadata; ffmpeg auto-rotates, so swap here too.
  const rot = Math.abs(Number(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0)) % 180;
  const [w, h] = rot === 90 ? [v.height, v.width] : [v.width, v.height];
  const rate = v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate;
  const [n, d] = rate.split('/').map(Number);
  const trc = v.color_transfer || '';
  return {
    width: w, height: h, fps: n / (d || 1), duration: Number(info.format.duration) || Number(v.duration) || 0,
    codec: v.codec_name, pixFmt: v.pix_fmt, hasAudio: !!a, audioCodec: a?.codec_name,
    hdr: trc === 'arib-std-b67' || trc === 'smpte2084',
  };
}

// 4K for social video: short side -> 2160, but the long side never exceeds 3840.
//   9:16 1080x1920 -> 2160x3840 | 4:5 1080x1350 -> 2160x2700 | 16:9 1920x1080 -> 3840x2160
export function planSize(w, h) {
  const scale = Math.min(2160 / Math.min(w, h), 3840 / Math.max(w, h));
  const even = (x) => Math.round(x / 2) * 2;
  return { scale, width: even(w * scale), height: even(h * scale) };
}

// Phone videos are variable frame rate; snap to a normal constant rate.
function cleanFps(fps) {
  const near = [24, 25, 30, 50, 60].find((c) => Math.abs(c - fps) < 0.6);
  return near ?? Math.min(60, Math.max(15, Math.round(fps)));
}

// Filter graph: [0:v] = video, [1:v] = copyright mark PNG.
function buildGraph(info, size, strength) {
  const s = STRENGTHS[strength] || STRENGTHS.normal;
  const g = markGeometry(size.width, size.height);
  const f = [];
  // HDR (iPhone HLG etc.) -> SDR bt709 so colours don't look washed out on TikTok/Instagram.
  if (info.hdr) {
    f.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p');
  }
  if (s.dn) f.push(`hqdn3d=${s.dn}`);                                             // light denoise BEFORE scaling
  f.push(`scale=${size.width}:${size.height}:flags=lanczos+accurate_rnd+full_chroma_int`);
  f.push(`unsharp=5:5:${s.sharp}:3:3:0`);                                           // luma-only sharpen AFTER scaling
  return `[0:v]${f.join(',')}[base];` +
    '[1:v]format=rgba,split=2[a][b];[a]colorchannelmixer=aa=0.92[m1];[b]colorchannelmixer=aa=0.4[m2];' +
    `[base][m1]overlay=x=${g.main.x}:y=${g.main.y}:format=auto[t];` +
    `[t][m2]overlay=x=${g.second.x}:y=${g.second.y}:format=auto,setsar=1,format=yuv420p[v]`;
}

// Runs the upscale. Writes to "<output>.part.mp4" and renames only after ffmpeg exits 0
// and the copyright mark is verified, so a broken file never carries the final name.
// opts: { strength, speed, hw (encoder from detectEncoders or null), threads, onProgress(fraction), signal }
export function upscale(input, output, opts = {}) {
  assertCredit();
  const info = probeVideo(input);
  const size = planSize(info.width, info.height);
  if (size.scale <= 1.001) throw new Error(`Video is already ${info.width}x${info.height}; nothing to upscale to 4K.`);
  const speed = SPEEDS[opts.speed] || SPEEDS.turbo;
  const useHw = !!(opts.hw && speed.hwQ);
  const threads = opts.threads || Math.max(1, Math.min(6, os.cpus().length - 2));
  const tmp = `${output}.part.mp4`;
  const markFile = `${output}.mark.png`;
  const mark = buildMarkPng(size.width, size.height);
  fs.writeFileSync(markFile, mark.png);
  const fps = cleanFps(info.fps);
  const venc = useHw ? opts.hw.args(speed.hwQ)
    : ['-c:v', 'libx264', '-profile:v', 'high', '-preset', speed.x264.preset, '-crf', String(speed.x264.crf), '-threads', String(threads)];
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-progress', 'pipe:1', '-nostats',
    '-i', input, '-i', markFile, '-filter_complex', buildGraph(info, size, opts.strength),
    '-map', '[v]', ...(info.hasAudio ? ['-map', '0:a:0'] : []),
    ...venc, '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-r', String(fps), '-fps_mode', 'cfr', '-map_metadata', '-1',
    '-metadata', `copyright=(c) ${CREDIT}`, '-metadata', `comment=Upscaled with ${APP_NAME} by ${CREDIT}`,
    // AAC audio is copied untouched (perfect sync); anything else becomes AAC 192k.
    ...(info.hasAudio ? (info.audioCodec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']) : ['-an']),
    '-movflags', '+faststart', '-f', 'mp4', '-y', tmp];

  const ffmpeg = tool('ffmpeg');
  const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '', buf = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      const m = l.match(/^out_time_us=(\d+)/);
      if (m && info.duration) opts.onProgress?.(Math.min(1, Number(m[1]) / 1e6 / info.duration));
    }
  });
  const cancel = () => child.kill();
  opts.signal?.addEventListener('abort', cancel);

  const done = new Promise((resolve, reject) => {
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', cancel);
      fs.rmSync(markFile, { force: true });
      const bad = (msg) => { if (!process.env.REELS4K_KEEP_FAILED) fs.rmSync(tmp, { force: true }); reject(new Error(msg)); };
      if (code !== 0) return bad(opts.signal?.aborted ? 'Cancelled.' : `ffmpeg failed (code ${code}): ${err.trim().slice(-400)}`);
      if (!verifyMark(ffmpeg, tmp, info.duration, size.width, size.height, mark.fillCount)) {
        return bad('Integrity check failed: the copyright mark is missing from the output.');
      }
      fs.renameSync(tmp, output);
      resolve({ output, size: fs.statSync(output).size, ...size, fps, encoder: useHw ? opts.hw.name : 'x264 (CPU)' });
    });
  });
  return { info, size, done, encoder: useHw ? opts.hw.name : 'x264 (CPU)' };
}
