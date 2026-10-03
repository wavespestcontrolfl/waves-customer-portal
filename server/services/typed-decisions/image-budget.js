/**
 * Fit report photos into a Cloudflare Clef request (server/services/typed-decisions).
 *
 * The server twin of the client's `fitImagesToBudget`
 * (client/src/utils/imageCompression.js) and the same contract, in sharp:
 *   - the budget is for the WHOLE batch, not per image;
 *   - walk LADDER best-quality-first and stop at the FIRST rung whose total fits,
 *     so we shed the minimum quality the budget demands;
 *   - never upscale (a rung's `maxEdge` only shrinks);
 *   - an original that is already a clean JPEG is kept byte-for-byte whenever a
 *     re-encode would not be smaller (and once a rung fits, originals that fit
 *     back into the leftover headroom are restored, cheapest first); an
 *     original is never kept above the top rung's edge (1600px);
 *   - images are processed SEQUENTIALLY: a phone photo decodes to tens of MB of
 *     raster and a four-image batch decoded at once is not worth the memory.
 *
 * What differs from the client, on purpose:
 *   - Clef takes ONE kind of body: a request over ~150 KB is refused (HTTP 413,
 *     measured 2026-10-02), so the default budget is 150 KB and the ladder runs
 *     lower than the MMS ladder (down to a 512px edge).
 *   - Privacy: nothing sent may carry EXIF / GPS / XMP / IPTC / comments. Every
 *     re-encode drops metadata (sharp's default; `withMetadata` is never
 *     called) after applying the EXIF orientation, and an original is kept
 *     verbatim only when its JPEG segment list holds no APPn (other than the
 *     JFIF APP0) and no comment segment.
 *   - The output is always a JPEG data URL. A PNG/WebP/HEIC original is never
 *     "kept": it is re-encoded (alpha flattened onto white) or the batch fails.
 *   - Animated inputs contribute their first frame.
 *
 * Budget unit: the length of the data-URL strings (base64 plus the
 * `data:image/jpeg;base64,` prefix), because that is what lands in the JSON
 * body and what `callWorkersAIDecision` re-checks before it fetches.
 *
 * Result: `{ ok:true, images:[{ dataUrl, bytes, width, height, sha256 }] }` (index-aligned
 * with the input; `bytes` is the JPEG byte length, `sha256` is over the bytes
 * sent) or `{ ok:false, reason, images:[], ... }` with reason `invalid_input`,
 * `too_many_images`, `undecodable_image` or `over_budget`. Never throws.
 */
const crypto = require('crypto');
const sharp = require('sharp');

const DEFAULT_BUDGET_BYTES = 150 * 1024;
const DEFAULT_MAX_IMAGES = 4;
const DATA_URL_PREFIX = 'data:image/jpeg;base64,';

// Ordered best-quality-first; each rung gives up edge and quality together.
// 1600/q80 down to 800/q58 is what report photos landed on in the 2026-10-02
// measurement; the two lowest rungs are the last resort for four busy photos.
const LADDER = Object.freeze([
  { maxEdge: 1600, quality: 80 },
  { maxEdge: 1600, quality: 70 },
  { maxEdge: 1280, quality: 72 },
  { maxEdge: 1280, quality: 62 },
  { maxEdge: 1024, quality: 65 },
  { maxEdge: 1024, quality: 55 },
  { maxEdge: 800, quality: 58 },
  { maxEdge: 800, quality: 50 },
  { maxEdge: 640, quality: 52 },
  { maxEdge: 640, quality: 44 },
  { maxEdge: 512, quality: 46 },
  { maxEdge: 512, quality: 38 },
].map(Object.freeze));

const dataUrlLength = (bytes) => DATA_URL_PREFIX.length + Math.ceil(bytes / 3) * 4;
const sha256Of = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const totalLength = (items) => items.reduce((sum, it) => sum + dataUrlLength(it.buffer.length), 0);

// True for a JPEG whose segment list before the scan carries no APP1..APP15
// (EXIF, XMP, ICC, IPTC, Adobe) and no COM comment: such a file has nothing
// to strip, so it can be sent as it is. Fails SAFE: anything unparseable is
// "not clean" and gets re-encoded instead.
function isCleanJpeg(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return false;
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return false;
    const marker = buf[off + 1];
    if (marker === 0xff) { off += 1; continue; } // fill byte
    if (marker === 0xda) return true; // start of scan: headers done
    if (marker === 0xd9) return false;
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { off += 2; continue; } // no length
    off += 2 + buf.readUInt16BE(off + 2);
  }
  return false;
}

async function encodeRung(buffer, { maxEdge, quality }) {
  const { data, info } = await sharp(buffer, { failOn: 'none' })
    .rotate() // apply EXIF orientation, then the tag is gone with the rest
    .flatten({ background: '#ffffff' }) // JPEG has no alpha
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .jpeg({ quality, mozjpeg: true }) // no withMetadata(): EXIF/GPS/XMP never leave
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

async function describeOriginal(buffer) {
  try {
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    if (!meta.width || !meta.height) return null;
    // An original is only ever kept at or below the top rung's edge: a 4000px
    // photo that happens to compress small is still not what the model needs.
    const clean = meta.format === 'jpeg' && Math.max(meta.width, meta.height) <= LADDER[0].maxEdge && isCleanJpeg(buffer);
    return { clean, width: meta.width, height: meta.height };
  } catch {
    return null;
  }
}

// Put back any clean original whose extra bytes still fit in the leftover
// headroom, cheapest first (maximises how many come back).
function restoreWithinHeadroom(originals, attempt, budget) {
  const result = [...attempt];
  let used = totalLength(result);
  const candidates = [];
  for (let i = 0; i < originals.length; i++) {
    if (originals[i] && result[i] !== originals[i]) {
      candidates.push({ i, delta: dataUrlLength(originals[i].buffer.length) - dataUrlLength(result[i].buffer.length) });
    }
  }
  candidates.sort((a, b) => a.delta - b.delta);
  for (const { i, delta } of candidates) {
    if (used + delta <= budget) {
      result[i] = originals[i];
      used += delta;
    }
  }
  return result;
}

function finish(items) {
  return items.map(({ buffer, width, height }) => ({
    dataUrl: `${DATA_URL_PREFIX}${buffer.toString('base64')}`,
    bytes: buffer.length,
    width,
    height,
    sha256: sha256Of(buffer),
  }));
}

async function fitImagesForClef(buffers, { budgetBytes = DEFAULT_BUDGET_BYTES, maxImages = DEFAULT_MAX_IMAGES } = {}) {
  const inputs = Array.isArray(buffers) ? buffers : [];
  if (!Array.isArray(buffers) || !inputs.every((b) => Buffer.isBuffer(b) && b.length > 0)) {
    return { ok: false, reason: 'invalid_input', images: [] };
  }
  const budget = Number(budgetBytes);
  if (!Number.isFinite(budget) || budget <= 0) return { ok: false, reason: 'over_budget', images: [], budgetBytes: budget };
  if (inputs.length > maxImages) return { ok: false, reason: 'too_many_images', images: [], maxImages };
  if (!inputs.length) return { ok: true, images: [], compressed: false };

  // Sequential on purpose — see the module header's memory note.
  const originals = [];
  for (const buffer of inputs) {
    const meta = await describeOriginal(buffer);
    if (!meta) return { ok: false, reason: 'undecodable_image', images: [] };
    originals.push(meta.clean ? { buffer, width: meta.width, height: meta.height } : null);
  }

  // Every input that is already a clean JPEG and fits as a batch ships
  // untouched: no re-encode, no generational loss on images that were never
  // the problem.
  if (originals.every(Boolean) && totalLength(originals) <= budget) {
    return { ok: true, images: finish(originals), compressed: false };
  }

  let bestLength = Infinity;
  try {
    for (const rung of LADDER) {
      const attempt = [];
      for (let i = 0; i < inputs.length; i++) {
        const encoded = await encodeRung(inputs[i], rung);
        // Keep whichever is smaller: re-encoding an already-small or
        // already-optimised JPEG routinely inflates it.
        const original = originals[i];
        attempt.push(original && original.buffer.length <= encoded.buffer.length ? original : encoded);
      }
      const length = totalLength(attempt);
      if (length < bestLength) bestLength = length;
      if (length <= budget) {
        return { ok: true, images: finish(restoreWithinHeadroom(originals, attempt, budget)), compressed: true };
      }
    }
  } catch {
    return { ok: false, reason: 'undecodable_image', images: [] };
  }
  return { ok: false, reason: 'over_budget', images: [], budgetBytes: budget, bestBytes: bestLength };
}

module.exports = { fitImagesForClef, isCleanJpeg, LADDER, DEFAULT_BUDGET_BYTES, DEFAULT_MAX_IMAGES };
