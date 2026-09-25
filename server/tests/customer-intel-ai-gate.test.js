'use strict';

// GATE_CUSTOMER_INTEL_AI — the customer-intelligence AI legs (nightly
// sentiment mining per customer + retention drafting) are dark by default:
// the churn/risk signal they feed is ruled unusable as a gauge (owner
// 2026-08-29) and they were ~60% of all FLAGSHIP volume (09-2026 ledger).
// Deterministic signals keep running either way; the gate is read at CALL
// time, so a flip needs no redeploy.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const db = require('../models/db');
const { dispatchWithFallback } = require('../services/llm/call');
const signalDetector = require('../services/customer-intelligence/signal-detector');

// Minimal chainable query: every table reads as "one recent inbound SMS with
// a body" so the sentiment step has something to send if it runs, and
// `insert` (signal save) is a no-op.
function query(rows) {
  const q = {
    where: () => q, whereNotNull: () => q, whereIn: () => q, whereRaw: () => q,
    orderBy: () => q, limit: () => q, select: () => q, join: () => q,
    count: () => ({ first: async () => ({ count: String(rows.length) }) }),
    first: async () => rows[0] || null,
    insert: async () => [],
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    catch: (rej) => q.then(undefined, rej),
  };
  return q;
}

describe('GATE_CUSTOMER_INTEL_AI', () => {
  const inbound = [{ customer_id: 'c1', direction: 'inbound', message_body: 'the tech was rude and I want to cancel',
    created_at: new Date(Date.now() - 3600000), technician_notes: 'note' }];

  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation(() => query(inbound));
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { signals: [] } });
  });
  afterEach(() => { delete process.env.GATE_CUSTOMER_INTEL_AI; });

  test('unset (default): detectSignals makes NO provider call', async () => {
    delete process.env.GATE_CUSTOMER_INTEL_AI;
    expect(signalDetector.aiSignalsEnabled()).toBe(false);
    await signalDetector.detectSignals('c1');
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('"false": still no provider call', async () => {
    process.env.GATE_CUSTOMER_INTEL_AI = 'false';
    await signalDetector.detectSignals('c1');
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('"true": the sentiment step runs against the highStakes policy', async () => {
    process.env.GATE_CUSTOMER_INTEL_AI = 'true';
    expect(signalDetector.aiSignalsEnabled()).toBe(true);
    await signalDetector.detectSignals('c1');
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(dispatchWithFallback.mock.calls[0][0].name).toBe('highStakes');
  });

  test('gate is read at call time — flipping mid-process takes effect without a reload', async () => {
    delete process.env.GATE_CUSTOMER_INTEL_AI;
    await signalDetector.detectSignals('c1');
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    process.env.GATE_CUSTOMER_INTEL_AI = 'true';
    await signalDetector.detectSignals('c1');
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  });
});
