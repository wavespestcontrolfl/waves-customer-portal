/**
 * Retention engine — the nightly critical-churn owner SMS is gated.
 *
 * Owner paused health notifications 2026-07-11: the "CHURN ALERT" SMS to
 * ADAM_PHONE must not fire unless GATE_CHURN_ALERT_SMS=true. Pins:
 *  - gate off → the outreach draft still saves (pending_approval) and is
 *    returned, but no SMS goes out;
 *  - gate on → the SMS fires to ADAM_PHONE as an internal_alert;
 *  - the real feature-gates entry fails closed when the env var is unset.
 */

jest.mock('../models/db', () => {
  const firstByTable = {};
  const insertedRows = [];
  const db = jest.fn((table) => {
    const chain = {
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      select: async () => [],
      first: async () => firstByTable[table],
      insert: (row) => {
        insertedRows.push({ table, row });
        return { returning: async () => [{ id: 77, ...row }] };
      },
    };
    return chain;
  });
  db.__firstByTable = firstByTable;
  db.__insertedRows = insertedRows;
  return db;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));
jest.mock('../services/twilio', () => ({
  sendSMS: jest.fn(async () => ({ sent: true })),
}));
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn(async () => ({
        content: [{
          text: JSON.stringify({
            outreach_type: 'call',
            strategy: 'personal_call',
            message: 'Personal call from Adam recommended.',
            urgency: 'today',
          }),
        }],
      })),
    },
  })),
);
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
}));

const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { isEnabled } = require('../config/feature-gates');
const RetentionEngine = require('../services/customer-intelligence/retention-engine');

const CUSTOMER_ID = 42;

beforeEach(() => {
  jest.clearAllMocks();
  db.__insertedRows.length = 0;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ADAM_PHONE = '+15555550100';
  db.__firstByTable.customer_health_scores = {
    customer_id: CUSTOMER_ID,
    churn_risk: 'critical',
    overall_score: 22,
    churn_probability: 0.8,
    churn_signals: JSON.stringify([{ signal: 'payment_failed', value: '2 failed payments' }]),
  };
  db.__firstByTable.customers = {
    id: CUSTOMER_ID,
    first_name: 'Pat',
    last_name: 'Rivera',
    // #2631 churn-lead-guard: outreach requires a real-customer pipeline stage
    // (active_customer/won/at_risk) and no soft-delete; leads get null.
    pipeline_stage: 'active_customer',
    deleted_at: null,
    waveguard_tier: 'Gold',
    monthly_rate: 89,
  };
  db.__firstByTable.retention_outreach = undefined; // no recent outreach
});

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ADAM_PHONE;
  delete process.env.GATE_CHURN_ALERT_SMS;
});

test('#2631 churn-lead-guard: a new_leads-stage record gets no outreach and no SMS', async () => {
  isEnabled.mockReturnValue(true);
  db.__firstByTable.customers = { ...db.__firstByTable.customers, pipeline_stage: 'new_leads' };

  const saved = await RetentionEngine.generateRetentionOutreach(CUSTOMER_ID);

  expect(saved).toBeNull();
  expect(db.__insertedRows.some((r) => r.table === 'retention_outreach')).toBe(false);
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
});

test('gate OFF: outreach draft still saves but no owner SMS fires', async () => {
  isEnabled.mockReturnValue(false);

  const saved = await RetentionEngine.generateRetentionOutreach(CUSTOMER_ID);

  expect(saved).toBeTruthy();
  expect(saved.status).toBe('pending_approval');
  expect(db.__insertedRows.some((r) => r.table === 'retention_outreach')).toBe(true);
  expect(isEnabled).toHaveBeenCalledWith('churnAlertSms');
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
});

test('gate ON: critical customer fires the internal_alert SMS to ADAM_PHONE', async () => {
  isEnabled.mockReturnValue(true);

  const saved = await RetentionEngine.generateRetentionOutreach(CUSTOMER_ID);

  expect(saved).toBeTruthy();
  expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
  const [to, body, opts] = TwilioService.sendSMS.mock.calls[0];
  expect(to).toBe('+15555550100');
  expect(body).toContain('CHURN ALERT');
  expect(opts).toEqual({ messageType: 'internal_alert' });
});

test('real feature-gates entry fails closed (env unset) and opens only on exactly "true"', () => {
  const loadRealGates = () => {
    let mod;
    jest.isolateModules(() => {
      mod = jest.requireActual('../config/feature-gates');
    });
    return mod;
  };

  delete process.env.GATE_CHURN_ALERT_SMS;
  expect(loadRealGates().gates.churnAlertSms).toBe(false);

  process.env.GATE_CHURN_ALERT_SMS = 'false';
  expect(loadRealGates().gates.churnAlertSms).toBe(false);

  process.env.GATE_CHURN_ALERT_SMS = 'true';
  expect(loadRealGates().gates.churnAlertSms).toBe(true);
});
