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
  buildLiveEtaSnapshot: jest.fn(() => null),
  // Round-42: the lane also persists the draft's technician first names (none in these fixtures).
  techNamesFromContext: jest.fn(() => []),
  visitLoopCommitmentIds: jest.fn(() => []),
  visitLoopStatus: jest.fn(() => null),
  PROMPT_VERSION: 'house_voice_v8',
  // Real behavior mirrored for the gate-on tests below (Codex r3): true
  // when the reply carries an amount not present in context.billing's
  // authorized figures. Kept intentionally simple — the drafter's own unit
  // tests cover the full extraction/authorization grammar; this test file
  // only needs grounded-vs-ungrounded discrimination.
  replyQuotesUngroundedAmount: jest.fn((reply, context) => {
    const amounts = (String(reply || '').match(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g) || [])
      .map((a) => Math.round(Number(a.replace(/[^\d.]/g, '')) * 100));
    if (!amounts.length) return false;
    const authorized = new Set(
      [context?.billing?.outstandingBalance].filter((v) => v != null).map((v) => Math.round(v * 100))
    );
    return amounts.some((a) => !authorized.has(a));
  }),
  // Codex round-3 P2: generateLlmReviewDraft re-runs validateReserviceOffer
  // to persist the promised re-service lane(s), if any, on the review
  // card's input_snapshot. None of this file's fixtures promise a
  // re-service, so the stub reports no promise.
  validateReserviceOffer: jest.fn(() => ({ ok: true, violations: [], promisedLanes: undefined })),
  // generateLlmReviewDraft also persists the already-booked callbacks' snapshot (round-18); none here.
  reserviceBookedSnapshot: jest.fn(() => ({})),
}));

jest.mock('../services/context-aggregator', () => ({
  getContextForCustomer: jest.fn(async () => ({ summary: 'ctx', flags: [] })),
  getFullCustomerContext: jest.fn(async () => ({ summary: 'ctx', flags: [] })),
}));

jest.mock('../services/sms-suggest-mode', () => ({
  hasRedactionPlaceholder: jest.fn((text) => /\[(?:name|phone|address|date|time|email)\]/i.test(String(text || ''))),
  hasPriceQuote: jest.fn((text) => /\$\s*\d|\b\d[\d,]*(?:\.\d+)?\s*dollars?\b/i.test(String(text || ''))),
  // real sanitizer: the persisted shape is the contract /agent-draft reads
  sanitizeIntendedActions: jest.requireActual('../services/sms-suggest-mode').sanitizeIntendedActions,
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
const { generateGroundedDraft, replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');
const ContextAggregator = require('../services/context-aggregator');
const MODELS = require('../config/models');
const { processInboundSms, _test } = require('../services/estimate-conversion-agent');

const CUSTOMER = { id: 'cust-1', first_name: 'Catherine', last_name: 'Jones', city: 'Venice' };

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
  replyQuotesUngroundedAmount.mockClear();
  ContextAggregator.getContextForCustomer.mockReset();
  ContextAggregator.getContextForCustomer.mockResolvedValue({ summary: 'ctx', flags: [] });
  delete process.env.AGENT_REVIEW_LLM_DRAFTS;
  delete process.env.GATE_SMS_REAL_ANSWERS;
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
      // The version THIS draft actually used (pre-push audit P1) —
      // generateLlmReviewDraft now persists this per-draft value instead of
      // the static drafter.PROMPT_VERSION.
      promptVersion: 'house_voice_v8',
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
    // A live, sendable draft: may reach the scheduler path with no city.
    expect(call.liveOpenTimes).toBe(true);
    // Real-answers OPEN TIMES (pre-push audit P1): without this, a matched
    // customer's known city never reaches fetchOpenTimesBlock, and the
    // gate-on prompt would ask the model to offer times it has none of.
    expect(call.city).toBe('Venice');
  });

  test('persists the PER-DRAFT promptVersion generateGroundedDraft actually returned, not a hardcoded constant (pre-push audit P1)', async () => {
    seedActiveSchedulingThread();
    generateGroundedDraft.mockResolvedValue({
      parsed: { reply: 'Happy to help — here is what I have.', intended_actions: [], auto_send_safe: true, missing_info: null },
      passes: 1,
      converged: true,
      model: MODELS.OPENAI_SMS_DRAFT,
      // A value the mocked drafter.PROMPT_VERSION ('house_voice_v8' in this
      // file's module mock) does NOT match — proves the persisted value
      // came from THIS call's own result, never the static import.
      promptVersion: 'house_voice_v12_real_answers',
    });

    await processInboundSms({
      customer: CUSTOMER,
      from: '+19415551234',
      to: '+19415550000',
      body: 'Hello what happened this morning',
      smsLogId: 'sms-in-9',
    });

    const payload = lastDecisionInsert();
    expect(payload.prompt_version).toBe('house_voice_v12_real_answers');
  });

  test('persists the drafter\'s facts-generated instant as input_snapshot.facts_generated_at (Codex #5194 P2)', async () => {
    seedActiveSchedulingThread();
    const factsAt = new Date('2026-09-28T23:59:30.000Z');
    generateGroundedDraft.mockResolvedValue({
      parsed: { reply: 'A teammate will follow up.', intended_actions: [{ type: 'escalate', note: 'followup_promised' }], auto_send_safe: false, missing_info: null },
      passes: 1,
      converged: true,
      model: MODELS.OPENAI_SMS_DRAFT,
      promptVersion: 'house_voice_v12_real_answers',
      factsGeneratedAt: factsAt,
    });

    await processInboundSms({
      customer: CUSTOMER, from: '+19415551234', to: '+19415550000',
      body: 'Hello what happened this morning', smsLogId: 'sms-in-10',
    });

    const snapshot = JSON.parse(lastDecisionInsert().input_snapshot);
    expect(snapshot.facts_generated_at).toBe(factsAt.toISOString());
  });

  test('omits facts_generated_at when the drafter returns none (legacy/frozen replay)', async () => {
    seedActiveSchedulingThread();
    generateGroundedDraft.mockResolvedValue({
      parsed: { reply: 'Happy to help.', intended_actions: [], auto_send_safe: true, missing_info: null },
      passes: 1, converged: true, model: MODELS.OPENAI_SMS_DRAFT, promptVersion: 'house_voice_v12_real_answers',
    });

    await processInboundSms({
      customer: CUSTOMER, from: '+19415551234', to: '+19415550000',
      body: 'Hello what happened this morning', smsLogId: 'sms-in-11',
    });

    expect(JSON.parse(lastDecisionInsert().input_snapshot)).not.toHaveProperty('facts_generated_at');
  });

  test('passes the already-resolved estimate id through to generateGroundedDraft (pre-push audit P2)', async () => {
    // fetchOpenTimesBlock's getAvailableSlots(city, estimateId, {customerId})
    // needs THAT estimate's own service minutes, not a generic default —
    // generateLlmReviewDraft must forward estimate.id, not drop it.
    generateGroundedDraft.mockResolvedValue({
      parsed: { reply: 'ok', intended_actions: [], auto_send_safe: true, missing_info: null },
      passes: 1,
      converged: true,
      model: MODELS.OPENAI_SMS_DRAFT,
      promptVersion: 'house_voice_v8',
    });

    await _test.generateLlmReviewDraft({
      customer: CUSTOMER,
      body: 'Hello what happened this morning',
      decision: { intent: 'service_scheduling_window_reply', confidence: 0.9 },
      estimate: { id: 'estimate-42' },
    });

    expect(generateGroundedDraft).toHaveBeenCalledWith(expect.objectContaining({ estimateId: 'estimate-42' }));
  });

  test('no estimate resolved: estimateId is null, not undefined or omitted', async () => {
    generateGroundedDraft.mockResolvedValue({
      parsed: { reply: 'ok', intended_actions: [], auto_send_safe: true, missing_info: null },
      passes: 1,
      converged: true,
      model: MODELS.OPENAI_SMS_DRAFT,
      promptVersion: 'house_voice_v8',
    });

    await _test.generateLlmReviewDraft({
      customer: CUSTOMER,
      body: 'Hello what happened this morning',
      decision: { intent: 'service_scheduling_window_reply', confidence: 0.9 },
      estimate: undefined,
    });

    expect(generateGroundedDraft).toHaveBeenCalledWith(expect.objectContaining({ estimateId: null }));
  });

  // Codex round-2 P2: getContextForCustomer defaults to skipping the LIVE
  // ETA GPS lookup — this Agent Review draft renders the SAME buildFactsBlock
  // the shadow drafter does, so it must opt in explicitly rather than
  // silently losing the fact to the new default.
  test('opts into LIVE ETA resolution — this draft renders the facts block LIVE ETA feeds (Codex round-2 P2)', async () => {
    generateGroundedDraft.mockResolvedValue({
      parsed: { reply: 'ok', intended_actions: [], auto_send_safe: true, missing_info: null },
      passes: 1,
      converged: true,
      model: MODELS.OPENAI_SMS_DRAFT,
      promptVersion: 'house_voice_v8',
    });

    await _test.generateLlmReviewDraft({
      customer: CUSTOMER,
      body: 'Hello what happened this morning',
      decision: { intent: 'service_scheduling_window_reply', confidence: 0.9 },
    });

    // Codex round-16 P2: the opt-in also requires the release gate (gate-off is byte-identical).
    expect(ContextAggregator.getContextForCustomer).toHaveBeenCalledWith(CUSTOMER, { includeLiveEta: false });

    ContextAggregator.getContextForCustomer.mockClear();
    const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    try {
      await _test.generateLlmReviewDraft({
        customer: CUSTOMER,
        body: 'Hello what happened this morning',
        decision: { intent: 'service_scheduling_window_reply', confidence: 0.9 },
      });
      expect(ContextAggregator.getContextForCustomer).toHaveBeenCalledWith(CUSTOMER, { includeLiveEta: true });
    } finally {
      if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
    }
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
    // The scheduling lane has no template: an empty card, never an echo.
    expect(payload.suggested_message).toBeNull();
    expect(JSON.parse(payload.input_snapshot).review_draft).toEqual({ source: 'template' });
  });

  test('LLM failure on a scheduling text never echoes the customer back (re-service regression)', async () => {
    generateGroundedDraft.mockResolvedValue({ parsed: null, passes: 0, converged: false });

    await processInboundSms({
      customer: CUSTOMER,
      from: '+19415551234',
      to: '+19415550000',
      body: 'We have had a few centipedes, and a few roaches get caught in our glue traps since your initial visit. I am curious if you are able to do Saturday morning before 9am for a respray?',
      smsLogId: 'sms-in-echo',
    });

    const payload = lastDecisionInsert();
    expect(payload.workflow).toBe('service_scheduling_sms');
    expect(payload.suggested_message).toBeNull();
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
    expect(payload.suggested_message).toBeNull();
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
    expect(payload.suggested_message).toBeNull();
  });

  test('a priced reply keeps the template (house rule: no prices in SMS)', async () => {
    seedActiveSchedulingThread();
    generateGroundedDraft.mockResolvedValue({
      parsed: { reply: 'Hello! The re-treatment runs $415.75, want me to book it?', intended_actions: [], auto_send_safe: true, missing_info: null },
      passes: 1,
      converged: true,
    });

    await processInboundSms({
      customer: CUSTOMER,
      from: '+19415551234',
      to: '+19415550000',
      body: 'Hello what happened this morning',
      smsLogId: 'sms-in-7',
    });

    const payload = lastDecisionInsert();
    expect(payload.model).toBe('deterministic_rules');
    expect(payload.suggested_message).toBeNull();
  });

  test('a priced TEMPLATE echo also stores NULL — the fallback lane is guarded too (Codex P1)', async () => {
    seedActiveSchedulingThread();
    // LLM path unavailable → no scheduling template, so nothing of the
    // customer's own "$50" can reach the card.
    generateGroundedDraft.mockResolvedValue({ parsed: null, passes: 0, converged: false });

    await processInboundSms({
      customer: CUSTOMER,
      from: '+19415551234',
      to: '+19415550000',
      body: 'Can we do Tuesday for $50',
      smsLogId: 'sms-in-8',
    });

    const payload = lastDecisionInsert();
    expect(payload.model).toBe('deterministic_rules');
    expect(payload.suggested_message).toBeNull();
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

// Codex r3 (PR #5119): with GATE_SMS_REAL_ANSWERS on, the shared drafter is
// instructed to answer billing questions with exact grounded amounts, but
// this lane rejected every hasPriceQuote match regardless — discarding a
// verified v12 answer in favor of the template. These lock the gate-aware
// fix: gate off stays byte-identical; gate on rejects only an amount the
// shared guard (replyQuotesUngroundedAmount) says is unauthorized.
describe('processInboundSms — GATE_SMS_REAL_ANSWERS grounded-amount guard (Codex r3)', () => {
  test('gate ON + a grounded amount (matches context.billing.outstandingBalance): LLM draft kept and persisted', async () => {
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    seedActiveSchedulingThread();
    ContextAggregator.getContextForCustomer.mockResolvedValue({
      summary: 'ctx',
      flags: [],
      billing: { outstandingBalance: 120.5 },
    });
    generateGroundedDraft.mockResolvedValue({
      parsed: { reply: 'Your current balance is $120.50 — want me to send a payment link?', intended_actions: [], auto_send_safe: false, missing_info: null },
      passes: 1,
      converged: true,
      model: MODELS.OPENAI_SMS_DRAFT,
      promptVersion: 'house_voice_v12_real_answers',
    });

    await processInboundSms({
      customer: CUSTOMER,
      from: '+19415551234',
      to: '+19415550000',
      body: 'How much do I owe',
      smsLogId: 'sms-in-grounded-1',
    });

    expect(replyQuotesUngroundedAmount).toHaveBeenCalled();
    const payload = lastDecisionInsert();
    expect(payload.model).toBe(MODELS.OPENAI_SMS_DRAFT);
    expect(payload.suggested_message).toContain('$120.50');
    expect(JSON.parse(payload.input_snapshot).review_draft).toEqual({ source: 'llm', passes: 1, no_reply: false });
  });

  test('gate ON + an ungrounded amount (no matching billing fact): falls back to the template', async () => {
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    seedActiveSchedulingThread();
    ContextAggregator.getContextForCustomer.mockResolvedValue({
      summary: 'ctx',
      flags: [],
      billing: { outstandingBalance: 120.5 },
    });
    generateGroundedDraft.mockResolvedValue({
      parsed: { reply: 'Your balance is $9999.00 — want me to send a payment link?', intended_actions: [], auto_send_safe: false, missing_info: null },
      passes: 1,
      converged: true,
      model: MODELS.OPENAI_SMS_DRAFT,
      promptVersion: 'house_voice_v12_real_answers',
    });

    await processInboundSms({
      customer: CUSTOMER,
      from: '+19415551234',
      to: '+19415550000',
      body: 'How much do I owe',
      smsLogId: 'sms-in-ungrounded-1',
    });

    expect(replyQuotesUngroundedAmount).toHaveBeenCalled();
    const payload = lastDecisionInsert();
    expect(payload.model).toBe('deterministic_rules');
    expect(payload.suggested_message || '').not.toContain('$9999.00');
  });

  test('gate OFF + any amount (even one that matches a billing fact): still falls back to the template (unchanged)', async () => {
    seedActiveSchedulingThread();
    ContextAggregator.getContextForCustomer.mockResolvedValue({
      summary: 'ctx',
      flags: [],
      billing: { outstandingBalance: 120.5 },
    });
    generateGroundedDraft.mockResolvedValue({
      parsed: { reply: 'Your balance is $120.50 — want me to send a payment link?', intended_actions: [], auto_send_safe: false, missing_info: null },
      passes: 1,
      converged: true,
      model: MODELS.OPENAI_SMS_DRAFT,
      promptVersion: 'house_voice_v8',
    });

    await processInboundSms({
      customer: CUSTOMER,
      from: '+19415551234',
      to: '+19415550000',
      body: 'How much do I owe',
      smsLogId: 'sms-in-gate-off-1',
    });

    // Gate off never reaches the shared guard — same blanket hasPriceQuote
    // reject as before this fix.
    expect(replyQuotesUngroundedAmount).not.toHaveBeenCalled();
    const payload = lastDecisionInsert();
    expect(payload.model).toBe('deterministic_rules');
    expect(payload.suggested_message || '').not.toContain('$120.50');
  });
});


// Pre-push audit P1 (PR #5119 round 3): the estimate-review lane discarded
// parsed.intended_actions, so a v12 draft promising a payment link, a
// booking, or an owned follow-up reached the reviewer with no visible action.
describe('processInboundSms — intended actions persist on the estimate-review card', () => {
  test('an LLM draft\'s actions are sanitized into input_snapshot.intended_actions', async () => {
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    seedActiveSchedulingThread();
    ContextAggregator.getContextForCustomer.mockResolvedValue({ summary: 'ctx', flags: [], billing: { outstandingBalance: 120.5 } });
    generateGroundedDraft.mockResolvedValue({
      parsed: {
        reply: 'Your current balance is $120.50 — I will text your pay link now.',
        intended_actions: [{ type: 'send_payment_link' }, { type: 'escalate', note: 'followup_promised' }, { type: 42 }, { type: 'x', note: 'n'.repeat(300) }],
        auto_send_safe: false, missing_info: null,
      },
      passes: 1, converged: true, model: MODELS.OPENAI_SMS_DRAFT, promptVersion: 'house_voice_v12_real_answers',
    });
    await processInboundSms({ customer: CUSTOMER, from: '+19415551234', to: '+19415550000', body: 'How much do I owe', smsLogId: 'sms-in-actions-1' });
    const snapshot = JSON.parse(lastDecisionInsert().input_snapshot);
    expect(snapshot.intended_actions).toEqual([
      { type: 'send_payment_link' },
      { type: 'escalate', note: 'followup_promised' },
      { type: 'x', note: 'n'.repeat(200) },
    ]);
  });

  // Codex round-20 P2 (PR #5336): the snapshot rebuild must resolve the SAME lane the verification did — a
  // pronoun-only pest report ("they're back") needs the customer context, or the lane is lost and the
  // card is later rejected with "no promised re-service lane on record".
  test('the re-service snapshot rebuild gets the same context the draft was verified with (pronoun-only report keeps its lane)', async () => {
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    seedActiveSchedulingThread();
    const ctx = { summary: 'ctx', flags: [], customer: { id: 'cust-1' }, serviceHistory: [{ type: 'General Pest Control' }] };
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx);
    const { validateReserviceOffer } = require('../services/sms-shadow-drafter');
    validateReserviceOffer.mockClear();
    validateReserviceOffer.mockImplementation(({ context }) => (context && context.serviceHistory
      ? { ok: true, violations: [], promisedLanes: ['pest'] }
      : { ok: false, violations: ['no lane'] }));
    generateGroundedDraft.mockResolvedValue({
      parsed: {
        reply: "So sorry! I'm sending your free re-service booking link now.",
        intended_actions: [{ type: 'escalate', note: 'send_reservice_link' }],
        auto_send_safe: false, missing_info: null,
      },
      passes: 1, converged: true, model: MODELS.OPENAI_SMS_DRAFT, promptVersion: 'house_voice_v12_real_answers2',
    });
    await processInboundSms({ customer: CUSTOMER, from: '+19415551234', to: '+19415550000', body: "they're back", smsLogId: 'sms-in-pronoun-1' });
    const call = validateReserviceOffer.mock.calls[validateReserviceOffer.mock.calls.length - 1][0];
    expect(call.context).toBe(ctx);
    const snapshot = JSON.parse(lastDecisionInsert().input_snapshot);
    expect(snapshot.reservice_lanes_snapshot).toEqual(['pest']);
    validateReserviceOffer.mockImplementation(() => ({ ok: true, violations: [], promisedLanes: undefined }));
  });

  test('a template (non-LLM) draft carries no intended_actions key', async () => {
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    seedActiveSchedulingThread();
    generateGroundedDraft.mockResolvedValue(null);
    await processInboundSms({ customer: CUSTOMER, from: '+19415551234', to: '+19415550000', body: 'Can we do Tuesday', smsLogId: 'sms-in-actions-2' });
    const snapshot = JSON.parse(lastDecisionInsert().input_snapshot);
    expect(snapshot).not.toHaveProperty('intended_actions');
  });
});


// #5194 r2/r8: only the estimate's short code pins it as the priced job —
// never merely because the customer has one open, nor because the text says
// "estimate" or "quote".
describe('processInboundSms — estimate forwarded only when the message is linked to it', () => {
  test('a generic request with no short code forwards estimateId null', async () => {
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    seedActiveSchedulingThread();
    generateGroundedDraft.mockResolvedValue({ parsed: { reply: 'ok', intended_actions: [], auto_send_safe: true, missing_info: null }, passes: 1, converged: true, model: MODELS.OPENAI_SMS_DRAFT, promptVersion: 'house_voice_v12_real_answers' });
    await processInboundSms({ customer: CUSTOMER, from: '+19415551234', to: '+19415550000', body: 'Can you add lawn service Tuesday?', smsLogId: 'sms-link-1' });
    const calls = generateGroundedDraft.mock.calls;
    expect(calls[calls.length - 1][0]).toMatchObject({ estimateId: null });
  });
});


// A linked estimate prices the lookup itself; an unlinked open estimate is
// handed to the drafter as one job the reply may be about, and the drafter's
// service identity step decides (owner 2026-09-28; the choice itself is
// covered in sms-real-answers.test.js).
describe('generateLlmReviewDraft — estimate linkage from the conversation', () => {
  const draft = () => ({ parsed: { reply: 'ok', intended_actions: [], auto_send_safe: true, missing_info: null }, passes: 1, converged: true, model: MODELS.OPENAI_SMS_DRAFT, promptVersion: 'house_voice_v12_real_answers' });
  test('not linked → estimateId null and the estimate offered as an option; linked → estimateId, no option', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue({ summary: 'ctx', flags: [], upcomingServices: [] });
    generateGroundedDraft.mockResolvedValue(draft());
    await _test.generateLlmReviewDraft({ customer: CUSTOMER, body: 'Sounds good, can we do Tuesday?', decision: { intent: 'service_scheduling_window_reply', confidence: 0.9 }, estimate: { id: 'estimate-42', service_interest: 'Mosquito Control' }, estimateLinked: false });
    expect(generateGroundedDraft).toHaveBeenLastCalledWith(expect.objectContaining({ estimateId: null, openEstimate: { id: 'estimate-42', service: 'Mosquito Control' } }));
    generateGroundedDraft.mockResolvedValue(draft());
    await _test.generateLlmReviewDraft({ customer: CUSTOMER, body: 'About my estimate — can we do Tuesday?', decision: { intent: 'service_scheduling_window_reply', confidence: 0.9 }, estimate: { id: 'estimate-42', service_interest: 'Mosquito Control' }, estimateLinked: true });
    expect(generateGroundedDraft).toHaveBeenLastCalledWith(expect.objectContaining({ estimateId: 'estimate-42', openEstimate: null }));
  });
});
