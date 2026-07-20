/**
 * Health-alert complimentary-visit writer.
 *
 * The free_service action inserted a `price` column that does not exist on
 * scheduled_services — every execution threw and the failure was reported
 * only inside the action's result blob. Pins:
 *   - the insert uses estimated_price (0 = genuine complimentary price) and
 *     only real columns
 *   - an insert failure is logged via logger.error, not silently swallowed
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const HealthAlerts = require('../services/health-alerts');

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue(),
    ...overrides,
  });
  return builder;
}

const ALERT = {
  id: 'alert-1',
  customer_id: 'cust-1',
  recommended_actions: JSON.stringify([
    { type: 'free_service', label: 'Comp visit', serviceType: 'General Pest - Complimentary' },
  ]),
  auto_action_taken: '[]',
};

function wire({ insertChain }) {
  const queues = {
    customer_health_alerts: [
      chain({ first: jest.fn().mockResolvedValue(ALERT) }),
      chain(), // status update
    ],
    customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace' }) })],
    scheduled_services: [insertChain],
    activity_log: [chain()],
  };
  db.mockImplementation((table) => {
    const q = queues[table];
    if (!q || q.length === 0) throw new Error(`Unexpected db('${table}') call`);
    return q.shift();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('complimentary visit inserts estimated_price (no phantom price column)', async () => {
  const insertChain = chain();
  wire({ insertChain });

  const result = await HealthAlerts.executeAction('alert-1', 0);

  expect(result.result || result).toBeTruthy();
  const payload = insertChain.insert.mock.calls[0][0];
  expect(payload).toMatchObject({
    customer_id: 'cust-1',
    service_type: 'General Pest - Complimentary',
    status: 'pending',
    estimated_price: 0,
  });
  expect(payload).not.toHaveProperty('price');
  expect(payload.scheduled_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('an insert failure is logged loudly, not just swallowed into the result blob', async () => {
  const insertChain = chain({ insert: jest.fn().mockRejectedValue(new Error('column boom')) });
  wire({ insertChain });

  await HealthAlerts.executeAction('alert-1', 0);

  expect(logger.error).toHaveBeenCalledWith(
    expect.stringContaining('Complimentary service insert failed'),
  );
});
