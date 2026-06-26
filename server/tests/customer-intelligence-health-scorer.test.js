/**
 * health-scorer is now an ENRICHMENT-only layer. It must:
 *  - read the canonical customer_health_scores row (written by customer-health.js),
 *  - update ONLY the intelligence columns (upsell_opportunities, next_best_action,
 *    lifetime_value_estimate) — never overall_score / churn_risk / sub-scores,
 *  - skip the write entirely when no canonical row exists yet,
 *  - map next-best-action against the canonical vocab (low/moderate/high/critical).
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
  SIGNAL_TYPES: {
    COMPETITOR_MENTIONED: { weight: -25, severity: 'critical' },
    SERVICE_GAP_60_DAYS: { weight: -20, severity: 'warning' },
  },
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
  waveguard_tier: null,
  monthly_rate: '100',
};

describe('health-scorer enrichment (customer_health_scores)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('updates ONLY enrichment columns on the canonical row — never the score/risk', async () => {
    const row = { id: 'row-1', customer_id: 'c1', churn_risk: 'high', churn_probability: '0.55' };
    const updateChain = makeChain(undefined);

    wireDb({
      customers: [makeChain(customer)],
      customer_health_scores: [makeChain(row), updateChain],
      customer_signals: [makeChain(undefined, [])],
      service_records: [makeChain(undefined, [])], // no upsell triggers
    });

    const result = await healthScorer.enrichCustomer('c1');

    expect(updateChain.whereCalls).toEqual([['id', 'row-1']]);
    expect(updateChain.update).toHaveBeenCalledTimes(1);

    const written = updateChain.update.mock.calls[0][0];
    // Exactly the enrichment columns — nothing that belongs to the scorer.
    expect(Object.keys(written).sort()).toEqual(
      ['lifetime_value_estimate', 'next_best_action', 'updated_at', 'upsell_opportunities'].sort()
    );
    expect(written).not.toHaveProperty('overall_score');
    expect(written).not.toHaveProperty('churn_risk');
    expect(written).not.toHaveProperty('score_grade');
    expect(written).not.toHaveProperty('payment_score');

    // LTV uses the canonical row's churn_probability: 100*12*(1-0.55) = 540.
    expect(written.lifetime_value_estimate).toBeCloseTo(540);
    expect(result).toMatchObject({ hadRow: true });
  });

  test('skips the write when no canonical row exists yet', async () => {
    const maybeUpdate = makeChain(undefined);
    wireDb({
      customers: [makeChain(customer)],
      customer_health_scores: [makeChain(undefined), maybeUpdate], // lookup returns nothing
      customer_signals: [makeChain(undefined, [])],
      service_records: [makeChain(undefined, [])],
    });

    const result = await healthScorer.enrichCustomer('c1');

    expect(maybeUpdate.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ hadRow: false });
  });

  describe('determineNextAction uses the canonical low/moderate/high/critical vocab', () => {
    test('critical + competitor → CALL', () => {
      const out = healthScorer.determineNextAction(customer, 'critical',
        [{ signal: 'COMPETITOR_MENTIONED' }], []);
      expect(out).toMatch(/^CALL:.*competitor/);
    });
    test('high + service gap → SMS re-engage', () => {
      const out = healthScorer.determineNextAction(customer, 'high',
        [{ signal: 'SERVICE_GAP_60_DAYS' }], []);
      expect(out).toMatch(/^SMS: Re-engage/);
    });
    test('moderate → MONITOR', () => {
      const out = healthScorer.determineNextAction(customer, 'moderate', [], []);
      expect(out).toMatch(/^MONITOR:/);
    });
    test('low + upsell → UPSELL', () => {
      const out = healthScorer.determineNextAction(customer, 'low', [],
        [{ service: 'lawn_care', monthly_value: 72.5, confidence: 0.7 }]);
      expect(out).toMatch(/^UPSELL:/);
    });
    test('low + no upsell → MAINTAIN', () => {
      const out = healthScorer.determineNextAction(customer, 'low', [], []);
      expect(out).toMatch(/^MAINTAIN:/);
    });
  });
});
