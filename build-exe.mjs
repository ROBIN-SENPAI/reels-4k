// Builds dist/Reels4K.exe: a single Windows executable (Node single-executable-application).
// No npm packages needed. Steps: inline all modules into one CommonJS file, then `node --build-sea`.
//   node build-exe.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const ORDER = ['lib/credit.mjs', 'lib/watermark.mjs', 'lib/accel.mjs', 'lib/assets.mjs', 'lib/upscale.mjs', 'cli.mjs', 'server.mjs', 'main.mjs'];

const defaults = new Map();   // module -> default binding name
const named = new Map();      // module -> Set of named bindings
const bodies = [];
for (const f of ORDER) {
  const out = [];
  for (const line of fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r/g, '').split('\n')) {
    if (line.startsWith('#!')) continue;
    const imp = line.match(/^import (.+) from '(.+)';$/);
    if (imp) {
      if (imp[2].startsWith('.')) continue;                 // local module: inlined below
      const spec = imp[1].trim();
      if (spec.startsWith('{')) { const set = named.get(imp[2]) || new Set(); spec.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean).forEach((x) => set.add(x)); named.set(imp[2], set); }
      else defaults.set(imp[2], spec);
      continue;
    }
    if (/^import /.test(line)) throw new Error(`Unsupported import syntax in ${f}: ${line}`);
    out.push(line.replace(/^export (async function|function|const|let|class)/, '$1').replaceAll('import.meta.url', "'file:///'"));
  }
  bodies.push(`// ---- ${f} ----\n${out.join('\n')}`);
}
function hoistedLines() {
  const mods = new Set([...defaults.keys(), ...named.keys()]);
  return [...mods].map((m) => {
    const lines = [];
    if (defaults.has(m)) lines.push(`const ${defaults.get(m)} = require('${m}');`);
    if (named.has(m)) lines.push(`const { ${[...named.get(m)].join(', ')} } = require('${m}');`);
    return lines.join('\n');
  }).join('\n');
}
fs.mkdirSync(DIST, { recursive: true });
const bundle = path.join(DIST, 'bundle.cjs');
fs.writeFileSync(bundle, `'use strict';\n${hoistedLines()}\n${bodies.join('\n\n')}\n`);

const cfg = path.join(DIST, 'sea-config.json');
const exe = path.join(DIST, 'Reels4K.exe');
fs.writeFileSync(cfg, JSON.stringify({
  main: bundle, output: exe, disableExperimentalSEAWarning: true,
  assets: { 'index.html': path.join(ROOT, 'public', 'index.html') },
}, null, 2));
fs.rmSync(exe, { force: true });
const r = spawnSync(process.execPath, ['--build-sea', cfg], { stdio: 'inherit' });
if (r.status !== 0 || !fs.existsSync(exe)) { console.error('SEA build failed'); process.exit(1); }
console.log(`Built ${exe} (${(fs.statSync(exe).size / 1048576).toFixed(0)} MiB)`);
