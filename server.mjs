// Local web app: drag a video in the browser, get a 4K version back.
// Listens on 127.0.0.1 only (nothing is exposed to the network, nothing leaves your PC).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { upscale, probeVideo, planSize, STRENGTHS, SPEEDS } from './lib/upscale.mjs';
import { detectEncoders, checkFfmpeg } from './lib/accel.mjs';
import { CREDIT, APP_NAME, assertCredit } from './lib/credit.mjs';
import { asset } from './lib/assets.mjs';

const MAX_BYTES = 4 * 1024 ** 3;

export function runServer({ open = false } = {}) {
  assertCredit();
  const PORT = Number(process.env.PORT) || 4400;
  const WORK = process.env.REELS4K_WORK || path.join(os.tmpdir(), 'reels4k-work');
  fs.mkdirSync(WORK, { recursive: true });
  // Remove leftovers older than 24 h from earlier runs.
  for (const d of fs.readdirSync(WORK)) {
    const p = path.join(WORK, d);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 864e5) fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }

  const ffmpegVersion = checkFfmpeg();
  let encoders = [];                  // verified GPU encoders (filled in the background at start)
  let detecting = ffmpegVersion ? detectEncoders().then((e) => { encoders = e; }).catch(() => {}) : Promise.resolve();

  const jobs = new Map();             // id -> { dir, input, name, info, state, progress, error, output, abort }
  let busy = null;                    // only one encode at a time: it is heavy on a laptop
  const idOk = (id) => /^[0-9a-f-]{36}$/.test(id || '');
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    // Block other websites from calling the API (DNS rebinding / cross-site requests).
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return json(res, 403, { error: 'forbidden' });
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        assertCredit();
        const html = asset('index.html').toString('utf8').replaceAll('{{CREDIT}}', CREDIT).replaceAll('{{APP}}', APP_NAME);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
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
        const target = planSize(info.width, info.height);
        jobs.set(id, { dir, input, name, info, state: 'uploaded', progress: 0 });
        return json(res, 200, { id, info, target, tooBig: target.scale <= 1.001 });
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
          eta: j.state === 'running' && j.progress > 0.01 ? elapsed * (1 - j.progress) / j.progress : null });
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

  const link = `http://localhost:${PORT}`;
  const openBrowser = () => { if (open && !process.env.REELS4K_NO_OPEN && process.platform === 'win32') spawn('cmd', ['/c', 'start', '', link], { stdio: 'ignore', detached: true }).unref(); };
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { console.log(`${APP_NAME} is already running at ${link}`); openBrowser(); setTimeout(() => process.exit(0), 500); }
    else { console.error(e.message); process.exit(1); }
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`${APP_NAME} by ${CREDIT}\nRunning at ${link}  (close this window or press Ctrl+C to stop)`);
    if (!ffmpegVersion) console.log('WARNING: ffmpeg not found. Put ffmpeg.exe and ffprobe.exe next to this program or on PATH.');
    openBrowser();
  });
}
