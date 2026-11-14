// Copyright credit of this tool. It is burned into every output video (see watermark.mjs),
// written into the file metadata, and shown in the app. Several parts of the program check
// this value, so editing it makes the tool refuse to run.
import crypto from 'node:crypto';

export const CREDIT = 'SENPAI ACADEMY - ROBIN';
export const APP_NAME = 'Reels4K';
const CREDIT_SHA256 = '69a83db85593cb099b71767aa1901b8b66c1646b289760f64e9cfdbd10b76f49';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function assertCredit() {
  if (sha256(CREDIT) !== CREDIT_SHA256) {
    throw new Error('Integrity check failed: the copyright credit was modified. This copy of the tool will not run.');
  }
}
