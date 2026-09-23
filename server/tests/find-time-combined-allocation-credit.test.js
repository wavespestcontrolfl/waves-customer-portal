/**
 * find-time.js's buildDayStops — a version-2 combined allocation's expected-
 * minutes credit (Codex r7 P1). occupiedRows (visit-capacity.js) expands
 * every member of a combined allocation to the allocation's SUMMED span (two
 * 60-minute members sharing one 09:00 arrival read as one 09:00-11:00
 * occupied stop), but crediting that expanded stop from only ONE member's
 * own catalog identity understated it: the commit-side probe
 * (occupancy.js's stopCreditResolver, findConflictingVisitsWithTravel) sums
 * every member's OWN credit instead, so the two disagreed on how much of the
 * combined window is real work versus idle padding.
 */
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const { _internals } = require('../services/scheduling/find-time');
const { buildDayStops } = _internals;
const { ensureCatalogLoaded, clearExpectedServiceMinutesCache } = require('../services/scheduling/expected-service-minutes');

const DATE = '2099-01-05';
const TECH = { id: 'tech-1', name: 'Adam' };

// Catalog: min 30 / max 60 -> per-member midpoint 45 when matched against a
// window that fits it (a member's own 60-minute raw span); the SAME row
// still resolves 45 when matched against the wider expanded 120-minute
// window (no clamping either way at this size), so the buggy path (windowMinutes
// = the EXPANDED span, one member's identity) also lands on 45 — the two
// diverge only once summed per member (45 + 45 = 90).
const CATALOG = [{ service_key: null, name: 'pest_control', min_duration_minutes: 30, max_duration_minutes: 60, default_duration_minutes: null }];

function combinedMember(id, start, end) {
  return {
    id, scheduled_date: DATE, technician_id: TECH.id,
    window_start: start, window_end: end, service_type: 'pest_control', service_key_snapshot: null,
    estimated_duration_minutes: null,
    reservation_service_mix: { version: 2, allocatedServiceIds: ['m1', 'm2'] },
    first_name: 'Existing', last_name: 'Stop', city: 'Lakewood Ranch', svc_lat: 27.4, svc_lng: -82.4,
  };
}

beforeEach(async () => {
  clearExpectedServiceMinutesCache();
  db.mockImplementation((table) => {
    if (table !== 'services') throw new Error(`unexpected table ${table}`);
    return { select: async () => CATALOG };
  });
  await ensureCatalogLoaded(db);
});

test('a two-member combined allocation is credited with the SUM of each member\'s own expected minutes, not one member\'s credit against the expanded window', () => {
  const services = [
    combinedMember('m1', '09:00', '10:00'),
    combinedMember('m2', '09:00', '10:00'),
  ];
  const [stop] = buildDayStops(services, {
    tech: TECH, date: DATE, excludeSet: new Set(), wantsPackedEnds: true, wantsExpectedMinutesCredit: true,
  });
  // occupiedRows expands both members to the summed 09:00-11:00 span.
  expect(stop.startMin).toBe(540);
  expect(stop.endMin).toBe(660);
  // Aggregate: 45 (m1's own credit, windowed to its own 60-minute span) +
  // 45 (m2's own credit, same) = 90 — NOT 45 (one member's credit windowed
  // against the full 120-minute expanded span, what the bug computed).
  expect(stop.expectedMinutes).toBe(90);
});

test('a lone (non-allocation) stop is unaffected — same credit as a direct expectedMinutesSync call', () => {
  const services = [{
    id: 'solo', scheduled_date: DATE, technician_id: TECH.id,
    window_start: '13:00', window_end: '14:00', service_type: 'pest_control', service_key_snapshot: null,
    estimated_duration_minutes: null, reservation_service_mix: null,
    first_name: 'Solo', last_name: 'Stop', city: 'Lakewood Ranch', svc_lat: 27.4, svc_lng: -82.4,
  }];
  const [stop] = buildDayStops(services, {
    tech: TECH, date: DATE, excludeSet: new Set(), wantsPackedEnds: true, wantsExpectedMinutesCredit: true,
  });
  expect(stop.startMin).toBe(780);
  expect(stop.endMin).toBe(840);
  expect(stop.expectedMinutes).toBe(45);
});

test('wantsExpectedMinutesCredit false: no expectedMinutes field at all, allocation or not', () => {
  const services = [
    combinedMember('m1', '09:00', '10:00'),
    combinedMember('m2', '09:00', '10:00'),
  ];
  const [stop] = buildDayStops(services, {
    tech: TECH, date: DATE, excludeSet: new Set(), wantsPackedEnds: true, wantsExpectedMinutesCredit: false,
  });
  expect(stop).not.toHaveProperty('expectedMinutes');
});
