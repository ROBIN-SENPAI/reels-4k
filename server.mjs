// Local app server: the UI runs in its own app window and talks to this server.
// Listens on 127.0.0.1 only (nothing is exposed to the network, nothing leaves your PC).
// Protection: Host check, cross-site check, strict CSP, and a random per-launch API token.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { upscale, probeVideo, planSize, STRENGTHS, SPEEDS, HDR_TONEMAP } from './lib/upscale.mjs';
import { detectEncoders, checkFfmpeg, tool } from './lib/accel.mjs';
import { getCredit, APP_NAME, VERSION, assertCredit } from './lib/credit.mjs';
import { asset } from './lib/assets.mjs';

const MAX_BYTES = 4 * 1024 ** 3;
const esc = (t) => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
// Footer HTML built only from the verified credit.
const footer = (c) => [c.a, c.b].map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener"><b>${esc(p.name)}</b></a> <span>${esc(p.url.replace(/^https?:\/\//, ''))}</span>`).join('<i></i>');
const CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Opens the UI as a standalone app window (Edge/Chrome --app mode, no tabs or address bar); falls back to the default browser.
function openAppWindow(link) {
  if (process.platform !== 'win32') return;
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const rel = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe'];
  for (const r of rel) for (const base of pf) {
    const exe = path.join(base, r);
    if (fs.existsSync(exe)) { spawn(exe, [`--app=${link}`, '--window-size=1240,780', '--no-first-run'], { stdio: 'ignore', detached: true }).unref(); return; }
  }
  spawn('cmd', ['/c', 'start', '', link], { stdio: 'ignore', detached: true }).unref();
}

export function runServer({ open = false } = {}) {
  assertCredit();
  const PORT = Number(process.env.PORT) || 4400;
  const WORK = process.env.REELS4K_WORK || path.join(os.tmpdir(), 'reels4k-work');
  const TOKEN = crypto.randomBytes(18).toString('hex');
  fs.mkdirSync(WORK, { recursive: true });
  // Remove leftovers older than 24 h from earlier runs.
  for (const d of fs.readdirSync(WORK)) {
    const p = path.join(WORK, d);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 864e5) fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }

  const ffmpegVersion = checkFfmpeg();
  let encoders = [];                  // verified GPU encoders (filled in the background at start)
  const detecting = ffmpegVersion ? detectEncoders().then((e) => { encoders = e; }).catch(() => {}) : Promise.resolve();

  const jobs = new Map();             // id -> { dir, input, name, info, state, progress, error, output, abort }
  let lastPing = 0;                   // the UI pings while its window is open; the app exits some time after the window is closed
  let busy = null;                    // only one encode at a time: it is heavy on a laptop
  const idOk = (id) => /^[0-9a-f-]{36}$/.test(id || '');
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

  // Preview frame (JPEG) from the middle of a video: mode thumb | full | crop (100% crop for A/B compare).
  function frame(res, j, which, mode) {
    const src = which === 'out' ? j.output : j.input;
    const t = target(j);
    const cw = Math.min(720, t.width), ch = Math.min(450, t.height);
    const cx = Math.floor((t.width - cw) / 4) * 2, cy = Math.floor((t.height - ch) / 4) * 2;
    const tm = j.info.hdr && which === 'in' ? HDR_TONEMAP.join(',') + ',' : '';
    const vf = mode === 'thumb' ? `${tm}scale=-2:72`
      : mode === 'crop' ? (which === 'in' ? `${tm}scale=${t.width}:${t.height}:flags=bicubic,crop=${cw}:${ch}:${cx}:${cy}` : `crop=${cw}:${ch}:${cx}:${cy}`)
        : `${tm}scale=1280:-2`;
    const p = spawn(tool('ffmpeg'), ['-v', 'error', '-ss', String(j.info.duration / 2), '-i', src, '-frames:v', '1', '-vf', `${vf},format=yuvj420p`, '-q:v', '2', '-f', 'mjpeg', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
    p.stdout.pipe(res);
    res.on('close', () => p.kill());
  }
  const target = (j) => planSize(j.info.width, j.info.height);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    // Block other websites from reaching the server (DNS rebinding / cross-site requests).
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return json(res, 403, { error: 'forbidden' });
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: 'forbidden' });
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        assertCredit();
        const html = asset('index.html').toString('utf8').replaceAll('{{FOOTER}}', footer(getCredit())).replaceAll('{{APP}}', APP_NAME).replaceAll('{{TOKEN}}', TOKEN).replaceAll('{{VERSION}}', VERSION);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/logo.svg') {
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' });
        return res.end(asset('logo.svg'));
      }
      if (url.pathname.startsWith('/api/')) {
        const t = req.headers['x-token'] || url.searchParams.get('t') || '';
        if (t.length !== TOKEN.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN))) return json(res, 401, { error: 'unauthorized' });
      }
      if (req.method === 'POST' && url.pathname === '/api/ping') { lastPing = Date.now(); return json(res, 200, { ok: true }); }
      if (req.method === 'GET' && url.pathname === '/api/caps') {
        await detecting;
        return json(res, 200, { ffmpeg: ffmpegVersion, gpu: encoders.map((e) => e.name), threads: os.cpus().length });
      }
      if (req.method === 'PUT' && url.pathname === '/api/upload') {
        if (!ffmpegVersion) return json(res, 500, { error: 'ffmpeg was not found. Put ffmpeg.exe and ffprobe.exe next to this program or install them on PATH.' });
        if (Number(req.headers['content-length'] || 0) > MAX_BYTES) return json(res, 413, { error: 'File too large (max 4 GB).' });
        const id = crypto.randomUUID();
        const dir = path.join(WORK, id);
        fs.mkdirSync(dir);
        const name = path.basename(url.searchParams.get('name') || 'video.mp4');
        const input = path.join(dir, 'input' + (path.extname(name).replace(/[^.\w]/g, '') || '.mp4'));
        await pipeline(req, fs.createWriteStream(input));
        let info;
        try { info = probeVideo(input); } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); return json(res, 400, { error: e.message }); }
        const tg = planSize(info.width, info.height);
        jobs.set(id, { dir, input, name, info, state: 'uploaded', progress: 0 });
        return json(res, 200, { id, info, target: tg, tooBig: tg.scale <= 1.001 });
      }
      if (req.method === 'GET' && url.pathname === '/api/frame') {
        const id = url.searchParams.get('id'), which = url.searchParams.get('which') === 'out' ? 'out' : 'in';
        const j = idOk(id) && jobs.get(id);
        if (!j || (which === 'out' && j.state !== 'done')) return json(res, 404, { error: 'not ready' });
        return frame(res, j, which, url.searchParams.get('mode'));
      }
      if (req.method === 'POST' && url.pathname === '/api/start') {
        const j = jobs.get(url.searchParams.get('id'));
        if (!j) return json(res, 404, { error: 'unknown id' });
        if (busy) return json(res, 409, { error: 'Another video is being processed. Wait for it to finish.' });
        const q = url.searchParams;
        const strength = STRENGTHS[q.get('strength')] ? q.get('strength') : 'normal';
        const speed = SPEEDS[q.get('speed')] ? q.get('speed') : 'turbo';
        j.abort = new AbortController();
        j.output = path.join(j.dir, 'output-4k.mp4');
        j.state = 'running'; j.progress = 0; j.error = null; j.t0 = Date.now();
        try {
          const job = upscale(j.input, j.output, { strength, speed, hw: encoders[0] || null, signal: j.abort.signal, onProgress: (f) => { j.progress = f; } });
          j.encoder = job.encoder;
          busy = j;
          job.done.then((r) => { j.state = 'done'; j.result = r; j.progress = 1; j.secs = (Date.now() - j.t0) / 1000; })
            .catch((e) => { j.state = j.abort.signal.aborted ? 'cancelled' : 'error'; j.error = e.message; })
            .finally(() => { busy = null; });
        } catch (e) { j.state = 'error'; j.error = e.message; }
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/cancel') {
        jobs.get(url.searchParams.get('id'))?.abort?.abort();
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/job') {
        const j = jobs.get(url.searchParams.get('id'));
        if (!j) return json(res, 404, { error: 'unknown id' });
        const elapsed = j.t0 ? (Date.now() - j.t0) / 1000 : 0;
        return json(res, 200, { state: j.state, progress: j.progress, error: j.error, result: j.result, secs: j.secs, encoder: j.encoder,
          eta: j.state === 'running' && j.progress > 0.05 ? elapsed * (1 - j.progress) / j.progress : null });
      }
      if (req.method === 'GET' && url.pathname === '/api/download') {
        const id = url.searchParams.get('id');
        const j = idOk(id) && jobs.get(id);
        if (!j || j.state !== 'done') return json(res, 404, { error: 'not ready' });
        const base = path.parse(j.name).name.replace(/[^\w .-]/g, '_') + '-4k.mp4';
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': fs.statSync(j.output).size,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(base)}` });
        return fs.createReadStream(j.output).pipe(res);
      }
      if (req.method === 'POST' && url.pathname === '/api/clear') {
        const id = url.searchParams.get('id');
        const j = idOk(id) && jobs.get(id);
        if (j && j.state !== 'running') { fs.rmSync(j.dir, { recursive: true, force: true }); jobs.delete(id); }
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) { if (!res.headersSent) json(res, 500, { error: e.message }); else res.destroy(); }
  });

  setInterval(() => { if (lastPing && !busy && Date.now() - lastPing > (Number(process.env.REELS4K_IDLE_MS) || 150000)) { console.log('Window closed. Exiting.'); process.exit(0); } }, 10000).unref();
  const link = `http://localhost:${PORT}`;
  const launch = () => { if (open && !process.env.REELS4K_NO_OPEN) openAppWindow(link); };
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { console.log(`${APP_NAME} is already running at ${link}`); launch(); setTimeout(() => process.exit(0), 500); }
    else { console.error(e.message); process.exit(1); }
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`${APP_NAME} ${VERSION} | ${getCredit().meta}\nRunning at ${link}  (close this window or press Ctrl+C to stop)`);
    if (!ffmpegVersion) console.log('WARNING: ffmpeg not found. Put ffmpeg.exe and ffprobe.exe next to this program or on PATH.');
    launch();
  });
}
