// Loads bundled files: from the single-file executable (node:sea) or from disk in dev mode.
import fs from 'node:fs';
import path from 'node:path';
import sea from 'node:sea';
import { fileURLToPath } from 'node:url';

export function asset(name) {
  if (sea.isSea()) return Buffer.from(sea.getAsset(name));
  return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', name));
}
