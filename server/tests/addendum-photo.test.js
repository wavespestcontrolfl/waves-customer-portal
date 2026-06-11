// WDO addendum photo normalization: EXIF orientation must be baked into the
// pixels (pdf-lib ignores orientation tags — phone photos rendered sideways
// in the official addendum) and large photos must downscale to a bounded
// JPEG so the combined report+invoice email can't exceed SendGrid's 30MB cap.

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const sharp = require('sharp');
const { normalizeAddendumPhoto, ADDENDUM_PHOTO_MAX_DIM } = require('../services/pdf/addendum-photo');

describe('normalizeAddendumPhoto', () => {
  test('bakes EXIF orientation into the pixels', async () => {
    // 800x600 stored with orientation 6 (90° CW rotation needed) — i.e. a
    // portrait phone photo saved landscape with a rotation tag.
    const input = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 120, g: 120, b: 120 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const out = await normalizeAddendumPhoto(input);
    expect(out).not.toBeNull();
    const meta = await sharp(out.buffer).metadata();
    // Rotation applied: dimensions swap, and no orientation tag survives.
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(800);
    expect(meta.orientation).toBeUndefined();
    expect(out.contentType).toBe('image/jpeg');
  });

  test('downscales oversized photos to the bounded long edge', async () => {
    const input = await sharp({
      create: { width: 4000, height: 2000, channels: 3, background: { r: 10, g: 200, b: 30 } },
    })
      .jpeg()
      .toBuffer();

    const out = await normalizeAddendumPhoto(input);
    const meta = await sharp(out.buffer).metadata();
    expect(meta.width).toBe(ADDENDUM_PHOTO_MAX_DIM);
    expect(meta.height).toBe(ADDENDUM_PHOTO_MAX_DIM / 2);
    expect(out.buffer.length).toBeLessThan(input.length * 2);
  });

  test('never enlarges small photos', async () => {
    const input = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 10, b: 30 } },
    })
      .jpeg()
      .toBuffer();

    const out = await normalizeAddendumPhoto(input);
    const meta = await sharp(out.buffer).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(300);
  });

  test('converts PNG (with transparency flattened to white) to JPEG', async () => {
    const input = await sharp({
      create: { width: 500, height: 500, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
    })
      .png()
      .toBuffer();

    const out = await normalizeAddendumPhoto(input);
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe('jpeg');
  });

  test('returns null on undecodable input so callers keep the original', async () => {
    const out = await normalizeAddendumPhoto(Buffer.from('definitely not an image'));
    expect(out).toBeNull();
  });
});
