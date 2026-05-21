const migration = require('../models/migrations/20260521000003_sms_template_trigger_event_key');

describe('sms template trigger event migration', () => {
  test('backfills SMS templates to their actual notification events', async () => {
    const updates = [];
    const knex = jest.fn((table) => {
      expect(table).toBe('sms_templates');
      const query = {
        where(criteria) {
          query.criteria = criteria;
          return query;
        },
        async update(values) {
          updates.push([query.criteria.template_key, values.trigger_event_key]);
          return 1;
        },
      };
      return query;
    });
    knex.schema = {
      hasColumn: jest.fn(async () => true),
      alterTable: jest.fn(),
    };

    await migration.up(knex);

    const map = Object.fromEntries(updates);
    expect(map.estimate_followup_expiring).toBe('estimate.expiring_soon');
    expect(map.estimate_followup_final).toBe('estimate.followup_final');
    expect(map.appointment_confirmation).toBe('appointment.booked');
    expect(map.self_booking_confirmation).toBe('appointment.booked');
    expect(map.auto_new_recurring).toBe('customer.recurring_created');
    expect(updates).toHaveLength(14);
  });
});
