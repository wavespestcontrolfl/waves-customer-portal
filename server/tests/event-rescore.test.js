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

  test('posts an admin notification (not an SMS) on a real crossing when it WINS the claim', async () => {
    wireDb({ priorRisk: 'high', claimResult: 1, customer: CUSTOMER });
    customerHealth.scoreCustomer.mockResolvedValue({
      overall: 22, churnRisk: 'critical',
      churnSignals: [{ signal: 'COMPETITOR_MENTIONED', value: 'Competitor mentioned', severity: 'critical' }],
    });

    await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });

    expect(triggerNotification).toHaveBeenCalledTimes(1);
    const [triggerKey, payload] = triggerNotification.mock.calls[0];
    expect(triggerKey).toBe('internal_admin_alert');
    expect(payload.title).toMatch(/Churn risk \(live\)/);
    expect(payload.title).toMatch(/Pat Lee/);
    expect(payload.body).toMatch(/CRITICAL/);
    expect(payload.body).toMatch(/Competitor mentioned/);
    expect(payload.link).toBe('/admin/customers?view=health');
  });

  test('does NOT alert (or even claim) when the customer was ALREADY critical', async () => {
    const { claimChain } = wireDb({ priorRisk: 'critical', claimResult: 1, customer: CUSTOMER });
    customerHealth.scoreCustomer.mockResolvedValue({ overall: 18, churnRisk: 'critical', churnSignals: [] });

    await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });

    expect(claimChain.update).not.toHaveBeenCalled(); // transition guard short-circuits before the claim
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('does NOT alert when it LOSES the claim (concurrent winner)', async () => {
    wireDb({ priorRisk: 'high', claimResult: 0, customer: CUSTOMER });
    customerHealth.scoreCustomer.mockResolvedValue({ overall: 18, churnRisk: 'critical', churnSignals: [] });

    await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });

    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('no claim and no alert when the rescore is not critical', async () => {
    const { claimChain } = wireDb({ priorRisk: 'moderate', customer: CUSTOMER });
    customerHealth.scoreCustomer.mockResolvedValue({ overall: 45, churnRisk: 'high', churnSignals: [] });

    await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });

    expect(claimChain.update).not.toHaveBeenCalled();
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('releases the claim when the notification throws (so a later text retries)', async () => {
    const { releaseChain } = wireDb({ priorRisk: 'high', claimResult: 1, customer: CUSTOMER });
    customerHealth.scoreCustomer.mockResolvedValue({ overall: 20, churnRisk: 'critical', churnSignals: [] });
    triggerNotification.mockRejectedValueOnce(new Error('notif down'));

    await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });

    expect(releaseChain.update).toHaveBeenCalledWith({ critical_alert_sent_at: null });
  });

  test('releases the claim when the notification is undelivered (no bell, no push)', async () => {
    const { releaseChain } = wireDb({ priorRisk: 'high', claimResult: 1, customer: CUSTOMER });
    customerHealth.scoreCustomer.mockResolvedValue({ overall: 20, churnRisk: 'critical', churnSignals: [] });
    triggerNotification.mockResolvedValueOnce({ bellWritten: false, push: { sent: 0 } });

    await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });

    expect(releaseChain.update).toHaveBeenCalledWith({ critical_alert_sent_at: null });
  });

  test('counts a push-only delivery as delivered (no release)', async () => {
    const { releaseChain } = wireDb({ priorRisk: 'high', claimResult: 1, customer: CUSTOMER });
    customerHealth.scoreCustomer.mockResolvedValue({ overall: 20, churnRisk: 'critical', churnSignals: [] });
    triggerNotification.mockResolvedValueOnce({ bellWritten: false, push: { sent: 2 } });

    await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });

    expect(releaseChain.update).not.toHaveBeenCalled();
  });
});
