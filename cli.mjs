#!/usr/bin/env node
// Command line: node cli.mjs <video> [output.mp4] [--strength soft|normal|strong] [--quality fast|balanced|best] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { upscale, STRENGTHS, QUALITY } from './lib/upscale.mjs';

const args = process.argv.slice(2);
const opts = { strength: 'normal', quality: 'balanced' };
let force = false;
const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--strength') opts.strength = args[++i];
  else if (a === '--quality') opts.quality = args[++i];
  else if (a === '--force') force = true;
  else if (a.startsWith('-')) fail(`Unknown option ${a}`);
  else pos.push(a);
}
if (!pos.length || pos.length > 2) fail('Usage: node cli.mjs <video> [output.mp4] [--strength soft|normal|strong] [--quality fast|balanced|best] [--force]');
if (!STRENGTHS[opts.strength]) fail('--strength must be soft, normal or strong');
if (!QUALITY[opts.quality]) fail('--quality must be fast, balanced or best');

const input = path.resolve(pos[0]);
if (!fs.existsSync(input)) fail(`Input not found: ${input}`);
const p = path.parse(input);
const output = path.resolve(pos[1] || path.join(p.dir, `${p.name}-4k.mp4`));
if (output.toLowerCase() === input.toLowerCase()) fail('Output must differ from input.');
if (fs.existsSync(output) && !force) fail(`Output exists: ${output} (use --force)`);

try {
  const t0 = Date.now();
  const job = upscale(input, output, {
    ...opts,
    onProgress: (f) => process.stdout.write(`\r${(f * 100).toFixed(1)}%   `),
  });
  console.log(`${job.info.width}x${job.info.height} @ ${job.info.fps.toFixed(2)}fps -> ${job.size.width}x${job.size.height}` +
    ` (${opts.strength}, ${opts.quality})${job.info.hdr ? ' [HDR -> SDR]' : ''}`);
  const r = await job.done;
  console.log(`\nDone: ${r.output}\n${(r.size / 1048576).toFixed(1)} MiB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} catch (e) { fail(e.message); }

function fail(m) { console.error(`error: ${m}`); process.exit(1); }
