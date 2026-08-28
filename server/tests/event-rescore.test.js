/**
 * Event-driven health rescore (near-real-time on a hot inbound SMS).
 *  - no-op unless GATE_EVENT_RESCORE === 'true',
 *  - detects fresh signals for the customer, then rescores (canonical engine),
 *  - on a real crossing into critical posts an ADMIN NOTIFICATION (bell+push,
 *    never an SMS, never a message to the customer): priorRisk filters out
 *    already-critical customers (nightly/Stripe/pre-enable), and an ATOMIC
 *    conditional update (critical_alert_sent_at IS NULL) ensures two concurrent
 *    inbound texts can't both alert — exactly one wins the rowcount,
 *  - releases the claim if the notification doesn't deliver, so a later text
 *    retries; never throws (called fire-and-forget).
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

// customer_health_scores is hit up to 3×: prior-risk read (first), the atomic
// claim (update → rows affected: 1 = won, 0 = lost), and — only on an
// undelivered notification — the claim release (update). `claimChain`/
// `releaseChain` are returned so tests can assert which fired.
function wireDb({ priorRisk = null, claimResult = 0, customer } = {}) {
  const claimChain = makeChain({ update: claimResult });
  const releaseChain = makeChain({ update: 1 });
  const queues = {
    customer_health_scores: [makeChain({ first: priorRisk == null ? undefined : { churn_risk: priorRisk } }), claimChain, releaseChain],
    customers: [makeChain({ first: customer }), makeChain({ first: customer })],
  };
  db.mockImplementation((table) => (queues[table]?.shift()) || makeChain());
  return { claimChain, releaseChain };
}

const CUSTOMER = { id: 'c1', first_name: 'Pat', last_name: 'Lee', waveguard_tier: 'Gold', monthly_rate: '120', phone: '+19415551234' };

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
    wireDb({ priorRisk: 'moderate', customer: CUSTOMER });
    customerHealth.scoreCustomer.mockResolvedValue({ overall: 70, churnRisk: 'moderate', churnSignals: [] });

    await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });

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
