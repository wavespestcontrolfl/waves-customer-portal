/**
 * get_day_summary visit prices: the day's total adds only each visit's own
 * price (a set price, a deliberate $0, or the prepaid amount when no price is
 * set). A visit with no price is counted in visits_without_price. It used to be
 * counted as $125 (a $0 visit too), so the old estimated_revenue more than
 * doubled some real days.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => true), isEnabled: jest.fn(() => false) }));
jest.mock('../services/scheduling/day-quality', () => ({ getScheduleQualityMeasurements: jest.fn() }));

const db = require('../models/db');
const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');

function visit(id, estimated_price, prepaid_amount = null) {
  return { id, customer_id: `c-${id}`, status: 'scheduled', estimated_price, prepaid_amount, city: 'Venice', first_name: 'Pat', last_name: 'Example', tech_name: 'Tech One' };
}

test('the day total adds only the visits\' own prices and counts a visit with no price instead of guessing one', async () => {
  // pg sends numeric columns as strings. A set price wins over a prepayment, a $0 one too.
  const visits = [
    visit('priced-a', '100.10'),
    visit('priced-b', '200.20'),
    visit('zero', '0.00', '50.00'),
    visit('prepaid-only', null, '89.00'),
    visit('plan', null),
  ];
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') {
      const q = { where: () => q, whereNotIn: () => q, leftJoin: () => q, select: async () => visits };
      return q;
    }
    const q = { where: () => q, count: () => q, first: async () => ({ count: '1' }) };
    return q;
  });

  const summary = await executeScheduleTool('get_day_summary', { date: '2026-10-31' });

  expect(summary).toMatchObject({ total_services: 5, visit_price_total: 389.3, visits_with_price: 4, visits_without_price: 1 });
  expect(summary).not.toHaveProperty('estimated_revenue');
});
