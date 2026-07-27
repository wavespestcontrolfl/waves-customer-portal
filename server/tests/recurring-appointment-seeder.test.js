const RecurringAppointmentSeeder = require('../services/recurring-appointment-seeder');

describe('recurring appointment seeder', () => {
  test('infers pest control cadence from labels and frequency fields', () => {
    expect(RecurringAppointmentSeeder.inferRecurringPattern({
      service: { service: 'pest_control', label: 'Quarterly Pest Control' },
    })).toBe('quarterly');

    expect(RecurringAppointmentSeeder.inferRecurringPattern({
      service: { service: 'pest_control', frequency: 'bi-monthly' },
    })).toBe('bimonthly');
  });

  test('builds quarterly pest follow-up appointments for the rest of the year', () => {
    const rows = RecurringAppointmentSeeder.buildRecurringFollowUpRows({
      id: 'parent-1',
      customer_id: 'customer-1',
      technician_id: 'tech-1',
      scheduled_date: '2026-06-05',
      window_start: '09:00:00',
      window_end: '10:00:00',
      service_type: 'Quarterly Pest Control',
      status: 'confirmed',
      estimated_duration_minutes: 60,
      payment_method_preference: 'prepay_annual',
      source_estimate_id: 'estimate-1',
      zone: 'bradenton',
    }, {
      pattern: 'quarterly',
      plannedCount: 4,
      skipWeekends: true,
      weekendShift: 'forward',
    });

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.scheduled_date)).toEqual([
      '2026-09-04',
      '2026-12-04',
      '2027-03-05',
    ]);
    expect(rows[0]).toEqual(expect.objectContaining({
      customer_id: 'customer-1',
      technician_id: 'tech-1',
      service_type: 'Quarterly Pest Control',
      estimated_duration_minutes: 60,
      payment_method_preference: 'prepay_annual',
      source_estimate_id: 'estimate-1',
      is_recurring: true,
      recurring_pattern: 'quarterly',
      recurring_parent_id: 'parent-1',
      recurring_ongoing: true,
      status: 'pending',
      customer_confirmed: false,
      appointment_type: 'pest_general',
    }));
  });

  test('stamps the classifier tag on every seeded follow-up', () => {
    const rows = RecurringAppointmentSeeder.buildRecurringFollowUpRows({
      id: 'parent-2',
      customer_id: 'customer-2',
      scheduled_date: '2026-06-05',
      window_start: '09:00:00',
      window_end: '10:00:00',
      service_type: 'Monthly Mosquito Treatment',
    }, {
      pattern: 'monthly',
      plannedCount: 3,
    });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.appointment_type).toBe('mosquito');
    }
  });

  test('does not extend a completed one-year quarterly series on retry', () => {
    const rows = RecurringAppointmentSeeder.buildRecurringFollowUpRows({
      id: 'parent-1',
      customer_id: 'customer-1',
      scheduled_date: '2026-06-05',
      window_start: '09:00:00',
      window_end: '10:00:00',
      service_type: 'Quarterly Pest Control',
    }, {
      pattern: 'quarterly',
      plannedCount: 4,
      existingDates: ['2026-06-05', '2026-09-04', '2026-12-04', '2027-03-05'],
    });

    expect(rows).toHaveLength(0);
  });
});

describe('seasonal_feb_oct cadence (mosquito seasonal 9x, owner 2026-07-27)', () => {
  const seedFrom = (scheduled_date) => RecurringAppointmentSeeder.buildRecurringFollowUpRows({
    id: 'parent-mq9',
    customer_id: 'customer-1',
    scheduled_date,
    service_type: 'Seasonal Mosquito Control Service',
    status: 'confirmed',
  }, {
    pattern: RecurringAppointmentSeeder.SEASONAL_FEB_OCT,
    visitsPerYear: 9,
    skipWeekends: false,
  });
  const monthsOf = (base, rows) => [base, ...rows.map((r) => r.scheduled_date)].map((d) => d.slice(0, 7));

  test('normalizes the explicit cadence but NOT bare 9-visit numbers', () => {
    expect(RecurringAppointmentSeeder.normalizeRecurringPattern('seasonal_feb_oct')).toBe('seasonal_feb_oct');
    expect(RecurringAppointmentSeeder.normalizeRecurringPattern('seasonal9')).toBe('seasonal_feb_oct');
    // Unchanged contract: a bare 9 still infers bimonthly, so legacy 9-visit
    // rows keep office scheduling instead of silently gaining a series.
    expect(RecurringAppointmentSeeder.normalizeRecurringPattern('9')).toBe('bimonthly');
    // '9x' remains the T&S every_6_weeks token — this cadence must not steal it.
    expect(RecurringAppointmentSeeder.normalizeRecurringPattern('9x')).toBe('every_6_weeks');
  });

  test('fits the value in the recurring_pattern column (varchar(20))', () => {
    expect(RecurringAppointmentSeeder.SEASONAL_FEB_OCT.length).toBeLessThanOrEqual(20);
  });

  test('February start runs Feb-Oct with no winter visits', () => {
    const rows = seedFrom('2026-02-12');
    expect(rows).toHaveLength(8); // + the parent = 9 visits
    expect(monthsOf('2026-02-12', rows)).toEqual([
      '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
      '2026-07', '2026-08', '2026-09', '2026-10',
    ]);
  });

  test('mid-season start still delivers all 9, rolling across the winter gap', () => {
    // Owner ruling 2026-07-27: full 9 visits, rolling — a July buyer is not
    // short-changed to four just because the season ends in October.
    const rows = seedFrom('2026-07-14');
    expect(rows).toHaveLength(8);
    expect(monthsOf('2026-07-14', rows)).toEqual([
      '2026-07', '2026-08', '2026-09', '2026-10',
      '2027-02', '2027-03', '2027-04', '2027-05', '2027-06',
    ]);
  });

  test('off-season start puts every SEEDED visit in season', () => {
    // The parent visit is whatever the office booked and is not ours to move;
    // every follow-up this seeder creates must clear Nov-Jan.
    for (const base of ['2026-11-10', '2026-12-08', '2027-01-06']) {
      const rows = seedFrom(base);
      expect(rows).toHaveLength(8);
      const offSeason = rows
        .map((r) => Number(r.scheduled_date.slice(5, 7)))
        .filter((m) => m === 11 || m === 12 || m === 1);
      expect(offSeason).toEqual([]);
      expect(rows[0].scheduled_date.slice(5, 7)).toBe('02');
    }
  });

  test('no seeded visit ever lands in November, December or January', () => {
    for (let month = 1; month <= 12; month++) {
      const base = `2026-${String(month).padStart(2, '0')}-15`;
      const bad = seedFrom(base)
        .map((r) => Number(r.scheduled_date.slice(5, 7)))
        .filter((m) => m === 11 || m === 12 || m === 1);
      expect({ base, bad }).toEqual({ base, bad: [] });
    }
  });

  test('a BACKWARD weekend shift cannot pull a February visit into January', () => {
    // Mirror of the October edge (pre-push P1 r2). weekendShift:'back' moves
    // dates earlier, so February is the dangerous edge — a 2024-10-05 parent
    // produced 2025-01-31 before the clamp learned direction. Clamping the
    // wrong way here would cross the whole winter and land it ~4 months off.
    const rows = RecurringAppointmentSeeder.buildRecurringFollowUpRows({
      id: 'parent-mq9', customer_id: 'customer-1', scheduled_date: '2024-10-05',
    }, {
      pattern: RecurringAppointmentSeeder.SEASONAL_FEB_OCT,
      visitsPerYear: 9,
      skipWeekends: true,
      weekendShift: 'back',
    });
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.scheduled_date).filter((d) => [11, 12, 1].includes(Number(d.slice(5, 7)))))
      .toEqual([]);
    // Pushed FORWARD into February, not back to the previous October.
    expect(rows[0].scheduled_date.slice(0, 7)).toBe('2025-02');
  });

  test('both weekend-shift directions keep every start month out of winter', () => {
    for (const weekendShift of ['forward', 'back']) {
      for (let month = 1; month <= 12; month++) {
        const base = `2026-${String(month).padStart(2, '0')}-15`;
        const bad = RecurringAppointmentSeeder.buildRecurringFollowUpRows({
          id: 'parent-mq9', customer_id: 'customer-1', scheduled_date: base,
        }, {
          pattern: RecurringAppointmentSeeder.SEASONAL_FEB_OCT,
          visitsPerYear: 9,
          skipWeekends: true,
          weekendShift,
        }).map((r) => r.scheduled_date).filter((d) => [11, 12, 1].includes(Number(d.slice(5, 7))));
        expect({ weekendShift, base, bad }).toEqual({ weekendShift, base, bad: [] });
      }
    }
  });

  test('the weekend shift and blackout nudge cannot push an October visit into November', () => {
    // Both adjustments move dates FORWARD, so the season's last month is the
    // dangerous edge: a blacked-out Oct 31 would otherwise seed Nov 1 and break
    // the cadence's contract (pre-push P1). The clamp walks BACK to the nearest
    // in-season day that is also clear of weekends and blackouts.
    const seeded = (opts) => RecurringAppointmentSeeder.buildRecurringFollowUpRows({
      id: 'parent-mq9', customer_id: 'customer-1', scheduled_date: '2028-02-29',
    }, {
      pattern: RecurringAppointmentSeeder.SEASONAL_FEB_OCT,
      visitsPerYear: 9,
      skipWeekends: true,
      weekendShift: 'forward',
      ...opts,
    });

    for (const blackoutDates of [
      null,
      new Set(['2028-10-31']),
      new Set(['2028-10-31', '2028-10-30', '2028-10-27']),
    ]) {
      const rows = seeded(blackoutDates ? { blackoutDates } : {});
      const offSeason = rows
        .map((r) => r.scheduled_date)
        .filter((d) => [11, 12, 1].includes(Number(d.slice(5, 7))));
      expect(offSeason).toEqual([]);
      // The plan must still be whole — clamping trims dates, never visits.
      expect(rows).toHaveLength(8);
      // And never onto a blacked-out day.
      if (blackoutDates) {
        expect(rows.filter((r) => blackoutDates.has(r.scheduled_date))).toEqual([]);
      }
    }
  });
});

describe('clampDateToSeason — shared season clamp for external callers (pre-push P1 r4)', () => {
  // admin-schedule's creation/rewrite/extension paths weekend-shift series
  // dates OUTSIDE the seeder; they clamp through this export so a shifted
  // seasonal date can never land in the Nov–Jan gap.
  const clamp = RecurringAppointmentSeeder.clampDateToSeason;
  const S = RecurringAppointmentSeeder.SEASONAL_FEB_OCT;

  test('no-op for other patterns, in-season dates, and empty input', () => {
    expect(clamp('monthly', '2026-11-02', {})).toBe('2026-11-02');
    expect(clamp(S, '2026-06-15', {})).toBe('2026-06-15');
    expect(clamp(S, null, {})).toBe(null);
  });

  test('a forward weekend shift past Oct 31 (Sat) pulls back into October', () => {
    expect(clamp(S, '2026-11-02', {})).toBe('2026-10-31');
  });

  test('honors skipWeekends while walking back', () => {
    // Oct 31 is a Saturday; the nearest in-season weekday is Fri Oct 30.
    expect(clamp(S, '2026-11-02', { skipWeekends: true })).toBe('2026-10-30');
  });

  test('a back-shifted date that undershoots February pushes forward, not across the winter', () => {
    expect(clamp(S, '2027-01-29', {})).toBe('2027-02-01');
  });

  test('walks past blackout dates', () => {
    expect(clamp(S, '2026-11-02', { blackoutDates: new Set(['2026-10-31', '2026-10-30']) }))
      .toBe('2026-10-29');
  });
});

describe('every_6_weeks cadence (T&S 9x Enhanced, un-retired 2026-07-24)', () => {
  test('normalizes the explicit frequency text but NOT bare 9-visit numbers', () => {
    expect(RecurringAppointmentSeeder.normalizeRecurringPattern('every_6_weeks')).toBe('every_6_weeks');
    expect(RecurringAppointmentSeeder.normalizeRecurringPattern('Every 6 Weeks')).toBe('every_6_weeks');
    expect(RecurringAppointmentSeeder.normalizeRecurringPattern('9x')).toBe('every_6_weeks');
    // Mosquito seasonal rows carry 9 visits and must keep their historical
    // bimonthly inference — only the explicit text selects the new cadence.
    expect(RecurringAppointmentSeeder.normalizeRecurringPattern('9')).toBe('bimonthly');
  });

  test('builds follow-ups at 42-day gaps for the rest of the program year', () => {
    const rows = RecurringAppointmentSeeder.buildRecurringFollowUpRows({
      id: 'parent-ts9',
      customer_id: 'customer-1',
      scheduled_date: '2026-01-05',
      window_start: '09:00:00',
      window_end: '10:00:00',
      service_type: 'Enhanced Tree & Shrub Care Service',
      status: 'confirmed',
    }, {
      pattern: 'every_6_weeks',
      plannedCount: 9,
      skipWeekends: false,
    });
    expect(rows).toHaveLength(8);
    expect(rows[0].scheduled_date).toBe('2026-02-16'); // +42 days
    expect(rows[1].scheduled_date).toBe('2026-03-30'); // +84 days
  });
});
