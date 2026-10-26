// Drawn e-signature images (a signature pad's PNG/JPEG data URL): one validator
// for every surface that stores one — the WDO licensee signature
// (routes/admin-projects.js) and the customer contract signature
// (routes/contracts-public.js). The checks are the WDO route's original ones:
// a PNG or JPEG data URL, under the size cap, real PNG/JPEG magic bytes, and
// visible ink (a blank pad exports a uniform image), so a malformed or empty
// image is refused while the signer is still holding the pen instead of
// failing silently when the PDF is stamped.
const logger = require('./logger');

const DATA_URL_RE = /^data:(image\/(?:png|jpeg));base64,(.+)$/i;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2MB
// The byte cap bounds the COMPRESSED image; a small, highly compressed PNG can still declare a huge bitmap. A pad
// exports a few megapixels at most (the customer pad downscales to 1200px wide; the WDO pad is its box ×
// devicePixelRatio, 160px tall), so anything past these bounds is refused from the image header, before any decode.
const MAX_SIGNATURE_PIXELS = 8 * 1000 * 1000;
const MAX_SIGNATURE_SIDE = 8192;

function isPng(buffer) {
  return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
}
function isJpeg(buffer) {
  return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

// A signature with no ink is a uniform image: every channel's standard deviation sits
// near zero. Decode failures read as blank, so an unverifiable image is refused too.
async function signatureHasInk(buffer) {
  try {
    const sharp = require('sharp');
    // limitInputPixels: sharp refuses (throws, read as blank) a bitmap past the cap instead of decoding it.
    const stats = await sharp(buffer, { limitInputPixels: MAX_SIGNATURE_PIXELS }).stats();
    return stats.channels.some((ch) => ch.stdev > 1.5);
  } catch (err) {
    logger.warn(`[signature-image] ink check failed (decode error): ${err.message}`);
    return false;
  }
}

// Width and height from the image header (sharp reads metadata without decoding pixels); null when unreadable.
async function signatureDimensions(buffer) {
  try {
    const { width, height } = await require('sharp')(buffer).metadata();
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

function withinSignatureBounds({ width, height }) {
  return width <= MAX_SIGNATURE_SIDE && height <= MAX_SIGNATURE_SIDE && width * height <= MAX_SIGNATURE_PIXELS;
}

// { ok: true, image, contentType, buffer } for a usable signature, else
// { ok: false, status, error, code? } shaped for the route to send as is.
async function parseSignatureImage(value, { maxBytes = DEFAULT_MAX_BYTES, maxLabel = '2MB' } = {}) {
  const image = String(value || '').trim();
  const m = image.match(DATA_URL_RE);
  if (!m) return { ok: false, status: 400, error: 'signature must be a PNG or JPEG data URL' };
  const approxBytes = Math.floor((m[2].length * 3) / 4);
  if (approxBytes > maxBytes) return { ok: false, status: 413, error: `Signature image too large (max ${maxLabel})` };
  const buffer = Buffer.from(m[2], 'base64');
  if (!isPng(buffer) && !isJpeg(buffer)) return { ok: false, status: 400, error: 'signature image is not a valid PNG or JPEG' };
  // An unreadable header falls through to the ink check, which refuses it as blank or unreadable.
  const dims = await signatureDimensions(buffer);
  if (dims && !withinSignatureBounds(dims)) return { ok: false, status: 413, error: 'Signature image is too large. Please clear the pad and sign again.' };
  if (!(await signatureHasInk(buffer))) {
    return { ok: false, status: 400, error: 'Signature looks blank or unreadable — please clear the pad and sign again', code: 'signature_blank' };
  }
  return { ok: true, image, contentType: m[1].toLowerCase(), buffer };
}

// The image bytes of a stored data URL, for stamping into a PDF; null when it is not one.
function signatureImageBuffer(dataUrl) {
  const m = String(dataUrl || '').match(DATA_URL_RE);
  return m ? Buffer.from(m[2], 'base64') : null;
}

module.exports = { parseSignatureImage, signatureHasInk, signatureImageBuffer, DEFAULT_MAX_BYTES, MAX_SIGNATURE_PIXELS, MAX_SIGNATURE_SIDE };
