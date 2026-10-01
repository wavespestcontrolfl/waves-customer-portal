/**
 * Rival-hold strict buffer at reserve time (Codex r4 P1 on #5314): another
 * estimate's live hold on the SAME tech/date can be minted DURING a signed
 * offer's 45-minute life. reserveSlot's grace check (verifyArrivalCapacity's
 * arrivalGraceMinutes) only compares the candidate's own simulated delay
 * against the signed grace — it never re-applies the strict travel-gap
 * BUFFER to a hold that didn't exist yet when packCapacityEnds screened this
 * offer, so two holds could graduate without the buffer the contract
 * promises a live hold always keeps ("a live hold never gets the waiver").
 *
 * refuseGracedOfferOnRivalHoldConflict (slot-reservation.js) closes this:
 * for a GRACED offer only, load the date's current live holds for this
 * technician (or unassigned) — excluding this estimate's own — and refuse
 * if the candidate would violate the strict travel-gap buffer against any
 * of them, reusing find-time.js's own row-expansion/entity-shaping
 * (expandRowsWithCredit/capacityNeighbourEntity) rather than a hand-rolled
 * shape.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { refuseGracedOfferOnRivalHoldConflict } = require('../services/slot-reservation')._internals;
const { clearExpectedServiceMinutesCache } = require('../services/scheduling/expected-service-minutes');

const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  clearExpectedServiceMinutesCache();
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// A bare-bones fake knex trx: every constraint method chains, `.select()`
// resolves to the configured rows for 'scheduled_services', and 'services'
// (the expected-minutes catalog read) resolves empty — no catalog match, so
// every row/candidate falls back to its own window length (zero padding,
// the legacy drive+buffer gap) exactly like the packCapacityEnds tests.
function makeTrx({ scheduledServicesRows = [] } = {}) {
  let capturedTechFilter = null;
  const chain = {
    where: jest.fn((arg) => {
      if (typeof arg === 'function') capturedTechFilter = arg;
      return chain;
    }),
    whereNot: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
    whereNotNull: jest.fn(() => chain),
    whereRaw: jest.fn(() => chain),
    select: jest.fn(async () => scheduledServicesRows),
  };
  const trx = jest.fn((table) => {
    if (table === 'scheduled_services') return chain;
    if (table === 'services') return { select: jest.fn(async () => []) };
    throw new Error(`unexpected table ${table}`);
  });
  return { trx, chain, getCapturedTechFilter: () => capturedTechFilter };
}

// Co-located (zero modeled drive) hold row, shaped like a raw
// scheduled_services row (window_start/window_end, not startMin/endMin —
// expandRowsWithCredit does that expansion).
function holdRow(id, windowStart, windowEnd, overrides = {}) {
  return {
    id, technician_id: 'tech-1', customer_id: null, scheduled_date: '2027-06-01',
    window_start: windowStart, window_end: windowEnd,
    estimated_duration_minutes: null, lat: 27.4, lng: -82.4,
    service_type: 'pest_control', service_key_snapshot: null,
    reservation_expires_at: '2099-01-01T00:00:00Z', reservation_service_mix: null,
    source_estimate_id: 'rival-estimate',
    ...overrides,
  };
}

const BASE_OPTS = {
  estimateId: 'this-estimate', date: '2027-06-01', techId: 'tech-1',
  slotStartMinutes: 660, effectiveDurationMinutes: 60, // 11:00-12:00
  holdPin: { lat: 27.4, lng: -82.4 }, candidateExpectedMinutes: undefined,
};

test('grace 0: never even queries — byte-identical no-op', async () => {
  const { trx } = makeTrx({ scheduledServicesRows: [holdRow('rival-1', '10:00', '11:00')] });
  await expect(refuseGracedOfferOnRivalHoldConflict(trx, {
    ...BASE_OPTS, useCapacity: true, offerArrivalGrace: 0,
  })).resolves.toBeUndefined();
  expect(trx).not.toHaveBeenCalled();
});

test('useCapacity false: never queries, even with a positive grace', async () => {
  const { trx } = makeTrx({ scheduledServicesRows: [holdRow('rival-1', '10:00', '11:00')] });
  await expect(refuseGracedOfferOnRivalHoldConflict(trx, {
    ...BASE_OPTS, useCapacity: false, offerArrivalGrace: 90,
  })).resolves.toBeUndefined();
  expect(trx).not.toHaveBeenCalled();
});

test('a rival hold minted after the offer (co-located, touching the candidate) is refused at grace > 0', async () => {
  // Hold 10:00-11:00, candidate 11:00-12:00: 0 free minutes vs the 15-minute
  // buffer (no catalog credit either side) — violates.
  const { trx } = makeTrx({ scheduledServicesRows: [holdRow('rival-1', '10:00', '11:00')] });
  await expect(refuseGracedOfferOnRivalHoldConflict(trx, {
    ...BASE_OPTS, useCapacity: true, offerArrivalGrace: 90,
  })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'rival_hold_travel_gap' });
});

test('a far rival hold (no real conflict) is fine — grace > 0 does not refuse for no reason', async () => {
  // Hold 06:00-07:00 — hours before the candidate's 11:00 start.
  const { trx } = makeTrx({ scheduledServicesRows: [holdRow('rival-1', '06:00', '07:00')] });
  await expect(refuseGracedOfferOnRivalHoldConflict(trx, {
    ...BASE_OPTS, useCapacity: true, offerArrivalGrace: 90,
  })).resolves.toBeUndefined();
});

test('no rival holds at all: resolves without ever reaching the catalog/travel-gap machinery', async () => {
  const { trx } = makeTrx({ scheduledServicesRows: [] });
  await expect(refuseGracedOfferOnRivalHoldConflict(trx, {
    ...BASE_OPTS, useCapacity: true, offerArrivalGrace: 90,
  })).resolves.toBeUndefined();
});

test('gate off (GATE_SLOT_TRAVEL_GAP unset): violatesTravelGap itself no-ops, so even a touching hold is fine', async () => {
  delete process.env.GATE_SLOT_TRAVEL_GAP;
  const { trx } = makeTrx({ scheduledServicesRows: [holdRow('rival-1', '10:00', '11:00')] });
  await expect(refuseGracedOfferOnRivalHoldConflict(trx, {
    ...BASE_OPTS, useCapacity: true, offerArrivalGrace: 90,
  })).resolves.toBeUndefined();
});

describe('the technician filter itself excludes another technician\'s hold', () => {
  test('with a technician candidate: the filter checks unassigned OR this exact tech, never another', async () => {
    const { trx, getCapturedTechFilter } = makeTrx({ scheduledServicesRows: [] });
    await refuseGracedOfferOnRivalHoldConflict(trx, { ...BASE_OPTS, useCapacity: true, offerArrivalGrace: 90 });
    const filter = getCapturedTechFilter();
    expect(filter).toBeInstanceOf(Function);
    const calls = { whereNull: [], orWhere: [] };
    filter({
      whereNull: (col) => { calls.whereNull.push(col); return this; },
      orWhere: (col, val) => { calls.orWhere.push([col, val]); return this; },
    });
    expect(calls.whereNull).toEqual(['technician_id']);
    // Only THIS candidate's own tech ('tech-1') is OR'd in — a hold for
    // 'tech-2' matches neither whereNull('technician_id') nor
    // orWhere('technician_id', 'tech-1'), so it is excluded at the SQL level.
    expect(calls.orWhere).toEqual([['technician_id', 'tech-1']]);
  });

  test('with an unassigned candidate (techId null): the filter is unassigned-only, no orWhere at all', async () => {
    const { trx, getCapturedTechFilter } = makeTrx({ scheduledServicesRows: [] });
    await refuseGracedOfferOnRivalHoldConflict(trx, {
      ...BASE_OPTS, techId: null, useCapacity: true, offerArrivalGrace: 90,
    });
    const filter = getCapturedTechFilter();
    const calls = { whereNull: [], orWhere: [] };
    filter({
      whereNull: (col) => { calls.whereNull.push(col); return this; },
      orWhere: (col, val) => { calls.orWhere.push([col, val]); return this; },
    });
    expect(calls.whereNull).toEqual(['technician_id']);
    expect(calls.orWhere).toEqual([]);
  });
});
