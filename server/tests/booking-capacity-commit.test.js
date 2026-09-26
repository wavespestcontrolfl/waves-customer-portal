/**
 * Confirm-time whole-route capacity re-check for self-serve bookings
 * (GATE_BOOK_CAPACITY_COMMIT, owner-approved 2026-09-26 dispatch backlog).
 *
 * createSelfBooking's existing commit-time checks (conflictQuery,
 * findConflictingVisits) only re-run the overlap predicate; under
 * GATE_SCHEDULING_CAPACITY the OFFER is stronger (find-time.js certifies each
 * candidate through arrival-route.js's whole-route arrival simulation), so a
 * booking landing on the same tech-day between offer and confirm can make the
 * route infeasible without ever overlapping the exact window. This covers
 * assertBookCapacityCommit's gate wiring and argument-passing contract, and
 * persistBookCapacityOrder's use of the certified fit (Codex #4992 r1 P1:
 * evaluateArrivalPlacement may certify feasibility through a corrected order
 * — clockOrder/storedOrderStale — different from the day's stale stored
 * route_order values; that corrected order must be persisted, not discarded)
 * — both with arrival-route.js mocked (no DB). See
 * booking-capacity-commit-db.test.js for the real end-to-end feasible/
 * infeasible/stale-order proof against PostgreSQL.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockCheckArrivalPlacement = jest.fn();
const mockPersistArrivalOrder = jest.fn();
jest.mock('../services/scheduling/arrival-route', () => ({
  checkArrivalPlacement: (...args) => mockCheckArrivalPlacement(...args),
  persistArrivalOrder: (...args) => mockPersistArrivalOrder(...args),
}));

const { assertBookCapacityCommit, persistBookCapacityOrder } = require('../routes/booking')._internals;

const BASE = {
  trx: { isTransaction: true },
  technicianId: 'tech-1',
  date: '2099-06-01',
  windowStart: '09:00',
  windowEnd: '10:00',
  durationMinutes: 60,
  lat: 27.5,
  lng: -82.4,
  serviceType: 'Pest Control',
};

describe('assertBookCapacityCommit', () => {
  const savedCapacity = process.env.GATE_SCHEDULING_CAPACITY;
  const savedCommit = process.env.GATE_BOOK_CAPACITY_COMMIT;
  afterEach(() => {
    mockCheckArrivalPlacement.mockReset();
    mockPersistArrivalOrder.mockReset();
    if (savedCapacity === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
    else process.env.GATE_SCHEDULING_CAPACITY = savedCapacity;
    if (savedCommit === undefined) delete process.env.GATE_BOOK_CAPACITY_COMMIT;
    else process.env.GATE_BOOK_CAPACITY_COMMIT = savedCommit;
  });

  test('both gates off: no-op, never calls checkArrivalPlacement (gate-off byte-identical)', async () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    delete process.env.GATE_BOOK_CAPACITY_COMMIT;
    await expect(assertBookCapacityCommit(BASE)).resolves.toBeUndefined();
    expect(mockCheckArrivalPlacement).not.toHaveBeenCalled();
  });

  test('GATE_SCHEDULING_CAPACITY on, GATE_BOOK_CAPACITY_COMMIT off: no-op', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    delete process.env.GATE_BOOK_CAPACITY_COMMIT;
    await expect(assertBookCapacityCommit(BASE)).resolves.toBeUndefined();
    expect(mockCheckArrivalPlacement).not.toHaveBeenCalled();
  });

  test('GATE_BOOK_CAPACITY_COMMIT on, GATE_SCHEDULING_CAPACITY off: no-op (both gates required)', async () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_BOOK_CAPACITY_COMMIT = 'true';
    await expect(assertBookCapacityCommit(BASE)).resolves.toBeUndefined();
    expect(mockCheckArrivalPlacement).not.toHaveBeenCalled();
  });

  test('no technicianId (zone/no-tech confirm): no-op even with both gates on', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    process.env.GATE_BOOK_CAPACITY_COMMIT = 'true';
    await expect(assertBookCapacityCommit({ ...BASE, technicianId: null })).resolves.toBeUndefined();
    expect(mockCheckArrivalPlacement).not.toHaveBeenCalled();
  });

  describe('both gates on, technicianId present', () => {
    beforeEach(() => {
      process.env.GATE_SCHEDULING_CAPACITY = 'true';
      process.env.GATE_BOOK_CAPACITY_COMMIT = 'true';
    });

    test('feasible: resolves with the certified fit (the slot still books)', async () => {
      const fit = { feasible: true, routeOrder: ['a', '__candidate__', 'b'] };
      mockCheckArrivalPlacement.mockResolvedValue(fit);
      await expect(assertBookCapacityCommit(BASE)).resolves.toBe(fit);
      expect(mockCheckArrivalPlacement).toHaveBeenCalledTimes(1);
    });

    test('infeasible: refused with the SLOT_TAKEN shape (409, isOperational)', async () => {
      mockCheckArrivalPlacement.mockResolvedValue({ feasible: false, reason: 'arrival_window' });
      await expect(assertBookCapacityCommit(BASE)).rejects.toMatchObject({
        code: 'SLOT_TAKEN', statusCode: 409, isOperational: true,
      });
    });

    test('calls checkArrivalPlacement under the caller\'s OWN transaction (never a second locking scheme) with the exact candidate', async () => {
      mockCheckArrivalPlacement.mockResolvedValue({ feasible: true });
      await assertBookCapacityCommit(BASE);
      expect(mockCheckArrivalPlacement).toHaveBeenCalledWith({
        conn: BASE.trx,
        date: BASE.date,
        technicianId: BASE.technicianId,
        prospective: {
          lat: BASE.lat, lng: BASE.lng,
          estimated_duration_minutes: BASE.durationMinutes,
          service_type: BASE.serviceType,
        },
        windowStart: BASE.windowStart,
        windowEnd: BASE.windowEnd,
        durationMinutes: BASE.durationMinutes,
      });
    });

    test('non-finite lat/lng (no coords resolved) normalize to null rather than NaN', async () => {
      mockCheckArrivalPlacement.mockResolvedValue({ feasible: true });
      await assertBookCapacityCommit({ ...BASE, lat: NaN, lng: NaN });
      expect(mockCheckArrivalPlacement).toHaveBeenCalledWith(expect.objectContaining({
        prospective: expect.objectContaining({ lat: null, lng: null }),
      }));
    });
  });
});

describe('persistBookCapacityOrder', () => {
  afterEach(() => { mockPersistArrivalOrder.mockReset(); });

  test('no fit (the check did not run — gate off or no technician): no-op, never calls persistArrivalOrder', async () => {
    await expect(persistBookCapacityOrder({ isTransaction: true }, undefined, 'visit-1')).resolves.toBeUndefined();
    expect(mockPersistArrivalOrder).not.toHaveBeenCalled();
  });

  test('a certified fit is applied onto the just-inserted row via the shared persistArrivalOrder mechanism', async () => {
    const trx = { isTransaction: true };
    const fit = { feasible: true, routeOrder: ['a', '__candidate__', 'b'], target: { scheduled_date: '2099-06-01', technician_id: 'tech-1' } };
    await persistBookCapacityOrder(trx, fit, 'visit-1');
    expect(mockPersistArrivalOrder).toHaveBeenCalledTimes(1);
    expect(mockPersistArrivalOrder).toHaveBeenCalledWith(trx, fit, 'visit-1');
  });
});
