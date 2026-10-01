/**
 * signCustomerFacingSlots' arrivalGrace signing (owner ruling 2026-09-28,
 * Codex round 2 P1 fallback-audit finding on 95e1f84fdb): grace must be
 * signed as 0 for any slot that did NOT come from find-time/packCapacityEnds
 * — the ONLY generator that runs every candidate through packCapacityEnds'
 * grace-aware buffer waiver and withinArrivalGrace filter before a slot
 * survives to be signed at all. Signing the live grace onto every slot
 * regardless of origin would let a slot from a different generator (today,
 * buildAsapCapacitySlots — which self-guards to `[]` under capacity mode,
 * so this is not a live gap, but signing must not depend on staying correct
 * by accident in a different function) carry a leniency it was never
 * checked against; reserveSlot's real whole-route re-simulation could then
 * refuse it with 'arrival_grace' at a bound TIGHTER than the 120-minute
 * promise such a slot was always meant to keep. Grace must only ever ADD
 * leniency, never subtract it.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { signCustomerFacingSlots } = require('../services/estimate-slot-availability')._internals;
const { splitSignedSlotId } = require('../utils/slot-offer-token');

const ENV_KEYS = ['GATE_SCHEDULING_CAPACITY', 'SELF_SERVE_ARRIVAL_GRACE_MINUTES'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GATE_SCHEDULING_CAPACITY = 'true';
  process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '90';
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const FUTURE_DATE = '2099-06-01'; // never "today" — isolates the routeMode check from the same-day exclusion

function baseSlot(overrides = {}) {
  return {
    slotId: `${FUTURE_DATE}_10-00_tech-1`,
    date: FUTURE_DATE,
    windowStart: '10:00',
    techId: 'tech-1',
    durationMinutes: 60,
    ...overrides,
  };
}

test('a find-time capacity slot (routeMode: arrival_windows) signs the live grace', () => {
  const [signed] = signCustomerFacingSlots([baseSlot({ routeMode: 'arrival_windows' })], 'est-1');
  const parsed = splitSignedSlotId(signed.slotId);
  expect(parsed.arrivalGrace).toBe(90);
});

test('a slot with NO routeMode (any other generator) signs grace 0, never the live env value', () => {
  const [signed] = signCustomerFacingSlots([baseSlot()], 'est-1'); // no routeMode key at all
  const parsed = splitSignedSlotId(signed.slotId);
  expect(parsed.arrivalGrace).toBe(0);
});

test('a slot with a DIFFERENT routeMode value also signs grace 0', () => {
  const [signed] = signCustomerFacingSlots([baseSlot({ routeMode: 'legacy_grid' })], 'est-1');
  expect(splitSignedSlotId(signed.slotId).arrivalGrace).toBe(0);
});

test('routeMode is stripped from the public slot either way (never leaks to the client)', () => {
  const [signed] = signCustomerFacingSlots([baseSlot({ routeMode: 'arrival_windows' })], 'est-1');
  expect(Object.hasOwn(signed, 'routeMode')).toBe(false);
});

test('capacity mode off: every slot signs grace 0 regardless of routeMode (selfServeArrivalGraceMinutes already returns 0)', () => {
  delete process.env.GATE_SCHEDULING_CAPACITY;
  const [signed] = signCustomerFacingSlots([baseSlot({ routeMode: 'arrival_windows' })], 'est-1');
  expect(splitSignedSlotId(signed.slotId).arrivalGrace).toBe(0);
});
