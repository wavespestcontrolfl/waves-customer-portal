const migration = require('../models/migrations/20260627000004_backfill_landline_suppression');
const { normalizeE164, buildSuppressionRows, SOURCE } = migration._internals;

describe('backfill landline suppression — normalizeE164', () => {
  test('normalizes US formats to the +1XXXXXXXXXX key the send path uses', () => {
    expect(normalizeE164('9415550101')).toBe('+19415550101');
    expect(normalizeE164('(941) 555-0101')).toBe('+19415550101');
    expect(normalizeE164('1-941-555-0101')).toBe('+19415550101');
    expect(normalizeE164('+19415550101')).toBe('+19415550101');
    expect(normalizeE164('+1 (941) 555-0101')).toBe('+19415550101');
  });

  test('returns null for empty / unparseable phones (never a junk key)', () => {
    expect(normalizeE164('')).toBeNull();
    expect(normalizeE164(null)).toBeNull();
    expect(normalizeE164('not a phone')).toBeNull();
    expect(normalizeE164('123')).toBeNull(); // too short for E.164
  });
});

describe('backfill landline suppression — buildSuppressionRows', () => {
  test('produces one non_mobile row per unique normalized phone', () => {
    const rows = buildSuppressionRows([
      { id: 1, phone: '+19415550101' },
      { id: 2, phone: '(941) 555-0101' }, // same number, different format → deduped
      { id: 3, phone: '8777175476' },
      { id: 4, phone: '' },               // skipped
      { id: 5, phone: 'garbage' },        // skipped
      { id: 6, phone: '+19415550101' },   // exact dup → deduped
    ]);

    expect(rows).toEqual([
      { phone: '+19415550101', reason: 'non_mobile', source: SOURCE, active: true },
      { phone: '+18777175476', reason: 'non_mobile', source: SOURCE, active: true },
    ]);
  });

  test('does not set created_at (left to the column default)', () => {
    const [row] = buildSuppressionRows([{ id: 1, phone: '9415550101' }]);
    expect(row).not.toHaveProperty('created_at');
  });

  test('handles empty / missing input', () => {
    expect(buildSuppressionRows([])).toEqual([]);
    expect(buildSuppressionRows(undefined)).toEqual([]);
  });
});
