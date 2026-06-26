/**
 * Event-driven health rescore (near-real-time on a hot inbound SMS).
 *  - no-op unless GATE_EVENT_RESCORE === 'true',
 *  - detects fresh signals for the customer, then rescores (canonical engine),
 *  - alerts the owner on the crossing into critical, claimed ATOMICALLY via a
 *    conditional update (critical_alert_sent_at IS NULL) so two concurrent
 *    inbound texts can't both alert — exactly one wins the rowcount,
 *  - never throws (called fire-and-forget); silent when ADAM_PHONE is unset.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }));
jest.mock('../services/customer-intelligence/signal-detector', () => ({
  detectSignals: jest.fn(() => Promise.resolve([])),
  SIGNAL_TYPES: {},
}));
jest.mock('../services/customer-health', () => ({ scoreCustomer: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(() => Promise.resolve({ sent: true })) }));

const db = require('../models/db');
const SignalDetector = require('../services/customer-intelligence/signal-detector');
const customerHealth = require('../services/customer-health');
const TwilioService = require('../services/twilio');
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

// claimResult = rows affected by the atomic claim update (1 = won, 0 = lost)
function wireDb({ claimResult = 0, customer } = {}) {
  const queues = {
    customer_health_scores: [makeChain({ update: claimResult })],
    customers: [makeChain({ first: customer })],
  };
  db.mockImplementation((table) => (queues[table]?.shift()) || makeChain());
}

const CUSTOMER = { id: 'c1', first_name: 'Pat', last_name: 'Lee', waveguard_tier: 'Gold', monthly_rate: '120', phone: '+19415551234' };

describe('rescoreOnInboundMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_EVENT_RESCORE = 'true';
    process.env.ADAM_PHONE = '+19415559999';
  });

  test('no-op when the gate is off', async () => {
    process.env.GATE_EVENT_RESCORE = 'false';
    const out = await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });
    expect(out).toBeNull();
    expect(SignalDetector.detectSignals).not.toHaveBeenCalled();
    expect(customerHealth.scoreCustomer).not.toHaveBeenCalled();
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });

  test('detects fresh signals, then rescores', async () => {
    wireDb({ customer: CUSTOMER });
    customerHealth.scoreCustomer.mockResolvedValue({ overall: 70, churnRisk: 'moderate', churnSignals: [] });

    await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });

    expect(SignalDetector.detectSignals).toHaveBeenCalledWith('c1');
    expect(customerHealth.scoreCustomer).toHaveBeenCalledWith('c1');
    expect(SignalDetector.detectSignals.mock.invocationCallOrder[0])
      .toBeLessThan(customerHealth.scoreCustomer.mock.invocationCallOrder[0]);
  });

  test('alerts the owner when it WINS the atomic critical claim', async () => {
    wireDb({ claimResult: 1, customer: CUSTOMER });
    customerHealth.scoreCustomer.mockResolvedValue({
      overall: 22, churnRisk: 'critical',
      churnSignals: [{ signal: 'COMPETITOR_MENTIONED', value: 'Competitor mentioned', severity: 'critical' }],
    });

    await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });

    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    const [to, body, opts] = TwilioService.sendSMS.mock.calls[0];
    expect(to).toBe('+19415559999');
    expect(body).toMatch(/CHURN ALERT \(live\)/);
    expect(body).toMatch(/Pat Lee/);
    expect(body).toMatch(/Competitor mentioned/);
    expect(opts).toEqual({ messageType: 'internal_alert' });
  });

  test('does NOT alert when it LOSES the claim (already alerted / concurrent winner)', async () => {
    wireDb({ claimResult: 0, customer: CUSTOMER });
    customerHealth.scoreCustomer.mockResolvedValue({ overall: 18, churnRisk: 'critical', churnSignals: [] });

    await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });

    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });

  test('no claim and no alert when the rescore is not critical', async () => {
    wireDb({ customer: CUSTOMER });
    const healthScoresChain = makeChain({ update: 1 });
    db.mockImplementation((table) => (table === 'customer_health_scores' ? healthScoresChain : makeChain({ first: CUSTOMER })));
    customerHealth.scoreCustomer.mockResolvedValue({ overall: 45, churnRisk: 'high', churnSignals: [] });

    await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });

    expect(healthScoresChain.update).not.toHaveBeenCalled(); // no claim attempted
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });

  test('won claim but no ADAM_PHONE → no SMS, no throw', async () => {
    delete process.env.ADAM_PHONE;
    wireDb({ claimResult: 1, customer: CUSTOMER });
    customerHealth.scoreCustomer.mockResolvedValue({ overall: 20, churnRisk: 'critical', churnSignals: [] });

    await expect(eventRescore.rescoreOnInboundMessage('c1', {})).resolves.toBeTruthy();
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });
});
