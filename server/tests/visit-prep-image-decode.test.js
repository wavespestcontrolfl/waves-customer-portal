/**
 * services/visit-prep.js image path with the REAL sharp: every accepted
 * upload is fully decoded and re-encoded as JPEG (Codex #5176 r1 P2 — a
 * header sniff alone admitted truncated payloads the technician could not
 * render), HEIC rides the converter first, converter saturation is a
 * retryable 503, and a genuine decode failure is a 400.
 */

const mockConvertHeicToJpeg = jest.fn();
jest.mock('../services/heic-to-jpeg', () => ({
  convertHeicToJpeg: (...args) => mockConvertHeicToJpeg(...args),
  MAX_HEIC_BYTES: 5 * 1024 * 1024,
}));
jest.mock('../utils/funnel-photos', () => ({ uploadFunnelPhotoToS3: jest.fn(), storeFunnelPhotos: jest.fn(), storeTreeShrubCustomerPhotos: jest.fn() }));
jest.mock('../services/photos', () => ({ deletePhoto: jest.fn() }));
jest.mock('../services/visit-groups', () => ({ lockStopForRow: jest.fn() }));
const mockDb = jest.fn(() => ({}));
mockDb.transaction = async (fn) => fn(mockDb);
jest.mock('../models/db', () => mockDb);

const sharp = require('sharp');
const { _internal: { prepareUploadFile, normalizeToJpeg } } = require('../services/visit-prep');

const HEIC_BYTES = Buffer.concat([Buffer.alloc(4, 0), Buffer.from('ftyp', 'ascii'), Buffer.from('heic', 'ascii'), Buffer.alloc(16, 4)]);
const isJpeg = (buf) => buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;

let realJpeg;
let realPng;
let realWebp;
beforeAll(async () => {
  const base = sharp({ create: { width: 12, height: 8, channels: 3, background: { r: 200, g: 40, b: 30 } } });
  realJpeg = await base.clone().jpeg().toBuffer();
  realPng = await base.clone().png().toBuffer();
  realWebp = await base.clone().webp().toBuffer();
});

describe('normalizeToJpeg', () => {
  test('a real JPEG, PNG, and WebP each come out as a decodable JPEG', async () => {
    for (const input of [realJpeg, realPng, realWebp]) {
      const out = await normalizeToJpeg(input);
      expect(isJpeg(out)).toBe(true);
      const meta = await sharp(out).metadata();
      expect(meta.format).toBe('jpeg');
      expect([meta.width, meta.height]).toEqual([12, 8]);
    }
  });

  test('a header-only payload (valid magic bytes, no image) is refused as an invalid photo', async () => {
    const headerOnly = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
    await expect(normalizeToJpeg(headerOnly)).rejects.toMatchObject({ statusCode: 400, code: 'PREP_INVALID_PHOTO' });
  });

  test('a truncated JPEG is refused, not stored half-broken', async () => {
    const truncated = realJpeg.subarray(0, Math.floor(realJpeg.length / 2));
    await expect(normalizeToJpeg(truncated)).rejects.toMatchObject({ statusCode: 400, code: 'PREP_INVALID_PHOTO' });
  });
});

describe('prepareUploadFile', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a declared JPEG that really is one is stored as normalized JPEG', async () => {
    const out = await prepareUploadFile({ buffer: realJpeg, mimetype: 'image/jpeg' });
    expect(out.mimeType).toBe('image/jpeg');
    expect(isJpeg(out.buffer)).toBe(true);
  });

  test('a declared PNG with PNG bytes is stored as JPEG too (one stored format)', async () => {
    const out = await prepareUploadFile({ buffer: realPng, mimetype: 'image/png' });
    expect(out.mimeType).toBe('image/jpeg');
    expect(isJpeg(out.buffer)).toBe(true);
  });

  test('HEIC: converted first, then normalized like every other upload', async () => {
    mockConvertHeicToJpeg.mockResolvedValue(realJpeg);
    const out = await prepareUploadFile({ buffer: HEIC_BYTES, mimetype: 'image/heic' });
    expect(mockConvertHeicToJpeg).toHaveBeenCalledTimes(1);
    expect(out.mimeType).toBe('image/jpeg');
    expect(isJpeg(out.buffer)).toBe(true);
  });

  test('HEIC converter saturation is a retryable 503, never "invalid"', async () => {
    mockConvertHeicToJpeg.mockRejectedValue(Object.assign(new Error('HEIC conversion capacity is unavailable'), { code: 'HEIC_CAPACITY' }));
    await expect(prepareUploadFile({ buffer: HEIC_BYTES, mimetype: 'image/heic' }))
      .rejects.toMatchObject({ statusCode: 503, code: 'PREP_CONVERTER_BUSY' });
  });

  test('a genuine HEIC decode failure is a 400', async () => {
    mockConvertHeicToJpeg.mockRejectedValue(new Error('HEIC data could not be decoded'));
    await expect(prepareUploadFile({ buffer: HEIC_BYTES, mimetype: 'image/heic' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'PREP_INVALID_PHOTO' });
  });
});
