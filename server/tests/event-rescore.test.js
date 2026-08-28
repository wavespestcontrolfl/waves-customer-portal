/**
 * Event-driven health rescore (near-real-time on a hot inbound SMS).
 *  - no-op unless GATE_EVENT_RESCORE === 'true',
 *  - detects fresh signals for the customer, then rescores (canonical engine),
 *  - never touches a notification and never reads customer_health_scores
 *    itself: the live churn alert (and its prior-risk read + atomic claim)
 *    was retired 2026-08-28,
 *  - never throws (called fire-and-forget).
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }));
jest.mock('../services/customer-intelligence/signal-detector', () => ({
  detectSignals: jest.fn(() => Promise.resolve([])),
  SIGNAL_TYPES: {},
}));
jest.mock('../services/customer-health', () => ({ scoreCustomer: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: jest.fn(() => Promise.resolve({ bellWritten: true })),
}));

const db = require('../models/db');
const SignalDetector = require('../services/customer-intelligence/signal-detector');
const customerHealth = require('../services/customer-health');
const { triggerNotification } = require('../services/notification-triggers');
const eventRescore = require('../services/customer-intelligence/event-rescore');

function makeChain({ first, update } = {}) {
  const chain = {};
  chain.where = jest.fn(() => chain);
  chain.whereNull = jest.fn(() => chain);
  chain.orderByRaw = jest.fn(() => chain);
  chain.first = jest.fn(() => Promise.resolve(first));
  chain.update = jest.fn(() => Promise.resolve(update));
  return chain;
}

// Any table access is a regression: the module's own DB reads (prior-risk
// read + atomic critical claim) left with the retired alert.
function wireDb() {
  db.mockImplementation(() => makeChain());
}


describe('rescoreOnInboundMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    triggerNotification.mockResolvedValue({ bellWritten: true });
    process.env.GATE_EVENT_RESCORE = 'true';
  });

  test('no-op when the gate is off', async () => {
    process.env.GATE_EVENT_RESCORE = 'false';
    const out = await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });
    expect(out).toBeNull();
    expect(SignalDetector.detectSignals).not.toHaveBeenCalled();
    expect(customerHealth.scoreCustomer).not.toHaveBeenCalled();
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('detects fresh signals, then rescores', async () => {
    wireDb();
    customerHealth.scoreCustomer.mockResolvedValue({ overall: 70, churnRisk: 'moderate', churnSignals: [] });

    const out = await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });

    expect(out).toEqual({ overall: 70, churnRisk: 'moderate', churnSignals: [] });
    expect(db).not.toHaveBeenCalled();
    expect(SignalDetector.detectSignals).toHaveBeenCalledWith('c1');
    expect(customerHealth.scoreCustomer).toHaveBeenCalledWith('c1');
    expect(SignalDetector.detectSignals.mock.invocationCallOrder[0])
      .toBeLessThan(customerHealth.scoreCustomer.mock.invocationCallOrder[0]);
  });

  test('a crossing into critical no longer alerts or claims (live churn alert retired 2026-08-28)', async () => {
    // Behavior under test is the ABSENCE of the alert: whatever the mocks
    // return, rescoreOnInboundMessage must return the score and touch no
    // notification.
    triggerNotification.mockClear();
    await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' }).catch(() => null);
    expect(triggerNotification).not.toHaveBeenCalled();
  });
});
