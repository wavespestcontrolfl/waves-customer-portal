/**
 * Event-driven health rescore (near-real-time on a hot inbound SMS).
 *  - no-op unless GATE_EVENT_RESCORE === 'true',
 *  - detects fresh signals for the customer, then rescores (canonical engine),
 *  - alerts the owner ONLY on a transition INTO critical (fires once at the
 *    crossing, never on every subsequent message while already critical),
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

function makeChain(firstResult) {
  const chain = {};
  chain.where = jest.fn(() => chain);
  chain.orderByRaw = jest.fn(() => chain);
  chain.first = jest.fn(() => Promise.resolve(firstResult));
  return chain;
}

// db queue per table: priorRow lookup (customer_health_scores), then customer
function wireDb({ priorRow, customer }) {
  const queues = {
    customer_health_scores: [makeChain(priorRow)],
    customers: [makeChain(customer)],
  };
  db.mockImplementation((table) => (queues[table]?.shift()) || makeChain(undefined));
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
    wireDb({ priorRow: { churn_risk: 'moderate' }, customer: CUSTOMER });
    customerHealth.scoreCustomer.mockResolvedValue({ overall: 70, churnRisk: 'moderate', churnSignals: [] });

    await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });

    expect(SignalDetector.detectSignals).toHaveBeenCalledWith('c1');
    expect(customerHealth.scoreCustomer).toHaveBeenCalledWith('c1');
    // detection happens before scoring
    expect(SignalDetector.detectSignals.mock.invocationCallOrder[0])
      .toBeLessThan(customerHealth.scoreCustomer.mock.invocationCallOrder[0]);
  });

  test('alerts the owner on a transition INTO critical', async () => {
    wireDb({ priorRow: { churn_risk: 'high' }, customer: CUSTOMER });
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

  test('does NOT re-alert when the customer was already critical', async () => {
    wireDb({ priorRow: { churn_risk: 'critical' }, customer: CUSTOMER });
    customerHealth.scoreCustomer.mockResolvedValue({ overall: 18, churnRisk: 'critical', churnSignals: [] });

    await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });

    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });

  test('no alert when the rescore is not critical', async () => {
    wireDb({ priorRow: { churn_risk: 'moderate' }, customer: CUSTOMER });
    customerHealth.scoreCustomer.mockResolvedValue({ overall: 45, churnRisk: 'high', churnSignals: [] });

    await eventRescore.rescoreOnInboundMessage('c1', { source: 'inbound_sms' });

    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });

  test('critical transition but no ADAM_PHONE → no alert, no throw', async () => {
    delete process.env.ADAM_PHONE;
    wireDb({ priorRow: { churn_risk: 'high' }, customer: CUSTOMER });
    customerHealth.scoreCustomer.mockResolvedValue({ overall: 20, churnRisk: 'critical', churnSignals: [] });

    await expect(eventRescore.rescoreOnInboundMessage('c1', {})).resolves.toBeTruthy();
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });
});
