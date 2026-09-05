const {
  splitTotalAcrossVisits,
  resolveSeriesParentId,
  stampSeriesPrepaid,
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
    it('locks out terminal statuses so a finished or replaced visit is not re-stamped', () => {
      expect(TERMINAL_STATUSES.has('completed')).toBe(true);
      expect(TERMINAL_STATUSES.has('cancelled')).toBe(true);
      expect(TERMINAL_STATUSES.has('no_show')).toBe(true);
      expect(TERMINAL_STATUSES.has('rescheduled')).toBe(true);
      expect(TERMINAL_STATUSES.has('skipped')).toBe(true);
      expect(TERMINAL_STATUSES.has('pending')).toBe(false);
      expect(TERMINAL_STATUSES.has('on_site')).toBe(false);
    });
  });

  describe('stampSeriesPrepaid', () => {
    it('uses the caller transaction when requested', async () => {
      const rows = [
        { id: 'svc-1', recurring_parent_id: null, status: 'pending', scheduled_date: '2026-06-15' },
        { id: 'svc-2', recurring_parent_id: 'svc-1', status: 'pending', scheduled_date: '2026-09-15' },
      ];
      const updates = [];
      let call = 0;
      const trx = jest.fn(() => {
        call += 1;
        const builder = {
          where(arg) {
            if (typeof arg === 'function') arg.call(builder);
            this.whereArg = arg;
            return this;
          },
          orWhere() { return this; },
          whereNotIn() { return this; },
          orderBy() { return this; },
          forUpdate() { this.locked = true; return this; },
          first: jest.fn(async () => rows[0]),
          update: jest.fn((patch) => {
            updates.push({ id: builder.whereArg?.id, patch });
            return builder;
          }),
          returning: jest.fn(async () => [{
            id: builder.whereArg?.id,
            prepaid_amount: builder.update.mock.calls.at(-1)?.[0]?.prepaid_amount,
          }]),
          then(resolve, reject) {
            return Promise.resolve(rows).then(resolve, reject);
          },
        };
        if (call === 1) builder.then = undefined;
        return builder;
      });
      trx.transaction = jest.fn();

      const result = await stampSeriesPrepaid(trx, {
        anchorServiceId: 'svc-1',
        totalAmount: 200,
        method: 'cash',
        useExistingTransaction: true,
      });

      expect(trx.transaction).not.toHaveBeenCalled();
      expect(updates).toEqual([
        expect.objectContaining({ id: 'svc-1', patch: expect.objectContaining({ prepaid_amount: 100 }) }),
        expect.objectContaining({ id: 'svc-2', patch: expect.objectContaining({ prepaid_amount: 100 }) }),
      ]);
      expect(result.updatedRows).toEqual([
        expect.objectContaining({ id: 'svc-1', prepaid_amount: 100 }),
        expect.objectContaining({ id: 'svc-2', prepaid_amount: 100 }),
      ]);
    });

    it('decides eligibility on the LOCKED in-transaction read: a sibling cancelled after the anchor read is not stamped (Codex #3878 r1 P1)', async () => {
      // Anchor read (outside the trx) still shows svc-2 pending; by the time
      // the transaction takes its row locks a series cancel has committed
      // and svc-2 is cancelled. The stamp must fan out over ONE visit.
      const anchor = { id: 'svc-1', recurring_parent_id: null, status: 'pending', scheduled_date: '2026-06-15' };
      const lockedFamily = [
        anchor,
        { id: 'svc-2', recurring_parent_id: 'svc-1', status: 'cancelled', scheduled_date: '2026-09-15' },
      ];
      const updates = [];
      const familyReads = [];
      const makeBuilder = () => {
        const builder = {
          where(arg) { if (typeof arg === 'function') arg.call(builder); this.whereArg = arg; return this; },
          orWhere() { return this; },
          whereNotIn(col, vals) { this.notIn = [col, vals]; return this; },
          orderBy() { return this; },
          forUpdate() { this.locked = true; return this; },
          first: jest.fn(async () => anchor),
          update: jest.fn((patch) => { updates.push({ id: builder.whereArg?.id, patch }); return builder; }),
          returning: jest.fn(async () => [{ id: builder.whereArg?.id }]),
          then(resolve, reject) {
            familyReads.push({ locked: builder.locked === true, terminalExcluded: builder.notIn?.[0] === 'status' && builder.notIn[1].includes('cancelled') });
            return Promise.resolve(lockedFamily).then(resolve, reject);
          },
        };
        return builder;
      };
      const trx = jest.fn(() => makeBuilder());
      const db = jest.fn(() => makeBuilder());
      db.transaction = jest.fn(async (handler) => handler(trx));

      const result = await stampSeriesPrepaid(db, { anchorServiceId: 'svc-1', totalAmount: 200, method: 'cash' });

      expect(db.transaction).toHaveBeenCalledTimes(1);
      // The ONLY family read happens inside the transaction, under FOR UPDATE.
      // ...and locks only the rows it will update — terminal rows are
      // excluded in SQL so the cancel's completed parent is never taken.
      expect(familyReads).toEqual([{ locked: true, terminalExcluded: true }]);
      expect(updates.map((u) => u.id)).toEqual(['svc-1']);
      expect(result.visitsCovered).toBe(1);
      expect(result.perVisitAmount).toBe(200);
    });
  });
});
