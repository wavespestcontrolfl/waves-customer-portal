/**
 * The app's own simulator as the day re-plan's last word (services/day-replan/app-sim.js): co-visit rows are one
 * stay in both the baseline and the plan, and a plan the app simulation rejects is never accepted. Synthetic rows.
 */
const { coVisitGroups, coVisitMinutes, appSimCheck, finalVerdict, withHour } = require('../services/day-replan/app-sim');

const HQ = { lat: 27.4330885, lng: -82.4056801 };

function row(id, lngOffset, hour, extra = {}) {
  return {
    id,
    customer_id: `cust-${id}`,
    visit_id: null,
    window_start: `${String(hour).padStart(2, '0')}:00:00`,
    window_end: `${String(hour + 1).padStart(2, '0')}:00:00`,
    time_window: null,
    estimated_duration_minutes: null, // no real estimate: the window span is the stay
    service_type: 'Quarterly Pest Control Service',
    service_address_line1: `${id} Test Ln`,
    service_address_line2: null,
    service_address_city: 'Parrish',
    service_address_zip: '34219',
    customer_address_line1: `${id} Test Ln`,
    customer_city: 'Parrish',
    customer_zip: '34219',
    lat: HQ.lat,
    lng: HQ.lng + lngOffset,
    ...extra,
  };
}

// Two rows for one customer, one property, one promised hour: one physical stop.
const pair = () => [
  row('p1', 0.05, 9, { customer_id: 'cust-pair', service_address_line1: '9 Pair Ln', customer_address_line1: '9 Pair Ln' }),
  row('p2', 0.05, 9, { customer_id: 'cust-pair', service_address_line1: '9 Pair Ln', customer_address_line1: '9 Pair Ln' }),
];

describe('co-visit groups', () => {
  test('same customer, property and window are one group charged one stay', () => {
    const groups = coVisitGroups(pair());
    expect(groups).toHaveLength(1);
    expect(groups[0].map((r) => r.id)).toEqual(['p1', 'p2']);
    // No real estimates: the 60-minute window is one hour on site, not two (the phantom hour).
    expect(coVisitMinutes(groups[0])).toBe(60);
  });

  test('real estimates are additive, floored by the window', () => {
    const rows = pair().map((r) => ({ ...r, estimated_duration_minutes: 45 }));
    expect(coVisitMinutes(coVisitGroups(rows)[0])).toBe(90);
  });

  test('different property, window or customer, or a visit group, are separate stops', () => {
    expect(coVisitGroups([pair()[0], { ...pair()[1], service_address_line1: '10 Other Ln', customer_address_line1: '10 Other Ln' }])).toHaveLength(2);
    expect(coVisitGroups([pair()[0], { ...pair()[1], window_start: '10:00:00', window_end: '11:00:00' }])).toHaveLength(2);
    expect(coVisitGroups([pair()[0], { ...pair()[1], customer_id: 'someone-else' }])).toHaveLength(2);
    expect(coVisitGroups([{ ...pair()[0], visit_id: 'v1' }, { ...pair()[1], visit_id: 'v1' }])).toHaveLength(2);
  });
});

describe('the app simulation', () => {
  const departureMin = 8 * 60;
  const input = (extra = {}) => ({ origin: HQ, departureMin, marginMin: 15, ...extra });

  test('a co-visit pair counts one stay in the baseline and in the plan', () => {
    const groups = coVisitGroups(pair());
    const check = appSimCheck(input({ groups, baselineOrder: ['p1'], best: { order: ['p1'], slots: { p1: 9 * 60 } } }));
    // Arrive after the 09:00 hour opens, stay 60 minutes once: service ends 10:00 plus the drive in.
    expect(check.current.endMin).toBe(check.planned.endMin);
    const oneStay = check.current.endMin;
    // The simulation merges the pair itself even when handed the rows one by one.
    const unmerged = appSimCheck(input({ groups: pair().map((r) => [r]), baselineOrder: ['p1', 'p2'], best: null }));
    expect(unmerged.current.endMin).toBe(oneStay);
    // Two different properties in that hour are two stays: an hour longer.
    const apart = pair();
    apart[1] = { ...apart[1], customer_id: 'cust-other', service_address_line1: '10 Other Ln', customer_address_line1: '10 Other Ln' };
    const two = appSimCheck(input({ groups: apart.map((r) => [r]), baselineOrder: ['p1', 'p2'], best: null }));
    expect(oneStay).toBe(9 * 60 + 60);
    expect(two.current.endMin).toBe(oneStay + 60);
    expect(check.planned.kept).toBe(true);
  });

  test('moving a stop applies its new hour to the row in memory and keeps its width', () => {
    const rows = [row('a', 0.01, 8), row('b', 0.30, 9)];
    const groups = rows.map((r) => [r]);
    const same = appSimCheck(input({ groups, baselineOrder: ['a', 'b'], best: { order: ['a', 'b'], slots: { a: 8 * 60, b: 9 * 60 } } }));
    expect(same.planned.driveMin).toBe(same.current.driveMin);
    // b moved to 14:00: the van waits for the hour, so the day ends later than the baseline.
    const later = appSimCheck(input({ groups, baselineOrder: ['a', 'b'], best: { order: ['a', 'b'], slots: { a: 8 * 60, b: 14 * 60 } } }));
    expect(later.planned.endMin).toBeGreaterThan(same.current.endMin);
  });

  test('every promise is checked against window start + 120 - margin', () => {
    // b is far: arrival is late for a plan that books it at 08:00 behind a.
    const rows = [row('a', 0.01, 8), row('b', 0.40, 8)];
    const check = appSimCheck(input({
      groups: rows.map((r) => [r]), baselineOrder: ['a', 'b'], best: { order: ['a', 'b'], slots: { a: 8 * 60, b: 8 * 60 } },
    }));
    expect(check.planned.kept).toBe(false);
  });
});

describe('the final verdict', () => {
  const accepted = { accepted: true, reason: 'accepted', savedMin: 40 };
  const sim = (driveMin, endMin, kept = true) => ({ driveMin, endMin, kept });

  test('the planner and the app simulation agree: accepted with the app saving', () => {
    expect(finalVerdict(accepted, { current: sim(100, 600), planned: sim(60, 590) }, 10)).toEqual({ accepted: true, reason: 'accepted', savedMin: 40 });
  });

  test.each([
    ['a promise is missed', { current: sim(100, 600), planned: sim(60, 590, false) }],
    ['the day ends later', { current: sim(100, 600), planned: sim(60, 601) }],
    ['the saving is under the floor', { current: sim(100, 600), planned: sim(95, 590) }],
    ['the plan has no app simulation', { current: sim(100, 600), planned: null }],
    ['the baseline has no app simulation', { current: null, planned: null }],
  ])('app_sim_rejects when %s', (_label, check) => {
    const verdict = finalVerdict(accepted, check, 10);
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe('app_sim_rejects');
  });

  test('a planner reject stays rejected with its own reason, and the app saving is reported', () => {
    const verdict = finalVerdict({ accepted: false, reason: 'saving_below_floor', savedMin: 3 }, { current: sim(100, 600), planned: sim(97, 600) }, 10);
    expect(verdict).toEqual({ accepted: false, reason: 'saving_below_floor', savedMin: 3 });
  });
});

describe('withHour', () => {
  test('keeps a booked width, and keeps a visit with no booked end open-ended', () => {
    expect(withHour({ window_start: '08:00:00', window_end: '09:30:00' }, 12 * 60)).toMatchObject({ window_start: '12:00:00', window_end: '13:30:00' });
    expect(withHour({ window_start: '08:00:00', window_end: null }, 12 * 60)).toMatchObject({ window_start: '12:00:00', window_end: null });
  });
});
