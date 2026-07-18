const { isValidBase64 } = require('./base64-validate');

const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_ENCODED_PHOTO_CHARS = 8 * 1024 * 1024;

// Prefix-only match: matching the entire multi-megabyte data URL can exhaust
// V8's regular-expression stack under load.
const DATA_URL_PREFIX_RE = /^data:image\/(?:jpeg|jpg|png|webp|heic|heif);base64,/;

function decodedBase64Bytes(base64) {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function validateRequestPhoto(photo) {
  if (typeof photo !== 'string') {
    return { ok: false, status: 400, error: 'Each attachment must be an image.' };
  }

  const prefix = DATA_URL_PREFIX_RE.exec(photo);
  if (!prefix) {
    return {
      ok: false,
      status: 400,
      error: 'Photos must be JPEG, PNG, WebP, HEIC, or HEIF images.',
    };
  }

  const base64 = photo.slice(prefix[0].length);
  if (decodedBase64Bytes(base64) > MAX_PHOTO_BYTES) {
    return { ok: false, status: 413, error: 'Each photo must be 5 MB or smaller.' };
  }
  if (!isValidBase64(base64)) {
    return { ok: false, status: 400, error: 'One of the attached photos could not be read.' };
  }

  return { ok: true, photo };
}

function validateRequestPhotos(photos) {
  if (photos == null) return { ok: true, photos: [] };
  if (!Array.isArray(photos)) {
    return { ok: false, status: 400, error: 'Photos must be submitted as a list.' };
  }
  if (photos.length > MAX_PHOTOS) {
    return { ok: false, status: 400, error: `Attach no more than ${MAX_PHOTOS} photos.` };
  }

  const validated = [];
  for (let index = 0; index < photos.length; index += 1) {
    const result = validateRequestPhoto(photos[index]);
    if (!result.ok) return { ...result, photoIndex: index };
    validated.push(result.photo);
  }
  return { ok: true, photos: validated };
}

module.exports = {
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  MAX_ENCODED_PHOTO_CHARS,
  decodedBase64Bytes,
  validateRequestPhoto,
  validateRequestPhotos,
};
