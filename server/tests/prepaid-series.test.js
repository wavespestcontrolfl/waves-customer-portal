const {
  splitTotalAcrossVisits,
  resolveSeriesParentId,
  TERMINAL_STATUSES,
} = require('../services/prepaid-series');

describe('prepaid-series helpers', () => {
  describe('splitTotalAcrossVisits', () => {
    it('splits evenly when total divides cleanly', () => {
      expect(splitTotalAcrossVisits(360, 4)).toEqual([90, 90, 90, 90]);
    });

    it('absorbs sub-cent remainder into the final visit so the sum matches', () => {
      const slices = splitTotalAcrossVisits(100, 3);
      expect(slices).toHaveLength(3);
      const sum = Math.round(slices.reduce((a, b) => a + b, 0) * 100) / 100;
      expect(sum).toBe(100);
      expect(slices[0]).toBe(33.33);
      expect(slices[1]).toBe(33.33);
      expect(slices[2]).toBe(33.34);
    });

    it('returns an empty list for zero visits or negative totals', () => {
      expect(splitTotalAcrossVisits(360, 0)).toEqual([]);
      expect(splitTotalAcrossVisits(-50, 4)).toEqual([]);
      expect(splitTotalAcrossVisits(NaN, 4)).toEqual([]);
    });
  });

  describe('resolveSeriesParentId', () => {
    it('returns recurring_parent_id when the row is a child', () => {
      expect(resolveSeriesParentId({ id: 'child-1', recurring_parent_id: 'parent-1' }))
        .toBe('parent-1');
    });

    it('falls back to the row id when there is no parent pointer', () => {
      expect(resolveSeriesParentId({ id: 'self-1' })).toBe('self-1');
    });

    it('handles missing service input', () => {
      expect(resolveSeriesParentId(null)).toBe(null);
      expect(resolveSeriesParentId(undefined)).toBe(null);
    });
  });

  describe('TERMINAL_STATUSES', () => {
    it('locks out completed/cancelled/no_show so a finished visit is not re-stamped', () => {
      expect(TERMINAL_STATUSES.has('completed')).toBe(true);
      expect(TERMINAL_STATUSES.has('cancelled')).toBe(true);
      expect(TERMINAL_STATUSES.has('no_show')).toBe(true);
      expect(TERMINAL_STATUSES.has('pending')).toBe(false);
      expect(TERMINAL_STATUSES.has('on_site')).toBe(false);
    });
  });
});
