// Returning customer $99 rule (owner 2026-11-24, GATE_RETURNING_SETUP_FEE_GAP): a customer who cancelled and
// comes back pays the WaveGuard setup fee again only when the gap from the last completed visit of the same plan
// is longer than one cycle + 30 days. The case that started it: a quarterly pest customer, last visit Aug 21,
// back Nov 24 (95 days), was charged $99 because the old waiver counted active plans only.

const waiver = require('../services/returning-setup-fee-waiver');
const converter = require('../services/estimate-converter');
const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');

const property = { homeSqFt: 2200, stories: 1, lotSqFt: 12000, propertyType: 'single_family' };
const soloQuarterlyPest = () => ({
  result: mapV1ToLegacyShape(generateEstimate({ ...property, services: { pest: { frequency: 'quarterly' } } })),
});

// Minimal knex double for the history reads (the customer row, plan visits, add-on lines, and the catalog rows
// behind a closeout's frozen add-on lines). The default customer holds no plan: a cancelled customer's row.
function fakeDb(rows, addonRows = [], catalog = [], customer = { id: 'c-1', active: true, waveguard_tier: null, monthly_rate: null }) {
  const calls = [];
  const db = (table) => {
    const q = {
      join() { return q; },
      leftJoin() { return q; },
      whereNotNull(col) { calls.push({ table, whereNotNull: col }); return q; },
      where(arg, op, value) { calls.push({ table, arg, op, value }); return q; },
      whereIn(col, values) { calls.push({ table, whereIn: col, values }); return q; },
      orWhereIn(col, values) { calls.push({ table, whereIn: col, values }); return q; },
      orderBy() { return q; },
      limit() { return q; },
      first() { return customer instanceof Error ? Promise.reject(customer) : Promise.resolve(customer); },
      select() {
        if (table === 'services') return Promise.resolve(catalog);
        return Promise.resolve(table.startsWith('scheduled_service_addons') ? addonRows : rows);
      },
    };
    return q;
  };
  db.calls = calls;
  db.raw = (sql) => ({ sql });
  return db;
}

const NOV_24_NOON_ET = new Date('2026-11-24T17:00:00Z');

// The decision a save makes: one history read from the verified account, then the pure decision on the priced plan.
const decideFor = async (db, estimateData, now = NOV_24_NOON_ET) => waiver.decideReturningSetupFeeWaiverForPlan(
  converter.recurringServicesFromEstimateData(estimateData),
  await waiver.loadReturningVisitHistory(db, { customerId: 'c-1', now }),
);

describe('returning customer setup fee window', () => {
  afterEach(() => { delete process.env.GATE_RETURNING_SETUP_FEE_GAP; });

  test('window is one cycle plus 30 days', () => {
    expect(waiver.windowDaysForVisitsPerYear(4)).toBe(121);
    expect(waiver.windowDaysForVisitsPerYear(6)).toBe(91);
    expect(waiver.windowDaysForVisitsPerYear(12)).toBe(60);
    expect(waiver.windowDaysForVisitsPerYear(0)).toBeNull();
  });

  test('inside the window waives, past it charges, the last day still waives', () => {
    const base = { todayKey: '2026-11-24', visitsPerYear: 4, family: 'pest_control' };
    expect(waiver.decideReturningSetupFeeWaiver({ ...base, lastVisitKey: '2026-08-21' }))
      .toEqual(expect.objectContaining({ rule: 'returning_customer_gap', gapDays: 95, windowDays: 121 }));
    expect(waiver.decideReturningSetupFeeWaiver({ ...base, lastVisitKey: '2026-07-26' })).toEqual(expect.objectContaining({ gapDays: 121 }));
    expect(waiver.decideReturningSetupFeeWaiver({ ...base, lastVisitKey: '2026-07-25' })).toBeNull();
    expect(waiver.decideReturningSetupFeeWaiver({ ...base, lastVisitKey: '2026-12-01' })).toBeNull();
  });

  test('gate off: no read, no waiver', async () => {
    const db = fakeDb([{ scheduled_date: '2026-08-21', service_type: 'Pest Control Service', is_recurring: true, recurring_pattern: 'quarterly' }]);
    expect(await decideFor(db, soloQuarterlyPest())).toBeNull();
    expect(db.calls).toHaveLength(0);
  });

  test('gate on: a quarterly pest customer back after 95 days gets the waiver', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const db = fakeDb([
      { scheduled_date: '2026-10-02', service_type: 'Lawn Care', is_recurring: true },
      { scheduled_date: new Date(2026, 7, 21), service_type: 'Pest Control Service', is_recurring: null, recurring_parent_id: 'root-1', recurring_pattern: 'quarterly' },
    ]);
    const stamp = await decideFor(db, soloQuarterlyPest());
    expect(stamp).toEqual(expect.objectContaining({
      family: 'pest_control', lastCompletedVisitDate: '2026-08-21', decidedOn: '2026-11-24', gapDays: 95, windowDays: 121,
    }));
    expect(db.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'scheduled_services as s', arg: { 's.customer_id': 'c-1', 's.status': 'completed' } }),
    ]));
    // No lower date bound and no row limit: a series longer than a year must still be found.
    expect(db.calls).not.toEqual(expect.arrayContaining([expect.objectContaining({ arg: 's.scheduled_date', op: '>=' })]));
  });

  test('gate on: the gap runs from the day the visit was performed', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    // Scheduled 122 days back (charges), performed a day later at 121 (waives).
    const db = fakeDb([{
      scheduled_date: '2026-07-25', performed_date: '2026-07-26', service_type: 'Pest Control Service', is_recurring: true, recurring_pattern: 'quarterly',
    }]);
    expect(await decideFor(db, soloQuarterlyPest()))
      .toEqual(expect.objectContaining({ lastCompletedVisitDate: '2026-07-26', gapDays: 121 }));
    // A completed visit scheduled after today never hides an earlier qualifying one.
    const ahead = fakeDb([
      { scheduled_date: '2026-11-30', service_type: 'Pest Control Service', is_recurring: true, recurring_pattern: 'quarterly' },
      { scheduled_date: '2026-08-21', service_type: 'Pest Control Service', is_recurring: true, recurring_pattern: 'quarterly' },
    ]);
    expect(await decideFor(ahead, soloQuarterlyPest()))
      .toEqual(expect.objectContaining({ gapDays: 95 }));
  });

  test('gate on: a termite foam visit under a stale pest label is never pest evidence', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const db = fakeDb([{
      scheduled_date: '2026-10-01', service_type: 'Pest Control', service_key: 'foam_recurring', service_name: 'Recurring Termite Foam Service',
      is_recurring: true, recurring_pattern: 'quarterly',
    }]);
    expect(await decideFor(db, soloQuarterlyPest())).toBeNull();
  });

  test('gate on: a moved seasonal visit walks from the slot it holds, not the day it moved to', () => {
    const moved = waiver.oldSeriesCycleDays({
      scheduled_date: '2026-10-14', date_exception: true, date_exception_cadence_date: '2026-09-15', recurring_pattern: 'seasonal_feb_oct',
    });
    const inSlot = waiver.oldSeriesCycleDays({ scheduled_date: '2026-09-15', recurring_pattern: 'seasonal_feb_oct' });
    expect(moved).toBe(inSlot);
  });

  test('gate on: a legacy child with no pattern follows its parent series cadence', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const monthlyPest = { result: mapV1ToLegacyShape(generateEstimate({ ...property, services: { pest: { frequency: 'monthly' } } })) };
    const db = fakeDb([{
      scheduled_date: '2026-08-21', service_type: 'Pest Control Service', is_recurring: null, recurring_parent_id: 'root-1', parent_pattern: 'quarterly',
    }]);
    expect(await decideFor(db, monthlyPest))
      .toEqual(expect.objectContaining({ gapDays: 95, windowDays: 121 }));
  });

  test('gate on: two plan visits on the same day pick the later completion, whatever the row order', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const monthly = { visit_id: 'v-a', completed_at: '2026-08-21T14:00:00Z', scheduled_date: '2026-08-21', service_type: 'Pest Control Service', is_recurring: true, recurring_pattern: 'monthly' };
    const quarterly = { visit_id: 'v-b', completed_at: '2026-08-21T18:00:00Z', scheduled_date: '2026-08-21', service_type: 'Pest Control Service', is_recurring: true, recurring_pattern: 'quarterly' };
    for (const rows of [[monthly, quarterly], [quarterly, monthly]]) {
      expect(await decideFor(fakeDb(rows), soloQuarterlyPest()))
        .toEqual(expect.objectContaining({ windowDays: 121 }));
    }
  });

  test('gate on: a lawn-rounds cycle walks from the series anchor, not the visit day', () => {
    const fromAnchor = waiver.oldSeriesCycleDays({
      scheduled_date: '2026-08-21', recurring_pattern: 'lawn_rounds_9', recurring_parent_id: 'root-1', parent_round_anchor: '2026-02-02',
    });
    const seeder = require('../services/recurring-appointment-seeder');
    const expected = Math.round((Date.parse(`${seeder.nextRecurringDate('2026-08-21', 'lawn_rounds_9', 1, { roundAnchor: '2026-02-02' })}T00:00:00Z`)
      - Date.parse('2026-08-21T00:00:00Z')) / 86400000);
    expect(fromAnchor).toBe(expected);
  });

  test('gate on: a legacy pattern name reads as the scheduler reads it', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    expect(waiver.oldSeriesCycleDays({ scheduled_date: '2026-08-21', recurring_pattern: 'bi-monthly' })).toBe(61);
    expect(waiver.oldSeriesCycleDays({ scheduled_date: '2026-08-21', recurring_pattern: 'Quarterly' })).toBe(91);
    const monthlyPest = { result: mapV1ToLegacyShape(generateEstimate({ ...property, services: { pest: { frequency: 'monthly' } } })) };
    // Bi-monthly before, monthly now, back after 80 days: the old 91-day window waives.
    const db = fakeDb([{ scheduled_date: '2026-09-05', service_type: 'Pest Control Service', is_recurring: true, recurring_pattern: 'bi-monthly' }]);
    expect(await decideFor(db, monthlyPest))
      .toEqual(expect.objectContaining({ gapDays: 80, windowDays: 91 }));
  });

  test('gate on: a custom series longer than a year uses its own window', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    // Every 400 days, back after 410: inside 400 + 30.
    const db = fakeDb([{
      scheduled_date: '2025-10-10', service_type: 'Pest Control Service', is_recurring: true, recurring_pattern: 'custom', recurring_interval_days: 400,
    }]);
    expect(await decideFor(db, soloQuarterlyPest()))
      .toEqual(expect.objectContaining({ gapDays: 410, windowDays: 430 }));
  });

  test('gate on: only a visit of the same family counts, and a long gap charges', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const lawnOnly = fakeDb([{ scheduled_date: '2026-11-01', service_type: 'Lawn Care', is_recurring: true }]);
    expect(await decideFor(lawnOnly, soloQuarterlyPest())).toBeNull();
    const longGap = fakeDb([{ scheduled_date: '2026-05-01', service_type: 'Pest Control Service', is_recurring: true, recurring_pattern: 'quarterly' }]);
    expect(await decideFor(longGap, soloQuarterlyPest())).toBeNull();
  });

  test('gate on: one-time visits, callbacks and included follow-ups never count', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const db = fakeDb([
      { scheduled_date: '2026-11-10', service_type: 'Pest Control Service', is_recurring: false },
      { scheduled_date: '2026-11-05', service_type: 'Pest Control Service', is_recurring: false, recurring_parent_id: 'root-1' },
      { scheduled_date: '2026-11-01', service_type: 'Pest Control Service', is_recurring: true, is_callback: true },
      { scheduled_date: '2026-10-20', service_type: 'Pest Control Service', is_recurring: true, followup_included: true },
    ]);
    expect(await decideFor(db, soloQuarterlyPest())).toBeNull();
  });

  test('gate on: the window is the OLD plan cycle, whatever cadence the new plan has', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const monthlyPest = { result: mapV1ToLegacyShape(generateEstimate({ ...property, services: { pest: { frequency: 'monthly' } } })) };
    const wasQuarterly = fakeDb([{ scheduled_date: '2026-08-21', service_type: 'Pest Control Service', is_recurring: true, recurring_pattern: 'quarterly' }]);
    expect(await decideFor(wasQuarterly, monthlyPest))
      .toEqual(expect.objectContaining({ gapDays: 95, windowDays: 121 }));
    const wasMonthly = fakeDb([{ scheduled_date: '2026-08-21', service_type: 'Pest Control Service', is_recurring: true, recurring_pattern: 'monthly' }]);
    expect(await decideFor(wasMonthly, soloQuarterlyPest())).toBeNull();
  });

  test('gate on: the linked catalog identity outranks a stale label', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const db = fakeDb([{
      scheduled_date: '2026-11-01', service_type: 'Pest Control', is_recurring: true, recurring_pattern: 'monthly',
      service_key: 'lawn_care_monthly', service_name: 'Lawn Care',
    }]);
    expect(await decideFor(db, soloQuarterlyPest())).toBeNull();
  });

  test('gate on: one-time catalog work and one-time bookings are not plan evidence', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const db = fakeDb([
      { scheduled_date: '2026-11-10', service_type: 'Pest Control', is_recurring: true, recurring_pattern: 'quarterly', catalog_billing_type: 'one_time' },
      { scheduled_date: '2026-11-01', service_type: 'Commercial Pest Control', is_recurring: true, recurring_pattern: 'quarterly' },
    ]);
    expect(await decideFor(db, soloQuarterlyPest())).toBeNull();
  });

  test('gate on: a recurring add-on line on another plan visit counts, at its own cadence', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const mosquito = { result: mapV1ToLegacyShape(generateEstimate({ ...property, services: { mosquito: { tier: 'monthly' } } })) };
    const db = fakeDb(
      [{ scheduled_date: '2026-11-17', service_type: 'Lawn Care', is_recurring: true, recurring_pattern: 'every_6_weeks' }],
      [{ scheduled_date: '2026-11-17', service_type: 'Mosquito Control', is_recurring: true, line_pattern: 'monthly' }],
    );
    expect(await decideFor(db, mosquito))
      .toEqual(expect.objectContaining({
        family: 'mosquito', gapDays: 7,
        windowDays: 60,
      }));
  });

  test('gate on: a seasonal mosquito plan uses its real winter gap to the next round', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const octToFeb = waiver.oldSeriesCycleDays({ scheduled_date: '2026-10-15', recurring_pattern: 'seasonal_feb_oct' });
    expect(octToFeb).toBeGreaterThan(100);
    const mosquito = { result: mapV1ToLegacyShape(generateEstimate({ ...property, services: { mosquito: { tier: 'monthly' } } })) };
    const db = fakeDb([{ scheduled_date: '2026-10-15', service_type: 'Mosquito Control', is_recurring: true, recurring_pattern: 'seasonal_feb_oct' }]);
    expect(await decideFor(db, mosquito, new Date('2027-01-20T17:00:00Z')))
      .toEqual(expect.objectContaining({ family: 'mosquito', gapDays: 97, windowDays: octToFeb + 30 }));
  });

  test('gate on: add-on lines follow the schedule: one_time never counts, no pattern rides the parent cadence', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const mosquito = { result: mapV1ToLegacyShape(generateEstimate({ ...property, services: { mosquito: { tier: 'monthly' } } })) };
    const oneTime = fakeDb([], [{ scheduled_date: '2026-11-17', service_type: 'Mosquito Control', is_recurring: true, recurring_pattern: 'quarterly', line_pattern: 'one_time' }]);
    expect(await decideFor(oneTime, mosquito)).toBeNull();
    const inherits = fakeDb([], [{ scheduled_date: '2026-08-21', service_type: 'Mosquito Control', is_recurring: true, recurring_pattern: 'quarterly', line_pattern: null }]);
    expect(await decideFor(inherits, mosquito))
      .toEqual(expect.objectContaining({ family: 'mosquito', gapDays: 95, windowDays: 121 }));
  });

  // An account with an active plan is the existing-member waiver's, which the accept checks again. Regression
  // (pre-push audit 2026-11-25): the rule stored a second, permanent waiver for a member, and it outlived the plan.
  test('gate on: an active member is never under the rule; a cancelled customer is; a failed member lookup fails the read', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const recentPest = [{ scheduled_date: '2026-11-01', service_type: 'Pest Control Service', is_recurring: true, recurring_pattern: 'quarterly' }];
    for (const member of [{ id: 'c-1', active: true, waveguard_tier: 'Silver' }, { id: 'c-1', active: true, waveguard_tier: null, monthly_rate: 45 }]) {
      const db = fakeDb(recentPest, [], [], member);
      expect(await waiver.loadReturningVisitHistory(db, { customerId: 'c-1', now: NOV_24_NOON_ET })).toBeNull();
      expect(db.calls.map((call) => call.table)).toEqual(['customers']);
    }
    // The cancellation cleared the tier and the rate: the rule decides.
    expect(await decideFor(fakeDb(recentPest), soloQuarterlyPest())).toEqual(expect.objectContaining({ gapDays: 23 }));
    await expect(waiver.loadReturningVisitHistory(fakeDb(recentPest, [], [], new Error('customers down')), { customerId: 'c-1' }))
      .rejects.toThrow('customers down');
  });

  // The closeout freezes the visit's place in its plan series (service_data.completedSeries): a frequency change
  // rewrites the series root's schedule row after its visits completed. Regression (pre-push audit 2026-11-25): a
  // quarterly customer whose series was changed to monthly before the cancellation owed $99 at 95 days.
  describe('gate on: a closeout that froze its plan series is read by it, not by the schedule row', () => {
    const quarterly = { planVisit: true, pattern: 'quarterly', cycleDays: 91 };
    const nowMonthly = { is_recurring: true, recurring_pattern: 'monthly' };
    const visit = (scheduleNow, series) => ({
      visit_id: 'visit-1', scheduled_date: '2026-08-21', service_type: 'Pest Control Service', ...scheduleNow,
      frozen: { primary: false, key: null, name: null, addonLines: null, series },
    });
    beforeEach(() => { process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true'; });

    test('a quarterly visit whose series changed to monthly afterwards keeps its quarterly window', async () => {
      // 95 days back: inside the quarterly window (121), past the monthly one (60).
      expect(await decideFor(fakeDb([visit(nowMonthly, quarterly)]), soloQuarterlyPest()))
        .toEqual(expect.objectContaining({ gapDays: 95, windowDays: 121 }));
      // A closeout from before the freeze reads the schedule row of today.
      expect(await decideFor(fakeDb([visit(nowMonthly, null)]), soloQuarterlyPest())).toBeNull();
    });

    test('whether the visit was a plan application is the closeout\'s answer', async () => {
      // The row later reads as a one-time visit: still the plan application it was.
      expect(await decideFor(fakeDb([visit({ is_recurring: false }, quarterly)]), soloQuarterlyPest()))
        .toEqual(expect.objectContaining({ gapDays: 95, windowDays: 121 }));
      // Completed as a one-time visit, linked to a series afterwards: never a plan application.
      const oneTime = { planVisit: false, pattern: null, cycleDays: null };
      expect(await decideFor(fakeDb([visit({ is_recurring: true, recurring_pattern: 'quarterly' }, oneTime)]), soloQuarterlyPest())).toBeNull();
    });

    test('an add-on line that rides the visit takes the frozen cycle; a line with its own cadence keeps its own', async () => {
      const mosquito = { result: mapV1ToLegacyShape(generateEstimate({ ...property, services: { mosquito: { tier: 'monthly' } } })) };
      const MOSQUITO_ID = '11111111-1111-4111-8111-111111111111';
      const catalog = [{ id: MOSQUITO_ID, service_key: 'mosquito_monthly', name: 'Mosquito Control', billing_type: 'recurring' }];
      const lawnVisit = (addonLines) => ({
        ...visit({ ...nowMonthly, service_type: 'Lawn Care' }, quarterly),
        frozen: { primary: false, key: null, name: null, addonLines, series: quarterly },
      });
      const line = (pattern) => ({ serviceId: MOSQUITO_ID, serviceName: 'Mosquito Control', serviceKey: 'mosquito_monthly', recurrence: { pattern } });
      expect(await decideFor(fakeDb([lawnVisit([line(null)])], [], catalog), mosquito))
        .toEqual(expect.objectContaining({ family: 'mosquito', gapDays: 95, windowDays: 121 }));
      expect(await decideFor(fakeDb([lawnVisit([line('monthly')])], [], catalog), mosquito)).toBeNull();
      // A closeout that froze the series and no line list: the schedule's line rides the frozen cycle too.
      const scheduleLine = { ...lawnVisit(null), service_type: 'Mosquito Control', addon_service_id: MOSQUITO_ID, line_pattern: null };
      expect(await decideFor(fakeDb([lawnVisit(null)], [scheduleLine], catalog), mosquito))
        .toEqual(expect.objectContaining({ family: 'mosquito', gapDays: 95, windowDays: 121 }));
    });

    // The completion's one read of the visit's schedule row, as a knex double.
    const completing = (row) => { const q = { leftJoin: () => q, where: () => q, first: () => Promise.resolve(row) }; return () => q; };

    test('a completion freezes the cadence the visit ran on: its own, or its parent series\' when it has none', async () => {
      const freeze = (row) => waiver.frozenPlanSeriesForCompletion('visit-1', completing(row));
      expect(await freeze({ scheduled_date: '2026-08-21', is_recurring: true, recurring_pattern: 'quarterly' }))
        .toEqual({ series: quarterly, addonLines: null });
      expect((await freeze({ scheduled_date: '2026-08-21', is_recurring: null, recurring_parent_id: 'root-1', parent_pattern: 'bimonthly' })).series)
        .toEqual({ planVisit: true, pattern: 'bimonthly', cycleDays: 61 });
      expect((await freeze({ scheduled_date: '2026-08-21', is_recurring: false })).series).toEqual({ planVisit: false, pattern: null, cycleDays: null });
      expect(await freeze(undefined)).toBeNull();
    });

    // A line's own cadence is walked from the series slot its visit holds, and the completion freezes that cycle.
    // Regression (pre-push audit 2026-11-25): a September seasonal round performed in October was walked from the
    // performed day (October to February), so a customer back in January paid no $99.
    test('a seasonal add-on line performed a month late keeps the cycle of its own slot', async () => {
      const mosquito = { result: mapV1ToLegacyShape(generateEstimate({ ...property, services: { mosquito: { tier: 'monthly' } } })) };
      const septemberSlot = waiver.oldSeriesCycleDays({ scheduled_date: '2026-09-15', recurring_pattern: 'seasonal_feb_oct' });
      const fromOctober = waiver.oldSeriesCycleDays({ scheduled_date: '2026-10-14', recurring_pattern: 'seasonal_feb_oct' });
      expect(fromOctober - septemberSlot).toBeGreaterThan(60);
      // The lawn visit moved from its Sep 15 slot to Oct 14 and was performed that day.
      const moved = {
        visit_id: 'visit-1', scheduled_date: '2026-10-14', date_exception: true, date_exception_cadence_date: '2026-09-15',
        performed_date: '2026-10-14', service_type: 'Lawn Care', is_recurring: true, recurring_pattern: 'monthly',
      };
      const seasonal = { pattern: 'seasonal_feb_oct', intervalDays: null, nth: null, weekday: null };
      const line = (recurrence) => ({ serviceId: null, serviceName: 'Mosquito Control', recurrence });
      const frozen = await waiver.frozenPlanSeriesForCompletion('visit-1', completing(moved), [line(seasonal), line({ ...seasonal, pattern: null })]);
      // The line with its own cadence gets its cycle; the line that rides the visit gets none.
      expect(frozen.addonLines).toEqual([line({ ...seasonal, cycleDays: septemberSlot }), line({ ...seasonal, pattern: null })]);
      const visit = (addonLines) => ({ ...moved, frozen: { primary: false, key: null, name: null, addonLines, series: frozen.series } });
      // Read by the frozen cycle; a closeout that froze the cadence with no cycle walks the schedule row's slot.
      for (const lines of [[frozen.addonLines[0]], [line(seasonal)]]) {
        // Nov 24, 41 days after the visit: inside the slot's window. Jan 20, 98 days after: past it.
        expect(await decideFor(fakeDb([visit(lines)]), mosquito))
          .toEqual(expect.objectContaining({ family: 'mosquito', gapDays: 41, windowDays: septemberSlot + 30 }));
        expect(await decideFor(fakeDb([visit(lines)]), mosquito, new Date('2027-01-20T17:00:00Z'))).toBeNull();
      }
      // A frozen cycle is the answer, whatever the schedule row says afterwards.
      const editedLater = { ...visit([frozen.addonLines[0]]), date_exception: false, date_exception_cadence_date: null };
      expect(await decideFor(fakeDb([editedLater]), mosquito, new Date('2027-01-20T17:00:00Z'))).toBeNull();
    });
  });

  // The closeout freezes what the visit performed: its service (service_data.completedServiceKey with the label
  // of that day) and its add-on lines with their cadence (completedAddonLines). The schedule row and its lines can
  // be edited after the visit. Regressions (pre-push audits 2026-11-25): an edit of a completed visit's schedule
  // changes who owes the $99.
  describe('gate on: a closeout that froze its service is read by that service, not by the schedule row', () => {
    const catalog = [
      { id: '33333333-3333-4333-8333-333333333333', service_key: 'pest_general_quarterly', name: 'Quarterly Pest Control', billing_type: 'recurring' },
      { id: '44444444-4444-4444-8444-444444444444', service_key: 'pest_general_one_time', name: 'One-Time Pest Control', billing_type: 'one_time' },
    ];
    const visit = (scheduleNow, frozen) => ({
      visit_id: 'visit-1', scheduled_date: '2026-08-21', is_recurring: true, recurring_pattern: 'quarterly', ...scheduleNow,
      frozen: { primary: true, addonLines: [], ...frozen },
    });
    const pointedAtLawn = { service_type: 'Lawn Care', service_key: 'lawn_care_monthly', service_name: 'Monthly Lawn Care' };
    const pointedAtPest = { service_type: 'Pest Control Service', service_key: 'pest_general_quarterly', service_name: 'Quarterly Pest Control' };
    beforeEach(() => { process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true'; });

    test('a completed pest visit later pointed at lawn still counts as pest: by the frozen key, or by the frozen label when no key was frozen', async () => {
      for (const frozen of [{ key: 'pest_general_quarterly', name: 'Pest Control Service' }, { key: null, name: 'Pest Control Service' }]) {
        expect(await decideFor(fakeDb([visit(pointedAtLawn, frozen)], [], catalog), soloQuarterlyPest()))
          .toEqual(expect.objectContaining({ family: 'pest_control', gapDays: 95, windowDays: 121 }));
      }
    });

    test('a completed lawn visit later pointed at pest is not pest evidence', async () => {
      for (const frozen of [{ key: 'lawn_care_monthly', name: 'Lawn Care' }, { key: null, name: 'Lawn Care' }]) {
        expect(await decideFor(fakeDb([visit(pointedAtPest, frozen)], [], catalog), soloQuarterlyPest())).toBeNull();
      }
    });

    test('the frozen key brings its own catalog facts: a one-time catalog service is not plan evidence', async () => {
      const db = fakeDb([visit(pointedAtPest, { key: 'pest_general_one_time', name: 'Pest Control Service' })], [], catalog);
      expect(await decideFor(db, soloQuarterlyPest())).toBeNull();
      expect(db.calls).toContainEqual({ table: 'services', whereIn: 'service_key', values: ['pest_general_one_time'] });
    });
  });

  describe('gate on: a closeout that froze its add-on lines is read from that list, not from the schedule', () => {
    const MOSQUITO_ID = '11111111-1111-4111-8111-111111111111';
    const AERATION_ID = '22222222-2222-4222-8222-222222222222';
    const mosquito = () => ({ result: mapV1ToLegacyShape(generateEstimate({ ...property, services: { mosquito: { tier: 'monthly' } } })) });
    const lawnVisit = (addonLines) => ({
      visit_id: 'visit-1', scheduled_date: '2026-11-17', service_type: 'Lawn Care', is_recurring: true, recurring_pattern: 'quarterly',
      frozen: { primary: false, key: null, name: null, addonLines },
    });
    const scheduleLine = (extra = {}) => ({
      visit_id: 'visit-1', scheduled_date: '2026-11-17', service_type: 'Mosquito Control', is_recurring: true, recurring_pattern: 'quarterly',
      addon_service_id: MOSQUITO_ID, line_pattern: 'monthly', ...extra,
    });
    const frozenLine = (extra = {}) => ({ serviceId: MOSQUITO_ID, serviceName: 'Mosquito Control', serviceKey: 'mosquito_monthly', ...extra });
    const catalog = [{ id: MOSQUITO_ID, service_key: 'mosquito_monthly', name: 'Mosquito Control', billing_type: 'recurring' }];
    beforeEach(() => { process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true'; });

    test('a frozen plan line counts after its schedule line was removed, at the cadence the closeout froze', async () => {
      // Read by the frozen key, and by the catalog id when no key was frozen.
      const monthly = { recurrence: { pattern: 'monthly' } };
      for (const line of [frozenLine(monthly), { serviceId: MOSQUITO_ID, serviceName: null, ...monthly }]) {
        const db = fakeDb([lawnVisit([line])], [], catalog);
        expect(await decideFor(db, mosquito())).toEqual(expect.objectContaining({ family: 'mosquito', gapDays: 7, windowDays: 60 }));
        expect(db.calls).toContainEqual({ table: 'services', whereIn: 'id', values: [MOSQUITO_ID] });
      }
      // No pattern: the line rode the visit's own cadence (quarterly).
      const rides = fakeDb([lawnVisit([frozenLine({ recurrence: { pattern: null } })])], [], catalog);
      expect(await decideFor(rides, mosquito())).toEqual(expect.objectContaining({ family: 'mosquito', windowDays: 121 }));
    });

    test('a frozen one_time line is one application, whatever the schedule says now', async () => {
      const oneTime = [frozenLine({ recurrence: { pattern: 'one_time' } })];
      // The schedule line removed (a line with no cadence would ride the visit's), or edited to a plan cadence.
      expect(await decideFor(fakeDb([lawnVisit(oneTime)], [], catalog), mosquito())).toBeNull();
      expect(await decideFor(fakeDb([lawnVisit(oneTime)], [scheduleLine()], catalog), mosquito())).toBeNull();
    });

    test('a schedule line added or pointed at mosquito after the visit is not evidence', async () => {
      // The closeout froze no add-on line, and one whose line was another service.
      expect(await decideFor(fakeDb([lawnVisit([])], [scheduleLine()], catalog), mosquito())).toBeNull();
      const frozeAeration = [{ serviceId: AERATION_ID, serviceName: 'Core Aeration', serviceKey: 'lawn_aeration', recurrence: { pattern: null } }];
      const aeration = { id: AERATION_ID, service_key: 'lawn_aeration', name: 'Core Aeration', billing_type: 'one_time' };
      expect(await decideFor(fakeDb([lawnVisit(frozeAeration)], [scheduleLine()], [...catalog, aeration]), mosquito())).toBeNull();
    });

    test('an older closeout froze no cadence: the schedule line of the same service gives it, and with no such line the frozen line is not evidence', async () => {
      const older = [frozenLine()];
      expect(await decideFor(fakeDb([lawnVisit(older)], [scheduleLine()], catalog), mosquito()))
        .toEqual(expect.objectContaining({ family: 'mosquito', gapDays: 7, windowDays: 60 }));
      expect(await decideFor(fakeDb([lawnVisit(older)], [scheduleLine({ line_pattern: 'one_time' })], catalog), mosquito())).toBeNull();
      // The line removed, or the visit's line now another service's: nothing proves the frozen line was a plan line.
      expect(await decideFor(fakeDb([lawnVisit(older)], [], catalog), mosquito())).toBeNull();
      expect(await decideFor(fakeDb([lawnVisit(older)], [scheduleLine({ addon_service_id: AERATION_ID })], catalog), mosquito())).toBeNull();
    });

    // The schedule takes an add-on typed with no catalog service. Regression (pre-push audit 2026-11-25): the
    // closeout froze such a line's name and cadence, the read dropped it, and the frozen list hid the schedule
    // line, so a mosquito customer back a week after a treatment owed $99.
    test('a frozen line saved with a name only is read by that name', async () => {
      const named = (recurrence) => [{ serviceId: null, serviceName: 'Mosquito Control', ...(recurrence ? { recurrence } : {}) }];
      const own = fakeDb([lawnVisit(named({ pattern: 'monthly' }))], [], catalog);
      expect(await decideFor(own, mosquito())).toEqual(expect.objectContaining({ family: 'mosquito', gapDays: 7, windowDays: 60 }));
      expect(own.calls.some((call) => call.table === 'services')).toBe(false);
      // No pattern rides the visit's cadence (quarterly); one_time is one application.
      expect(await decideFor(fakeDb([lawnVisit(named({ pattern: null }))], [], catalog), mosquito()))
        .toEqual(expect.objectContaining({ family: 'mosquito', windowDays: 121 }));
      expect(await decideFor(fakeDb([lawnVisit(named({ pattern: 'one_time' }))], [], catalog), mosquito())).toBeNull();
      // An older closeout froze no cadence: the schedule line of the same name with no catalog service gives it.
      const nameOnly = (service_type) => scheduleLine({ addon_service_id: null, service_type });
      expect(await decideFor(fakeDb([lawnVisit(named())], [nameOnly('Mosquito Control')], catalog), mosquito()))
        .toEqual(expect.objectContaining({ family: 'mosquito', gapDays: 7, windowDays: 60 }));
      // A line of another name, a catalog line, or no line: nothing proves the frozen line was a plan line.
      for (const lines of [[nameOnly('Mosquito Barrier')], [scheduleLine()], []]) {
        expect(await decideFor(fakeDb([lawnVisit(named())], lines, catalog), mosquito())).toBeNull();
      }
    });

    test('a closeout from before the frozen list reads the schedule line, and makes no catalog read', async () => {
      const db = fakeDb([lawnVisit(null)], [scheduleLine()], catalog);
      expect(await decideFor(db, mosquito())).toEqual(expect.objectContaining({ family: 'mosquito', gapDays: 7 }));
      expect(db.calls.some((call) => call.table === 'services')).toBe(false);
    });
  });

  test('gate on: a visit closed as declined, inspection only or incomplete is not an application', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    for (const visit_outcome of ['customer_declined', 'inspection_only', 'incomplete']) {
      const db = fakeDb([{ scheduled_date: '2026-11-01', service_type: 'Pest Control Service', is_recurring: true, recurring_pattern: 'quarterly', visit_outcome }]);
      expect(await decideFor(db, soloQuarterlyPest())).toBeNull();
    }
  });

  test('a read failure is thrown to the caller, never read as "no history"', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const db = () => { throw new Error('db down'); };
    await expect(waiver.loadReturningVisitHistory(db, { customerId: 'c-1' })).rejects.toThrow('db down');
  });

  test('gate on: with no linked service, the stored key outranks the label', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const db = fakeDb([{
      scheduled_date: '2026-11-01', service_type: 'Pest Control', is_recurring: true, recurring_pattern: 'quarterly',
      service_key_snapshot: 'lawn_care_monthly',
    }]);
    expect(await decideFor(db, soloQuarterlyPest())).toBeNull();
  });

  test('gate on: a day-based old series (biweekly, custom interval) uses its own interval', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    // The scheduler's own next date (nextRecurringDate) decides the old cycle.
    const at = (pattern, extra = {}) => waiver.oldSeriesCycleDays({ scheduled_date: '2026-08-21', recurring_pattern: pattern, ...extra });
    expect(at('biweekly')).toBe(14);
    expect(at('custom', { recurring_interval_days: 42 })).toBe(42);
    // No interval: the scheduler's fallback gap (91 days), so a quarterly-like old series keeps its 121-day window.
    expect(at('custom')).toBe(91);
    expect(at('every_6_weeks')).toBe(42);
    // Month-based plans use the owner's fixed cycle (windows 60 / 91 / 121), never a weekday projection, and the
    // interval column counts only for a custom series.
    expect(at('quarterly', { recurring_interval_days: 30 })).toBe(91);
    expect(at('bimonthly')).toBe(61);
    expect(at('monthly')).toBe(30);
    expect(at('one_time')).toBeNull();
    expect(at('daily')).toBe(1);
    expect(at('semiannual')).toBe(183);
    expect(at('no_such_pattern')).toBeNull();
    const wasBiweekly = fakeDb([{ scheduled_date: '2026-09-15', service_type: 'Pest Control Service', is_recurring: true, recurring_pattern: 'biweekly' }]);
    expect(await decideFor(wasBiweekly, soloQuarterlyPest())).toBeNull();
  });

  test('gate on: a bundle carries no fee, so the rule has nothing to waive', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const db = fakeDb([{ scheduled_date: '2026-11-01', service_type: 'Pest Control Service', is_recurring: true, recurring_pattern: 'quarterly' }]);
    const bundle = { result: mapV1ToLegacyShape(generateEstimate({ ...property, services: { pest: { frequency: 'quarterly' }, mosquito: {} } })) };
    expect(await decideFor(db, bundle)).toBeNull();
  });
});

// The price: the rule decides inside the one mapping step a save and the estimate tool's preview share.
describe('returning customer setup fee: the priced result', () => {
  const { agentEngineResultDigest } = require('../services/agent-estimate-preview');
  const history = (family) => ({ todayKey: '2026-11-24', lastByFamily: { [family]: { lastVisitKey: '2026-08-21', cycleDays: 91 } } });
  const engine = (services) => generateEstimate({ ...property, services });

  test('no history (gate off, no customer): the plain mapped result, fee in', () => {
    const { mapped, waiver: none } = waiver.mapWithReturningWaiver(engine({ pest: { frequency: 'quarterly' } }), mapV1ToLegacyShape, { history: null });
    expect(none).toBeNull();
    expect(mapped.oneTime.membershipFee).toBe(99);
  });

  test('solo pest inside the window: the fee leaves the mapped totals and the answer names the evidence', () => {
    const plain = mapV1ToLegacyShape(engine({ pest: { frequency: 'quarterly' } }));
    const { mapped, waiver: answer } = waiver.mapWithReturningWaiver(engine({ pest: { frequency: 'quarterly' } }), mapV1ToLegacyShape, { history: history('pest_control') });
    expect(answer).toEqual(expect.objectContaining({ rule: 'returning_customer_gap', family: 'pest_control', gapDays: 95, windowDays: 121 }));
    expect(mapped.oneTime.membershipFee).toBe(0);
    expect(mapped.oneTime.total).toBe(plain.oneTime.total - 99);
    expect(mapped.recurring.monthlyTotal).toBe(plain.recurring.monthlyTotal);
  });

  test('solo mosquito inside the window: the fee has no engine line, and still leaves the totals', () => {
    const plain = mapV1ToLegacyShape(engine({ mosquito: { tier: 'monthly' } }));
    expect(plain.oneTime.membershipFee).toBe(99);
    const { mapped, waiver: answer } = waiver.mapWithReturningWaiver(engine({ mosquito: { tier: 'monthly' } }), mapV1ToLegacyShape, { history: history('mosquito') });
    expect(answer).toEqual(expect.objectContaining({ family: 'mosquito' }));
    expect(mapped.oneTime.membershipFee).toBe(0);
    expect(mapped.oneTime.total).toBe(plain.oneTime.total - 99);
  });

  test('a technician price digest differs with and without the waiver, for pest and for mosquito', () => {
    for (const [services, family] of [[{ pest: { frequency: 'quarterly' } }, 'pest_control'], [{ mosquito: { tier: 'monthly' } }, 'mosquito']]) {
      const priced = engine(services);
      const waived = engine(services);
      waiver.mapWithReturningWaiver(waived, mapV1ToLegacyShape, { history: history(family) });
      expect(agentEngineResultDigest(waived)).not.toBe(agentEngineResultDigest(priced));
    }
  });

  test('past the window, another family, or a bundle: the result is untouched', () => {
    const late = { todayKey: '2026-12-25', lastByFamily: { pest_control: { lastVisitKey: '2026-08-21', cycleDays: 91 } } };
    expect(waiver.mapWithReturningWaiver(engine({ pest: { frequency: 'quarterly' } }), mapV1ToLegacyShape, { history: late }).waiver).toBeNull();
    expect(waiver.mapWithReturningWaiver(engine({ pest: { frequency: 'quarterly' } }), mapV1ToLegacyShape, { history: history('mosquito') }).waiver).toBeNull();
    const bundle = waiver.mapWithReturningWaiver(engine({ pest: { frequency: 'quarterly' }, mosquito: {} }), mapV1ToLegacyShape, { history: history('pest_control') });
    expect(bundle.waiver).toBeNull();
    expect(bundle.mapped.oneTime.membershipFee).toBe(0);
    // A solo plan already priced with no fee (an active member's waiver came first): no answer, no mark.
    const noFee = engine({ pest: { frequency: 'quarterly' } });
    for (const li of noFee.lineItems) li.initialFee = 0;
    expect(waiver.mapWithReturningWaiver(noFee, mapV1ToLegacyShape, { history: history('pest_control') }).waiver).toBeNull();
    expect(noFee.membershipSetupFeeWaived).toBeUndefined();
  });

  // A read-only replay carries the stored answer instead of the history. Regression: a quote whose plan changed
  // after the answer was stored (pest answer, now mosquito) replays with the other family's $99 left out.
  test('a stored answer waives only the plan family it names', () => {
    const stored = (family) => ({ rule: 'returning_customer_gap', family, gapDays: 95, windowDays: 121 });
    const same = waiver.mapWithReturningWaiver(engine({ mosquito: { tier: 'monthly' } }), mapV1ToLegacyShape, { stored: stored('mosquito') });
    expect(same.waiver).toEqual(stored('mosquito'));
    expect(same.mapped.oneTime.membershipFee).toBe(0);
    for (const [services, family] of [[{ mosquito: { tier: 'monthly' } }, 'pest_control'], [{ pest: { frequency: 'quarterly' } }, 'mosquito']]) {
      const raw = engine(services);
      const other = waiver.mapWithReturningWaiver(raw, mapV1ToLegacyShape, { stored: stored(family) });
      expect(other.waiver).toBeNull();
      expect(other.mapped.oneTime.membershipFee).toBe(99);
      expect(raw.membershipSetupFeeWaived).toBeUndefined();
    }
    // A write that re-prices hands the history too: the history decides, never the stored copy.
    const redecided = waiver.mapWithReturningWaiver(engine({ pest: { frequency: 'quarterly' } }), mapV1ToLegacyShape, {
      history: { todayKey: '2026-12-25', lastByFamily: { pest_control: { lastVisitKey: '2026-08-21', cycleDays: 91 } } },
      stored: stored('pest_control'),
    });
    expect(redecided.waiver).toBeNull();
    expect(redecided.mapped.oneTime.membershipFee).toBe(99);
  });
});

// A save the server cannot price stores the client's totals: the rule only confirms what those totals say.
// Regressions: a waiver stored beside totals that carry the $99, fee-free totals stored with no waiver (the accept
// bills $99 above the saved total), or a refusal of a result that leaves the fee out for another reason.
describe('returning customer setup fee: a save the server cannot price', () => {
  const inWindow = { todayKey: '2026-11-24', lastByFamily: { pest_control: { lastVisitKey: '2026-08-21', cycleDays: 91 } } };
  const pastWindow = { todayKey: '2026-11-24', lastByFamily: { pest_control: { lastVisitKey: '2026-07-01', cycleDays: 91 } } };
  const result = (services, waived) => waiver.mapWithReturningWaiver(
    generateEstimate({ ...property, services }), mapV1ToLegacyShape, { history: waived ? inWindow : null },
  ).mapped;
  const soloPest = { pest: { frequency: 'quarterly' } };
  const none = { waiver: null, stale: false };
  const marked = (r) => ({ ...r, returningSetupFeeWaiver: { rule: 'returning_customer_gap' } });

  test('fee-free totals the rule was claimed for: confirmed while the rule waives, stale when it does not', () => {
    // Claimed by the preview's mark, or by the quote that held the answer (a reopened estimate has no mark).
    for (const [data, options] of [[{ result: marked(result(soloPest, true)) }, {}], [{ result: result(soloPest, true) }, { answerHeld: true }]]) {
      expect(waiver.returningWaiverForUnpricedSave(data, inWindow, options))
        .toEqual({ waiver: expect.objectContaining({ family: 'pest_control', gapDays: 95 }), stale: false });
      expect(waiver.returningWaiverForUnpricedSave(data, pastWindow, options)).toEqual({ waiver: null, stale: true });
      expect(waiver.returningWaiverForUnpricedSave(data, null, options)).toEqual({ waiver: null, stale: true });
    }
  });

  test('nothing is stored and nothing is refused when the totals carry the fee or leave it out for another reason', () => {
    // No claim: the fee is out for a reason the rule does not own (a member, an older result).
    expect(waiver.returningWaiverForUnpricedSave({ result: result(soloPest, true) }, pastWindow)).toEqual(none);
    // The totals carry the fee: the bill does too, whatever was claimed.
    expect(waiver.returningWaiverForUnpricedSave({ result: marked(result(soloPest, false)) }, inWindow, { answerHeld: true })).toEqual(none);
    // The plan changed to a bundle, which carries no fee: the held answer has nothing to reconcile.
    expect(waiver.returningWaiverForUnpricedSave({ result: result({ ...soloPest, mosquito: {} }, false) }, pastWindow, { answerHeld: true })).toEqual(none);
    // A staff or move waiver covers the fee.
    expect(waiver.returningWaiverForUnpricedSave(
      { result: marked(result(soloPest, true)), operatorPriceAdjustment: { waiveSetupFee: true } }, pastWindow,
    )).toEqual(none);
    expect(waiver.returningWaiverForUnpricedSave({}, inWindow, { answerHeld: true })).toEqual(none);
  });

  test('a quote holds the answer as the operator waiver or as the frozen zero, and as nothing else', () => {
    const answer = { rule: 'returning_customer_gap', family: 'pest_control', gapDays: 95, windowDays: 121 };
    expect(waiver.holdsReturningSetupWaiver({ operatorPriceAdjustment: waiver.withReturningSetupWaiver(null, answer) })).toBe(true);
    expect(waiver.holdsReturningSetupWaiver({ setupFeeQuote: { amount: 0, waived: waiver.FROZEN_WAIVED_REASON, kind: 'waveguard_membership' } })).toBe(true);
    for (const data of [null, {}, { operatorPriceAdjustment: { waiveSetupFee: true } }, { setupFeeQuote: { amount: 0, waived: 'existing_member' } }]) {
      expect(waiver.holdsReturningSetupWaiver(data)).toBe(false);
    }
  });
});

// The stored answer rides the operator waiver every setup-fee reader already honors.
describe('returning customer setup fee: the stored answer', () => {
  const stamp = { rule: 'returning_customer_gap', family: 'pest_control', lastCompletedVisitDate: '2026-08-21', decidedOn: '2026-11-24', gapDays: 95, windowDays: 121 };

  test('the page, the bundle and the accept bill read it as a waived fee', () => {
    const estimateData = soloQuarterlyPest();
    const recurringServices = converter.recurringServicesFromEstimateData(estimateData);
    expect(converter.shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices, estimateData })).toBe(true);
    const stored = { ...estimateData, operatorPriceAdjustment: waiver.withReturningSetupWaiver(null, stamp) };
    expect(converter.estimateOperatorSetupFeeWaived(stored)).toBe(true);
    expect(converter.shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices, estimateData: stored })).toBe(false);
    expect(waiver.returningSetupFeeWaiverOf(stored)).toEqual(stamp);
    // A staff waiver is not the rule's.
    expect(waiver.returningSetupFeeWaiverOf({ operatorPriceAdjustment: { waiveSetupFee: true, internalReason: 'owner said so' } })).toBeNull();
  });

  test('a save drops the rule\'s waiver before it decides again, and keeps a discount that came with it', () => {
    expect(waiver.withoutReturningSetupWaiver(waiver.withReturningSetupWaiver(null, stamp))).toBeUndefined();
    const discount = { type: 'PERCENT', value: 10, label: 'Neighbor discount', internalReason: 'owner approved' };
    const kept = waiver.withoutReturningSetupWaiver(waiver.withReturningSetupWaiver(discount, stamp));
    expect(kept).toEqual(expect.objectContaining({ type: 'PERCENT', value: 10, label: 'Neighbor discount', internalReason: 'owner approved' }));
    expect(kept.waiveSetupFee).toBeUndefined();
    expect(kept.returningCustomerGap).toBeUndefined();
    // A staff or move waiver carries no rule evidence and passes through untouched.
    const staff = { waiveSetupFee: true, internalReason: 'owner said so' };
    expect(waiver.withoutReturningSetupWaiver(staff)).toBe(staff);
  });

});
