// Bounds for customer-submitted photos before Sharp decodes them. A few kilobytes of HEIC or JPEG
// header can claim a billion pixels; decoding that takes gigabytes of memory. So the size is read from
// the header (sharp metadata does not decode) and refused over the pixel ceiling, the decoder is told
// the same ceiling (limitInputPixels), and only one photo is checked or transcoded at a time.
const sharp = require('sharp');

// The report page shrinks every photo before sending it, and a phone camera's default output (12 to 24 MP) fits; anything
// larger is refused. One decode at a time machine-wide (the portal photo ID shares this semaphore), so the aggregate
// decode memory is one image of at most 25 MP.
const MAX_PHOTO_PIXELS = 25_000_000;
const MAX_CONCURRENT_TRANSCODES = 1;

class PhotoTooLargeError extends Error {
  constructor() {
    super('photo exceeds the pixel limit');
    this.code = 'photo_too_large';
  }
}

// Throws PhotoTooLargeError when the header says the image is over the ceiling. A header that cannot be
// read is not refused here: the transcode below throws on it, and a photo that is not transcoded goes to
// the vision provider as it always did.
async function assertPhotoWithinPixels(raw) {
  let meta;
  try {
    meta = await sharp(raw, { limitInputPixels: MAX_PHOTO_PIXELS }).metadata();
  } catch (err) {
    if (/pixel limit|exceeds/i.test(String(err && err.message))) throw new PhotoTooLargeError();
    return;
  }
  if (Number(meta.width) * Number(meta.height) > MAX_PHOTO_PIXELS) throw new PhotoTooLargeError();
}

// A released slot goes DIRECTLY to the next waiter (active is not decremented while one waits), so a caller that
// arrives between a release and the waiter's wake-up can never take the slot too and push the count past the cap.
let active = 0;
const waiting = [];
async function withTranscodeSlot(fn) {
  if (active >= MAX_CONCURRENT_TRANSCODES) {
    await new Promise((resolve) => waiting.push(resolve)); // resumes already holding the slot
  } else {
    active += 1;
  }
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next(); else active -= 1;
  }
}

module.exports = {
  MAX_PHOTO_PIXELS,
  MAX_CONCURRENT_TRANSCODES,
  PhotoTooLargeError,
  assertPhotoWithinPixels,
  withTranscodeSlot,
};
