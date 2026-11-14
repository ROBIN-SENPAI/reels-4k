// Core of Reels4K: probe a video, plan the 4K size, run ffmpeg safely.
// Used by both cli.mjs and server.mjs. Plain Node, needs ffmpeg + ffprobe on PATH.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

// Sharpness presets. cas = Contrast Adaptive Sharpen (no halos on text/edges), dn = hqdn3d denoise strength.
export const STRENGTHS = {
  soft:   { cas: 0.25, dn: '0.8:0.6:1.5:1.5' },
  normal: { cas: 0.40, dn: '1.2:1.0:2.5:2.5' },
  strong: { cas: 0.60, dn: '1.8:1.4:3.5:3.5' },
};
// Speed/quality presets for libx264.
export const QUALITY = {
  fast:     { preset: 'medium', crf: 20 },
  balanced: { preset: 'slow',   crf: 18 },
  best:     { preset: 'slower', crf: 16 },
};

export function probeVideo(file) {
  const p = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (p.error) throw new Error('ffprobe not found. Install ffmpeg and add it to PATH.');
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
  const common = [24, 25, 30, 50, 60];
  const near = common.find((c) => Math.abs(c - fps) < 0.6);
  return near ?? Math.min(60, Math.max(15, Math.round(fps)));
}

export function buildFilter(info, size, strength) {
  const s = STRENGTHS[strength] || STRENGTHS.normal;
  const f = [];
  // HDR (iPhone HLG etc.) -> SDR bt709 so colours don't look washed out on TikTok/Instagram.
  if (info.hdr) {
    f.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv');
  }
  f.push(`hqdn3d=${s.dn}`);                                                    // light denoise BEFORE scaling
  f.push(`scale=${size.width}:${size.height}:flags=lanczos+accurate_rnd+full_chroma_int`);
  f.push(`cas=${s.cas}`);                                                      // sharpen AFTER scaling
  f.push('setsar=1', 'format=yuv420p');
  return f.join(',');
}

// Runs the upscale. Writes to "<output>.part.mp4" and renames only after ffmpeg exits 0,
// so an interrupted run can never leave a broken file with the final name.
// opts: { strength, quality, threads, onProgress(fraction), signal }
export function upscale(input, output, opts = {}) {
  const info = probeVideo(input);
  const size = planSize(info.width, info.height);
  if (size.scale <= 1.001) {
    throw new Error(`Video is already ${info.width}x${info.height}; nothing to upscale to 4K.`);
  }
  const q = QUALITY[opts.quality] || QUALITY.balanced;
  const threads = opts.threads || Math.max(1, Math.min(6, os.cpus().length - 2));
  const tmp = `${output}.part.mp4`;
  const fps = cleanFps(info.fps);
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-progress', 'pipe:1', '-nostats',
    '-i', input, '-map', '0:v:0', ...(info.hasAudio ? ['-map', '0:a:0'] : []),
    '-vf', buildFilter(info, size, opts.strength),
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', q.preset, '-crf', String(q.crf), '-threads', String(threads),
    '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-r', String(fps), '-fps_mode', 'cfr', '-map_metadata', '-1', '-metadata:s:v', 'rotate=0',
    // AAC audio is copied untouched (perfect sync); anything else becomes AAC 192k.
    ...(info.hasAudio ? (info.audioCodec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']) : ['-an']),
    '-movflags', '+faststart', '-f', 'mp4', '-y', tmp];

  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
      if (code === 0) {
        fs.renameSync(tmp, output);
        resolve({ output, size: fs.statSync(output).size, ...size, fps });
      } else {
        fs.rmSync(tmp, { force: true });
        reject(new Error(opts.signal?.aborted ? 'Cancelled.' : `ffmpeg failed (code ${code}): ${err.trim().slice(-400)}`));
      }
    });
  });
  return { info, size, done };
}
