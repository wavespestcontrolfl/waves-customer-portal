'use strict';

const knex = require('knex');
const {
  customerVisibleBookingWhere,
  isUnreviewedDispatchOwned,
} = require('../services/call-booking-source-actions');

describe('customer-visible booking SQL predicate', () => {
  test('compiles as a grouped PostgreSQL filter before order and limit', async () => {
    const pg = knex({ client: 'pg' });
    const compiled = pg('scheduled_services')
      .whereIn('scheduled_services.status', ['pending', 'confirmed'])
      .where(customerVisibleBookingWhere)
      .orderBy('scheduled_services.scheduled_date', 'asc')
      .limit(12)
      .select('scheduled_services.id')
      .toSQL();

    expect(compiled.sql).toContain('"scheduled_services"."source_action" is null');
    expect(compiled.sql).toContain('"scheduled_services"."source_action" not in (?, ?, ?)');
    expect(compiled.sql).toContain("NOT (scheduled_services.source_action = 'voice_agent'");
    expect(compiled.sql.indexOf('source_action')).toBeLessThan(compiled.sql.indexOf('order by'));
    expect(compiled.sql.indexOf('order by')).toBeLessThan(compiled.sql.indexOf('limit'));
    expect(compiled.bindings).toEqual(expect.arrayContaining([
      'pending', 'confirmed', 'ai_call_pipeline_followup', 'ai_call_outbound_review', 'voice_agent', true, 12,
    ]));
    await pg.destroy();
  });

  test.each([
    ['ordinary pending row', { source_action: null, status: 'pending', customer_confirmed: false }, false],
    ['unreviewed call follow-up', { source_action: 'ai_call_pipeline_followup', status: 'pending', customer_confirmed: false }, true],
    ['reviewed outbound booking', { source_action: 'ai_call_outbound_review', status: 'pending', customer_confirmed: true }, false],
    ['unreviewed moved voice booking', { source_action: 'voice_agent', status: 'confirmed', customer_confirmed: false }, true],
    ['confirmed outbound booking', { source_action: 'ai_call_outbound_review', status: 'confirmed', customer_confirmed: false }, false],
  ])('%s has the canonical JS verdict', (_label, row, hidden) => {
    expect(isUnreviewedDispatchOwned(row)).toBe(hidden);
  });
});
