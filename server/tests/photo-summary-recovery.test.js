/**
 * photo-summary-recovery — the parked photo narrative survives a failed
 * closeout upload and returns once every photo is attached (Codex #4091 P1).
 */
const {
  PENDING_KEY, stripPhotoSummaryForRecovery, hasPendingPhotoSummary,
  restorePhotoSummaryAfterRecovery, completionPhotosFullyRecovered, expectedImageHashesFor,
} = require('../services/service-report/photo-summary-recovery');

describe('strip / restore', () => {
  test('strip parks the live summary; restore puts it back and clears the parked copy', () => {
    const sd = { typedReportSnapshot: { photoSummary: 'Two after photos show the treated bed line.', other: 1 } };
    expect(stripPhotoSummaryForRecovery(sd).changed).toBe(true);
    expect(sd.typedReportSnapshot.photoSummary).toBeNull();
    expect(sd.typedReportSnapshot[PENDING_KEY]).toBe('Two after photos show the treated bed line.');
    expect(hasPendingPhotoSummary(sd)).toBe(true);
    expect(restorePhotoSummaryAfterRecovery(sd).changed).toBe(true);
    expect(sd.typedReportSnapshot).toEqual({ photoSummary: 'Two after photos show the treated bed line.', other: 1 });
    expect(hasPendingPhotoSummary(sd)).toBe(false);
  });

  test('strip is idempotent and never overwrites a parked copy with null', () => {
    const sd = { typedReportSnapshot: { photoSummary: null, [PENDING_KEY]: 'kept' } };
    expect(stripPhotoSummaryForRecovery(sd).changed).toBe(false);
    expect(sd.typedReportSnapshot[PENDING_KEY]).toBe('kept');
  });

  test('no snapshot / no summary / non-object input are no-ops', () => {
    expect(stripPhotoSummaryForRecovery(null).changed).toBe(false);
    expect(stripPhotoSummaryForRecovery({}).changed).toBe(false);
    expect(stripPhotoSummaryForRecovery({ typedReportSnapshot: {} }).changed).toBe(false);
    expect(restorePhotoSummaryAfterRecovery({ typedReportSnapshot: { [PENDING_KEY]: '  ' } }).changed).toBe(false);
    expect(hasPendingPhotoSummary('x')).toBe(false);
  });
});

describe('completionPhotosFullyRecovered', () => {
  test('with expected hashes: every distinct submitted image needs a row; counts are irrelevant', () => {
    const notes = { completionPhotos: { uploaded: 2, failed: 1, expectedImageHashes: ['a', 'b'] } };
    expect(completionPhotosFullyRecovered(notes, { afterPhotoCount: 2, presentImageHashes: ['a', 'b'] })).toBe(true);
    expect(completionPhotosFullyRecovered(notes, { afterPhotoCount: 3, presentImageHashes: ['a', 'a', 'c'] })).toBe(false);
    expect(completionPhotosFullyRecovered(notes, { afterPhotoCount: 0, presentImageHashes: [] })).toBe(false);
    expect(completionPhotosFullyRecovered(notes, { presentImageHashes: ['b', 'a', null] })).toBe(true);
  });

  test('legacy notes without hashes fall back to uploaded + failed <= after-photo rows', () => {
    expect(completionPhotosFullyRecovered({ completionPhotos: { uploaded: 1, failed: 2 } }, { afterPhotoCount: 3 })).toBe(true);
    expect(completionPhotosFullyRecovered({ completionPhotos: { uploaded: 1, failed: 2 } }, { afterPhotoCount: '3' })).toBe(true);
    expect(completionPhotosFullyRecovered({ completionPhotos: { uploaded: 1, failed: 2 } }, { afterPhotoCount: 2 })).toBe(false);
    expect(completionPhotosFullyRecovered({ completionPhotos: { uploaded: 0, failed: 1, expectedImageHashes: [] } }, { afterPhotoCount: 0 })).toBe(false);
    expect(completionPhotosFullyRecovered({}, { afterPhotoCount: 0 })).toBe(true);
    expect(completionPhotosFullyRecovered(null, {})).toBe(true);
  });
});

describe('expectedImageHashesFor', () => {
  test('hashes the submitted bytes, dedupes identical images, skips empty and undecodable entries', () => {
    const decode = (data) => { if (data === 'bad') throw new Error('nope'); return { buffer: Buffer.from(data) }; };
    const hash = (buf) => `h:${buf.toString()}`;
    expect(expectedImageHashesFor([{ data: 'x' }, { data: 'x' }, { data: 'y' }, { data: 'bad' }, { data: '' }, null], { decode, hash }))
      .toEqual(['h:x', 'h:y']);
    expect(expectedImageHashesFor(undefined, { decode, hash })).toEqual([]);
  });
});
