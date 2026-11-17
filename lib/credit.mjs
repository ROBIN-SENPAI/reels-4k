// Copyright credit of this tool, stored ENCRYPTED (AES-256-GCM) and SIGNED (Ed25519) in credit.data.mjs.
// It is decrypted and verified every time the app starts, serves a page, or processes a video; the
// burned-in video mark, the file metadata and the footer all come from the verified data only.
// Changing the text, the data or the signature makes the program refuse to run. The signing key is
// private (not in this repo), so a valid credit with different text cannot be produced.
import crypto from 'node:crypto';
import { KB, CREDIT_BLOB, CREDIT_SIG, CREDIT_PUB } from './credit.data.mjs';

export const APP_NAME = 'Reels4K';
export const VERSION = '1.2.0';
const KA = '5b1e0c7a93d24f86a7c1e45d90b3f2a8';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fail = () => { throw new Error('Integrity check failed: the copyright credit was modified. This copy of the tool will not run.'); };

let cache = null;
// Returns { a:{name,url,mark}, b:{name,url,mark}, meta } from the verified credit.
export function getCredit() {
  if (cache) return cache;
  try {
    const raw = Buffer.from(CREDIT_BLOB, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(KA + KB).digest(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
    const pub = crypto.createPublicKey({ key: Buffer.from(CREDIT_PUB, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, plain, pub, Buffer.from(CREDIT_SIG, 'base64'))) fail();
    const c = JSON.parse(plain.toString('utf8'));
    const mark = (p) => `${p.name} - ${p.url.replace(/^https?:\/\//, '').toUpperCase()}`;   // text burned into the video
    cache = { a: { ...c.a, mark: mark(c.a) }, b: { ...c.b, mark: mark(c.b) },
      meta: `(c) ${c.a.name} ${c.a.url} | ${c.b.name} ${c.b.url}` };
  } catch { fail(); }
  return cache;
}

export function assertCredit() { getCredit(); }
