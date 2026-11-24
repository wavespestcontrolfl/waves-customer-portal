jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/booking-make-room', () => ({ bookingMakeRoomMode: jest.fn(() => 'off') }));
jest.mock('../services/technician-eligibility', () => {
  const actual = jest.requireActual('../services/technician-eligibility');
  return { ...actual, loadTechShifts: jest.fn(async () => () => null) };
});

/**
 * A warm capacity list is rechecked locally against the technician-days a new
 * or extended booking touched. The recheck must judge a card the way cold
 * find-time and reserve do: the technician's shift end, a rival hold's strict
 * travel buffer for a graced card, and a live make-room hold's destination hours.
 */
const db = require('../models/db');
const makeRoom = require('../services/scheduling/booking-make-room');
const technicianEligibility = require('../services/technician-eligibility');
const arrivalRoute = require('../services/scheduling/arrival-route');
const slotOfferToken = require('../utils/slot-offer-token');
const { recheckCachedCapacitySlots } = require('../services/estimate-slot-availability')._internals;

const DATE = '2027-05-20';
const MOVES = { v: 1, date: DATE, techId: 'tech-1', shiftMin: 60, moves: [{ id: 'visit-b', from: '09:00', to: '10:00', widthMin: 60 }] };
const slot = (start, extra = {}) => ({
  slotId: `signed-${start}`, date: DATE, techId: 'tech-1', windowStart: start,
  windowEnd: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`, durationMinutes: 60, ...extra,
});
const rivalHold = (start, end) => ({
  id: 'rival-hold', technician_id: 'tech-1', scheduled_date: DATE, status: 'pending',
  window_start: `${start}:00`, window_end: `${end}:00`, estimated_duration_minutes: 60,
  customer_id: null, reservation_expires_at: '2027-05-14T16:00:00Z', source_estimate_id: 'another-estimate',
  lat: 27.75, lng: -82.15, service_type: 'Pest Control', service_key_snapshot: null, is_recurring: false, is_callback: false,
});

// Query result per select, in order: the affected technician-days, then (mode on) the live make-room holds.
function connReturning(...results) {
  let call = 0;
  const make = () => new Proxy(() => {}, {
    get: (_, name) => {
      if (name === 'select') return async () => results[call++] || [];
      if (name === 'then') return undefined;
      return (...args) => { if (typeof args[0] === 'function') args[0](make()); return make(); };
    },
  });
  return () => make();
}
const AFFECTED = [{ technician_id: 'tech-1', scheduled_date: DATE }];
const run = (slots, conn, extra = {}) => recheckCachedCapacitySlots(slots, {
  dateFrom: DATE, dateTo: DATE, estimateId: 'est-1', coords: { lat: 27.3364, lng: -82.5307 }, durationMinutes: 60,
  prospective: {}, cachedAt: '2027-05-14T15:00:00Z', routeDaySlug: null, candidateExpectedMinutes: 60, conn, ...extra,
});

describe('recheckCachedCapacitySlots', () => {
  let load; let evaluate;
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_SLOT_TRAVEL_GAP;
    makeRoom.bookingMakeRoomMode.mockReturnValue('off');
    technicianEligibility.loadTechShifts.mockResolvedValue(() => null);
    load = jest.spyOn(arrivalRoute, 'loadArrivalRouteContext').mockResolvedValue({ rows: [], target: {} });
    evaluate = jest.spyOn(arrivalRoute, 'evaluateArrivalPlacement').mockReturnValue({ feasible: true, detourMinutes: 0 });
  });
  afterEach(() => { jest.restoreAllMocks(); delete process.env.GATE_SLOT_TRAVEL_GAP; });

  test('the route simulation gets the technician\'s shift end, as cold find-time passes it', async () => {
    technicianEligibility.loadTechShifts.mockResolvedValue(() => ({ startMin: 480, endMin: 17 * 60 }));
    expect(await run([slot('09:00')], connReturning(AFFECTED))).toHaveLength(1);
    expect(evaluate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ shiftEndMin: 17 * 60 }));
    // The simulation refuses an hour that runs past the shift: the card goes.
    evaluate.mockReturnValue({ feasible: false, reason: 'shift_end' });
    expect(await run([slot('09:00')], connReturning(AFFECTED))).toEqual([]);
    // No shift set: the option is not passed.
    evaluate.mockClear();
    technicianEligibility.loadTechShifts.mockResolvedValue(() => null);
    await run([slot('09:00')], connReturning(AFFECTED));
    expect(evaluate.mock.calls[0][1]).not.toHaveProperty('shiftEndMin');
  });

  describe('a graced card and a live rival hold', () => {
    beforeEach(() => { process.env.GATE_SLOT_TRAVEL_GAP = 'true'; });
    const withGrace = (arrivalGrace) => jest.spyOn(slotOfferToken, 'splitSignedSlotId').mockReturnValue({ arrivalGrace });

    test('the hold\'s strict travel buffer drops the card even though the route still fits', async () => {
      withGrace(20);
      load.mockResolvedValue({ rows: [rivalHold('10:00', '11:00')], target: {} });
      expect(await run([slot('09:00')], connReturning(AFFECTED))).toEqual([]);
    });

    test('a hold clear of the buffer, or a card with no grace, stays', async () => {
      withGrace(20);
      load.mockResolvedValue({ rows: [rivalHold('15:00', '16:00')], target: {} });
      expect(await run([slot('09:00')], connReturning(AFFECTED))).toHaveLength(1);
      slotOfferToken.splitSignedSlotId.mockReturnValue({ arrivalGrace: 0 });
      load.mockResolvedValue({ rows: [rivalHold('10:00', '11:00')], target: {} });
      expect(await run([slot('09:00')], connReturning(AFFECTED))).toHaveLength(1);
    });
  });

  test('a make-room hold revived by an expiry-only extension takes its move destination off the list', async () => {
    makeRoom.bookingMakeRoomMode.mockReturnValue('on');
    const live = [{ technician_id: 'tech-1', scheduled_date: DATE, make_room_moves: MOVES }];
    const kept = await run([slot('10:00'), slot('11:00')], connReturning(AFFECTED, live));
    expect(kept.map((s) => s.windowStart)).toEqual(['11:00']);
    // Mode off reads nothing of the chain.
    const off = (makeRoom.bookingMakeRoomMode.mockReturnValue('off'), await run([slot('10:00'), slot('11:00')], connReturning(AFFECTED, live)));
    expect(off.map((s) => s.windowStart)).toEqual(['10:00', '11:00']);
  });
});
