// RetentionEngine.generateRetentionOutreach's dispatchWithFallback validate
// hook (Codex reviewer finding on #4884): the OUTREACH_SCHEMA doesn't enum
// or length-bound `message` / `strategy`, so
// {"outreach_type":"sms","strategy":"","message":"   ","urgency":"today"}
// would previously store a pending_approval row with a blank message (could
// text the owner a blank action), and a `strategy` over 255 chars would fail
// the varchar(255) outreach_strategy insert (migration 20260401000037) and
// abort the nightly loop. Fixed with a validate hook requiring a non-blank
// message and a non-blank, <=255-char strategy — rejected either way rather
// than truncated, since strategy is a short free-text label the schema
// itself does not bound.
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
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model', TEXT_POLICIES: { customerCopy: { name: 'customerCopy' } } }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  customerIntelAiLive: () => process.env.GATE_CUSTOMER_INTEL_AI === 'true',
}));

const db = require('../models/db');
const { dispatchWithFallback } = require('../services/llm/call');
const RetentionEngine = require('../services/customer-intelligence/retention-engine');

const CUSTOMER_ID = 42;

beforeAll(() => { process.env.GATE_CUSTOMER_INTEL_AI = 'true'; });
afterAll(() => { delete process.env.GATE_CUSTOMER_INTEL_AI; });

beforeEach(() => {
  jest.clearAllMocks();
  db.__insertedRows.length = 0;
  db.__firstByTable.customer_health_scores = {
    customer_id: CUSTOMER_ID, churn_risk: 'critical', overall_score: 22, churn_probability: 0.8,
    churn_signals: JSON.stringify([{ signal: 'payment_failed', value: '2 failed payments' }]),
  };
  db.__firstByTable.customers = {
    id: CUSTOMER_ID, first_name: 'Pat', last_name: 'Rivera',
    pipeline_stage: 'active_customer', deleted_at: null, waveguard_tier: 'Gold', monthly_rate: 89,
  };
  db.__firstByTable.retention_outreach = undefined;
});

// Grabs the `validate` hook dispatchWithFallback was called with, without
// caring about the rest of generateRetentionOutreach's flow.
async function capturedValidate() {
  dispatchWithFallback.mockResolvedValue({ ok: true, json: {} });
  await RetentionEngine.generateRetentionOutreach(CUSTOMER_ID);
  const [, , options] = dispatchWithFallback.mock.calls[0];
  return options.validate;
}

describe('generateRetentionOutreach dispatchWithFallback validate hook', () => {
  test('a blank message is rejected', async () => {
    const validate = await capturedValidate();
    expect(validate({ json: { outreach_type: 'sms', strategy: 'empathy_check_in', message: '   ', urgency: 'today' } })).toBe('schema_invalid');
    expect(validate({ json: { outreach_type: 'sms', strategy: 'empathy_check_in', message: 42, urgency: 'today' } })).toBe('schema_invalid');
  });

  test('a blank strategy is rejected', async () => {
    const validate = await capturedValidate();
    expect(validate({ json: { outreach_type: 'sms', strategy: '', message: 'Hi Pat, checking in.', urgency: 'today' } })).toBe('schema_invalid');
    expect(validate({ json: { outreach_type: 'sms', strategy: '   ', message: 'Hi Pat, checking in.', urgency: 'today' } })).toBe('schema_invalid');
  });

  test('a strategy over 255 chars is rejected rather than truncated', async () => {
    const validate = await capturedValidate();
    expect(validate({ json: { outreach_type: 'sms', strategy: 'x'.repeat(256), message: 'Hi Pat, checking in.', urgency: 'today' } })).toBe('schema_invalid');
    expect(validate({ json: { outreach_type: 'sms', strategy: 'x'.repeat(255), message: 'Hi Pat, checking in.', urgency: 'today' } })).toBeNull();
  });

  test('a rejected draft (dispatchWithFallback returns ok:false) is never saved', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'schema_invalid' });
    expect(await RetentionEngine.generateRetentionOutreach(CUSTOMER_ID)).toBeNull();
    expect(db.__insertedRows.some((r) => r.table === 'retention_outreach')).toBe(false);
  });

  test('an on-contract draft validates clean and is saved', async () => {
    dispatchWithFallback.mockResolvedValue({
      ok: true,
      json: { outreach_type: 'sms', strategy: 'empathy_check_in', message: 'Hi Pat, checking in on the recent visit.', urgency: 'today' },
    });
    const saved = await RetentionEngine.generateRetentionOutreach(CUSTOMER_ID);
    const [, , options] = dispatchWithFallback.mock.calls[0];
    expect(options.validate({ json: { outreach_type: 'sms', strategy: 'empathy_check_in', message: 'Hi Pat, checking in on the recent visit.', urgency: 'today' } })).toBeNull();
    expect(saved).toBeDefined();
    expect(db.__insertedRows.some((r) => r.table === 'retention_outreach')).toBe(true);
  });
});
