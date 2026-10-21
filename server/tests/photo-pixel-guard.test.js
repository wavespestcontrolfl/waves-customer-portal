/**
 * Customer photos are bounded by PIXELS before Sharp decodes them (a few kilobytes of header can claim a
 * billion pixels), and only a couple of transcodes run at once. Real sharp here.
 */
const sharp = require('sharp');
const {
  MAX_PHOTO_PIXELS, MAX_CONCURRENT_TRANSCODES, PhotoTooLargeError, assertPhotoWithinPixels, withTranscodeSlot,
} = require('../utils/photo-pixel-guard');

// A real tiny JPEG with its SOF0 height and width rewritten in place: a few hundred bytes that CLAIM
// width x height pixels. sharp reads the header for metadata and never decodes it.
async function tinyJpegClaiming(width, height) {
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).jpeg().toBuffer();
  const buf = Buffer.from(jpeg);
  for (let i = 0; i < buf.length - 9; i += 1) {
    if (buf[i] === 0xff && (buf[i + 1] === 0xc0 || buf[i + 1] === 0xc2)) {
      buf.writeUInt16BE(height, i + 5);
      buf.writeUInt16BE(width, i + 7);
      return buf;
    }
  }
  throw new Error('no SOF marker');
}

describe('assertPhotoWithinPixels', () => {
  test('a tiny-bytes JPEG that claims 60000 x 60000 pixels is refused from its header, before any decode', async () => {
    const huge = await tinyJpegClaiming(60000, 60000);
    expect(huge.length).toBeLessThan(2000);
    await expect(assertPhotoWithinPixels(huge)).rejects.toBeInstanceOf(PhotoTooLargeError);
    await expect(assertPhotoWithinPixels(huge)).rejects.toMatchObject({ code: 'photo_too_large' });
  });

  test('the ceiling is on the pixel count, not on one side', async () => {
    await expect(assertPhotoWithinPixels(await tinyJpegClaiming(8000, 7000))).rejects.toBeInstanceOf(PhotoTooLargeError); // 56 MP
    await expect(assertPhotoWithinPixels(await tinyJpegClaiming(8000, 6000))).resolves.toBeUndefined(); // 48 MP phone sensor
    await expect(assertPhotoWithinPixels(await tinyJpegClaiming(30000, 1000))).resolves.toBeUndefined(); // 30 MP panorama
    expect(MAX_PHOTO_PIXELS).toBe(50_000_000);
  });

  test('an ordinary photo passes, and bytes sharp cannot read are left to the caller', async () => {
    const ok = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    await expect(assertPhotoWithinPixels(ok)).resolves.toBeUndefined();
    await expect(assertPhotoWithinPixels(Buffer.from('not an image'))).resolves.toBeUndefined();
  });

  test('the decoder is told the same ceiling, so a header that lies is still stopped at decode', async () => {
    // a real 8x8 image decodes under a ceiling above its size and fails under one below it
    const small = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
    await expect(sharp(small, { limitInputPixels: 100 }).jpeg().toBuffer()).resolves.toBeInstanceOf(Buffer);
    await expect(sharp(small, { limitInputPixels: 10 }).jpeg().toBuffer()).rejects.toThrow();
  });
});

describe('withTranscodeSlot', () => {
  test(`never runs more than ${MAX_CONCURRENT_TRANSCODES} at once, and releases the slot on a failure`, async () => {
    let running = 0;
    let peak = 0;
    const work = async (fail) => withTranscodeSlot(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running -= 1;
      if (fail) throw new Error('boom');
      return 'done';
    });
    const results = await Promise.allSettled([work(false), work(true), work(false), work(false), work(true), work(false)]);
    expect(peak).toBe(MAX_CONCURRENT_TRANSCODES);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
    expect(await work(false)).toBe('done'); // nothing leaked
  });
});
