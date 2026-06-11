/**
 * Focused tests for the health-scorer upsert (customer_health_scores).
 *
 * The write must be idempotent per (customer, day) WITHOUT relying on a
 * unique constraint that may not exist:
 *  - lookup is keyed on customer_id only (no scored_at filter — that column
 *    equality lookup is what caused the day-2 23505 on the 093 shape and the
 *    undefined-column crash on the 037 shape),
 *  - if a row exists for the customer, update it in place (re-stamping
 *    scored_at), never insert a second row,
 *  - if no row exists, insert one with scored_at set.
 */

jest.mock('../models/db', () => {
  const mock = jest.fn();
  return mock;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));
jest.mock('../services/customer-intelligence/signal-detector', () => ({
  SIGNAL_TYPES: {},
}));
jest.mock('../utils/datetime-et', () => ({
  etDateString: jest.fn(() => '2026-06-10'),
}));

const db = require('../models/db');
const healthScorer = require('../services/customer-intelligence/health-scorer');

function makeChain(firstResult, listResult = []) {
  const chain = {};
  chain.whereCalls = [];
  chain.where = jest.fn((...args) => { chain.whereCalls.push(args); return chain; });
  chain.whereIn = jest.fn(() => chain);
  chain.select = jest.fn(() => chain);
  chain.groupBy = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => chain);
  chain.orderByRaw = jest.fn(() => chain);
  chain.first = jest.fn(() => Promise.resolve(firstResult));
  chain.update = jest.fn(() => Promise.resolve(1));
  chain.insert = jest.fn(() => Promise.resolve([1]));
  chain.then = (resolve, reject) => Promise.resolve(listResult).then(resolve, reject);
  return chain;
}

function wireDb(queues) {
  db.mockImplementation((table) => {
    const queue = queues[table];
    if (queue && queue.length) return queue.shift();
    return makeChain(undefined, []);
  });
}

const customer = {
  id: 'c1',
  first_name: 'Pat',
  created_at: new Date('2020-01-01'),
  member_since: '2020-01-01',
  waveguard_tier: null,
  monthly_rate: '100',
};

describe('health-scorer customer_health_scores upsert', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('day 2: existing customer row is updated in place — no second insert, no 23505 path', async () => {
    const lookupChain = makeChain({ id: 'row-1', customer_id: 'c1', scored_at: '2026-06-09T00:00:00.000Z' });
    const writeChain = makeChain(undefined);

    wireDb({
      customers: [makeChain(customer)],
      customer_signals: [makeChain(undefined, [])],
      service_records: [makeChain(undefined, [])],
      customer_health_scores: [lookupChain, writeChain],
    });

    await healthScorer.calculateHealth('c1');

    // Lookup keyed on customer_id only — no scored_at/day filter.
    expect(lookupChain.whereCalls).toEqual([['customer_id', 'c1']]);
    expect(lookupChain.orderByRaw).toHaveBeenCalledWith('scored_at DESC NULLS LAST');

    // Update targets the existing row by id; insert never fires.
    expect(writeChain.whereCalls).toEqual([['id', 'row-1']]);
    expect(writeChain.update).toHaveBeenCalledTimes(1);
    expect(writeChain.insert).not.toHaveBeenCalled();

    const updated = writeChain.update.mock.calls[0][0];
    expect(updated.scored_at).toBe('2026-06-10'); // re-stamped to today
    expect(updated).toHaveProperty('overall_score');
    expect(updated).toHaveProperty('churn_risk');
    expect(updated).toHaveProperty('churn_signals');
    expect(updated).toHaveProperty('updated_at');

    // score_grade must stay consistent with the overall_score on the row
    // (same A-F thresholds as customer-health.js getGrade()).
    const s = updated.overall_score;
    const expectedGrade = s >= 80 ? 'A' : s >= 65 ? 'B' : s >= 50 ? 'C' : s >= 35 ? 'D' : 'F';
    expect(updated.score_grade).toBe(expectedGrade);
  });

  test('first score: no existing row inserts one row with scored_at set', async () => {
    const lookupChain = makeChain(undefined);
    const writeChain = makeChain(undefined);

    wireDb({
      customers: [makeChain(customer)],
      customer_signals: [makeChain(undefined, [])],
      service_records: [makeChain(undefined, [])],
      customer_health_scores: [lookupChain, writeChain],
    });

    await healthScorer.calculateHealth('c1');

    expect(writeChain.insert).toHaveBeenCalledTimes(1);
    expect(writeChain.update).not.toHaveBeenCalled();

    const inserted = writeChain.insert.mock.calls[0][0];
    expect(inserted.customer_id).toBe('c1');
    expect(inserted.scored_at).toBe('2026-06-10');
    expect(inserted).toHaveProperty('overall_score');
    expect(inserted).toHaveProperty('churn_risk');
  });

  test('first-insert race: 23505 unique violation falls back to updating the winner row', async () => {
    const lookupChain = makeChain(undefined);
    const insertChain = makeChain(undefined);
    const uniqueErr = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    insertChain.insert = jest.fn(() => Promise.reject(uniqueErr));
    const refetchChain = makeChain({ id: 'row-9', customer_id: 'c1' });
    const updateChain = makeChain(undefined);

    wireDb({
      customers: [makeChain(customer)],
      customer_signals: [makeChain(undefined, [])],
      service_records: [makeChain(undefined, [])],
      customer_health_scores: [lookupChain, insertChain, refetchChain, updateChain],
    });

    await expect(healthScorer.calculateHealth('c1')).resolves.toMatchObject({ riskLevel: expect.any(String) });

    expect(insertChain.insert).toHaveBeenCalledTimes(1);
    expect(updateChain.whereCalls).toEqual([['id', 'row-9']]);
    expect(updateChain.update).toHaveBeenCalledTimes(1);
    expect(updateChain.update.mock.calls[0][0].scored_at).toBe('2026-06-10');
  });

  test('non-unique insert errors are rethrown, not swallowed', async () => {
    const lookupChain = makeChain(undefined);
    const insertChain = makeChain(undefined);
    const otherErr = Object.assign(new Error('column "nope" does not exist'), { code: '42703' });
    insertChain.insert = jest.fn(() => Promise.reject(otherErr));

    wireDb({
      customers: [makeChain(customer)],
      customer_signals: [makeChain(undefined, [])],
      service_records: [makeChain(undefined, [])],
      customer_health_scores: [lookupChain, insertChain],
    });

    await expect(healthScorer.calculateHealth('c1')).rejects.toThrow('column "nope" does not exist');
  });

  test('repeat run on the same day stays idempotent — still a single-row update', async () => {
    const lookupChain = makeChain({ id: 'row-1', customer_id: 'c1', scored_at: '2026-06-10T00:00:00.000Z' });
    const writeChain = makeChain(undefined);

    wireDb({
      customers: [makeChain(customer)],
      customer_signals: [makeChain(undefined, [])],
      service_records: [makeChain(undefined, [])],
      customer_health_scores: [lookupChain, writeChain],
    });

    await healthScorer.calculateHealth('c1');

    expect(writeChain.update).toHaveBeenCalledTimes(1);
    expect(writeChain.insert).not.toHaveBeenCalled();
  });
});
