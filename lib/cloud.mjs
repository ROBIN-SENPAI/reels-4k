// Cloud GPU mode: Real-ESRGAN on a free Kaggle GPU, driven by the official `kaggle` command-line tool.
// Flow: prepare video locally -> private Kaggle dataset -> GPU notebook -> download result -> (caller adds the
// copyright mark locally) -> delete the dataset and notebook from the Kaggle account again.
// Needs the kaggle CLI (pip install kaggle) already signed in (~/.kaggle). Nothing is downloaded by this program.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { tool } from './accel.mjs';
import { HDR_TONEMAP } from './upscale.mjs';

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('Cancelled.')); }, { once: true });
});

// Finds the kaggle executable: env KAGGLE_CLI, PATH, or the usual Python Scripts folders on Windows.
export function kaggleBin() {
  if (process.env.KAGGLE_CLI && fs.existsSync(process.env.KAGGLE_CLI)) return process.env.KAGGLE_CLI;
  const exe = process.platform === 'win32' ? 'kaggle.exe' : 'kaggle';
  const probe = spawnSync(exe, ['--version'], { encoding: 'utf8' });
  if (!probe.error && probe.status === 0) return exe;
  if (process.platform === 'win32') {
    for (const root of [path.join(process.env.APPDATA || '', 'Python'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python')]) {
      try {
        for (const d of fs.readdirSync(root)) {
          const p = path.join(root, d, 'Scripts', 'kaggle.exe');
          if (fs.existsSync(p)) return p;
        }
      } catch {}
    }
  }
  return null;
}

// Runs one kaggle CLI command. Resolves { code, out } (stdout+stderr), never rejects except on cancel.
// A .js/.mjs/.cjs path (used for tests with a fake CLI) is run through node.
const launch = (bin, args) => /.(c|m)?js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
function kg(bin, args, { cwd, signal } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(...launch(bin, args), { cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const kill = () => { p.kill(); reject(new Error('Cancelled.')); };
    signal?.addEventListener('abort', kill, { once: true });
    p.on('error', (e) => resolve({ code: -1, out: String(e.message) }));
    p.on('close', (code) => { signal?.removeEventListener('abort', kill); resolve({ code, out }); });
  });
}
// `kernels logs` prints a JSON array of {stream_name,data}; return the readable text without nbconvert noise.
function kernelLog(out) {
  let text = out;
  try { text = JSON.parse(out.slice(out.indexOf('['))).map((e) => e.data).join(''); } catch {}
  return text.split('\n').filter((l) => l.trim() && !/nbconvert|filter_links|SyntaxWarning|re\.sub\(|outdated .kaggle./i.test(l)).join('\n');
}
const clean = (s) => s.split('\n').filter((l) => !/outdated .kaggle. version/i.test(l)).join('\n').trim();

// { available, user, reason } - used by the UI to enable the cloud option.
export async function cloudCaps() {
  const bin = kaggleBin();
  if (!bin) return { available: false, reason: 'Kaggle CLI not found (pip install kaggle, then sign in).' };
  const r = await kg(bin, ['config', 'view']);
  const m = r.out.match(/username:\s*(\S+)/);
  if (!m || m[1] === 'None') return { available: false, reason: 'Kaggle CLI is not signed in.' };
  return { available: true, user: m[1], bin };
}

// Normalises the source for the cloud: auto-rotation, constant frame rate, SDR, 8-bit yuv420p, near-lossless H.264.
export function prepareForCloud(input, outFile, info, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const vf = [...(info.hdr ? [...HDR_TONEMAP, 'format=yuv420p'] : []), `scale=${info.width}:${info.height}:flags=bicubic`, 'format=yuv420p'].join(',');
    const fps = [24, 25, 30, 50, 60].find((c) => Math.abs(c - info.fps) < 0.6) ?? Math.min(60, Math.max(15, Math.round(info.fps)));
    const p = spawn(tool('ffmpeg'), ['-hide_banner', '-nostdin', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-i', input, '-map', '0:v:0', '-vf', vf,
      '-r', String(fps), '-fps_mode', 'cfr', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-f', 'mp4', '-y', outFile],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '', buf = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', (d) => {
      buf += d; const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) { const m = l.match(/^out_time_us=(\d+)/); if (m && info.duration) onProgress?.(Math.min(1, Number(m[1]) / 1e6 / info.duration)); }
    });
    signal?.addEventListener('abort', () => p.kill(), { once: true });
    p.on('close', (code) => code === 0 ? resolve(fps) : reject(new Error(signal?.aborted ? 'Cancelled.' : `Prepare failed: ${err.trim().slice(-300)}`)));
  });
}

// The notebook that runs on Kaggle's GPU(s). Reads job.json {outW,outH}, upscales every frame with Real-ESRGAN, one worker per GPU (fp16, channels_last)
// (realesr-general-x4v3 via the `spandrel` loader, no basicsr needed) and writes upscaled.mp4 (no audio).
const NOTEBOOK = `
import glob, json, os, queue, subprocess, sys, threading, time, urllib.request
def sh(cmd):
    print('+', cmd, flush=True); subprocess.check_call(cmd, shell=True)
sh(sys.executable + ' -m pip install -q spandrel imageio-ffmpeg')
import cv2, torch, torch.nn.functional as F, imageio_ffmpeg
from spandrel import ModelLoader
ndev = torch.cuda.device_count()
if ndev == 0:
    raise SystemExit('NO_GPU: enable the GPU accelerator for this notebook')
print('GPUs:', ndev, [torch.cuda.get_device_name(i) for i in range(ndev)], flush=True)
found = glob.glob('/kaggle/input/**/job.json', recursive=True)
print('input files:', found, flush=True)
if not found:
    for dp, dn, fn in os.walk('/kaggle/input'): print(dp, fn, flush=True)
    raise SystemExit('NO_INPUT: dataset not mounted')
root = found[0]
cfg = json.load(open(root)); base = os.path.dirname(root)
inp = [p for p in glob.glob(base + '/input.*')][0]
outW, outH = int(cfg['outW']), int(cfg['outH'])
wpath = '/kaggle/working/realesr-general-x4v3.pth'
urllib.request.urlretrieve('https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth', wpath)

# one model copy per GPU (fp16 + channels_last when supported)
models, half = [], False
for d in range(ndev):
    desc = ModelLoader().load_from_file(wpath)
    half = bool(getattr(desc, 'supports_half', False))
    m = desc.model.to('cuda:' + str(d)).eval()
    if half: m = m.half()
    models.append(m.to(memory_format=torch.channels_last))

cap = cv2.VideoCapture(inp)
fps = cap.get(cv2.CAP_PROP_FPS) or 30
total_guess = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
enc = subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', str(outW) + 'x' + str(outH),
    '-r', str(fps), '-i', '-', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '13', '-pix_fmt', 'yuv420p', '/kaggle/working/upscaled.mp4'],
    stdin=subprocess.PIPE)

inq = queue.Queue(maxsize=ndev * 3)
results, cond = {}, threading.Condition()
state = {'total': None, 'error': None}

def reader():
    n = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok: break
            inq.put((n, frame)); n += 1
    except Exception as e:
        state['error'] = repr(e)
    for _ in range(ndev): inq.put(None)
    with cond:
        state['total'] = n; cond.notify_all()

def worker(d):
    dev = torch.device('cuda:' + str(d)); m = models[d]
    try:
        with torch.cuda.device(d), torch.inference_mode():
            while True:
                item = inq.get()
                if item is None: break
                idx, frame = item
                t = torch.from_numpy(frame[:, :, ::-1].copy()).to(dev).permute(2, 0, 1).unsqueeze(0)
                t = ((t.half() if half else t.float()) / 255).contiguous(memory_format=torch.channels_last)
                o = F.interpolate(m(t), size=(outH, outW), mode='bicubic', antialias=True).clamp(0, 1)
                arr = (o[0].permute(1, 2, 0) * 255).round().byte().cpu().numpy()[:, :, ::-1]
                data = arr.tobytes()
                with cond:
                    results[idx] = data; cond.notify_all()
    except Exception as e:
        with cond:
            state['error'] = repr(e); cond.notify_all()

threads = [threading.Thread(target=reader, daemon=True)] + [threading.Thread(target=worker, args=(d,), daemon=True) for d in range(ndev)]
for th in threads: th.start()

nxt, t0 = 0, time.time()
while True:
    with cond:
        while nxt not in results and state['error'] is None and not (state['total'] is not None and nxt >= state['total']):
            cond.wait(timeout=5)
        if state['error'] is not None: raise SystemExit('WORKER_FAILED ' + state['error'])
        if state['total'] is not None and nxt >= state['total']: break
        data = results.pop(nxt)
    enc.stdin.write(data); nxt += 1
    if nxt % 25 == 0: print('frames', nxt, '/', total_guess, round(nxt / (time.time() - t0), 2), 'fps', flush=True)
enc.stdin.close(); rc = enc.wait()
if rc != 0 or nxt == 0: raise SystemExit('ENCODE_FAILED rc=' + str(rc) + ' frames=' + str(nxt))
json.dump({'frames': nxt, 'seconds': round(time.time() - t0, 1), 'gpus': ndev}, open('/kaggle/working/done.json', 'w'))
print('DONE', nxt, 'frames in', round(time.time() - t0, 1), 's on', ndev, 'GPU(s)', flush=True)
`;

// Runs the whole cloud job. onPhase(text, fraction) reports progress. Returns the path of the upscaled (no audio) video.
// Always deletes the dataset and notebook from the Kaggle account at the end.
export async function runCloud({ bin, user, preparedVideo, outW, outH, workDir, signal, onPhase, notebook = NOTEBOOK }) {
  const id = crypto.randomBytes(4).toString('hex');
  const slug = `reels4k-${id}`;
  const dsRef = `${user}/${slug}-in`, kRef = `${user}/${slug}-run`;
  const dsDir = path.join(workDir, 'k-data'), kDir = path.join(workDir, 'k-kernel'), outDir = path.join(workDir, 'k-out');
  for (const d of [dsDir, kDir, outDir]) fs.mkdirSync(d, { recursive: true });
  const made = { ds: false, kernel: false };
  try {
    onPhase('Uploading to your private Kaggle dataset', 0.1);
    fs.copyFileSync(preparedVideo, path.join(dsDir, 'input.mp4'));
    fs.writeFileSync(path.join(dsDir, 'job.json'), JSON.stringify({ outW, outH }));
    fs.writeFileSync(path.join(dsDir, 'dataset-metadata.json'), JSON.stringify({ title: `${slug}-in`, id: dsRef, licenses: [{ name: 'CC0-1.0' }] }));
    let r = await kg(bin, ['datasets', 'create', '-p', dsDir, '-q'], { signal });
    made.ds = true;
    if (r.code !== 0) throw new Error('Kaggle dataset upload failed: ' + clean(r.out).slice(-300));
    for (let i = 0; ; i++) {                                       // wait until the dataset is ready
      r = await kg(bin, ['datasets', 'status', dsRef], { signal });
      if (/ready/i.test(r.out)) break;
      if (/error|fail/i.test(r.out) || i > 120) throw new Error('Kaggle dataset did not become ready: ' + clean(r.out).slice(-200));
      await sleep(5000, signal);
    }

    onPhase('Starting the Kaggle GPU notebook', 0.2);
    fs.writeFileSync(path.join(kDir, 'run.py'), notebook);
    fs.writeFileSync(path.join(kDir, 'kernel-metadata.json'), JSON.stringify({
      id: kRef, title: `${slug}-run`, code_file: 'run.py', language: 'python', kernel_type: 'script', is_private: true,
      enable_gpu: true, enable_internet: true, dataset_sources: [dsRef], competition_sources: [], kernel_sources: [], model_sources: [],
    }, null, 2));
    r = await kg(bin, ['kernels', 'push', '-p', kDir], { signal });
    made.kernel = true;
    if (r.code !== 0 || /error/i.test(r.out) && !/successfully/i.test(r.out)) throw new Error('Kaggle notebook push failed: ' + clean(r.out).slice(-300));

    const t0 = Date.now();
    for (;;) {                                                      // wait for the notebook to finish
      await sleep(8000, signal);
      r = await kg(bin, ['kernels', 'status', kRef], { signal });
      const st = (r.out.match(/(COMPLETE|ERROR|CANCEL\w*|RUNNING|QUEUED|NEW)/i) || [''])[0].toUpperCase();
      const mins = Math.floor((Date.now() - t0) / 60000), secs = Math.floor((Date.now() - t0) / 1000) % 60;
      if (st === 'COMPLETE') break;
      if (st === 'ERROR' || st.startsWith('CANCEL')) {
        const lg = await kg(bin, ['kernels', 'logs', kRef], { signal });
        const text = kernelLog(lg.out);
        try { fs.writeFileSync(path.join(workDir, 'kaggle-log.txt'), text); } catch {}
        throw new Error(`Kaggle notebook ${st.toLowerCase()}: ` + text.slice(-1200));
      }
      onPhase(`${st === 'RUNNING' ? 'Processing on Kaggle GPU' : 'Waiting for a Kaggle GPU'} (${mins}:${String(secs).padStart(2, '0')})`, st === 'RUNNING' ? 0.5 : 0.25);
      if (Date.now() - t0 > 3 * 3600 * 1000) throw new Error('Kaggle job took longer than 3 hours; giving up.');
    }

    try { const lg = await kg(bin, ['kernels', 'logs', kRef], { signal }); fs.writeFileSync(path.join(workDir, 'kaggle-log.txt'), kernelLog(lg.out)); } catch {}   // kept for diagnostics / speed numbers
    onPhase('Downloading the result from Kaggle', 0.85);
    r = await kg(bin, ['kernels', 'output', kRef, '-p', outDir, '-o', '-q'], { signal });
    const result = path.join(outDir, 'upscaled.mp4');
    if (!fs.existsSync(result)) throw new Error('Kaggle finished but returned no video: ' + clean(r.out).slice(-300));
    return result;
  } finally {
    // best-effort cleanup of the Kaggle account (also when cancelled or failed)
    if (made.kernel) await kg(bin, ['kernels', 'delete', kRef, '-y']).catch(() => {});
    if (made.ds) await kg(bin, ['datasets', 'delete', dsRef, '-y']).catch(() => {});
  }
}
