/**
 * slot-reservation.js candidateExpectedMinutesFromRow — a combined-visit
 * hold's reservation_service_mix (combined-visit-capacity.js, version 1/2)
 * carries every member's own engine key, but the row's single
 * service_key_snapshot/service_type column can only ever hold ONE identity
 * (Codex #4664 r3 P1): /extend read that one column exclusively, so a
 * legacy multi-service hold's real (summed) credit was never recoverable —
 * only ONE member's identity (or none) ever counted.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-slot-availability', () => ({
  invalidateEstimate: jest.fn(),
  resolveEstimateSlotProfile: jest.fn(),
  resolveCatalogSlotProfile: jest.fn(),
  SLOT_DAY_START_MINUTES: 8 * 60,
  SLOT_DAY_END_MINUTES: 17 * 60,
  MAX_SLOT_HORIZON_DAYS: 90,
}));

const { candidateExpectedMinutesFromRow } = require('../services/slot-reservation')._internals;
const { clearExpectedServiceMinutesCache } = require('../services/scheduling/expected-service-minutes');

function fakeConn(rows) {
  const fn = (table) => {
    if (table !== 'services') throw new Error(`unexpected table ${table}`);
    return { select: async () => rows };
  };
  return fn;
}

const CATALOG = [
  { service_key: 'quarterly_pest', name: 'Quarterly Pest Control Service', category: 'pest_control', min_duration_minutes: 30, max_duration_minutes: 60 },
  { service_key: 'bimonthly_lawn', name: 'Bi-Monthly Lawn Care Service', category: 'lawn_care', min_duration_minutes: 40, max_duration_minutes: 80 },
];

beforeEach(() => clearExpectedServiceMinutesCache());

test('a single-service row (no mix) reads its own service_key_snapshot/service_type — unaffected baseline', async () => {
  const row = { service_key_snapshot: 'quarterly_pest', service_type: 'Quarterly Pest Control Service' };
  expect(await candidateExpectedMinutesFromRow(fakeConn(CATALOG), row, 60)).toBe(45);
});

test('a version-2 combined-visit mix sums each member\'s OWN category credit against its OWN allocated minutes', async () => {
  const row = {
    service_key_snapshot: 'quarterly_pest', // stale/partial identity — must NOT be read when a mix is present
    service_type: 'Quarterly Pest Control Service',
    reservation_service_mix: { version: 2, services: ['pest_control', 'lawn_care'], durations: [60, 60], durationMinutes: 120 },
  };
  // pest_control midpoint 45 (60-min member window) + lawn_care midpoint 60
  // (60-min member window) = 105, clamped to the 120-minute visit window.
  expect(await candidateExpectedMinutesFromRow(fakeConn(CATALOG), row, 120)).toBe(105);
});

test('a version-1 legacy mix (no per-member durations) splits the window evenly across members', async () => {
  const row = {
    reservation_service_mix: { version: 1, services: ['pest_control', 'lawn_care'], durationMinutes: 120 },
  };
  // Each member's own share is 60 (120 / 2 members): same as the v2 case
  // above (45 + 60 = 105) because both catalog rows happen to fit inside
  // a 60-minute member window.
  expect(await candidateExpectedMinutesFromRow(fakeConn(CATALOG), row, 120)).toBe(105);
});

test('a mix member whose engine key has no matching category falls back to its own share of the window', async () => {
  const row = {
    reservation_service_mix: { version: 2, services: ['pest_control', 'termite_bait'], durations: [60, 60], durationMinutes: 120 },
  };
  // pest_control 45 + termite_bait (no category match) 60 = 105.
  expect(await candidateExpectedMinutesFromRow(fakeConn(CATALOG), row, 120)).toBe(105);
});

test('an empty/malformed mix falls back to the single-column lookup', async () => {
  const row = { service_key_snapshot: 'quarterly_pest', reservation_service_mix: { version: 1, services: [] } };
  expect(await candidateExpectedMinutesFromRow(fakeConn(CATALOG), row, 60)).toBe(45);
});

test('no row / non-finite window -> undefined, same as before', async () => {
  expect(await candidateExpectedMinutesFromRow(fakeConn(CATALOG), null, 60)).toBeUndefined();
  expect(await candidateExpectedMinutesFromRow(fakeConn(CATALOG), { service_type: 'x' }, 0)).toBeUndefined();
});
