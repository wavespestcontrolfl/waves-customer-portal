// Codex #6431 r3: generateAlerts inserts under a FOR SHARE read of a LIVE
// customer row, so it waits for an in-flight merge (which holds both customer
// rows FOR UPDATE) and then skips the retired profile — no late alert lands on
// a merged-away record.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const db = require('../models/db');
const HealthAlerts = require('../services/health-alerts');

function chain(result) {
  const c = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'forShare']) c[m] = jest.fn(() => c);
  c.first = jest.fn(async () => result);
  c.insert = jest.fn(() => c);
  c.returning = jest.fn(async () => [{ id: 'alert-new' }]);
  return c;
}

function wire({ liveCustomer }) {
  const calls = { customers: [], alerts: [] };
  db.mockImplementation((table) => {
    const c = chain(undefined); // dedupe read: no open alert yet
    calls.alerts.push(c);
    return c;
  });
  db.transaction = jest.fn(async (fn) => {
    const trx = (table) => {
      const c = chain(table === 'customers' ? liveCustomer : undefined);
      (table === 'customers' ? calls.customers : calls.alerts).push(c);
      return c;
    };
    return fn(trx);
  });
  return calls;
}

// critical_risk fires on a high churn risk alone.
const SCORE = { overall: 20, grade: 'F', churnRisk: 'critical', churnProbability: 0.9, churnSignals: [] };

test('a live customer gets the alert, inserted after a FOR SHARE read of the customer row', async () => {
  const calls = wire({ liveCustomer: { id: 'cust-1' } });
  const created = await HealthAlerts.generateAlerts('cust-1', SCORE);
  expect(created.length).toBeGreaterThan(0);
  const lock = calls.customers[0];
  expect(lock.where).toHaveBeenCalledWith({ id: 'cust-1' });
  expect(lock.whereNull).toHaveBeenCalledWith('deleted_at');
  expect(lock.forShare).toHaveBeenCalled();
});

test('a retired (merged-away) customer gets no alert', async () => {
  const calls = wire({ liveCustomer: undefined });
  const created = await HealthAlerts.generateAlerts('cust-1', SCORE);
  expect(created).toEqual([]);
  expect(calls.alerts.some((c) => c.insert.mock.calls.length)).toBe(false);
});
