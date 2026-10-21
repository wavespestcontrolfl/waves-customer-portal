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
    await expect(assertPhotoWithinPixels(await tinyJpegClaiming(8000, 6000))).rejects.toBeInstanceOf(PhotoTooLargeError); // 48 MP sensor mode
    await expect(assertPhotoWithinPixels(await tinyJpegClaiming(6000, 4500))).rejects.toBeInstanceOf(PhotoTooLargeError); // 27 MP
    await expect(assertPhotoWithinPixels(await tinyJpegClaiming(6000, 4000))).resolves.toBeUndefined(); // 24 MP camera default
    await expect(assertPhotoWithinPixels(await tinyJpegClaiming(4032, 3024))).resolves.toBeUndefined(); // 12 MP phone
    await expect(assertPhotoWithinPixels(await tinyJpegClaiming(24000, 1000))).resolves.toBeUndefined(); // 24 MP panorama
    await expect(assertPhotoWithinPixels(await tinyJpegClaiming(26000, 1000))).rejects.toBeInstanceOf(PhotoTooLargeError); // 26 MP
    expect(MAX_PHOTO_PIXELS).toBe(25_000_000);
    expect(MAX_CONCURRENT_TRANSCODES).toBe(1);
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

describe('withTranscodeSlot hands a released slot straight to the next waiter', () => {
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  test('in a burst of 8 callers with interleaved releases the running count never passes 2, and every caller runs', async () => {
    const gates = Array.from({ length: 8 }, deferred);
    let running = 0;
    let peak = 0;
    const started = [];
    const calls = gates.map((gate, i) => withTranscodeSlot(async () => {
      running += 1;
      peak = Math.max(peak, running);
      started.push(i);
      await gate.promise;
      running -= 1;
      return i;
    }));
    await tick();
    expect(started).toEqual(Array.from({ length: MAX_CONCURRENT_TRANSCODES }, (_, i) => i)); // only the first caller(s) run; the rest wait
    // release in an interleaved order while new callers keep arriving between a release and the waiter's wake-up
    const late = [];
    for (const i of [1, 0, 3, 2, 5, 4]) {
      gates[i].resolve();
      // two microtask hops: the late caller runs after the releaser's finally has run and before the woken waiter's
      // continuation, the exact window a slot that is released and then re-taken would leak through
      late.push(Promise.resolve().then(() => {}).then(() => withTranscodeSlot(async () => { running += 1; peak = Math.max(peak, running); await tick(); running -= 1; return 'late'; })));
      await tick();
      expect(running).toBeLessThanOrEqual(MAX_CONCURRENT_TRANSCODES);
    }
    gates[6].resolve();
    gates[7].resolve();
    const results = await Promise.all([...calls, ...late]);
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_TRANSCODES);
    expect(results.slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(results.filter((r) => r === 'late')).toHaveLength(6);
    // nothing leaked: a fresh caller runs at once
    let ran = false;
    await withTranscodeSlot(async () => { ran = true; });
    expect(ran).toBe(true);
  });

  test('a waiter holding a handed-off slot that throws still frees it for the next', async () => {
    const hold = [deferred()];
    const holders = hold.map((d) => withTranscodeSlot(() => d.promise));
    const failing = withTranscodeSlot(async () => { throw new Error('boom'); });
    const after = withTranscodeSlot(async () => 'after');
    await tick();
    hold[0].resolve();
    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('after');
    await Promise.all(holders);
  });
});
