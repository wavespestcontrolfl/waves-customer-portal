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
