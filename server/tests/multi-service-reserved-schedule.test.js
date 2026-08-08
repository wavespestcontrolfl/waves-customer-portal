/**
 * Multi-service reserved accepts — general promotion + back-to-back stacking
 * (owner directive 2026-08-08, GATE_MULTI_SERVICE_RESERVED_SCHEDULE).
 *
 * The reservation path (every online accept where the customer picks a slot)
 * only ever scheduled the reserved service's series plus a hand-maintained
 * list of promotions: standalone rodent bait, then termite/bond, then
 * mosquito — each added after someone noticed a billed program that scheduled
 * nothing. Lawn and tree & shrub were never promoted, so all four
 * multi-service accepts in prod history scheduled pest and silently dropped
 * lawn; the lawn series was hand-built 6 to 37 days later, once spawning a
 * duplicate pest series that had to be cancelled.
 *
 * These cover the two pure pieces that decision rests on: WHICH lines get
 * promoted, and the clock arithmetic that walks the stacked trip forward.
 */
const {
  combineRecurringServicesForScheduling,
  generallyPromotableRemainingUnits,
  addMinutesToClock,
  alignClockUpToHour,
  recurringServiceKey,
} = require('../services/estimate-converter');

describe('generallyPromotableRemainingUnits', () => {
  test('promotes the lawn line a lawn+pest accept used to drop', () => {
    // The exact shape that produced the prod failures: pest and lawn share no
    // cadence route, so lawn lands in `remaining` and was never scheduled.
    const { remaining, combos } = combineRecurringServicesForScheduling([
      { name: 'Quarterly Pest Control', frequency: 'quarterly', visitsPerYear: 4 },
      { name: 'Every 6 Weeks Lawn Care Service', frequency: 'custom', visitsPerYear: 9 },
    ]);
    expect(combos).toEqual([]);
    const lawn = remaining.filter((svc) => recurringServiceKey(svc) === 'lawn_care');
    expect(lawn).toHaveLength(1);

    const promoted = generallyPromotableRemainingUnits(lawn);
    expect(promoted).toHaveLength(1);
    expect(promoted[0].service.name).toBe('Every 6 Weeks Lawn Care Service');
  });

  test('carries the tree & shrub catalog key so the row links service_id', () => {
    const promoted = generallyPromotableRemainingUnits([
      { service: 'tree_shrub', serviceKey: 'tree_shrub_program', name: 'Bi-Monthly Tree & Shrub Care Service' },
    ]);
    expect(promoted).toHaveLength(1);
    expect(promoted[0].catalogServiceKey).toBe('tree_shrub_program');
  });

  test('leaves lines without a catalog key resolvable by name (auto-schedule parity)', () => {
    const promoted = generallyPromotableRemainingUnits([
      { service: 'lawn_care', name: 'Monthly Lawn Care Service' },
    ]);
    expect(promoted[0].catalogServiceKey).toBeNull();
    expect(promoted[0].service.name).toBe('Monthly Lawn Care Service');
  });

  test('never double-schedules termite or mosquito — their own promotions own the cadence rules', () => {
    const promoted = generallyPromotableRemainingUnits([
      { service: 'mosquito', name: 'Monthly Mosquito Control Service' },
      { service: 'termite_bait', name: 'Termite Bait' },
      { service: 'termite_bond_renewable', name: 'Termite Bond' },
      { service: 'termite_station_rental', name: 'Station Rental' },
    ]);
    expect(promoted).toEqual([]);
  });

  test('skips an unlabeled line rather than inserting a NULL service_type', () => {
    // A NULL service_type throws inside the per-unit try/catch, which
    // completes the accept while scheduling nothing — the precise failure the
    // mosquito r17 normalization closed.
    expect(generallyPromotableRemainingUnits([{ service: 'lawn_care' }])).toEqual([]);
  });

  test('reads a label from any of the three name fields the lines use', () => {
    const promoted = generallyPromotableRemainingUnits([
      { service: 'lawn_care', serviceName: 'Bi-Monthly Lawn Care Service' },
      { service: 'foam_recurring', service_name: 'Foam Program' },
    ]);
    expect(promoted.map((u) => u.service.name))
      .toEqual(['Bi-Monthly Lawn Care Service', 'Foam Program']);
  });

  test('tolerates a non-array without throwing mid-accept', () => {
    expect(generallyPromotableRemainingUnits(undefined)).toEqual([]);
    expect(generallyPromotableRemainingUnits(null)).toEqual([]);
  });
});

describe('addMinutesToClock', () => {
  test('walks a stacked trip forward one visit at a time', () => {
    // Reserved pest 10:00–11:00 → lawn 11:00–12:00 → T&S 12:00–13:00.
    expect(addMinutesToClock('11:00:00', 60)).toBe('12:00:00');
    expect(addMinutesToClock('12:00:00', 60)).toBe('13:00:00');
  });

  test('crosses the hour boundary on non-60 durations', () => {
    expect(addMinutesToClock('10:45:00', 45)).toBe('11:30:00');
    expect(addMinutesToClock('09:50:00', 25)).toBe('10:15:00');
  });

  test('accepts HH:MM as well as HH:MM:SS', () => {
    expect(addMinutesToClock('08:00', 90)).toBe('09:30:00');
  });

  test('returns null instead of wrapping past midnight', () => {
    // A wrapped time would stamp the visit at 00:30 on the RESERVED date —
    // i.e. before the trip it was supposed to follow. Null makes the caller
    // fall back to copying the reserved window.
    expect(addMinutesToClock('23:30:00', 60)).toBeNull();
    expect(addMinutesToClock('23:00:00', 60)).toBeNull();
  });

  test('returns null on unparseable input rather than a bad time literal', () => {
    expect(addMinutesToClock('', 60)).toBeNull();
    expect(addMinutesToClock(null, 60)).toBeNull();
    expect(addMinutesToClock('not-a-time', 60)).toBeNull();
    expect(addMinutesToClock('10:00:00', NaN)).toBeNull();
    expect(addMinutesToClock('10:00:00', undefined)).toBeNull();
  });

  test('holds the boundary exactly at 23:59', () => {
    expect(addMinutesToClock('23:00:00', 59)).toBe('23:59:00');
    expect(addMinutesToClock('23:00:00', 60)).toBeNull();
  });
});

describe('alignClockUpToHour', () => {
  // AGENTS.md (owner 2026-07-27): window_start is ALWAYS HH:00:00. Only
  // window_end is duration-driven and may land off-hour. A stacked start
  // inherited from a 90-minute visit's 10:30 end would violate that.
  test('leaves an already-hour-aligned time alone', () => {
    expect(alignClockUpToHour('11:00:00')).toBe('11:00:00');
    expect(alignClockUpToHour('08:00')).toBe('08:00:00');
  });

  test('rounds an off-hour end UP to the next hour, never down', () => {
    expect(alignClockUpToHour('10:30:00')).toBe('11:00:00');
    expect(alignClockUpToHour('10:15:00')).toBe('11:00:00');
    expect(alignClockUpToHour('10:59:00')).toBe('11:00:00');
  });

  test('returns null rather than rolling into the next day', () => {
    expect(alignClockUpToHour('23:30:00')).toBeNull();
    expect(alignClockUpToHour('23:00:00')).toBe('23:00:00');
  });

  test('returns null on unparseable input', () => {
    expect(alignClockUpToHour('')).toBeNull();
    expect(alignClockUpToHour(null)).toBeNull();
    expect(alignClockUpToHour('nope')).toBeNull();
  });

  test('a 90-minute reserved visit yields an hour-aligned next start', () => {
    // 09:00 + 90min = 10:30 end (a legitimate off-hour END), so the stacked
    // visit must start at 11:00 — not 10:30.
    const reservedEnd = addMinutesToClock('09:00:00', 90);
    expect(reservedEnd).toBe('10:30:00');
    expect(alignClockUpToHour(reservedEnd)).toBe('11:00:00');
  });
});
