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
    const stats = await sharp(buffer).stats();
    return stats.channels.some((ch) => ch.stdev > 1.5);
  } catch (err) {
    logger.warn(`[signature-image] ink check failed (decode error): ${err.message}`);
    return false;
  }
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

module.exports = { parseSignatureImage, signatureHasInk, signatureImageBuffer, DEFAULT_MAX_BYTES };
