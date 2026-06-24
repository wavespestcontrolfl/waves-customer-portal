/**
 * Regression: the citation form-filler sends full-page screenshots to the vision API.
 * A long directory page screenshots to 10k+ px tall, and Anthropic rejects any image
 * whose longest edge exceeds 8000px (400 -> the runner's run-level `llm_error`, which
 * aborts the whole batch). boundedShot must downscale oversized screenshots to within
 * the limit before they reach callVision, while leaving normal screenshots untouched.
 */
const sharp = require('sharp');
const { _internals } = require('../services/seo/browser-form-filler');
const { boundedShot, MAX_SHOT_EDGE } = _internals;

const dims = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
const fakePage = (buf) => ({ screenshot: async () => buf });

describe('browser-form-filler boundedShot', () => {
  test('downscales an over-tall full-page screenshot to within the API limit', async () => {
    const tall = await sharp({ create: { width: 1280, height: 10000, channels: 3, background: '#ffffff' } }).png().toBuffer();
    expect(dims(tall).h).toBeGreaterThan(8000); // would 400 the vision API as-is

    const out = await boundedShot(fakePage(tall));
    const d = dims(out);
    expect(d.w).toBeLessThanOrEqual(MAX_SHOT_EDGE);
    expect(d.h).toBeLessThanOrEqual(MAX_SHOT_EDGE);
    expect(d.h).toBeGreaterThan(d.w); // aspect ratio preserved (still a tall image)
  });

  test('passes a within-limit screenshot through untouched (no re-encode)', async () => {
    const small = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const out = await boundedShot(fakePage(small));
    expect(out).toBe(small);
  });
});
