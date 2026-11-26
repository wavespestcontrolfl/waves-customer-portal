const {
  filterPublicBookedRows,
  selectReviewedBookedRows,
} = require('../services/estimate-converter');

const booked = (overrides = {}) => ({
  id: 'visit-reviewed',
  source_estimate_id: 41,
  customer_id: 73,
  reservation_expires_at: null,
  scheduled_date: '2026-12-10',
  status: 'confirmed',
  ...overrides,
});

describe('estimate converter reviewed booked-visit boundary', () => {
  test('omitted reviewed-booking contract preserves staff/manual linked-row discovery', () => {
    const rows = [booked(), booked({ id: 'visit-other' })];
    expect(selectReviewedBookedRows(rows, { enforce: false })).toBe(rows);
  });

  test('explicit no-visit succeeds only when no caller-reviewable booking remains', () => {
    expect(selectReviewedBookedRows([], {
      enforce: true,
      reviewedBookedVisitId: null,
      estimateId: 41,
      customerId: 73,
    })).toEqual([]);

    expect(() => selectReviewedBookedRows([booked()], {
      enforce: true,
      reviewedBookedVisitId: null,
      estimateId: 41,
      customerId: 73,
    })).toThrow(expect.objectContaining({
      code: 'APPOINTMENT_REFRESH_REQUIRED', status: 412, statusCode: 412,
    }));
  });

  test('an exact newly graduated row is the only selected reservation', () => {
    const row = booked();
    expect(selectReviewedBookedRows([row], {
      enforce: true,
      reviewedBookedVisitId: row.id,
      estimateId: 41,
      customerId: 73,
    })).toEqual([row]);
  });

  test('a second reviewable booking requires office review instead of date-order selection', () => {
    expect(() => selectReviewedBookedRows([
      booked(),
      booked({ id: 'visit-other', scheduled_date: '2026-12-01' }),
    ], {
      enforce: true,
      reviewedBookedVisitId: 'visit-reviewed',
      estimateId: 41,
      customerId: 73,
    })).toThrow(expect.objectContaining({
      code: 'APPOINTMENT_OFFICE_REVIEW_REQUIRED', status: 422, statusCode: 422,
    }));
  });

  test('a missing selected row remains refresh-required even when another booking exists', () => {
    expect(() => selectReviewedBookedRows([booked({ id: 'visit-other' })], {
      enforce: true,
      reviewedBookedVisitId: 'visit-missing',
      estimateId: 41,
      customerId: 73,
    })).toThrow(expect.objectContaining({ code: 'APPOINTMENT_REFRESH_REQUIRED', status: 412 }));
  });

  test.each([
    ['missing selected id', []],
    ['foreign customer', [booked({ customer_id: 999 })]],
    ['wrong estimate stamp', [booked({ source_estimate_id: 99 })]],
    ['live hold instead of booked row', [booked({ reservation_expires_at: new Date('2026-12-01T12:00:00Z') })]],
    ['partial row missing source', [booked({ source_estimate_id: undefined })]],
    ['partial row missing owner', [booked({ customer_id: undefined })]],
    ['partial row missing expiry field', [(() => {
      const row = booked();
      delete row.reservation_expires_at;
      return row;
    })()]],
  ])('%s fails closed', (_label, rows) => {
    expect(() => selectReviewedBookedRows(rows, {
      enforce: true,
      reviewedBookedVisitId: 'visit-reviewed',
      estimateId: 41,
      customerId: 73,
    })).toThrow(expect.objectContaining({ code: 'APPOINTMENT_REFRESH_REQUIRED', status: 412 }));
  });

  test('the selected row bypasses the callback; only competing stamps use it', async () => {
    const selected = booked();
    const historical = booked({ id: 'visit-historical', status: 'cancelled' });
    const competing = booked({ id: 'visit-competing' });
    const isReviewableBookedVisit = jest.fn(async (id) => id === competing.id);

    await expect(filterPublicBookedRows([selected, historical, competing], {
      reviewedBookedVisitId: selected.id,
      isReviewableBookedVisit,
    })).resolves.toEqual([selected, competing]);
    expect(isReviewableBookedVisit.mock.calls).toEqual([
      [historical.id],
      [competing.id],
    ]);
  });

  test('a reviewable competing booking counts with a residual hold timestamp', async () => {
    const selected = booked();
    const residualClaim = booked({
      id: 'visit-residual-claim',
      reservation_expires_at: new Date('2026-12-01T12:00:00Z'),
    });
    const candidates = await filterPublicBookedRows([selected, residualClaim], {
      reviewedBookedVisitId: selected.id,
      isReviewableBookedVisit: async (id) => id === residualClaim.id,
    });
    expect(() => selectReviewedBookedRows(candidates, {
      enforce: true,
      reviewedBookedVisitId: selected.id,
      estimateId: 41,
      customerId: 73,
    })).toThrow(expect.objectContaining({ code: 'APPOINTMENT_OFFICE_REVIEW_REQUIRED', status: 422 }));
  });

  test('explicit no-visit evaluates every stamped row under the caller contract', async () => {
    const legacy = booked({ id: 'legacy' });
    const current = booked({ id: 'current' });
    const rows = await filterPublicBookedRows([legacy, current], {
      reviewedBookedVisitId: null,
      isReviewableBookedVisit: async (id) => id === current.id,
    });
    expect(rows).toEqual([current]);
  });

  test('the explicit contract requires its eligibility callback even with no stamped rows', async () => {
    await expect(filterPublicBookedRows([], {
      reviewedBookedVisitId: null,
    })).rejects.toThrow('reviewedBookedVisitId requires isReviewableBookedVisit');
  });
});
