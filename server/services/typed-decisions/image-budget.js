/**
 * Fit report photos into a Cloudflare Clef request (server/services/typed-decisions).
 *
 * The server twin of the client's `fitImagesToBudget`
 * (client/src/utils/imageCompression.js) and the same contract, in sharp:
 *   - the budget is for the WHOLE batch, not per image;
 *   - walk LADDER best-quality-first and stop at the FIRST rung whose total fits,
 *     so we shed the minimum quality the budget demands;
 *   - never upscale (a rung's `maxEdge` only shrinks);
 *   - images are processed SEQUENTIALLY: a phone photo decodes to tens of MB of
 *     raster and a four-image batch decoded at once is not worth the memory.
 *
 * What differs from the client, on purpose:
 *   - Clef takes ONE kind of body: a request over ~150 KB is refused (HTTP 413,
 *     measured 2026-10-02), so the default budget is 150 KB and the ladder runs
 *     lower than the MMS ladder (down to a 512px edge).
 *   - Privacy: nothing sent may carry EXIF / GPS / XMP / IPTC / comments, so
 *     EVERY image is re-encoded, even one that already fits: a JPEG can hide a
 *     comment or APP segment after its first scan or in trailing bytes, and a
 *     header walk cannot prove it clean (Codex #5666 r1). The re-encode applies
 *     the EXIF orientation, then drops all metadata (`withMetadata` is never
 *     called). The client's "keep the original" rule is dropped here on purpose.
 *   - The output is always a JPEG data URL. A PNG/WebP/HEIC original is never
 *     "kept": it is re-encoded (alpha flattened onto white) or the batch fails.
 *   - Animated inputs contribute their first frame.
 *
 * Budget unit: the length of the data-URL strings (base64 plus the
 * `data:image/jpeg;base64,` prefix). The provider limit is on the WHOLE JSON
 * body, so pass `reserveBytes` = the serialized size of everything else in the
 * request (`clefBodyOverhead(state, questions)`); `callWorkersAIDecision`
 * re-checks the serialized body before it fetches.
 *
 * Result: `{ ok:true, images:[{ dataUrl, bytes, width, height, sha256 }] }` (frozen
 * records; askPackage accepts ONLY these, never bare strings; index-aligned
 * with the input; `bytes` is the JPEG byte length, `sha256` is over the bytes
 * sent) or `{ ok:false, reason, images:[], ... }` with reason `invalid_input`,
 * `too_many_images`, `undecodable_image` or `over_budget`. Never throws.
 */
const crypto = require('crypto');
const sharp = require('sharp');

const DEFAULT_BUDGET_BYTES = 150 * 1024;
const DEFAULT_MAX_IMAGES = 4;
const DATA_URL_PREFIX = 'data:image/jpeg;base64,';
const MAX_INPUT_PIXELS = 25_000_000;

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

// One upright, flattened, metadata-free sRGB raster per (image, edge): the
// ladder has six edges and two qualities each, so resizing once per edge and
// only re-running the JPEG encode per quality keeps a four-photo walk fast.
async function rasterAt(buffer, maxEdge) {
  // 25 MP decode cap (the visit-prep upload normalizer's limit): a small file
  // declaring huge dimensions is refused instead of decoded.
  const { data, info } = await sharp(buffer, { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS })
    .rotate() // apply EXIF orientation, then the tag is gone with the rest
    .flatten({ background: '#ffffff' }) // JPEG has no alpha
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

async function encodeRung(raster, quality) {
  const { data, width, height, channels } = raster;
  // A raw raster carries no metadata, so nothing but pixels can leave.
  const buffer = await sharp(data, { raw: { width, height, channels } }).jpeg({ quality }).toBuffer();
  return { buffer, width, height };
}

// The serialized size of the request body WITHOUT images, plus the
// `"images":[...]` framing: what the image budget must leave room for.
function clefBodyOverhead(state, questions) {
  try {
    // UTF-8 bytes, not characters: the provider limit is on the wire body.
    return Buffer.byteLength(JSON.stringify({ images: [], state, questions }), 'utf8');
  } catch {
    return Infinity;
  }
}

// Each image's data URL is a JSON string in the body: quotes and a comma.
const framedLength = (items) => totalLength(items) + items.length * 3;

// Every record this fitter returns is frozen and remembered here: askPackage
// sends ONLY these (isFittedImage), so whatever reaches Clef was decoded and
// re-encoded by sharp in this module, never caller-supplied bytes that merely
// start with an image signature (Codex #5666 r3).
const FITTED = new WeakSet();
const isFittedImage = (record) => record !== null && typeof record === 'object' && FITTED.has(record);

function finish(items) {
  return items.map(({ buffer, width, height }) => {
    const record = Object.freeze({
      dataUrl: `${DATA_URL_PREFIX}${buffer.toString('base64')}`,
      bytes: buffer.length,
      width,
      height,
      sha256: sha256Of(buffer),
    });
    FITTED.add(record);
    return record;
  });
}

async function fitImagesForClef(buffers, { budgetBytes = DEFAULT_BUDGET_BYTES, maxImages = DEFAULT_MAX_IMAGES, reserveBytes = 0 } = {}) {
  const inputs = Array.isArray(buffers) ? buffers : [];
  if (!Array.isArray(buffers) || !inputs.every((b) => Buffer.isBuffer(b) && b.length > 0)) {
    return { ok: false, reason: 'invalid_input', images: [] };
  }
  const budget = Number(budgetBytes) - (Number(reserveBytes) || 0);
  if (!Number.isFinite(budget) || budget <= 0) return { ok: false, reason: 'over_budget', images: [], budgetBytes: budget };
  if (inputs.length > maxImages) return { ok: false, reason: 'too_many_images', images: [], maxImages };
  if (!inputs.length) return { ok: true, images: [], compressed: false };

  let bestLength = Infinity;
  const rasters = { edge: null, list: [] };
  try {
    for (const rung of LADDER) {
      // Sequential on purpose — see the module header's memory note.
      if (rasters.edge !== rung.maxEdge) {
        rasters.edge = rung.maxEdge;
        rasters.list = [];
        for (const input of inputs) rasters.list.push(await rasterAt(input, rung.maxEdge));
      }
      const attempt = [];
      for (const raster of rasters.list) attempt.push(await encodeRung(raster, rung.quality));
      const length = framedLength(attempt);
      if (length < bestLength) bestLength = length;
      if (length <= budget) return { ok: true, images: finish(attempt), compressed: true };
    }
  } catch {
    return { ok: false, reason: 'undecodable_image', images: [] };
  }
  return { ok: false, reason: 'over_budget', images: [], budgetBytes: budget, bestBytes: bestLength };
}

module.exports = { fitImagesForClef, isFittedImage, clefBodyOverhead, MAX_INPUT_PIXELS, LADDER, DEFAULT_BUDGET_BYTES, DEFAULT_MAX_IMAGES };
