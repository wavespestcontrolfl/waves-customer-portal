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
    }));
  });
});
