/**
 * photo-summary-recovery — the parked photo narrative survives a failed
 * closeout upload and returns once every photo is attached (Codex #4091 P1).
 */
const {
  PENDING_KEY, stripPhotoSummaryForRecovery, hasPendingPhotoSummary,
  restorePhotoSummaryAfterRecovery, completionPhotosFullyRecovered,
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
  test('needs at least uploaded + failed after-photos; no closeout record means nothing to wait for', () => {
    expect(completionPhotosFullyRecovered({ completionPhotos: { uploaded: 1, failed: 2 } }, 3)).toBe(true);
    expect(completionPhotosFullyRecovered({ completionPhotos: { uploaded: 1, failed: 2 } }, '3')).toBe(true);
    expect(completionPhotosFullyRecovered({ completionPhotos: { uploaded: 1, failed: 2 } }, 2)).toBe(false);
    expect(completionPhotosFullyRecovered({ completionPhotos: { uploaded: 0, failed: 1 } }, 0)).toBe(false);
    expect(completionPhotosFullyRecovered({}, 0)).toBe(true);
    expect(completionPhotosFullyRecovered(null, 0)).toBe(true);
  });
});
