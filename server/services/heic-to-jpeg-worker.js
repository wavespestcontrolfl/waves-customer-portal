'use strict';

const { isMainThread, parentPort, workerData } = require('worker_threads');
const libheif = require('libheif-js/wasm-bundle');
const sharp = require('sharp');

// A decoded RGBA image uses four bytes per pixel before libheif and Sharp's
// own working memory. 25 MP covers common 12 MP and 24 MP phone photos while
// keeping two simultaneous workers near 200 MB of raw pixel buffers.
const MAX_HEIC_PIXELS = 25_000_000;

async function decodePrimaryToJpeg(input) {
  if (libheif.ready?.then) await libheif.ready;
  const decoder = new libheif.HeifDecoder();
  let images = [];

  try {
    images = decoder.decode(input);
    if (!Array.isArray(images) || images.length === 0) {
      throw new Error('HEIC data could not be decoded');
    }

    // Tiled HEIC files can expose their tiles before the composed image.
    // File order is not presentation order; libheif's primary flag is.
    const image = images.find((candidate) => candidate.is_primary());
    if (!image) throw new Error('HEIC file has no primary image');

    const width = image.get_width();
    const height = image.get_height();
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
      throw new Error('HEIC primary image has invalid dimensions');
    }
    if (width * height > MAX_HEIC_PIXELS) {
      throw new Error('HEIC primary image exceeds the pixel limit');
    }

    const rgba = new Uint8ClampedArray(width * height * 4);
    const displayData = await new Promise((resolve, reject) => {
      image.display({ data: rgba, width, height }, (result) => {
        if (!result) reject(new Error('HEIC primary image could not be rendered'));
        else resolve(result);
      });
    });

    const pixels = Buffer.from(
      displayData.data.buffer,
      displayData.data.byteOffset,
      displayData.data.byteLength,
    );
    return sharp(pixels, { raw: { width, height, channels: 4 } })
      .jpeg({ quality: 85 })
      .toBuffer();
  } finally {
    for (const image of images) image.free?.();
    decoder.decoder?.delete?.();
  }
}

if (!isMainThread) {
  decodePrimaryToJpeg(Buffer.from(workerData))
    .then((jpeg) => parentPort.postMessage({ ok: true, jpeg }))
    .catch((error) => parentPort.postMessage({ ok: false, error: error.message }));
}

module.exports = { decodePrimaryToJpeg, MAX_HEIC_PIXELS };
