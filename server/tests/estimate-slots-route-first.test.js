// Route-first slot ordering (GATE_GEO_SLOT_RANKING): the offered list keeps
// the guaranteed soonest card, then leads with route-fit (routeOptimal) days
// before pure-capacity days. Gate off → soonest-first ordering unchanged.
const { _internals } = require('../services/estimate-slot-availability');

const slot = (date, windowStart, { routeOptimal = false, detour = null, techId = 'tech-1' } = {}) => ({
  slotId: `${date}_${windowStart.replace(':', '-')}_${techId}`,
  date,
  windowStart,
  windowEnd: windowStart.replace(/^(\d{2})/, (h) => String(Number(h) + 1).padStart(2, '0')),
  techId,
  routeOptimal,
  nearbyJob: routeOptimal ? { detourMinutes: detour ?? 5 } : null,
});

describe('route-first customer-facing slot ordering', () => {
  // Three first-day slots so the scarce-first-day pin (≤2) stays out of
  // the way — these tests target the ordering strategies themselves.
  const pool = [
    slot('2026-07-22', '13:00'),                                  // soonest, NOT route-fit
    slot('2026-07-22', '15:00'),
    slot('2026-07-22', '16:00'),
    slot('2026-07-23', '09:00'),
    slot('2026-07-24', '10:00', { routeOptimal: true, detour: 4 }),
    slot('2026-07-25', '11:00'),
    slot('2026-07-27', '13:00', { routeOptimal: true, detour: 9 }),
  ];

  test('default ordering (gate off) is unchanged: day-diversified soonest-first', () => {
    const picks = _internals.selectCustomerFacingSlots(pool, 4).map((s) => s.slotId);
    expect(picks).toEqual([
      '2026-07-22_13-00_tech-1',
      '2026-07-23_09-00_tech-1',
      '2026-07-24_10-00_tech-1',
      '2026-07-25_11-00_tech-1',
    ]);
  });

  test('routeFirst keeps the soonest card, then route-fit days, then the rest', () => {
    const picks = _internals
      .selectCustomerFacingSlots(pool, 6, { routeFirst: true })
      .map((s) => s.slotId);
    expect(picks).toEqual([
      '2026-07-22_13-00_tech-1',  // guaranteed soonest option
      '2026-07-24_10-00_tech-1',  // route-fit days next…
      '2026-07-27_13-00_tech-1',
      '2026-07-22_15-00_tech-1',  // …then pure-capacity days, diversified
      '2026-07-23_09-00_tech-1',
      '2026-07-25_11-00_tech-1',
    ]);
  });

  test('a route-fit soonest card is not duplicated', () => {
    const routeSoonest = [
      slot('2026-07-22', '13:00', { routeOptimal: true, detour: 3 }),
      slot('2026-07-23', '09:00'),
      slot('2026-07-24', '10:00', { routeOptimal: true, detour: 6 }),
    ];
    const picks = _internals
      .selectCustomerFacingSlots(routeSoonest, 3, { routeFirst: true })
      .map((s) => s.slotId);
    expect(picks).toEqual([
      '2026-07-22_13-00_tech-1',
      '2026-07-24_10-00_tech-1',
      '2026-07-23_09-00_tech-1',
    ]);
  });

  test('no route-fit slots degrades to the default spread', () => {
    const noRoute = [
      slot('2026-07-22', '13:00'),
      slot('2026-07-23', '09:00'),
      slot('2026-07-24', '10:00'),
    ];
    expect(_internals.selectCustomerFacingSlots(noRoute, 3, { routeFirst: true }).map((s) => s.slotId))
      .toEqual(_internals.selectCustomerFacingSlots(noRoute, 3).map((s) => s.slotId));
  });
});
