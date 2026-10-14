/**
 * Payment status contract, end to end through the drafter (PR #5331, owner ruling 2026-10-01): the verify/revise loop feeds
 * a status the model did not copy back as a violation, the final draft records the sentences it copied (the snapshot every
 * send seam rechecks), a draft that never converges is held, and gate-off is untouched.
 */
const GATE = 'GATE_SMS_REAL_ANSWERS';
const COPY = 'We received your $120.00 card payment on Sep 12, 2026.';
const PARAPHRASE = 'Yes, we got your $120.00 payment from Sep 12 - thank you!';
const HANDOFF = 'A teammate will confirm that and follow up within the hour.';
const INBOUND = 'Did you get my $120 payment from Sep 12?';

const contextWith = () => ({
  summary: 'Test customer',
  customer: { id: 'cust-1' },
  upcomingServices: [],
  billing: {
    outstandingBalance: 0,
    hasProcessingPayment: false,
    recentPaymentsTruncated: false,
    recentPayments: [{ id: 'p1', amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' }],
    invoiceStatuses: [],
  },
});

let prior;
beforeEach(() => {
  prior = { gate: process.env[GATE], verify: process.env.SHADOW_DRAFT_VERIFY, fewshot: process.env.SHADOW_FEWSHOT };
  delete process.env.SHADOW_DRAFT_VERIFY;
  process.env.SHADOW_FEWSHOT = 'false';
  process.env[GATE] = 'true';
});
afterEach(() => {
  for (const [k, v] of [[GATE, prior.gate], ['SHADOW_DRAFT_VERIFY', prior.verify], ['SHADOW_FEWSHOT', prior.fewshot]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  jest.dontMock('../services/llm/call'); jest.dontMock('../services/llm/deep');
  jest.dontMock('../services/availability'); jest.dontMock('../services/call-booking-catalog');
  jest.resetModules();
});

function load(replies) {
  jest.resetModules();
  const dispatched = [];
  const queue = [...replies];
  jest.doMock('../services/availability', () => ({ getAvailableSlots: jest.fn(async () => ({ days: [] })) }));
  jest.doMock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => [] }));
  jest.doMock('../services/llm/call', () => ({
    dispatchWithFallback: jest.fn(async (policy, payload) => {
      dispatched.push(payload.text);
      const reply = queue.length > 1 ? queue.shift() : queue[0];
      return { ok: true, text: JSON.stringify({ reply, intended_actions: [], missing_info: null }), model: 'fixture-model' };
    }),
  }));
  // the LLM verifier is happy with everything: only the deterministic payment-status check can fail a draft
  jest.doMock('../services/llm/deep', () => ({
    createDeepMessage: jest.fn(async () => ({ model: 'verifier', content: [{ text: JSON.stringify({ supported: true, violations: [] }) }] })),
  }));
  jest.doMock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: jest.fn() } })));
  return { drafter: require('../services/sms-shadow-drafter'), dispatched };
}
const draft = (drafter, context = contextWith()) => drafter.generateGroundedDraft({
  client: {}, context, inboundMessage: INBOUND, intent: { intent: 'general_customer_sms_needs_review' }, schedulingIntent: false, voiceProfile: null,
});

test('the facts block carries the rendered sentence and the model is told to copy it', async () => {
  const { drafter, dispatched } = load([COPY]);
  const result = await draft(drafter);
  expect(result.factsBlock).toContain(`\n  - ${COPY}\n`);
  expect(result.factsBlock).not.toContain('- Recent payments:');
  expect(dispatched[0]).toContain('Payment status sentences');
});

test('a verbatim copy converges on the first pass and is recorded in the snapshot', async () => {
  const { drafter } = load([`Hi Dana, ${COPY}`]);
  const result = await draft(drafter);
  expect(result.converged).toBe(true);
  expect(result.passes).toBe(1);
  expect(result.paymentStatusSnapshot).toEqual({ customer_id: 'cust-1', sentences: [COPY], family_counts: { payment: 1 } });
  expect(result.promptVersion).toBe(require('../services/sms-shadow-drafter').REAL_ANSWERS_PROMPT_VERSION);
});

test('a paraphrase is fed back as a violation; the revised verbatim copy converges with the snapshot', async () => {
  const { drafter, dispatched } = load([PARAPHRASE, COPY]);
  const result = await draft(drafter);
  expect(dispatched).toHaveLength(2);
  expect(dispatched[1]).toContain('not a word-for-word copy of one "Payment status sentences" line');
  expect(result.parsed.reply).toBe(COPY);
  expect(result.converged).toBe(true);
  expect(result.passes).toBe(2);
  expect(result.paymentStatusSnapshot).toEqual({ customer_id: 'cust-1', sentences: [COPY], family_counts: { payment: 1 } });
});

test('a model that never copies is never converged: nothing publishes or sends it', async () => {
  const { drafter, dispatched } = load([PARAPHRASE]);
  const result = await draft(drafter);
  expect(dispatched.length).toBe(drafter.MAX_REVISIONS + 1);
  expect(result.converged).toBe(false);
  expect(result.paymentStatusSnapshot.sentences).toEqual([]); // (never published or sent: it copies nothing)
});

test('a hand-off that states no status converges, copies nothing, and records that the draft was payment-scoped', async () => {
  const { drafter } = load([HANDOFF]);
  const result = await draft(drafter);
  expect(result.converged).toBe(true);
  // (scoped by the customer's message: every send seam then judges the final body as payment-scoped; the autonomous rung needs copy-only)
  expect(result.paymentStatusSnapshot).toEqual({ customer_id: 'cust-1', sentences: [], scoped: true });
});

test('a draft in a thread that touches no money records no snapshot', async () => {
  const { drafter } = load(['A teammate will confirm the arrival time and follow up within the hour.']);
  const result = await drafter.generateGroundedDraft({
    client: {}, context: { ...contextWith(), smsHistory: [{ direction: 'inbound', body: 'What time is the tech coming Tuesday?' }] }, inboundMessage: 'What time is the tech coming Tuesday?',
    intent: { intent: 'general_customer_sms_needs_review' }, schedulingIntent: false, voiceProfile: null,
  });
  expect(result.paymentStatusSnapshot).toBeNull();
});

// Independent review (P1-1 / structural a): the recent thread scopes the draft, so a bare pronoun message cannot dodge the contract.
test('the recent thread scopes the draft: "ok thanks" after a billing message cannot be answered with an unlisted status', async () => {
  const context = { ...contextWith(), smsHistory: [{ direction: 'inbound', body: 'ok thanks' }, { direction: 'outbound', body: COPY }] };
  const asDraft = (replies) => { const { drafter, dispatched } = load(replies); return drafter.generateGroundedDraft({ client: {}, context, inboundMessage: 'ok thanks', intent: { intent: 'general_customer_sms_needs_review' }, schedulingIntent: false, voiceProfile: null }).then((result) => ({ result, dispatched })); };
  const held = await asDraft(["Yes, it's in our system - you're all set!"]);
  expect(held.result.converged).toBe(false);
  expect(held.dispatched.length).toBe(held.result.passes);
  const fine = await asDraft(['Sounds good, see you Tuesday!']);
  expect(fine.result.converged).toBe(true);
  expect(fine.result.paymentStatusSnapshot).toEqual({ customer_id: 'cust-1', sentences: [], scoped: true });
});

test('an ungrounded account (billing unavailable) renders no sentence, so even a "true" status is a violation', async () => {
  const context = contextWith();
  context.billing = { unavailable: true, recentPayments: context.billing.recentPayments };
  const { drafter } = load([COPY]);
  const result = await draft(drafter, context);
  expect(result.factsBlock).toContain('Payment status sentences: none on file right now');
  expect(result.converged).toBe(false);
  expect(result.paymentStatusSnapshot.sentences).toEqual([]);
});

test('gate off: no Payment status section, main\'s Recent payments line, nothing is judged or snapshotted', async () => {
  delete process.env[GATE];
  const { drafter } = load([PARAPHRASE]);
  const result = await draft(drafter);
  expect(result.promptVersion).toBe('house_voice_v11');
  expect(result.factsBlock).not.toContain('Payment status sentences');
  expect(result.factsBlock).toContain('- Recent payments: $120.00 paid Saturday, Sep 12');
  expect(result.converged).toBe(true); // no deterministic payment-status check exists gate-off
  expect(result.paymentStatusSnapshot == null).toBe(true);
});

// draftShadowReply threads the snapshot to every place a send seam reads it from.
describe('draftShadowReply persists the payment_status_snapshot where every send seam reads it', () => {
  async function run({ deliveryMode, autoSendResult, reply = COPY }) {
    jest.resetModules();
    const insertedRows = [];
    const mockDb = jest.fn((table) => {
      if (table !== 'message_drafts') throw new Error(`unexpected table: ${table}`);
      return { insert: jest.fn((row) => { insertedRows.push(row); return { returning: jest.fn(async () => [{ id: 'draft-1' }]) }; }) };
    });
    const maybeAutoSend = jest.fn(async () => autoSendResult);
    const publishSuggestion = jest.fn(async () => 'decision-1');
    const resolveDeliveryMode = jest.fn(async () => deliveryMode);
    jest.doMock('../models/db', () => mockDb);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/context-aggregator', () => ({ getContextForCustomer: jest.fn(async () => contextWith()), authorizedDuesCents: jest.fn(() => []) }));
    jest.doMock('../services/voice-profile-distiller', () => ({ getApprovedVoiceProfile: jest.fn(async () => null) }));
    jest.doMock('../services/llm/call', () => ({
      dispatchWithFallback: jest.fn(async () => ({ ok: true, text: JSON.stringify({ reply, intended_actions: [], missing_info: null }), model: 'fixture-model' })),
    }));
    jest.doMock('../services/llm/deep', () => ({ createDeepMessage: jest.fn(async () => ({ model: 'v', content: [{ text: JSON.stringify({ supported: true, violations: [] }) }] })) }));
    jest.doMock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: jest.fn() } })));
    jest.doMock('../services/sms-auto-send', () => ({ autoSendActionsSafe: jest.fn(() => true), maybeAutoSend }));
    jest.doMock('../services/sms-suggest-mode', () => ({
      AUTO_SEND_MODE: 'auto_send', SUGGESTED_STATUS: 'suggested', resolveDeliveryMode, publishSuggestion, supersedeStaleSuggestions: jest.fn(async () => 0),
      hasRedactionPlaceholder: jest.fn(() => false), hasPriceQuote: jest.fn((t) => /\$\s?\d/.test(String(t || ''))),
    }));
    jest.doMock('../services/comms-lint', () => ({ lintComms: jest.fn(() => ({ pass: true, failures: [] })), toFlags: jest.fn(() => []) }));
    const { draftShadowReply } = require('../services/sms-shadow-drafter');
    await draftShadowReply({
      inboundMessage: INBOUND, fromPhone: '+19415550100', customer: { id: 'cust-1' }, smsLogId: 'sms-1',
      intent: { intent: 'general_customer_sms_needs_review', confidence: 0.9 },
    });
    return { insertedRows, maybeAutoSend, publishSuggestion };
  }
  const SNAP = { customer_id: 'cust-1', sentences: [COPY], family_counts: { payment: 1 } };
  afterEach(() => { jest.dontMock('../models/db'); jest.dontMock('../services/sms-auto-send'); jest.dontMock('../services/sms-suggest-mode'); jest.dontMock('../services/comms-lint'); jest.dontMock('../services/context-aggregator'); jest.dontMock('../services/voice-profile-distiller'); });

  test('the shadow draft row, the auto-send claim and the fallback card all carry it', async () => {
    const out = await run({ deliveryMode: 'auto_send', autoSendResult: { sent: false, reason: 'provider_failure', ambiguous: false } });
    // the draft row's snapshot (intended_actions JSON) and both publication paths
    expect(JSON.stringify(out.insertedRows[0])).toContain('payment_status_snapshot');
    expect(out.maybeAutoSend).toHaveBeenCalledWith(expect.objectContaining({ paymentStatusSnapshot: SNAP }));
    expect(out.publishSuggestion).toHaveBeenCalledWith(expect.objectContaining({ paymentStatusSnapshot: SNAP }));
  });

  test('the suggest lane carries it too', async () => {
    const out = await run({ deliveryMode: 'suggest' });
    expect(out.publishSuggestion).toHaveBeenCalledWith(expect.objectContaining({ paymentStatusSnapshot: SNAP }));
  });

  test('a hand-off reply copies no sentence: it carries only the payment-scope marker', async () => {
    const out = await run({ deliveryMode: 'suggest', reply: HANDOFF });
    expect(out.publishSuggestion).toHaveBeenCalledWith(expect.objectContaining({ paymentStatusSnapshot: { customer_id: 'cust-1', sentences: [], scoped: true } }));
  });

  test('a draft whose figure is not an authorized one stays shadow even though the verifier passed it', async () => {
    const out = await run({ deliveryMode: 'suggest', reply: 'Your account balance is $999.00.' });
    expect(out.publishSuggestion).not.toHaveBeenCalled();
    expect(out.insertedRows[0]).toEqual(expect.objectContaining({ status: 'shadow' }));
  });
});

// Codex round-45 P1: while a payment plan is active the invoice total / balance is not what is due now. It must reach neither the prompt
// (Balance line, Open invoice line, summary, flags) nor the owed-figure allowlist.
describe('an active payment plan withholds every invoice total from the prompt and the owed-figure allowlist', () => {
  const planContext = (over = {}) => ({
    ...contextWith(),
    summary: 'Dana Test | Pest | ⚠️ $300.00 overdue | Next: Pest Sep 30',
    flags: [{ type: 'overdue_balance', severity: 'high', detail: '$300.00 outstanding' }],
    billing: {
      ...contextWith().billing, outstandingBalance: 300, hasActivePaymentPlan: true,
      openInvoice: { id: 'i1', status: 'sent', title: 'Quarterly pest', amountDue: 300, dueDate: '2026-10-05' },
      ...over,
    },
  });
  test('facts block: no $300 anywhere, a plain explanation instead', () => {
    const { drafter } = load([COPY]);
    const block = drafter.buildFactsBlock(planContext());
    expect(block).not.toMatch(/\$300|300\.00/);
    expect(block).toContain('- Balance: on an ACTIVE PAYMENT PLAN');
    expect(block).toContain('- Open invoice: status sent, "Quarterly pest", on an active payment plan');
    expect(block).toContain('on an active payment plan');
  });
  test('the same account without a plan still shows the figures (the suppression is the plan, nothing else)', () => {
    const { drafter } = load([COPY]);
    const block = drafter.buildFactsBlock(planContext({ hasActivePaymentPlan: false }));
    expect(block).toContain('- Balance: $300.00 outstanding');
    expect(block).toContain('$300.00 due (net of any applied credit)');
  });
  test('gate off: the facts block is main\'s even for a plan customer', () => {
    delete process.env[GATE];
    const { drafter } = load([COPY]);
    expect(drafter.buildFactsBlock(planContext())).toContain('- Balance: $300.00 outstanding');
  });
  test('draft time: a figure is authorized only as its rendered sentence - the balance sentence off a plan, and NOTHING on a plan; "The total is $300.00." is held either way', () => {
    const { drafter } = load([COPY]);
    const ask = (reply, ctx) => drafter.replyQuotesUngroundedAmount(reply, ctx, { inboundMessage: 'How much do I owe?' });
    const BAL = 'Your account balance is $300.00.';
    expect(ask(BAL, planContext({ hasActivePaymentPlan: false }))).toBe(false);
    expect(ask(BAL, planContext())).toBe(true); // the renderer withholds the balance on a plan: no such sentence exists
    expect(ask('The total is $300.00.', planContext({ hasActivePaymentPlan: false }))).toBe(true);
    expect(ask('The total is $300.00.', planContext())).toBe(true);
  });
  test('the pooled gate-off rule still authorizes the figure (billingAmountCents is main\'s: no plan-aware variant any more)', () => {
    const { drafter } = load([COPY]);
    expect(drafter.billingAmountCents(planContext()).owed.has(30000)).toBe(true);
    expect(drafter.billingAmountCents(planContext({ hasActivePaymentPlan: false })).owed.has(30000)).toBe(true);
  });
});

// Owner 2026-10-01 ~23:58Z: Zelle and the plan price reach a customer only as rendered sentences, through the same verify / revise loop.
describe('Zelle and the plan price through the drafter loop', () => {
  const NOT_OFFERED = "We don't take Zelle right now.";
  const ZELLE_INBOUND = 'Can I pay by Zelle?';
  let priorRecipient;
  beforeEach(() => { priorRecipient = process.env.ZELLE_RECIPIENT; });
  afterEach(() => { if (priorRecipient === undefined) delete process.env.ZELLE_RECIPIENT; else process.env.ZELLE_RECIPIENT = priorRecipient; });
  const ask = (drafter, context = contextWith(), inboundMessage = ZELLE_INBOUND) => drafter.generateGroundedDraft({
    client: {}, context, inboundMessage, intent: { intent: 'general_customer_sms_needs_review' }, schedulingIntent: false, voiceProfile: null,
  });

  test('no recipient configured: the facts carry "We don\'t take Zelle right now."; copying it converges and is recorded; Zelle in the model\'s own words is fed back', async () => {
    delete process.env.ZELLE_RECIPIENT;
    const copy = load([NOT_OFFERED]);
    const ok = await ask(copy.drafter);
    expect(ok.factsBlock).toContain(`\n  - ${NOT_OFFERED}\n`);
    expect(ok.converged).toBe(true);
    expect(ok.paymentStatusSnapshot).toEqual({ customer_id: 'cust-1', sentences: [NOT_OFFERED] }); // (no target invoice, so no zelle field)
    const own = load(["Sorry, we don't accept Zelle, but your pay link takes card.", NOT_OFFERED]);
    const fixed = await ask(own.drafter);
    expect(own.dispatched).toHaveLength(2);
    expect(own.dispatched[1]).toContain('something about Zelle that is not a word-for-word copy');
    expect(fixed.parsed.reply).toBe(NOT_OFFERED);
    expect(fixed.converged).toBe(true);
  });

  test('a recipient is configured but no target invoice resolves (no open invoice): NO Zelle sentence exists, so any Zelle wording never converges', async () => {
    process.env.ZELLE_RECIPIENT = 'payments@wavespestcontrol.com';
    const { drafter, dispatched } = load(['Yes, you can use Zelle to payments@wavespestcontrol.com.']);
    const result = await ask(drafter);
    expect(result.factsBlock).not.toContain('by Zelle to');
    expect(result.factsBlock).not.toContain("We don't take Zelle");
    expect(result.factsBlock).not.toContain('payments@wavespestcontrol.com');
    expect(result.converged).toBe(false);
    expect(dispatched.length).toBe(drafter.MAX_REVISIONS + 1);
    expect(result.zelleInvoiceId).toBeNull();
  });

  test('the plan price: the facts carry the rendered sentence; copying it converges, the same figure in the model\'s own words is a violation', async () => {
    const PRICE = 'Your monthly plan price is $99.00.';
    const ctx = () => ({ ...contextWith(), customer: { id: 'cust-1', billingLane: { monthlyBilled: true, monthlyDues: { base: 99 } } } });
    const copy = load([PRICE]);
    const ok = await ask(copy.drafter, ctx(), 'How much is my plan?');
    expect(ok.factsBlock).toContain(`\n  - ${PRICE}\n`);
    expect(ok.converged).toBe(true);
    expect(ok.paymentStatusSnapshot.sentences).toEqual([PRICE]);
    const own = load(['Your plan is $99 a month.', PRICE]);
    const fixed = await ask(own.drafter, ctx(), 'How much is my plan?');
    expect(own.dispatched).toHaveLength(2);
    expect(fixed.parsed.reply).toBe(PRICE);
    expect(fixed.converged).toBe(true);
  });
});
