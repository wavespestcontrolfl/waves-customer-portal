// #4741 (2026-09-24): a technician tap became the score directly (tap 3 =
// 3.0) while older scores were blended (tap 3 = 0.9) and were never
// recalculated. The gauge's "vs. last visit" trend must only compare a new
// score with a previous score of the SAME kind.

const { loadPreviousScore } = require('../services/pest-pressure/store');
const { calculatePestPressureScore } = require('../services/pest-pressure/calculate');
const { DEFAULT_CONFIG } = require('../services/pest-pressure/config');

const TAP = { technicianActivityRating: { value: 3, weight: 100, present: true } };
const BLENDED = { clientRating: { value: 3, weight: 25, present: true } };

// Rows are newest first, like the ORDER BY service_date DESC the query asks for.
function fakeKnex(rows) {
  return () => {
    const q = {};
    ['where', 'whereNot', 'whereNotNull', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.limit = jest.fn(() => q);
    q.select = jest.fn(() => Promise.resolve(rows));
    q.first = jest.fn(() => Promise.resolve(rows[0]));
    return q;
  };
}

const june = { displayed_score: '0.9', service_date: '2026-06-10', service_record_id: 'rec-june', component_scores: BLENDED };
const sep = { displayed_score: '4.0', service_date: '2026-09-25', service_record_id: 'rec-sep', component_scores: TAP };
const args = { customerId: 'cust-synthetic-1', serviceLine: 'pest', beforeServiceRecordId: 'rec-now', beforeServiceDate: '2026-09-28' };

describe('loadPreviousScore scale awareness', () => {
  test('a tap-scored completion ignores an older blended score (no baseline, no trend)', async () => {
    const result = await loadPreviousScore(fakeKnex([june]), { ...args, currentScale: 'technician_rating' });
    expect(result).toEqual({ value: null });
  });

  test('and the persisted trend is then the same as a first score', () => {
    const previous = null;
    const result = calculatePestPressureScore({
      clientRating: null, technicianRating: null, reServiceImpact: null, recurringIssueRating: null, riskFactorRating: null,
      previousScore: previous, technicianDirectRating: 3,
    }, DEFAULT_CONFIG);
    expect(result.trend).toBe('first_marker');
    expect(result.trendDelta ?? null).toBeNull();
  });

  test('a tap-scored completion skips blended rows and uses the newest tap-scored one', async () => {
    const result = await loadPreviousScore(fakeKnex([june, sep].reverse()), { ...args, currentScale: 'technician_rating' });
    expect(result).toMatchObject({ value: 4, serviceRecordId: 'rec-sep' });
  });

  test('a blended completion skips tap-scored rows', async () => {
    const result = await loadPreviousScore(fakeKnex([sep, june]), { ...args, currentScale: 'blended' });
    expect(result).toMatchObject({ value: 0.9, serviceRecordId: 'rec-june' });
  });

  test('without currentScale the legacy newest-any-scale lookup is unchanged', async () => {
    const result = await loadPreviousScore(fakeKnex([sep, june]), args);
    expect(result).toMatchObject({ value: 4, serviceRecordId: 'rec-sep' });
  });

  test('a score row with unreadable components falls back to the cutover date', async () => {
    const legacyJune = { ...june, component_scores: null };
    const undated = await loadPreviousScore(fakeKnex([legacyJune]), { ...args, currentScale: 'technician_rating' });
    expect(undated).toEqual({ value: null });
    const legacyBlendedLike = await loadPreviousScore(fakeKnex([legacyJune]), { ...args, currentScale: 'blended' });
    expect(legacyBlendedLike).toMatchObject({ value: 0.9 });
  });
});
