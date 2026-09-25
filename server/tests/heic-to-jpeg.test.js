const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { convertHeicToJpeg, MAX_HEIC_BYTES } = require('../services/heic-to-jpeg');

const FIXTURE_PATH = path.join(__dirname, 'fixtures/heic/synthetic-96x64.heic');
const FIXTURE = fs.readFileSync(FIXTURE_PATH);

jest.setTimeout(30_000);

describe('HEIC to JPEG conversion', () => {
  test('decodes a real HEIC in a worker and returns a viewable JPEG', async () => {
    const jpeg = await convertHeicToJpeg(FIXTURE);
    const metadata = await sharp(jpeg).metadata();

    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(metadata).toMatchObject({ format: 'jpeg', width: 96, height: 64 });
  });

  test('rejects malformed data and releases the worker slot for the next conversion', async () => {
    await expect(convertHeicToJpeg(Buffer.from('not a HEIC file'))).rejects.toThrow(/decoded|conversion/i);

    const jpeg = await convertHeicToJpeg(FIXTURE);
    await expect(sharp(jpeg).metadata()).resolves.toMatchObject({ format: 'jpeg' });
  });

  test('enforces byte and decoded-pixel bounds before allocating large RGBA buffers', async () => {
    await expect(convertHeicToJpeg(Buffer.alloc(MAX_HEIC_BYTES + 1))).rejects.toThrow(/size limit/i);

    const oversizedDimensions = Buffer.from(FIXTURE);
    const ispe = oversizedDimensions.indexOf(Buffer.from('ispe'));
    expect(ispe).toBeGreaterThan(0);
    oversizedDimensions.writeUInt32BE(6_000, ispe + 8);
    oversizedDimensions.writeUInt32BE(5_000, ispe + 12);
    await expect(convertHeicToJpeg(oversizedDimensions)).rejects.toThrow(/pixel limit/i);
  });

  test('caps conversion workers at two and accepts work again after both terminate', async () => {
    const results = await Promise.allSettled([
      convertHeicToJpeg(FIXTURE),
      convertHeicToJpeg(FIXTURE),
      convertHeicToJpeg(FIXTURE),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(2);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(results.find(({ status }) => status === 'rejected').reason.message).toMatch(/capacity/i);

    const jpeg = await convertHeicToJpeg(FIXTURE);
    await expect(sharp(jpeg).metadata()).resolves.toMatchObject({ width: 96, height: 64 });
  });

  test('renders the primary image after tiles instead of the first decoded image', async () => {
    const tile = { is_primary: jest.fn(() => false), free: jest.fn() };
    const primary = {
      is_primary: jest.fn(() => true),
      get_width: () => 2,
      get_height: () => 1,
      display: (target, done) => done(target),
      free: jest.fn(),
    };
    const deleteDecoder = jest.fn();
    jest.resetModules();
    jest.doMock('libheif-js/wasm-bundle', () => ({
      HeifDecoder: class {
        constructor() { this.decoder = { delete: deleteDecoder }; }
        decode() { return [tile, primary]; }
      },
    }));
    jest.doMock('sharp', () => () => ({ jpeg: () => ({ toBuffer: async () => Buffer.from('jpeg') }) }));

    const { decodePrimaryToJpeg } = require('../services/heic-to-jpeg-worker');
    await expect(decodePrimaryToJpeg(Buffer.from('mock HEIC'))).resolves.toEqual(Buffer.from('jpeg'));
    expect(primary.is_primary).toHaveBeenCalledTimes(1);
    expect(tile.free).toHaveBeenCalledTimes(1);
    expect(primary.free).toHaveBeenCalledTimes(1);
    expect(deleteDecoder).toHaveBeenCalledTimes(1);
    jest.dontMock('libheif-js/wasm-bundle');
    jest.dontMock('sharp');
  });
});
