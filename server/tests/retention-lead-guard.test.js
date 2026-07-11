/**
 * Churn/retention lead guard (2026-07-11, the Copeman alert): health scores
 * cover leads too, so a never-paying new_lead could be churn-scored
 * "critical", burn an AI outreach draft, and page Adam at 3 AM. Retention
 * outreach and churn alerts are for REAL customers (CUSTOMER_STAGES) only.
 */

jest.mock('../models/db', () => { const fn = jest.fn(); fn.raw = jest.fn((s) => s); return fn; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({})) }));

const db = require('../models/db');
const RetentionEngine = require('../services/customer-intelligence/retention-engine');

const makeChain = (result) => {
  const chain = {};
  for (const m of ['where', 'whereIn', 'whereRaw', 'orderBy', 'select', 'insert', 'returning', 'limit']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.first = jest.fn(() => Promise.resolve(result));
  chain.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return chain;
};

describe('generateRetentionOutreach — real customers only', () => {
  afterEach(() => db.mockReset());

  test('a critical-risk NEW LEAD gets no outreach and no alert (returns before the outreach-history read)', async () => {
    const queue = [
      makeChain({ churn_risk: 'critical', overall_score: 12, churn_signals: '[]', churn_probability: 0.9 }),
      makeChain({ id: 'lead1', pipeline_stage: 'new_lead', first_name: 'Donovan', last_name: 'Copeman', deleted_at: null }),
    ];
    db.mockImplementation(() => queue.shift());

    const out = await RetentionEngine.generateRetentionOutreach('lead1');

    expect(out).toBeNull();
    expect(queue).toHaveLength(0);
    expect(db).toHaveBeenCalledTimes(2); // health + customer, nothing after the guard
  });

  test('a soft-deleted customer is also skipped', async () => {
    const queue = [
      makeChain({ churn_risk: 'critical', overall_score: 12, churn_signals: '[]', churn_probability: 0.9 }),
      makeChain({ id: 'c2', pipeline_stage: 'won', deleted_at: new Date('2026-06-01') }),
    ];
    db.mockImplementation(() => queue.shift());

    expect(await RetentionEngine.generateRetentionOutreach('c2')).toBeNull();
    expect(db).toHaveBeenCalledTimes(2);
  });

  test('a real customer passes the guard (proceeds to the outreach-history read)', async () => {
    const queue = [
      makeChain({ churn_risk: 'critical', overall_score: 12, churn_signals: '[]', churn_probability: 0.9 }),
      makeChain({ id: 'c3', pipeline_stage: 'won', deleted_at: null }),
      makeChain({ id: 'recent-outreach' }), // recent outreach exists → engine stops HERE, past the guard
    ];
    db.mockImplementation(() => queue.shift());

    expect(await RetentionEngine.generateRetentionOutreach('c3')).toBeNull();
    expect(db).toHaveBeenCalledTimes(3);
  });
});
