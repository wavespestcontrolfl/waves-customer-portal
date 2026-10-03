// fitImagesForClef (typed-decisions/image-budget.js): the server twin of the
// client's fitImagesToBudget. Images are generated in-test with sharp
// (synthetic noise, no real photos).
const sharp = require('sharp');
const crypto = require('crypto');
const { fitImagesForClef, isCleanJpeg, LADDER, DEFAULT_BUDGET_BYTES } = require('../services/typed-decisions/image-budget');
const { CLEF_MAX_IMAGES, CLEF_IMAGES_BUDGET_BYTES } = require('../services/llm/call');

jest.setTimeout(60000);

// Noise compresses badly, so a large noisy frame is guaranteed to need a ladder.
function noise(width, height, channels = 3) {
  const data = Buffer.alloc(width * height * channels);
  let seed = 12345;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = seed >> 16;
  }
  return data;
}
const jpegOf = (width, height, opts = {}) => sharp(noise(width, height), { raw: { width, height, channels: 3 } }).jpeg({ quality: opts.quality || 85 });
const decodeUrl = (dataUrl) => Buffer.from(dataUrl.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
const urlLen = (images) => images.reduce((n, i) => n + i.dataUrl.length, 0);

describe('fitImagesForClef', () => {
  test('the defaults match the adapter limits (150 KB, 4 images)', () => {
    expect(DEFAULT_BUDGET_BYTES).toBe(CLEF_IMAGES_BUDGET_BYTES);
    expect(CLEF_MAX_IMAGES).toBe(4);
  });

  test('the ladder is best-first, never grows, and runs below 1024', () => {
    for (let i = 1; i < LADDER.length; i++) {
      expect(LADDER[i].maxEdge).toBeLessThanOrEqual(LADDER[i - 1].maxEdge);
      if (LADDER[i].maxEdge === LADDER[i - 1].maxEdge) expect(LADDER[i].quality).toBeLessThan(LADDER[i - 1].quality);
    }
    expect(LADDER[0]).toEqual({ maxEdge: 1600, quality: 80 });
    expect(Math.min(...LADDER.map((r) => r.maxEdge))).toBeLessThan(1024);
  });

  test('a large image shrinks to fit, as a JPEG data URL with its own sha256 over the sent bytes', async () => {
    const big = await jpegOf(2400, 1800).toBuffer();
    expect(big.length).toBeGreaterThan(DEFAULT_BUDGET_BYTES);
    const out = await fitImagesForClef([big]);
    expect(out.ok).toBe(true);
    expect(out.images).toHaveLength(1);
    const [img] = out.images;
    expect(img.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(urlLen(out.images)).toBeLessThanOrEqual(DEFAULT_BUDGET_BYTES);
    const sent = decodeUrl(img.dataUrl);
    expect(sent.length).toBe(img.bytes);
    expect(img.sha256).toBe(crypto.createHash('sha256').update(sent).digest('hex'));
    const meta = await sharp(sent).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([img.width, img.height]);
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(1600);
    // aspect ratio kept
    expect(img.width / img.height).toBeCloseTo(2400 / 1800, 1);
  });

  test('stops at the first rung that fits: a roomy budget keeps the top rung (1600 edge)', async () => {
    const big = await jpegOf(2400, 1800).toBuffer();
    const out = await fitImagesForClef([big], { budgetBytes: 4 * 1024 * 1024 });
    expect(Math.max(out.images[0].width, out.images[0].height)).toBe(1600);
  });

  test('a clean JPEG above the top rung edge is not kept verbatim even when it fits', async () => {
    const wide = await sharp(Buffer.alloc(2400 * 100 * 3, 128), { raw: { width: 2400, height: 100, channels: 3 } }).jpeg().toBuffer();
    expect(wide.length).toBeLessThan(DEFAULT_BUDGET_BYTES);
    const out = await fitImagesForClef([wide]);
    expect(out.ok).toBe(true);
    expect(out.images[0].width).toBe(1600);
  });

  test('a small clean JPEG is kept byte-for-byte and never upscaled', async () => {
    const small = await jpegOf(320, 240, { quality: 60 }).toBuffer();
    expect(isCleanJpeg(small)).toBe(true);
    const out = await fitImagesForClef([small]);
    expect(out.ok).toBe(true);
    expect(out.compressed).toBe(false);
    expect(decodeUrl(out.images[0].dataUrl).equals(small)).toBe(true);
    expect([out.images[0].width, out.images[0].height]).toEqual([320, 240]);
  });

  test('a small PNG is re-encoded to JPEG without being enlarged', async () => {
    const png = await sharp(noise(200, 100), { raw: { width: 200, height: 100, channels: 3 } }).png().toBuffer();
    const out = await fitImagesForClef([png]);
    expect(out.ok).toBe(true);
    const meta = await sharp(decodeUrl(out.images[0].dataUrl)).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([200, 100]);
  });

  test('EXIF (including GPS) is stripped from what is sent, and the orientation is applied', async () => {
    const tagged = await jpegOf(400, 200)
      .withExif({ IFD0: { Copyright: 'synthetic-owner' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '27/1 0/1 0/1' } })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const before = await sharp(tagged).metadata();
    expect(before.exif).toBeDefined();
    expect(before.orientation).toBe(6);
    expect(isCleanJpeg(tagged)).toBe(false);
    const out = await fitImagesForClef([tagged]);
    expect(out.ok).toBe(true);
    const sent = decodeUrl(out.images[0].dataUrl);
    const meta = await sharp(sent).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(sent.includes(Buffer.from('synthetic-owner'))).toBe(false);
    expect(sent.includes(Buffer.from('Exif'))).toBe(false);
    // orientation 6 = rotated 90deg: the 400x200 frame arrives upright as 200x400
    expect([out.images[0].width, out.images[0].height]).toEqual([200, 400]);
    expect([meta.width, meta.height]).toEqual([200, 400]);
  });

  test('a JPEG comment segment is not clean and is not sent verbatim', async () => {
    const plain = await jpegOf(200, 100).toBuffer();
    const text = Buffer.from('lat=27.0 lon=-82.0');
    const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, text.length + 2]), text]);
    const withComment = Buffer.concat([plain.subarray(0, 2), com, plain.subarray(2)]);
    expect(isCleanJpeg(withComment)).toBe(false);
    const out = await fitImagesForClef([withComment]);
    expect(out.ok).toBe(true);
    expect(decodeUrl(out.images[0].dataUrl).includes(text)).toBe(false);
  });

  test('the budget is for the whole batch: four large images share it', async () => {
    const bigs = await Promise.all([1, 2, 3, 4].map(() => jpegOf(900, 700).toBuffer()));
    const budgetBytes = 300 * 1024;
    expect(bigs.reduce((n, b) => n + b.length, 0)).toBeGreaterThan(budgetBytes);
    const out = await fitImagesForClef(bigs, { budgetBytes });
    expect(out.ok).toBe(true);
    expect(out.images).toHaveLength(4);
    expect(urlLen(out.images)).toBeLessThanOrEqual(budgetBytes);
  });

  test('more than maxImages is refused with a reason, before any decode', async () => {
    const one = await jpegOf(100, 100).toBuffer();
    expect(await fitImagesForClef([one, one, one, one, one])).toMatchObject({ ok: false, reason: 'too_many_images', images: [] });
    expect(await fitImagesForClef([one, one, one], { maxImages: 2 })).toMatchObject({ ok: false, reason: 'too_many_images' });
  });

  test('an impossible budget fails over_budget and reports the best total it reached', async () => {
    const big = await jpegOf(900, 700).toBuffer();
    const out = await fitImagesForClef([big], { budgetBytes: 500 });
    expect(out).toMatchObject({ ok: false, reason: 'over_budget', images: [] });
    expect(out.bestBytes).toBeGreaterThan(500);
  });

  test('bad input: not buffers, an empty buffer, or undecodable bytes', async () => {
    expect(await fitImagesForClef('nope')).toMatchObject({ ok: false, reason: 'invalid_input' });
    expect(await fitImagesForClef(['data:image/jpeg;base64,AAAA'])).toMatchObject({ ok: false, reason: 'invalid_input' });
    expect(await fitImagesForClef([Buffer.alloc(0)])).toMatchObject({ ok: false, reason: 'invalid_input' });
    expect(await fitImagesForClef([Buffer.from('not an image at all')])).toMatchObject({ ok: false, reason: 'undecodable_image' });
    expect(await fitImagesForClef([])).toEqual({ ok: true, images: [], compressed: false });
  });
});
