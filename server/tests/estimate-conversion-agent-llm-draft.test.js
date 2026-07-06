/**
 * Agent Review Draft — grounded LLM wiring (processInboundSms).
 *
 * The deterministic classifiers used to also WRITE the review draft via
 * fill-in-the-blank templates, which interpolated raw customer clauses
 * whenever a part-of-day word matched ("Hello Catherine! Hello what happened
 * this morning helps."). suggested_message now comes from the shadow
 * drafter's grounded draft→verify→revise engine; the templates remain only
 * as the fallback when the LLM draft is unavailable.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../services/sms-shadow-drafter', () => ({
  generateGroundedDraft: jest.fn(),
  PROMPT_VERSION: 'house_voice_v8',
}));

jest.mock('../services/context-aggregator', () => ({
  getContextForCustomer: jest.fn(async () => ({ summary: 'ctx', flags: [] })),
  getFullCustomerContext: jest.fn(async () => ({ summary: 'ctx', flags: [] })),
}));

jest.mock('../services/sms-suggest-mode', () => ({
  hasRedactionPlaceholder: jest.fn((text) => /\[(?:name|phone|address|date|time|email)\]/i.test(String(text || ''))),
}));

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({})));

jest.mock('../models/db', () => {
  const state = { inserts: [], smsLogRows: [], existingDecision: null };
  const makeBuilder = (table) => {
    const builder = {};
    const self = () => builder;
    Object.assign(builder, {
      select: jest.fn(self),
      where: jest.fn(self),
      andWhere: jest.fn(self),
      whereIn: jest.fn(self),
      whereNull: jest.fn(self),
      whereRaw: jest.fn(self),
      orWhereRaw: jest.fn(self),
      orderBy: jest.fn(self),
      orderByRaw: jest.fn(self),
      limit: jest.fn(self),
      first: jest.fn(async () => (table === 'agent_decisions' ? state.existingDecision : null)),
      insert: jest.fn((payload) => {
        state.inserts.push({ table, payload });
        return builder;
      }),
      returning: jest.fn(self),
      onConflict: jest.fn(() => ({ ignore: jest.fn(self) })),
      then: (resolve, reject) => {
        let rows = [];
        if (table === 'sms_log') rows = state.smsLogRows;
        if (table === 'agent_decisions' && state.inserts.length) {
          rows = [{ id: 'decision-1', ...state.inserts[state.inserts.length - 1].payload }];
        }
        return Promise.resolve(rows).then(resolve, reject);
      },
    });
    return builder;
  };
  const fn = jest.fn((table) => makeBuilder(table));
  fn.__state = state;
  return fn;
});

const db = require('../models/db');
const { generateGroundedDraft } = require('../services/sms-shadow-drafter');
const MODELS = require('../config/models');
const { processInboundSms } = require('../services/estimate-conversion-agent');

const CUSTOMER = { id: 'cust-1', first_name: 'Catherine', last_name: 'Jones' };

// An outbound scheduling prompt makes the thread "active scheduling", which is
// what routed Catherine's complaint into service_scheduling_sms in the first
// place — the exact misfire shape this wiring exists to fix.
function seedActiveSchedulingThread() {
  db.__state.smsLogRows = [
    {
      id: 'sms-out-1',
      direction: 'outbound',
      message_body: 'What time works best for your appointment on Tuesday?',
      message_type: 'manual',
      admin_user_id: 'admin-1',
      created_at: new Date('2026-07-05T10:00:00Z'),
    },
  ];
}

function lastDecisionInsert() {
  const rows = db.__state.inserts.filter((i) => i.table === 'agent_decisions');
  return rows[rows.length - 1]?.payload;
}

beforeEach(() => {
  db.__state.inserts.length = 0;
  db.__state.smsLogRows = [];
  db.__state.existingDecision = null;
  generateGroundedDraft.mockReset();
  delete process.env.AGENT_REVIEW_LLM_DRAFTS;
});

describe('processInboundSms — grounded LLM review draft', () => {
  test('scheduling misfire regression: LLM draft replaces the echo template', async () => {
    seedActiveSchedulingThread();
    generateGroundedDraft.mockResolvedValue({
      parsed: {
        reply: 'Hello Catherine! I am sorry the spiders are back. Let me check with the office on what happened this morning and I will follow up shortly.',
        intended_actions: [{ type: 'escalate' }],
        auto_send_safe: false,
        missing_info: null,
      },
      passes: 2,
      converged: true,
      model: MODELS.OPENAI_SMS_DRAFT,
    });

    const row = await processInboundSms({
      customer: CUSTOMER,
      from: '+19415551234',
      to: '+19415550000',
      body: 'Hello what happened this morning',
      smsLogId: 'sms-in-1',
      sourceMessageId: 'SM123',
    });

    expect(row).toBeTruthy();
    const payload = lastDecisionInsert();
    // The router still classifies deterministically…
    expect(payload.workflow).toBe('service_scheduling_sms');
    // …but the review draft is the grounded LLM reply, not the template echo.
    expect(payload.suggested_message).toContain('sorry the spiders are back');
    expect(payload.suggested_message).not.toContain('helps. I can check the route timing');
    // model = whichever model the drafter's routed engine actually used
    expect(payload.model).toBe(MODELS.OPENAI_SMS_DRAFT);
    expect(payload.prompt_version).toBe('house_voice_v8');
    const snapshot = JSON.parse(payload.input_snapshot);
    expect(snapshot.review_draft).toEqual({ source: 'llm', passes: 2, no_reply: false });

    // Drafter received the routed intent and the scheduling-intent flag.
    expect(generateGroundedDraft).toHaveBeenCalledTimes(1);
    const call = generateGroundedDraft.mock.calls[0][0];
    expect(call.inboundMessage).toBe('Hello what happened this morning');
    expect(call.intent.intent).toBe('service_scheduling_window_reply');
  });

  test('LLM failure falls back to the deterministic template', async () => {
    seedActiveSchedulingThread();
    generateGroundedDraft.mockRejectedValue(new Error('anthropic down'));

    await processInboundSms({
      customer: CUSTOMER,
      from: '+19415551234',
      to: '+19415550000',
      body: 'Hello what happened this morning',
      smsLogId: 'sms-in-2',
    });

    const payload = lastDecisionInsert();
    expect(payload.model).toBe('deterministic_rules');
    expect(payload.prompt_version).toBeNull();
    expect(typeof payload.suggested_message).toBe('string');
    expect(JSON.parse(payload.input_snapshot).review_draft).toEqual({ source: 'template' });
  });

  test('unconverged draft never replaces the template', async () => {
    seedActiveSchedulingThread();
    generateGroundedDraft.mockResolvedValue({
      parsed: { reply: 'The tech will be there at 2 PM sharp.', intended_actions: [], auto_send_safe: true, missing_info: null },
      passes: 3,
      converged: false,
    });

    await processInboundSms({
      customer: CUSTOMER,
      from: '+19415551234',
      to: '+19415550000',
      body: 'Hello what happened this morning',
      smsLogId: 'sms-in-3',
    });

    const payload = lastDecisionInsert();
    expect(payload.model).toBe('deterministic_rules');
    expect(payload.suggested_message).not.toContain('2 PM sharp');
  });

  test('redaction placeholder in the reply keeps the template', async () => {
    seedActiveSchedulingThread();
    generateGroundedDraft.mockResolvedValue({
      parsed: { reply: 'Hello [name]! We have you down for Tuesday.', intended_actions: [], auto_send_safe: true, missing_info: null },
      passes: 1,
      converged: true,
    });

    await processInboundSms({
      customer: CUSTOMER,
      from: '+19415551234',
      to: '+19415550000',
      body: 'Hello what happened this morning',
      smsLogId: 'sms-in-4',
    });

    const payload = lastDecisionInsert();
    expect(payload.model).toBe('deterministic_rules');
    expect(payload.suggested_message).not.toContain('[name]');
  });

  test('empty reply (no reply warranted) stores NULL, not the template', async () => {
    seedActiveSchedulingThread();
    generateGroundedDraft.mockResolvedValue({
      parsed: { reply: '', intended_actions: [{ type: 'none', note: 'no reply warranted' }], auto_send_safe: true, missing_info: null },
      passes: 1,
      converged: true,
      model: MODELS.OPENAI_SMS_DRAFT,
    });

    await processInboundSms({
      customer: CUSTOMER,
      from: '+19415551234',
      to: '+19415550000',
      body: 'Hello what happened this morning',
      smsLogId: 'sms-in-5',
    });

    const payload = lastDecisionInsert();
    expect(payload.suggested_message).toBeNull();
    expect(payload.model).toBe(MODELS.OPENAI_SMS_DRAFT);
    expect(JSON.parse(payload.input_snapshot).review_draft).toEqual({ source: 'llm', passes: 1, no_reply: true });
  });

  test('no matched customer: drafter never called, template kept', async () => {
    generateGroundedDraft.mockResolvedValue({ parsed: { reply: 'x' }, passes: 1, converged: true });

    await processInboundSms({
      customer: null,
      from: '+19415551234',
      to: '+19415550000',
      body: 'Hello what happened this morning',
      smsLogId: 'sms-in-6',
    });

    expect(generateGroundedDraft).not.toHaveBeenCalled();
  });

  test('webhook redelivery: existing idempotency key short-circuits BEFORE any LLM call', async () => {
    seedActiveSchedulingThread();
    db.__state.existingDecision = { id: 'decision-already-there' };
    generateGroundedDraft.mockResolvedValue({ parsed: { reply: 'x' }, passes: 1, converged: true, model: 'm' });

    const row = await processInboundSms({
      customer: CUSTOMER,
      from: '+19415551234',
      to: '+19415550000',
      body: 'Hello what happened this morning',
      smsLogId: 'sms-in-8',
      sourceMessageId: 'SM-redelivered',
    });

    expect(row).toBeNull(); // same semantics as the ignored insert
    expect(generateGroundedDraft).not.toHaveBeenCalled();
    expect(db.__state.inserts.filter((i) => i.table === 'agent_decisions')).toHaveLength(0);
  });

  test('kill switch AGENT_REVIEW_LLM_DRAFTS=false: drafter never called', async () => {
    process.env.AGENT_REVIEW_LLM_DRAFTS = 'false';
    seedActiveSchedulingThread();
    generateGroundedDraft.mockResolvedValue({ parsed: { reply: 'x' }, passes: 1, converged: true });

    await processInboundSms({
      customer: CUSTOMER,
      from: '+19415551234',
      to: '+19415550000',
      body: 'Hello what happened this morning',
      smsLogId: 'sms-in-7',
    });

    expect(generateGroundedDraft).not.toHaveBeenCalled();
    const payload = lastDecisionInsert();
    expect(payload.model).toBe('deterministic_rules');
  });
});
