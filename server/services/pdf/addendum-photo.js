/**
 * Normalize a WDO addendum photo for PDF embedding + email delivery.
 *
 * - Bakes EXIF orientation into the pixels: pdf-lib embeds images as-is and
 *   ignores orientation tags, so phone photos rendered sideways in the
 *   official addendum.
 * - Downscales to a bounded long edge and recompresses as JPEG: raw phone
 *   photos run 3-10MB each, and base64 email encoding inflates the addendum
 *   by ~33%, which could push the combined report+invoice email past
 *   SendGrid's 30MB hard cap. After this, photos are ~0.2-0.8MB and the
 *   email budget is effectively unreachable.
 *
 * Returns { buffer, contentType } or null when the input can't be decoded —
 * callers fall back to the original buffer (their format and byte-budget
 * checks still apply), so a sharp failure can never block a send.
 */
const logger = require('../logger');

const ADDENDUM_PHOTO_MAX_DIM = 1600;
const ADDENDUM_JPEG_QUALITY = 80;

async function normalizeAddendumPhoto(buffer) {
  try {
    const sharp = require('sharp');
    const out = await sharp(buffer)
      .rotate() // bake EXIF orientation into the pixels
      .resize({
        width: ADDENDUM_PHOTO_MAX_DIM,
        height: ADDENDUM_PHOTO_MAX_DIM,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' }) // PNG transparency → white, not black
      .jpeg({ quality: ADDENDUM_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    return { buffer: out, contentType: 'image/jpeg' };
  } catch (err) {
    logger.warn(`[wdo-pdf] addendum photo normalize failed (keeping original): ${err.message}`);
    return null;
  }
}

module.exports = { normalizeAddendumPhoto, ADDENDUM_PHOTO_MAX_DIM };
