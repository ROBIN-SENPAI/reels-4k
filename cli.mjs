// Command line mode.
//   reels4k <video> [out.mp4] [--strength soft|normal|strong] [--speed turbo|balanced|max] [--no-gpu] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { upscale, STRENGTHS, SPEEDS } from './lib/upscale.mjs';
import { detectEncoders, checkFfmpeg } from './lib/accel.mjs';
import { CREDIT, APP_NAME, assertCredit } from './lib/credit.mjs';

const USAGE = 'Usage: reels4k <video> [out.mp4] [--strength soft|normal|strong] [--speed turbo|balanced|max] [--no-gpu] [--force]';

export async function runCli(args) {
  const fail = (m) => { console.error(`error: ${m}`); process.exit(1); };
  const opts = { strength: 'normal', speed: 'turbo' };
  let force = false, gpu = true;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--strength') opts.strength = args[++i];
    else if (a === '--speed') opts.speed = args[++i];
    else if (a === '--force') force = true;
    else if (a === '--no-gpu') gpu = false;
    else if (a.startsWith('-')) fail(`Unknown option ${a}\n${USAGE}`);
    else pos.push(a);
  }
  if (!pos.length || pos.length > 2) fail(USAGE);
  if (!STRENGTHS[opts.strength]) fail('--strength must be soft, normal or strong');
  if (!SPEEDS[opts.speed]) fail('--speed must be turbo, balanced or max');
  try { assertCredit(); } catch (e) { fail(e.message); }
  if (!checkFfmpeg()) fail('ffmpeg not found. Put ffmpeg.exe and ffprobe.exe next to this program or on PATH.');

  const input = path.resolve(pos[0]);
  if (!fs.existsSync(input)) fail(`Input not found: ${input}`);
  const p = path.parse(input);
  const output = path.resolve(pos[1] || path.join(p.dir, `${p.name}-4k.mp4`));
  if (output.toLowerCase() === input.toLowerCase()) fail('Output must differ from input.');
  if (fs.existsSync(output) && !force) fail(`Output exists: ${output} (use --force)`);

  try {
    console.log(`${APP_NAME} by ${CREDIT}`);
    const hw = gpu && opts.speed === 'turbo' ? (await detectEncoders())[0] : null;
    const t0 = Date.now();
    const job = upscale(input, output, { ...opts, hw, onProgress: (f) => process.stdout.write(`\r${(f * 100).toFixed(1)}%   `) });
    console.log(`${job.info.width}x${job.info.height} @ ${job.info.fps.toFixed(2)}fps -> ${job.size.width}x${job.size.height}` +
      ` | ${opts.strength}, ${SPEEDS[opts.speed].label}, encoder: ${job.encoder}${job.info.hdr ? ' | HDR -> SDR' : ''}`);
    const r = await job.done;
    console.log(`\nDone: ${r.output}\n${(r.size / 1048576).toFixed(1)} MiB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  } catch (e) { fail(e.message); }
}
