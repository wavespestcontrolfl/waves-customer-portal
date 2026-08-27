const sharp = require('sharp');
const { toCleanSocialJpeg } = require('../services/social-media');

// Every social image upload funnels through toCleanSocialJpeg (inside
// uploadImageToS3). These tests lock in the two properties that make a
// published image clean: no metadata survives the re-encode (EXIF incl. GPS,
// XMP, and C2PA/AI-provenance segments from image providers), and the EXIF
// orientation is baked into pixels rather than silently dropped (a portrait
// phone photo must not publish sideways).

// A JPEG APP1/XMP segment carrying a C2PA-style provenance manifest, spliced
// in after SOI the way provider toolchains attach it.
function withFakeProvenance(jpegBuffer) {
  const payload = Buffer.from(
    'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><c2pa:manifest>ai-generated</c2pa:manifest></x:xmpmeta>',
    'utf8'
  );
  const segment = Buffer.alloc(4 + payload.length);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return Buffer.concat([jpegBuffer.subarray(0, 2), segment, jpegBuffer.subarray(2)]);
}

describe('toCleanSocialJpeg (social image metadata hygiene)', () => {
  test('strips EXIF and C2PA/XMP provenance segments from the published bytes', async () => {
    const base = await sharp({
      create: { width: 100, height: 60, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Copyright: 'strip-me', Software: 'ai-image-provider' } })
      .toBuffer();
    const tainted = withFakeProvenance(base);

    // Sanity: the input really carries the markers this test claims to strip.
    expect(tainted.includes('c2pa')).toBe(true);
    expect(tainted.includes('strip-me')).toBe(true);
    const inMeta = await sharp(tainted).metadata();
    expect(inMeta.exif).toBeDefined();
    expect(inMeta.orientation).toBe(6);

    const clean = await toCleanSocialJpeg(tainted);
    expect(clean.includes('c2pa')).toBe(false);
    expect(clean.includes('ns.adobe.com')).toBe(false);
    expect(clean.includes('strip-me')).toBe(false);
    const outMeta = await sharp(clean).metadata();
    expect(outMeta.format).toBe('jpeg');
    expect(outMeta.exif).toBeUndefined();
    expect(outMeta.xmp).toBeUndefined();
    expect(outMeta.orientation).toBeUndefined();
  });

  test('bakes EXIF orientation into pixels instead of dropping it (portrait photos stay upright)', async () => {
    // Orientation 6 = rotate 90° CW to display: a 100x60 sensor image must
    // come out 60x100. Dropping the tag without rotating would leave 100x60.
    const portrait = await sharp({
      create: { width: 100, height: 60, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const clean = await toCleanSocialJpeg(portrait);
    const meta = await sharp(clean).metadata();
    expect(meta.width).toBe(60);
    expect(meta.height).toBe(100);
  });

  test('passes PNG input through to clean JPEG (provider PNGs, brand cards)', async () => {
    const png = await sharp({
      create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 156, b: 222, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const clean = await toCleanSocialJpeg(png);
    const meta = await sharp(clean).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
  });
});
