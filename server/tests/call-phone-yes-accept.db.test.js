/**
 * GATE_CALL_PHONE_YES_ACCEPT through PostgreSQL (owner 2026-11-18, step 1: the office taps). A call booked a pest visit
 * while the customer had an open estimate: the sweep files ONE admin card for it, in one of two states (the caller's
 * yes in their own words, or "No yes heard"), with the shadow verdict for the later automatic step. It accepts
 * nothing and sends nothing. The card stays open while a visit the call booked is on the calendar, also after the
 * estimate expires, and closes itself once it stops being true. Runs inside a rolled-back transaction. Synthetic
 * names, numbers and addresses only. Skips without DATABASE_URL.
 */
const SKIP = !process.env.DATABASE_URL;

jest.setTimeout(120000);
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  Object.defineProperty(proxy, 'fn', { get: () => mockConn.fn });
  Object.defineProperty(proxy, 'schema', { get: () => mockConn.schema });
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})), notifyCustomer: jest.fn(async () => ({})) }));
jest.mock('../services/account-membership-email', () => ({
  sendMembershipStarted: jest.fn(async () => ({})),
  isEmailLike: (value) => /@/.test(String(value || '')),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));
// The tap's route runs through the real admin-triage router; only the login is stubbed (x-test-role picks the role).
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = null;
    req.techRole = req.headers['x-test-role'] || 'admin';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const knex = require('knex');
const express = require('express');
const { randomUUID } = require('crypto');
const { LOCK_NAMESPACE: TRIAGE_LOCK_NAMESPACE } = require('../utils/triage-locks');
const AppointmentReminders = require('../services/appointment-reminders');
const acceptance = require('../services/estimate-manual-acceptance');
const { sendMembershipStarted } = require('../services/account-membership-email');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { notifyAdmin } = require('../services/notification-service');
const Word = require('../services/call-phone-yes-word');
const {
  runCallPhoneYesSweep, evaluatePhoneYes, REASON_CODE, REASONS, ACCEPT_SOURCE, TAP_REFUSALS, acceptPhoneYesCard, FEE_NOTE, _private: PhoneYesPrivate,
} = require('../services/call-phone-yes-accept');

const GATE = 'GATE_CALL_PHONE_YES_ACCEPT';
const describeDb = SKIP ? describe.skip : describe;
const DAY = 86400000;
const WORDS = "Let's do the quarterly plan, just bill me each time you come out.";

// Quarterly pest: 4 visits a year at $45 = $180 a year = $15 a month. No setup fee disclosed.
const planData = (over = {}) => ({
  customerSelection: { frequency: 'quarterly' },
  setupFeeQuote: { amount: 0, waived: true },
  result: {
    totals: { year2mo: 15, year2: 180 },
    results: { pestTiers: [{ label: 'Quarterly', mo: 15, ann: 180, apps: 4, pa: 45 }] },
    recurring: {
      discount: 0, monthlyTotal: 15, grandTotal: 15,
      services: [{ name: 'Pest Control', service: 'pest_control', mo: 15, visitsPerYear: 4, perTreatment: 45 }],
    },
    oneTime: { items: [], membershipFee: 0 },
  },
  ...over,
});
// The V2 extraction: the caller's plan choice with its evidence quote (the caller's own sentence).
const extractionWith = (choice, intent = null) => ({
  meta: { call_summary: 'Caller asked about the quarterly plan.' },
  service_request: { primary_service_category: 'pest_general', ...(choice ? { billing_choice: choice } : {}), ...(intent ? { service_intent: intent } : {}) },
  scheduling: { status: 'confirmed' },
  evidence: choice ? [
    { field_path: '/service_request/billing_choice', quote: 'You can bill each time.', speaker: 'agent', transcript_offset_ms: 900 },
    { field_path: '/service_request/billing_choice', quote: WORDS, speaker: 'caller', transcript_offset_ms: 1200 },
  ] : [],
});

// A labeled two-speaker transcript: the caller says WORDS on a call that names the plan.
const transcriptWith = (choice) => (choice
  ? `Agent: Thanks for calling Waves, how can I help?\nCaller: ${WORDS}\nAgent: You can bill each time. You are all set.`
  : 'Agent: Thanks for calling Waves, how can I help?\nCaller: I need someone out for the bugs.\nAgent: You are all set.');
const RECORDED = { recording_url: 'https://example.test/recording.mp3', recording_duration_seconds: 60 };

describeDb('call phone yes cards (PostgreSQL)', () => {
  let database; let trx; let server; let base;
  const savedGate = process.env[GATE];

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    const app = express();
    app.use(express.json());
    app.use('/admin/triage', require('../routes/admin-triage'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await database.destroy();
    if (savedGate === undefined) delete process.env[GATE]; else process.env[GATE] = savedGate;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env[GATE] = 'true';
    trx = await database.transaction();
    mockConn = trx;
    // An active admin with no Push Settings row for the bell's type: its Bell switch reads on (call-phone-yes-bell.js).
    await trx('technicians').insert({ id: randomUUID(), name: 'Sample Admin', role: 'admin', active: true });
  });
  afterEach(async () => { await trx.rollback(); });

  let seq = 0;
  const inDays = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
  async function customer(over = {}) {
    const id = randomUUID();
    seq += 1;
    await trx('customers').insert({
      id, first_name: 'Pat', last_name: 'Sampleton', phone: `+1941555${String(4000 + seq)}`, email: `qa-${id.slice(0, 8)}@example.test`, active: true, ...over,
    });
    return id;
  }
  async function estimate(customerId, over = {}) {
    const [row] = await trx('estimates').insert({
      customer_id: customerId, status: 'sent', token: randomUUID().replace(/-/g, ''), customer_name: 'Pat Sampleton',
      address: '100 Example Lane, Sampleton, FL 34200', monthly_total: 15, annual_total: 180, onetime_total: 0,
      waveguard_tier: 'Bronze', show_one_time_option: false, bill_by_invoice: false, category: 'RESIDENTIAL',
      estimate_data: JSON.stringify(planData()), sent_at: new Date(Date.now() - 2 * DAY), expires_at: new Date(Date.now() + 5 * DAY), ...over,
    }).returning('*');
    return row;
  }
  async function call(customerId, choice, over = {}, intent = null) {
    const id = randomUUID();
    await trx('call_log').insert({
      id, customer_id: customerId, twilio_call_sid: `CA${id.replace(/-/g, '')}`, from_phone: '+19415550101', answered_by: 'human',
      processing_status: 'processed', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify(extractionWith(choice, intent)),
      transcription: transcriptWith(choice), direction: 'inbound', ...over,
    });
    return id;
  }
  async function visit(customerId, callLogId, over = {}) {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id, customer_id: customerId, source_call_log_id: callLogId, scheduled_date: inDays(9), window_start: '15:00', window_end: '17:00',
      service_type: 'General Pest Control', status: 'confirmed', source_action: 'ai_call_pipeline', is_recurring: false,
      service_address_line1: '100 Example Lane', service_address_city: 'Sampleton', service_address_state: 'FL', service_address_zip: '34200', ...over,
    });
    return id;
  }
  // The usual case: estimate sent two days ago; the yes call yesterday; the booking call two hours ago.
  async function phoneYes({
    estimateOver = {}, customerOver = {}, yesChoice = 'per_application', yesIntent = null, bookingChoice = null, bookingIntent = null, visitOver = {},
    bookingOver = {},
  } = {}) {
    const customerId = await customer(customerOver);
    const est = await estimate(customerId, estimateOver);
    const yesCallId = await call(customerId, yesChoice, { created_at: new Date(Date.now() - DAY) }, yesIntent);
    const bookingCallId = await call(customerId, bookingChoice, { created_at: new Date(Date.now() - 2 * 3600000), ...bookingOver }, bookingIntent);
    const visitId = await visit(customerId, bookingCallId, visitOver);
    return { customerId, est, yesCallId, bookingCallId, visitId };
  }
  const cards = (callLogId) => trx('triage_items').where({ call_log_id: callLogId, reason_code: REASON_CODE }).select('*');
  const statusOf = async (table, id) => (await trx(table).where({ id }).first('status')).status;
  const payloadOf = (card) => (typeof card.payload === 'string' ? JSON.parse(card.payload) : card.payload);
  const sweep = () => runCallPhoneYesSweep();

  test("a yes: ONE card with the caller's words and auto would accept; nothing accepted, nothing sent", async () => {
    const spy = jest.spyOn(acceptance, 'markEstimateManuallyAccepted');
    const { customerId, est, yesCallId, bookingCallId, visitId } = await phoneYes();
    const before = await trx('scheduled_services').where({ id: visitId }).first();

    await expect(sweep()).resolves.toMatchObject({ filed: 1, closed: 0 });

    const [card] = await cards(bookingCallId);
    expect(card).toMatchObject({
      status: 'open', severity: 'advisory', related_customer_id: customerId, related_estimate_id: est.id, related_scheduled_service_id: visitId,
      summary: 'Caller said yes to pay per application on the call. The estimate is not accepted yet.',
    });
    expect(payloadOf(card)).toMatchObject({
      flag: REASON_CODE, yes_heard: true, billing_choice: 'per_application', estimate_id: est.id, estimate_ids: [est.id],
      scheduled_service_id: visitId, yes_call_log_id: yesCallId, caller_words: WORDS,
      auto_would_accept: true, auto_reason: null, auto_message: null,
    });
    // Nothing accepted, linked, priced or sent.
    expect(spy).not.toHaveBeenCalled();
    expect(await statusOf('estimates', est.id)).toBe('sent');
    expect(await trx('scheduled_services').where({ id: visitId }).first()).toEqual(before);
    expect(sendMembershipStarted).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // The office's bell rings for the new card, once (call-phone-yes-bell.js; its rows: call-phone-yes-bell.db.test.js).
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin).toHaveBeenCalledWith('estimate', "Estimates — check Pat Sampleton's estimate", expect.any(String),
      expect.objectContaining({ bell: true, bannerKind: 'call_phone_yes', dedupeKey: `call-phone-yes:${card.id}` }));
    // One card per call, ever.
    await expect(sweep()).resolves.toMatchObject({ filed: 0, closed: 0 });
    spy.mockRestore();
  });

  test('a card whose check fails in a run rings nothing in that run, and rings once a check passes', async () => {
    await phoneYes();
    await sweep();
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    // The notification service is a stub here, so no bell row stands: every run whose check passes rings again.
    notifyAdmin.mockClear();
    const read = jest.spyOn(Word, 'callerWord').mockRejectedValue(Object.assign(new Error('read failed'), { code: 'ETEST' }));
    try {
      await sweep();
    } finally {
      read.mockRestore();
    }
    // A yes that could not be read again may have been taken back: nothing rings and the row is not rewritten.
    expect(notifyAdmin).not.toHaveBeenCalled();
    await sweep();
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['no billing choice on any call', { yesChoice: null }],
    ['the yes came before the estimate was (re)sent', { estimateOver: { sent_at: new Date(Date.now() - 5 * 3600000) } }],
  ])('no yes heard (%s): ONE card that says so, with no words', async (_name, setup) => {
    const { bookingCallId } = await phoneYes(setup);
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(bookingCallId);
    expect(card.summary).toBe('A call booked a pest visit while an estimate is open. No yes heard on the call. The estimate is not accepted yet.');
    expect(payloadOf(card)).toMatchObject({
      yes_heard: false, billing_choice: null, yes_call_log_id: null, caller_words: null,
      auto_would_accept: false, auto_reason: 'no_yes_heard', auto_message: REASONS.no_yes_heard,
    });
  });

  test.each([
    ['only a staff quote', { ai_extraction_enriched: JSON.stringify({ ...extractionWith('per_application'), evidence: [{ field_path: '/service_request/billing_choice', quote: 'You can bill each time.', speaker: 'agent' }] }) }],
    ["a caller quote the transcript does not hold", { transcription: 'Agent: Thanks for calling Waves.\nCaller: I need someone out for the bugs.\nAgent: You are all set.' }],
    ['a caller quote said only by staff', { transcription: `Agent: ${WORDS}\nCaller: Okay.\nAgent: You are all set.` }],
    ['an unlabeled transcript', { transcription: `Thanks for calling. ${WORDS} You are all set.` }],
  ])("a pay-per-application choice without the caller's own words (%s) is no yes the card shows", async (_name, change) => {
    const { yesCallId, bookingCallId } = await phoneYes();
    await trx('call_log').where({ id: yesCallId }).update(change);
    await sweep();
    const [card] = await cards(bookingCallId);
    expect(card.summary).toMatch(/No yes heard/);
    expect(payloadOf(card)).toMatchObject({
      yes_heard: false, billing_choice: null, caller_words: null, auto_would_accept: false, auto_reason: 'yes_without_words',
    });
  });

  // The call reader judges the words; the cards judge none (call-phone-yes-word.js). The card shows the caller's whole
  // turn, so a "don't" the call reader missed is in front of the person who decides.
  test("the card shows the caller's whole turn: a word the call reader misjudged is in front of the office", async () => {
    const { yesCallId, bookingCallId } = await phoneYes();
    const said = "Please don't bill me each time you come out.";
    await trx('call_log').where({ id: yesCallId }).update({
      ai_extraction_enriched: JSON.stringify({ ...extractionWith('per_application'), evidence: [{ field_path: '/service_request/billing_choice', quote: 'bill me each time', speaker: 'caller' }] }),
      transcription: `Agent: Thanks for calling Waves.\nCaller: ${said}\nAgent: Okay.`,
    });
    await sweep();
    const [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ yes_heard: true, caller_words: said });
  });

  test('a yes on the booking call itself is heard', async () => {
    const { bookingCallId } = await phoneYes({ yesChoice: null, bookingChoice: 'per_application' });
    await sweep();
    const [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ yes_heard: true, yes_call_log_id: bookingCallId, auto_would_accept: true });
  });

  test.each([
    ['the booking call itself chose annual prepay (the prepay card owns that call)', { bookingChoice: 'annual_prepay' }, 'chose_annual_prepay'],
    ['the call booked a lawn visit, not a pest visit', { visitOver: { service_type: 'Lawn Care' } }, 'no_pest_visit'],
    ['the estimate lapsed', { estimateOver: { expires_at: new Date(Date.now() - 3600000) } }, 'no_open_estimate'],
    // Archiving keeps the status, but the estimate is closed to the customer.
    ['the estimate is archived', { estimateOver: { archived_at: new Date(Date.now() - 3600000) } }, 'no_open_estimate'],
    ['the estimate was first sent after the booking call', { estimateOver: { sent_at: new Date(Date.now() - 3600000), created_at: new Date(Date.now() - 3600000) } },
      'no_open_estimate'],
    ['the booking call still has an extraction retry left', {
      bookingOver: { processing_status: 'extraction_failed', v2_extraction_status: 'failed', extraction_attempts: 1, ...RECORDED },
    }, 'call_still_processing'],
  ])('no card when %s', async (_name, setup, reason) => {
    const { customerId, bookingCallId } = await phoneYes(setup);
    await expect(evaluatePhoneYes({ callLogId: bookingCallId, customerId })).resolves.toEqual({ card: false, reason });
    await expect(sweep()).resolves.toMatchObject({ filed: 0 });
    expect(await cards(bookingCallId)).toEqual([]);
  });

  test('no card when the pest visit is linked and only a lawn visit is unlinked', async () => {
    const { customerId, est, bookingCallId, visitId } = await phoneYes();
    await trx('scheduled_services').where({ id: visitId }).update({ source_estimate_id: est.id });
    await visit(customerId, bookingCallId, { service_type: 'Lawn Care', scheduled_date: inDays(12) });
    await expect(evaluatePhoneYes({ callLogId: bookingCallId, customerId })).resolves.toEqual({ card: false, reason: 'no_pest_visit' });
    await expect(sweep()).resolves.toMatchObject({ filed: 0 });
  });

  test('a yes on a sandbox call is not heard', async () => {
    const { VOICE_RELAY_SANDBOX_SOURCE } = require('../services/voice-agent/relay-protocol');
    const { yesCallId, bookingCallId } = await phoneYes();
    await trx('call_log').where({ id: yesCallId }).update({ source: VOICE_RELAY_SANDBOX_SOURCE });
    await sweep();
    const [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ yes_heard: false, auto_reason: 'no_yes_heard' });
  });

  // The note call processing writes on a call-booked recurring visit when the agent quoted a rate
  // (call-recording-processor.js).
  const callRateNote = (rate) => `Rate quoted on call: $${rate} (recurring service — set up plan billing at this rate; intentionally not stamped on this visit).`;
  const invoiceOn = async (customerId, visitId, status = 'draft') => {
    const id = randomUUID();
    await trx('invoices').insert({
      id, customer_id: customerId, scheduled_service_id: visitId, status, token: randomUUID(), invoice_number: `TEST-${id.slice(0, 8)}`,
      subtotal: 99, total: 99, line_items: '[]',
    });
    return id;
  };
  // An annual prepay term and its prepay invoice (read as the churn guard reads them: customer-lifecycle-guard.js).
  const prepayTerm = async (customerId, status, invoiceStatus) => {
    await trx('annual_prepay_terms').insert({
      customer_id: customerId, term_start: inDays(-30), term_end: inDays(335), status, prepay_invoice_id: await invoiceOn(customerId, null, invoiceStatus),
      coverage_service_type: 'General Pest Control', coverage_visit_count: 4, prepay_amount: 400,
    });
  };

  test("a yes on a visit that bills a third-party payer of its own: auto would accept no, visit_payer", async () => {
    const [{ id: payerId }] = await trx('payers').insert({ display_name: 'Sample Property Managers' }).returning('id');
    const { bookingCallId } = await phoneYes({ visitOver: { payer_id: payerId } });
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ auto_would_accept: false, auto_reason: 'visit_payer', auto_message: REASONS.visit_payer });
  });

  test('a yes on a visit held for the office to confirm its street address: auto would accept no, visit_address_hold', async () => {
    const { visitId, bookingCallId } = await phoneYes({ visitOver: { customer_confirmed: false } });
    await trx('triage_items').insert({
      id: randomUUID(), call_log_id: bookingCallId, category: 'service_unknown', reason_code: 'outbound_booking_review', status: 'open',
      payload: JSON.stringify({ street_level_address: true, scheduled_service_id: visitId }),
    });
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ auto_would_accept: false, auto_reason: 'visit_address_hold', auto_message: REASONS.visit_address_hold });
  });

  test('a yes on a visit that already has an invoice (a pre-minted one): auto would accept no, visit_invoiced', async () => {
    const { customerId, visitId, bookingCallId } = await phoneYes();
    await invoiceOn(customerId, visitId);
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ auto_would_accept: false, auto_reason: 'visit_invoiced', auto_message: REASONS.visit_invoiced });
  });

  test.each([
    ['the visit is already a series', { visitOver: { is_recurring: true, recurring_pattern: 'quarterly' } }, 'visit_not_one_off'],
    ['the visit is at another address', { visitOver: { service_address_line1: '200 Other Road' } }, 'property_mismatch'],
    ['the visit carries a setup fee', { visitOver: { pending_setup_fee: 99 } }, 'setup_fee_stamped'],
    ['the visit carries a price', { visitOver: { estimated_price: 99 } }, 'visit_priced'],
    // Price decisions the bill honors over estimated_price (completion-pricing.js scheduledLines).
    ['the visit carries a primary-line price', { visitOver: { primary_line_price: 99 } }, 'visit_priced'],
    ['the visit carries a recorded line discount', { visitOver: { line_discount_type: 'fixed_amount', line_discount_dollars: 10 } }, 'visit_priced'],
    ['the visit carries an appointment discount', { visitOver: { discount_type: 'fixed_amount', discount_amount: 10, discount_dollars: 10 } }, 'visit_priced'],
    // A billing party on this visit alone: the plan's next visits would bill the account's own party.
    ['the visit is set to self-pay', { visitOver: { self_pay_override: true } }, 'visit_payer'],
    // A booking the office has not reviewed yet (hidden from the customer): the plan would start before it is confirmed.
    ['the visit is a voice-agent booking still pending review', { visitOver: { source_action: 'voice_agent', status: 'pending', customer_confirmed: false } }, 'visit_unreviewed'],
    ['the visit is an outbound-review booking still pending review', { visitOver: { source_action: 'ai_call_outbound_review', status: 'pending', customer_confirmed: false } }, 'visit_unreviewed'],
    // A start off the hour: the seeder copies the parent's start to every next visit (AGENTS.md: starts on the hour).
    ['the visit starts off the hour', { visitOver: { window_start: '09:30', window_end: '11:30' } }, 'visit_off_hour'],
    ['the visit starts seconds after the hour', { visitOver: { window_start: '09:00:30', window_end: '11:00' } }, 'visit_off_hour'],
    // A rate the booking call quoted for the recurring service (call processing's own note): the tap bills the plan's
    // per-visit price (45 here), so another rate refuses.
    ['the booking call quoted another rate for the plan', { visitOver: { internal_notes: callRateNote('30.00') } }, 'visit_call_rate'],
    // A twice-a-year pest plan: the converter seeds no series from it (planTermsOf), so the tap offers no plan and an
    // automatic accept would not go ahead either.
    ['the estimate is a twice-a-year plan', {
      estimateOver: { estimate_data: JSON.stringify(planData({ customerSelection: { frequency: 'semiannual' }, result: { ...planData().result, recurring: { ...planData().result.recurring, services: [
        { name: 'Pest Control', service: 'pest_control', mo: 15, visitsPerYear: 2, perTreatment: 90 },
      ] } } })) },
    }, 'plan_unresolved'],
    // Visit types completion never bills, by the label or the catalog key: a plan from one would bill $0.
    ['the visit is a re-service by its label', { visitOver: { service_type: 'Pest Control Re-Service' } }, 'visit_free_type'],
    ['the visit is a re-service by its catalog key', { visitOver: { service_key_snapshot: 'pest_re_service' } }, 'visit_free_type'],
    ['the visit date has passed', { visitOver: { scheduled_date: inDays(-5) } }, 'visit_in_past'],
    ['the customer is already a WaveGuard member', { customerOver: { waveguard_tier: 'Silver' } }, 'existing_plan'],
    ['the estimate is a commercial proposal', { estimateOver: { estimate_data: JSON.stringify(planData({ proposal: { enabled: true } })) } }, 'commercial_estimate'],
    ['the estimate is in the commercial category', { estimateOver: { category: 'COMMERCIAL' } }, 'commercial_estimate'],
    ['the estimate has a one-time line', {
      estimateOver: { onetime_total: 85, estimate_data: JSON.stringify(planData({ result: { ...planData().result, oneTime: { items: [{ name: 'Wasp Nest Removal', price: 85 }], membershipFee: 0 } } })) },
    }, 'one_time_items'],
    ['the estimate has a one-time total no line itemizes', { estimateOver: { onetime_total: 85 } }, 'one_time_items'],
    // Two separately priced pest lines read as one row once coalesced; the engine's own lines tell them apart.
    ['the estimate has two pest lines', {
      estimateOver: { estimate_data: JSON.stringify(planData({ result: { ...planData().result, lineItems: [
        { service: 'pest_control', perApp: 45, annual: 180, visitsPerYear: 4 }, { service: 'pest_control', perApp: 60, annual: 240, visitsPerYear: 4 },
      ] } })) },
    }, 'not_pest_plan'],
    // Each send was held back (the send path's deliveryState records no real handoff) and the customer never opened it.
    ['the estimate was never delivered', {
      estimateOver: { estimate_data: JSON.stringify({ ...planData(), deliveryState: { attemptedAt: new Date(Date.now() - 2 * DAY).toISOString(), sentChannels: [], failedChannels: ['sms'], channels: [] } }) },
    }, 'estimate_not_delivered'],
    ['the estimate maps two pest rows', {
      estimateOver: { estimate_data: JSON.stringify(planData({ result: { ...planData().result, recurring: { ...planData().result.recurring, services: [
        ...planData().result.recurring.services, { name: 'Pest Control', service: 'pest_control', mo: 20, visitsPerYear: 4, perTreatment: 60 },
      ] } } })) },
    }, 'not_pest_plan'],
    // The estimate's own manual accept refuses these (estimate-manual-acceptance.js), so an automatic one would too.
    ['the estimate still needs a manager approval', {
      estimateOver: { estimate_data: JSON.stringify(planData({ approvals: [{ requiresManagerApproval: true }] })) },
    }, 'accept_refused'],
    ['the estimate offers a one-time option', { estimateOver: { show_one_time_option: true } }, 'accept_refused'],
    ['the estimate is held for a re-price', {
      estimateOver: { estimate_data: JSON.stringify(planData({ estimatorEngine: { reprice_pending_at: '2026-11-19T10:00:00.000Z' } })) },
    }, 'accept_refused'],
  ])('a yes the accept would refuse (%s): ONE card, auto would accept no, with the reason', async (_name, setup, reason) => {
    const { est, bookingCallId } = await phoneYes(setup);
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    await expect(sweep()).resolves.toMatchObject({ filed: 0, closed: 0 });
    const [card] = await cards(bookingCallId);
    expect(card).toMatchObject({ status: 'open', related_estimate_id: est.id });
    expect(payloadOf(card)).toMatchObject({ yes_heard: true, auto_would_accept: false, auto_reason: reason, auto_message: REASONS[reason] });
  });

  test.each([
    ['the yes came on a later call than the booking', async ({ customerId }) => {
      await call(customerId, 'per_application', { created_at: new Date(Date.now() - 3600000) });
    }, 'yes_after_booking'],
    ['the booking call could not be read', ({ bookingCallId }) => trx('call_log').where({ id: bookingCallId }).update({ v2_extraction_status: 'failed' }),
      'booking_call_unread'],
    ['the customer called again after the yes', async ({ customerId }) => {
      await call(customerId, null, { created_at: new Date(Date.now() - 3600000) });
    }, 'newer_call'],
    ['the caller on the yes call is a tenant', ({ yesCallId }) => trx('call_log').where({ id: yesCallId }).update({
      ai_extraction_enriched: JSON.stringify({ ...extractionWith('per_application'), caller: { relationship_to_property: 'tenant' } }),
    }), 'caller_not_account_holder'],
    ['the caller said no to the price on the yes call', ({ yesCallId }) => trx('call_log').where({ id: yesCallId }).update({
      ai_extraction_enriched: JSON.stringify({
        ...extractionWith('per_application'),
        service_request: { ...extractionWith('per_application').service_request, price: { unit: 'per_application', stated_by: 'agent', caller_response: 'declined' } },
      }),
    }), 'caller_declined_price'],
    ['two open estimates', ({ customerId }) => estimate(customerId), 'more_than_one_estimate'],
    ['two visits on the booking call', ({ customerId, bookingCallId }) => visit(customerId, bookingCallId, { scheduled_date: inDays(12) }), 'more_than_one_visit'],
    // A follow-up visit is the call's only visit left: not a plan's first visit. Each row holds one sign of a follow-up
    // alone: a link to its first visit (cancelled here), or a follow-up path's source action with both links cleared
    // (deleting the first visit sets them null).
    ['the only visit left is linked to a cancelled first visit', async ({ customerId, bookingCallId, visitId }) => {
      const first = await visit(customerId, bookingCallId, { scheduled_date: inDays(5), status: 'cancelled' });
      await trx('scheduled_services').where({ id: visitId }).update({ parent_service_id: first });
    }, 'visit_follow_up'],
    ["the only visit left is a call's follow-up whose first visit was deleted", ({ visitId }) => trx('scheduled_services').where({ id: visitId })
      .update({ source_action: 'ai_call_pipeline_followup' }), 'visit_follow_up'],
    ["the only visit left is a package's follow-up whose first visit was deleted", ({ visitId }) => trx('scheduled_services').where({ id: visitId })
      .update({ source_action: 'package_followup_auto' }), 'visit_follow_up'],
    ['the visit is a follow-up booked from a finished visit', async ({ customerId, visitId }) => {
      const first = await visit(customerId, null, { source_action: 'admin', scheduled_date: inDays(-20), status: 'completed' });
      await trx('scheduled_services').where({ id: visitId }).update({ followup_source_service_id: first });
    }, 'visit_follow_up'],
    ['another live plan', ({ customerId }) => visit(customerId, null, {
      source_action: 'admin', is_recurring: true, recurring_pattern: 'quarterly', scheduled_date: inDays(30),
    }), 'existing_plan'],
    // An annual prepay: a term whose paid coverage is still live, or a prepay invoice still payable (paying it later
    // starts the term and seeds its visits). The tap would start a second, separately billed series beside it.
    ['an annual prepay term still covered', ({ customerId }) => prepayTerm(customerId, 'active', 'paid'), 'existing_plan'],
    ['an annual prepay invoice still payable', ({ customerId }) => prepayTerm(customerId, 'payment_pending', 'sent'), 'existing_plan'],
    // The shared live-plan reader (loadLiveRecurringObligationRows): a plan visit in progress is the customer's plan.
    ['a plan visit is in progress', ({ customerId }) => visit(customerId, null, {
      source_action: 'admin', is_recurring: true, recurring_pattern: 'quarterly', scheduled_date: inDays(0), status: 'on_site',
    }), 'existing_plan'],
  ])('%s: ONE card whose shadow line names it', async (_name, change, reason) => {
    const fixture = await phoneYes();
    await change(fixture);
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(fixture.bookingCallId);
    expect(REASONS[reason]).toEqual(expect.any(String));
    expect(payloadOf(card)).toMatchObject({ auto_would_accept: false, auto_reason: reason, auto_message: REASONS[reason] });
  });

  test.each([
    ['being read, after the yes', { hoursAgo: 1, processing_status: 'processing' }, {}, 'newer_call'],
    ['queued, with a recording, after the yes', { hoursAgo: 1, processing_status: 'pending', ...RECORDED }, {}, 'newer_call'],
    ['not started, with a recording, after the yes', { hoursAgo: 1, processing_status: null, ...RECORDED }, {}, 'newer_call'],
    ['with a transcription retry left, after the yes', { hoursAgo: 1, processing_status: 'no_transcription', extraction_attempts: 1, ...RECORDED }, {}, 'newer_call'],
    ['with an extraction retry left, after the yes', { hoursAgo: 1, processing_status: 'extraction_failed', extraction_attempts: 2, ...RECORDED }, {}, 'newer_call'],
    ['with a masked transcript not read yet, after the yes', {
      hoursAgo: 1, processing_status: null, transcription_metadata: JSON.stringify({ pan_detected: true }),
    }, {}, 'newer_call'],
    ['being read, between the send and the booking, with no yes yet', { hoursAgo: 5, processing_status: 'processing' }, { yesChoice: null }, 'no_yes_heard'],
    ['being read, after a booking call that could not be read', { hoursAgo: 1, processing_status: 'processing' }, {}, 'booking_call_unread', true],
  ])('a call from the customer %s waits; once read, the card files', async (_name, unread, setup, reason, bookingUnread = false) => {
    const fixture = await phoneYes(setup);
    if (bookingUnread) await trx('call_log').where({ id: fixture.bookingCallId }).update({ v2_extraction_status: 'failed' });
    const { hoursAgo, ...state } = unread;
    const unreadCallId = await call(fixture.customerId, null, { created_at: new Date(Date.now() - hoursAgo * 3600000), ...state });
    await expect(evaluatePhoneYes({ callLogId: fixture.bookingCallId, customerId: fixture.customerId }))
      .resolves.toEqual({ card: false, reason: 'call_still_processing' });
    await expect(sweep()).resolves.toMatchObject({ filed: 0 });
    await trx('call_log').where({ id: unreadCallId })
      .update({ processing_status: 'processed', transcription_status: 'completed', transcription: transcriptWith(null) });
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(fixture.bookingCallId);
    expect(payloadOf(card).auto_reason).toBe(reason);
  });

  // Owed: not in a final state and changed in the last 2 hours (call-phone-yes-word.js owedReadSql).
  const quiet = { created_at: new Date(Date.now() - 3 * 3600000), updated_at: new Date(Date.now() - 3 * 3600000) };
  test.each([
    ['a call with no recording, quiet for 3 hours', { processing_status: null, ...quiet }],
    ['a failed transcription with retries left, quiet for 3 hours', { processing_status: 'no_transcription', extraction_attempts: 1, ...quiet }],
    ['a failed extraction at the retry cap', { processing_status: 'extraction_failed', extraction_attempts: 3, ...RECORDED }],
    ['a failed transcription at the retry cap', { processing_status: 'no_transcription', extraction_attempts: 3, ...RECORDED }],
    ['a failed extraction older than the retry window', {
      processing_status: 'extraction_failed', extraction_attempts: 1, created_at: new Date(Date.now() - 8 * DAY), ...RECORDED,
    }],
  ])('%s owes no read: the card files at once', async (_name, state) => {
    const fixture = await phoneYes({ estimateOver: { sent_at: new Date(Date.now() - 10 * DAY) } });
    await call(fixture.customerId, null, { created_at: new Date(Date.now() - 3600000), ...state });
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
  });

  test("the latest word is found past fifty calls with none: a cancellation before them is no yes", async () => {
    const { customerId, bookingCallId } = await phoneYes();
    await call(customerId, null, { created_at: new Date(Date.now() - 90 * 60000) }, 'cancellation_request');
    for (let n = 0; n < 55; n += 1) await call(customerId, null, { created_at: new Date(Date.now() - 3600000 + n * 1000) });
    await expect(evaluatePhoneYes({ callLogId: bookingCallId, customerId }))
      .resolves.toMatchObject({ card: true, yes: null, noYes: 'caller_took_back' });
  });

  // The caller's word decides the card's state, never whether it exists (AGENTS.md: an owed ask closes only on evidence
  // answering it). A cancel or one-time ask may be about another estimate or service; the office reads it.
  test.each([
    ['the booking call asked for a one-time visit instead', { bookingIntent: 'preventative_one_time' }, 'caller_took_back'],
    ['the booking call asked to cancel', { bookingIntent: 'cancellation_request' }, 'caller_took_back'],
    ['the yes call itself also asked for a one-time visit', { yesIntent: 'preventative_one_time' }, 'caller_took_back'],
    ['an earlier call chose annual prepay', { yesChoice: 'annual_prepay' }, 'caller_chose_annual_prepay'],
  ])('the card files with no yes, the word named, when %s', async (_name, setup, reason) => {
    const { bookingCallId } = await phoneYes(setup);
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ yes_heard: false, caller_words: null, no_yes_reason: reason, auto_would_accept: false, auto_reason: reason });
    expect(payloadOf(card).no_yes_message).toMatch(/latest word/);
  });

  test('a send claim older than the settle time is a send that died: the card no longer waits on it', async () => {
    const { customerId, bookingCallId } = await phoneYes();
    await estimate(customerId, { status: 'sending', updated_at: new Date(Date.now() - 20 * 60000) });
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    expect(await cards(bookingCallId)).toHaveLength(1);
  });

  // A send in flight claims 'sending' and then restores the status: which estimates are open is known once it settles.
  test('an estimate being sent at filing: the card waits, then names every open estimate', async () => {
    const { customerId, bookingCallId } = await phoneYes();
    const other = await estimate(customerId, { status: 'sending' });
    await expect(evaluatePhoneYes({ callLogId: bookingCallId, customerId })).resolves.toEqual({ card: false, reason: 'estimate_being_sent' });
    await expect(sweep()).resolves.toMatchObject({ filed: 0 });
    await trx('estimates').where({ id: other.id }).update({ status: 'sent' });
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ auto_would_accept: false, auto_reason: 'more_than_one_estimate' });
    expect(payloadOf(card).estimate_ids).toHaveLength(2);
  });

  test('while the call with the yes is read again, the card shows no words and says so; after the read, the yes is back', async () => {
    const { yesCallId, bookingCallId } = await phoneYes();
    await sweep();
    await trx('call_log').where({ id: yesCallId }).update({ processing_status: 'processing' });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    let [card] = await cards(bookingCallId);
    expect(card.summary).toBe('A call booked a pest visit while an estimate is open. The call with the yes is being read again. The estimate is not accepted yet.');
    expect(payloadOf(card)).toMatchObject({ yes_heard: false, yes_rechecking: true, yes_call_log_id: yesCallId, caller_words: null, auto_would_accept: true });
    const stamp = card.updated_at;
    await sweep();
    [card] = await cards(bookingCallId);
    expect(card.updated_at).toEqual(stamp);
    await trx('call_log').where({ id: yesCallId }).update({ processing_status: 'processed' });
    await sweep();
    [card] = await cards(bookingCallId);
    expect(card.summary).toBe('Caller said yes to pay per application on the call. The estimate is not accepted yet.');
    expect(payloadOf(card)).toMatchObject({ yes_heard: true, yes_rechecking: false, yes_call_log_id: yesCallId, caller_words: WORDS });
  });

  test('a re-read that turns the yes into a cancel clears the yes in the same pass, the word named', async () => {
    const { yesCallId, bookingCallId } = await phoneYes();
    await sweep();
    await trx('call_log').where({ id: yesCallId }).update({ ai_extraction_enriched: JSON.stringify(extractionWith(null, 'cancellation_request')) });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    const [card] = await cards(bookingCallId);
    expect(card.status).toBe('open');
    expect(payloadOf(card)).toMatchObject({ yes_heard: false, caller_words: null, no_yes_reason: 'caller_took_back' });
  });

  // While a call owes a read nothing new shows, but a yes the read calls no longer back is cleared at once.
  test('a later cancel read while another call still owes a read clears the yes at once', async () => {
    const { customerId, bookingCallId } = await phoneYes();
    await sweep();
    await call(customerId, null, { created_at: new Date(Date.now() - 1800000) }, 'cancellation_request');
    await call(customerId, null, { created_at: new Date(Date.now() - 600000), processing_status: null });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    const [card] = await cards(bookingCallId);
    expect(card.status).toBe('open');
    expect(payloadOf(card)).toMatchObject({ yes_heard: false, caller_words: null, no_yes_reason: 'caller_took_back' });
  });

  test('a yes the read calls still back stays while another call owes a read', async () => {
    const { customerId, yesCallId, bookingCallId } = await phoneYes();
    await sweep();
    await call(customerId, null, { created_at: new Date(Date.now() - 600000), processing_status: null });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    const [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ yes_heard: true, yes_call_log_id: yesCallId });
  });

  test('a call relinked after the check gets no card for the old customer, and no row that would block the new one', async () => {
    const { customerId, bookingCallId } = await phoneYes();
    const other = await customer();
    const { fileCardForTest } = require('../services/call-phone-yes-accept')._private;
    const evaluation = await evaluatePhoneYes({ callLogId: bookingCallId, customerId });
    await trx('call_log').where({ id: bookingCallId }).update({ customer_id: other });
    await expect(fileCardForTest({ call: { id: bookingCallId, customer_id: customerId }, extraction: {}, evaluation })).resolves.toBe(false);
    expect(await cards(bookingCallId)).toEqual([]);
  });

  test('a yes call read again without the yes: the card shows no yes', async () => {
    const { yesCallId, bookingCallId } = await phoneYes();
    await sweep();
    await trx('call_log').where({ id: yesCallId }).update({ ai_extraction_enriched: JSON.stringify(extractionWith(null)), transcription: transcriptWith(null) });
    await sweep();
    const [card] = await cards(bookingCallId);
    expect(card.summary).toMatch(/No yes heard/);
    expect(payloadOf(card)).toMatchObject({ yes_heard: false, yes_rechecking: false, yes_call_log_id: null, caller_words: null });
  });

  test('an estimate sent after the booking call is not what the card is about, but it still makes two', async () => {
    const { customerId, est, bookingCallId } = await phoneYes();
    await estimate(customerId, { sent_at: new Date(Date.now() - 3600000), created_at: new Date(Date.now() - 3600000) });
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(bookingCallId);
    expect(card.related_estimate_id).toBeNull();
    expect(payloadOf(card)).toMatchObject({ estimate_ids: [est.id], auto_would_accept: false, auto_reason: 'more_than_one_estimate' });
  });

  // A call that gets no card is read again every run; a full page of them must not keep an older booking from its card.
  test('calls with no card never fill the scan: an older booking past a full page still gets its card', async () => {
    const { bookingCallId } = await phoneYes({ bookingOver: { created_at: new Date(Date.now() - 5 * 3600000) } });
    for (let n = 1; n <= 3; n += 1) {
      await phoneYes({ visitOver: { service_type: 'Lawn Care' }, bookingOver: { created_at: new Date(Date.now() - n * 3600000) } });
    }
    await expect(runCallPhoneYesSweep({ pageSize: 2 })).resolves.toMatchObject({ scanned: 4, filed: 1 });
    expect(await cards(bookingCallId)).toHaveLength(1);
  });

  // The send path stamps each real delivery's prices (sendSnapshot.priced); a change after it, or a delivery after the
  // yes, means the caller may have heard other terms.
  describe('terms the caller heard', () => {
    const { pricedContent } = require('../services/estimate-updated-wording');
    const stampOf = (over = {}) => pricedContent({ monthly_total: 15, annual_total: 180, onetime_total: 0, estimate_data: planData(), ...over });

    test('prices changed after the last delivery: the shadow line says the terms may differ', async () => {
      const { bookingCallId } = await phoneYes({ estimateOver: {
        estimate_data: JSON.stringify({ ...planData(), sendSnapshot: { priced: stampOf({ monthly_total: 12, annual_total: 144 }) } }),
      } });
      await expect(sweep()).resolves.toMatchObject({ filed: 1 });
      const [card] = await cards(bookingCallId);
      expect(payloadOf(card)).toMatchObject({ yes_heard: true, auto_would_accept: false, auto_reason: 'terms_may_differ' });
    });

    test('delivered again after the yes: the shadow line says the terms may differ', async () => {
      const { bookingCallId } = await phoneYes({ estimateOver: {
        estimate_data: JSON.stringify({ ...planData(), sendSnapshot: { priced: stampOf() }, deliveryState: {
          firstDeliveredAt: new Date(Date.now() - 2 * DAY).toISOString(), lastDeliveredAt: new Date(Date.now() - 12 * 3600000).toISOString(), sentChannels: ['sms'],
        } }),
      } });
      await expect(sweep()).resolves.toMatchObject({ filed: 1 });
      const [card] = await cards(bookingCallId);
      expect(payloadOf(card)).toMatchObject({ auto_would_accept: false, auto_reason: 'terms_may_differ' });
    });

    test('the delivered terms are the current ones and nothing was sent after the yes: auto would accept', async () => {
      const { bookingCallId } = await phoneYes({ estimateOver: {
        estimate_data: JSON.stringify({ ...planData(), sendSnapshot: { priced: stampOf() }, deliveryState: {
          firstDeliveredAt: new Date(Date.now() - 2 * DAY).toISOString(), lastDeliveredAt: new Date(Date.now() - 2 * DAY).toISOString(), sentChannels: ['sms'],
        } }),
      } });
      await expect(sweep()).resolves.toMatchObject({ filed: 1 });
      const [card] = await cards(bookingCallId);
      expect(payloadOf(card)).toMatchObject({ auto_would_accept: true });
    });
  });

  // A visit the call booked that is already on site or done still makes two (only the live one needs the card).
  test('the call booked two visits and one is on site: the shadow line says more than one visit', async () => {
    const { customerId, bookingCallId } = await phoneYes();
    await visit(customerId, bookingCallId, { status: 'on_site' });
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ auto_would_accept: false, auto_reason: 'more_than_one_visit' });
  });

  // A yes given while another estimate was open too may be about that one (a lawn quote accepted before the booking).
  test('a yes given while another estimate was open: the shadow line says it may be about that one', async () => {
    const { customerId, bookingCallId } = await phoneYes();
    await estimate(customerId, { sent_at: new Date(Date.now() - 3 * DAY), status: 'accepted', accepted_at: new Date(Date.now() - 12 * 3600000) });
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ yes_heard: true, auto_would_accept: false, auto_reason: 'yes_maybe_other_estimate' });
  });

  test('an estimate settled before the yes call leaves the yes clear', async () => {
    const { customerId, bookingCallId } = await phoneYes();
    await estimate(customerId, { sent_at: new Date(Date.now() - 3 * DAY), status: 'accepted', accepted_at: new Date(Date.now() - 30 * 3600000) });
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ yes_heard: true, auto_would_accept: true });
  });

  // A past recurring row still marked pending is not a live plan (the shared reader's lifecycle rule).
  test('a past recurring row still pending is no live plan: auto would accept', async () => {
    const { customerId, bookingCallId } = await phoneYes();
    await visit(customerId, null, { source_action: 'admin', is_recurring: true, recurring_pattern: 'quarterly', scheduled_date: inDays(-40), status: 'pending' });
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ auto_would_accept: true, auto_reason: null });
  });

  test('an archived estimate is not open: it never makes two', async () => {
    const { customerId, est, bookingCallId } = await phoneYes();
    // Archived before the yes call (one archived after it was open when the caller spoke).
    await estimate(customerId, { archived_at: new Date(Date.now() - 30 * 3600000) });
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(bookingCallId);
    expect(card.related_estimate_id).toBe(est.id);
    expect(payloadOf(card)).toMatchObject({ estimate_ids: [est.id], auto_would_accept: true });
  });

  // A booking call no pass reads (a voice-agent booking whose recording never arrives) waits out its bounded hold,
  // then files with its own reason; it never ages out of the lookback with no card.
  test('a booking call no pass reads holds the card for its bounded wait, then files as booking_call_unread', async () => {
    const recent = await phoneYes({ bookingOver: { processing_status: null, created_at: new Date(Date.now() - 3600000) } });
    await expect(evaluatePhoneYes({ callLogId: recent.bookingCallId, customerId: recent.customerId }))
      .resolves.toEqual({ card: false, reason: 'call_still_processing' });
    const threeHoursAgo = new Date(Date.now() - 3 * 3600000);
    const quiet = await phoneYes({ bookingOver: { processing_status: null, created_at: threeHoursAgo, updated_at: threeHoursAgo } });
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(quiet.bookingCallId);
    expect(payloadOf(card)).toMatchObject({ yes_heard: true, auto_would_accept: false, auto_reason: 'booking_call_unread' });
    expect(await cards(recent.bookingCallId)).toEqual([]);
  });

  test('two open estimates: the card names both and stays until neither is open or lapsed', async () => {
    const { customerId, est, bookingCallId } = await phoneYes();
    const other = await estimate(customerId);
    await expect(sweep()).resolves.toMatchObject({ filed: 1, closed: 0 });
    let [card] = await cards(bookingCallId);
    expect(card).toMatchObject({ status: 'open', related_estimate_id: null });
    expect(payloadOf(card).estimate_ids.sort()).toEqual([est.id, other.id].sort());
    // Nothing changed: the card keeps its version (Resolve and Dismiss are bound to it).
    await sweep();
    expect((await cards(bookingCallId))[0].updated_at).toEqual(card.updated_at);
    // An estimate that leaves loses its link, and the card's version moves.
    await trx('estimates').where({ id: est.id }).update({ status: 'declined', declined_at: new Date() });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    const filed = card;
    [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ estimate_ids: [other.id], yes_heard: true, caller_words: WORDS });
    expect(card.summary).toBe(filed.summary);
    expect(new Date(card.updated_at).getTime()).toBeGreaterThan(new Date(filed.updated_at).getTime());
    await trx('estimates').where({ id: other.id }).update({ status: 'expired', expires_at: new Date(Date.now() - 3600000) });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    expect(payloadOf((await cards(bookingCallId))[0]).estimate_ids).toEqual([other.id]);
    await trx('estimates').where({ id: other.id }).update({ status: 'declined', declined_at: new Date() });
    await expect(sweep()).resolves.toMatchObject({ closed: 1 });
    [card] = await cards(bookingCallId);
    expect(card).toMatchObject({ status: 'dismissed', resolution_source: 'auto', resolution_rule: 'call_phone_yes_moot' });
  });

  test("two open estimates: another estimate's accept keeps the card; linking the booked visit closes it", async () => {
    const { customerId, est, bookingCallId, visitId } = await phoneYes();
    const lawn = await estimate(customerId);
    await sweep();
    await trx('estimates').where({ id: lawn.id }).update({ status: 'accepted', accepted_at: new Date() });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    let [card] = await cards(bookingCallId);
    expect(card.status).toBe('open');
    await trx('scheduled_services').where({ id: visitId }).update({ source_estimate_id: est.id });
    await expect(sweep()).resolves.toMatchObject({ closed: 1 });
    [card] = await cards(bookingCallId);
    expect(card).toMatchObject({ status: 'dismissed', resolution_rule: 'call_phone_yes_moot' });
    expect(card.resolution_note).toContain('linked to an estimate');
  });

  test('a pest and a lawn visit: cancelling the pest visit closes the card', async () => {
    const { customerId, bookingCallId, visitId } = await phoneYes();
    await visit(customerId, bookingCallId, { service_type: 'Lawn Care', scheduled_date: inDays(12) });
    await expect(sweep()).resolves.toMatchObject({ filed: 1, closed: 0 });
    await trx('scheduled_services').where({ id: visitId }).update({ status: 'cancelled' });
    await expect(sweep()).resolves.toMatchObject({ closed: 1 });
    const [card] = await cards(bookingCallId);
    expect(card.resolution_note).toContain('no pest visit');
  });

  test('the yes moves with its call: a card whose yes call moves to another customer shows no yes, and stays open', async () => {
    const { yesCallId, bookingCallId } = await phoneYes();
    await sweep();
    await trx('call_log').where({ id: yesCallId }).update({ customer_id: await customer() });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    const [card] = await cards(bookingCallId);
    expect(card.status).toBe('open');
    expect(card.summary).toMatch(/No yes heard/);
    // The yes fields follow the calls; the shadow verdict stays as filed.
    expect(payloadOf(card)).toMatchObject({ yes_heard: false, yes_call_log_id: null, caller_words: null, auto_would_accept: true });
  });

  test("a later call's yes, in the caller's words, turns a no-yes card into a yes card", async () => {
    const { customerId, bookingCallId } = await phoneYes({ yesChoice: null });
    await sweep();
    const laterYesId = await call(customerId, 'per_application', { created_at: new Date(Date.now() - 3600000) });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    const [card] = await cards(bookingCallId);
    expect(card.summary).toBe('Caller said yes to pay per application on the call. The estimate is not accepted yet.');
    expect(payloadOf(card)).toMatchObject({ yes_heard: true, yes_call_log_id: laterYesId, caller_words: WORDS, auto_reason: 'no_yes_heard' });
  });

  test('the card stays open after the estimate expires and after the visit is done', async () => {
    const { est, bookingCallId, visitId } = await phoneYes();
    await sweep();
    await trx('estimates').where({ id: est.id }).update({ status: 'expired', expires_at: new Date(Date.now() - 3600000) });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    await trx('scheduled_services').where({ id: visitId }).update({ status: 'completed' });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    const [card] = await cards(bookingCallId);
    expect(card.status).toBe('open');
  });

  // A call after a newer estimate was sent (one sent after the booking call) may be about that estimate.
  test("a newer estimate's calls are not this card's: a yes there never shows here, a cancel there never closes it", async () => {
    const { customerId, yesCallId, bookingCallId } = await phoneYes();
    await sweep();
    await estimate(customerId, { sent_at: new Date(Date.now() - 3600000) });
    await call(customerId, 'per_application', { created_at: new Date(Date.now() - 1800000) });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    let [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ yes_heard: true, yes_call_log_id: yesCallId });
    await call(customerId, null, { created_at: new Date(Date.now() - 600000) }, 'cancellation_request');
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    [card] = await cards(bookingCallId);
    expect(card.status).toBe('open');
    expect(payloadOf(card)).toMatchObject({ yes_heard: true, yes_call_log_id: yesCallId });
  });

  test("a yes after a newer estimate was sent is not the card's at filing either", async () => {
    const { customerId, bookingCallId } = await phoneYes({ yesChoice: null });
    await estimate(customerId, { sent_at: new Date(Date.now() - 3600000) });
    await call(customerId, 'per_application', { created_at: new Date(Date.now() - 1800000) });
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ yes_heard: false, caller_words: null, auto_would_accept: false });
  });

  // A resend moves sent_at; the first real handoff (deliveryState.firstDeliveredAt) stays.
  test('a newer estimate sent again keeps its first send as the bound: its calls between the sends are not this card\'s', async () => {
    const { customerId, yesCallId, bookingCallId } = await phoneYes();
    await sweep();
    const resend = new Date(Date.now() - 600000);
    await estimate(customerId, {
      sent_at: resend,
      estimate_data: JSON.stringify({ ...planData(), deliveryState: {
        firstDeliveredAt: new Date(Date.now() - 3600000).toISOString(), lastDeliveredAt: resend.toISOString(), sentChannels: ['sms'],
      } }),
    });
    await call(customerId, 'per_application', { created_at: new Date(Date.now() - 1800000) });
    await call(customerId, null, { created_at: new Date(Date.now() - 1200000) }, 'cancellation_request');
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    const [card] = await cards(bookingCallId);
    expect(card.status).toBe('open');
    expect(payloadOf(card)).toMatchObject({ yes_heard: true, yes_call_log_id: yesCallId });
  });

  // The send path stamps sent_at even when every channel was held back; such a send reached no one, so it bounds nothing.
  test('a newer estimate whose send was held back bounds nothing: a later cancel still clears the yes', async () => {
    const { customerId, bookingCallId } = await phoneYes();
    await sweep();
    await estimate(customerId, {
      sent_at: new Date(Date.now() - 3600000),
      estimate_data: JSON.stringify({ ...planData(), deliveryState: { attemptedAt: new Date(Date.now() - 3600000).toISOString(), sentChannels: [], failedChannels: ['sms'], channels: [] } }),
    });
    await call(customerId, null, { created_at: new Date(Date.now() - 1200000) }, 'cancellation_request');
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    const [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ yes_heard: false, no_yes_reason: 'caller_took_back' });
  });

  test('another estimate open at the yes and sent again after it: the shadow line still says the yes may be about it', async () => {
    const { customerId, bookingCallId } = await phoneYes();
    await estimate(customerId, {
      status: 'accepted', accepted_at: new Date(Date.now() - 12 * 3600000), sent_at: new Date(Date.now() - 20 * 3600000),
      estimate_data: JSON.stringify({ ...planData(), deliveryState: { firstDeliveredAt: new Date(Date.now() - 30 * 3600000).toISOString(), sentChannels: ['sms'] } }),
    });
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ yes_heard: true, auto_would_accept: false, auto_reason: 'yes_maybe_other_estimate' });
  });

  test('an estimate whose sends were held back but which the customer opened counts as delivered', async () => {
    const { bookingCallId } = await phoneYes({ estimateOver: {
      status: 'viewed', viewed_at: new Date(Date.now() - 36 * 3600000),
      estimate_data: JSON.stringify({ ...planData(), deliveryState: { sentChannels: [], failedChannels: ['sms'], channels: [] } }),
    } });
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    const [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ yes_heard: true, auto_would_accept: true });
  });

  // The close is read again under the lock: evidence that changed after the first read keeps the card, and what the
  // re-read found is written, so the card (and the bell that rings from it) never keeps a yes the re-read no longer backs.
  test('a close whose evidence changed before the write keeps the card open, with what the re-read found', async () => {
    const { bookingCallId, customerId } = await phoneYes();
    await sweep();
    const [card] = await cards(bookingCallId);
    // A later call takes the yes back: the re-read finds no close, but a yes that no longer holds.
    await call(customerId, null, { created_at: new Date() }, 'cancellation_request');
    const { applyCardStateForTest } = require('../services/call-phone-yes-accept')._private;
    await expect(applyCardStateForTest(card, { close: 'No longer applies: test.' })).resolves.toBe(false);
    const [after] = await cards(bookingCallId);
    expect(after.status).toBe('open');
    expect(payloadOf(after)).toMatchObject({ yes_heard: false, no_yes_reason: 'caller_took_back' });
  });

  // A resend claims 'sending', then restores the status: a sweep in between keeps the card and its link.
  test('an estimate being sent again keeps the card open', async () => {
    const { est, bookingCallId } = await phoneYes();
    await sweep();
    await trx('estimates').where({ id: est.id }).update({ status: 'sending' });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    const [card] = await cards(bookingCallId);
    expect(card).toMatchObject({ status: 'open', related_estimate_id: est.id });
  });

  test('a card that names its estimate stays open when a second estimate opens', async () => {
    const { customerId, est, bookingCallId } = await phoneYes();
    await sweep();
    await estimate(customerId);
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    const [card] = await cards(bookingCallId);
    expect(card).toMatchObject({ status: 'open', related_estimate_id: est.id });
  });

  test.each([
    ['the estimate is declined', ({ est }) => trx('estimates').where({ id: est.id }).update({ status: 'declined', declined_at: new Date() }), 'declined'],
    ['every visit the call booked is cancelled', ({ bookingCallId }) => trx('scheduled_services').where({ source_call_log_id: bookingCallId }).update({ status: 'cancelled' }),
      'off the calendar'],
    ['the estimate is archived', ({ est }) => trx('estimates').where({ id: est.id }).update({ archived_at: new Date() }), 'archived'],
    ['the call moves to another customer', async ({ bookingCallId }) => {
      await trx('call_log').where({ id: bookingCallId }).update({ customer_id: await customer() });
    }, 'no longer linked'],
  ])('the card closes itself when %s', async (_name, change, note) => {
    const fixture = await phoneYes();
    await expect(sweep()).resolves.toMatchObject({ filed: 1, closed: 0 });
    await change(fixture);
    await expect(sweep()).resolves.toMatchObject({ closed: 1 });
    const [card] = await cards(fixture.bookingCallId);
    expect(card).toMatchObject({ status: 'dismissed', resolution_source: 'auto', resolution_rule: 'call_phone_yes_moot' });
    expect(card.resolution_note).toContain(note);
  });

  // A later word never closes the card: it shows as no yes, the word named.
  test.each([
    ['the customer chooses annual prepay on a later call', ({ customerId }) => call(customerId, 'annual_prepay', { created_at: new Date() }), 'caller_chose_annual_prepay'],
    ['the customer asks to cancel on a later call', ({ customerId }) => call(customerId, null, { created_at: new Date() }, 'cancellation_request'), 'caller_took_back'],
  ])('the card stays open with no yes, the word named, when %s', async (_name, change, reason) => {
    const fixture = await phoneYes();
    await expect(sweep()).resolves.toMatchObject({ filed: 1 });
    await change(fixture);
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    const [card] = await cards(fixture.bookingCallId);
    expect(card.status).toBe('open');
    expect(payloadOf(card)).toMatchObject({ yes_heard: false, no_yes_reason: reason });
  });

  // The office's Mark accepted links no visit: the visit still needs the plan's price, so the card stays and says so.
  test('an accept that leaves the visit unlinked keeps the card open and says so; linking the visit closes it', async () => {
    const { est, bookingCallId, visitId } = await phoneYes();
    await sweep();
    await trx('estimates').where({ id: est.id }).update({ status: 'accepted', accepted_at: new Date() });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    let [card] = await cards(bookingCallId);
    expect(card.status).toBe('open');
    expect(payloadOf(card)).toMatchObject({ estimate_accepted: true });
    expect(card.summary).toMatch(/accepted, but the visit this call booked is not linked/);
    const version = card.updated_at;
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    [card] = await cards(bookingCallId);
    expect(card.updated_at).toEqual(version);
    await trx('scheduled_services').where({ id: visitId }).update({ source_estimate_id: est.id });
    await expect(sweep()).resolves.toMatchObject({ closed: 1 });
    [card] = await cards(bookingCallId);
    expect(card).toMatchObject({ status: 'dismissed', resolution_rule: 'call_phone_yes_moot' });
    expect(card.resolution_note).toContain('linked to an estimate');
  });

  test('after an accept the yes is still read again: a re-read that drops it clears it, and the card stays', async () => {
    const { est, yesCallId, bookingCallId } = await phoneYes();
    await sweep();
    await trx('estimates').where({ id: est.id }).update({ status: 'accepted', accepted_at: new Date() });
    await sweep();
    await trx('call_log').where({ id: yesCallId }).update({ ai_extraction_enriched: JSON.stringify(extractionWith(null, 'cancellation_request')) });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    const [card] = await cards(bookingCallId);
    expect(card.status).toBe('open');
    expect(payloadOf(card)).toMatchObject({ estimate_accepted: true, yes_heard: false, caller_words: null, no_yes_reason: 'caller_took_back' });
    expect(card.summary).toMatch(/accepted, but the visit this call booked is not linked/);
  });

  test('two estimates: an accepted one keeps its link, so a later decline of the other leaves the card open', async () => {
    const { customerId, est, bookingCallId, visitId } = await phoneYes();
    const other = await estimate(customerId);
    await sweep();
    await trx('estimates').where({ id: est.id }).update({ status: 'accepted', accepted_at: new Date() });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    let [card] = await cards(bookingCallId);
    expect(payloadOf(card)).toMatchObject({ estimate_accepted: true });
    expect(payloadOf(card).estimate_ids.sort()).toEqual([est.id, other.id].sort());
    await trx('estimates').where({ id: other.id }).update({ status: 'declined', declined_at: new Date() });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    [card] = await cards(bookingCallId);
    expect(card.status).toBe('open');
    expect(payloadOf(card)).toMatchObject({ estimate_accepted: true, estimate_ids: [est.id] });
    await trx('scheduled_services').where({ id: visitId }).update({ source_estimate_id: est.id });
    await expect(sweep()).resolves.toMatchObject({ closed: 1 });
  });

  // A re-price hold during a send parks the estimate as send_failed until the office re-sends it: not a close.
  test('an estimate held back as send_failed during a re-send keeps the card, and its link', async () => {
    const { est, bookingCallId } = await phoneYes();
    await sweep();
    await trx('estimates').where({ id: est.id }).update({ status: 'send_failed', last_send_error: 'reprice_pending' });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    let [card] = await cards(bookingCallId);
    expect(card).toMatchObject({ status: 'open', related_estimate_id: est.id });
    await trx('estimates').where({ id: est.id }).update({ status: 'sent', last_send_error: null });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    [card] = await cards(bookingCallId);
    expect(card.status).toBe('open');
  });

  test('an accepted estimate that is then archived closes the card', async () => {
    const { est, bookingCallId } = await phoneYes();
    await sweep();
    await trx('estimates').where({ id: est.id }).update({ status: 'accepted', accepted_at: new Date() });
    await expect(sweep()).resolves.toMatchObject({ closed: 0 });
    await trx('estimates').where({ id: est.id }).update({ archived_at: new Date() });
    await expect(sweep()).resolves.toMatchObject({ closed: 1 });
    const [card] = await cards(bookingCallId);
    expect(card).toMatchObject({ status: 'dismissed', resolution_rule: 'call_phone_yes_moot' });
    expect(card.resolution_note).toContain('archived');
  });

  test('gate off: no card', async () => {
    const { bookingCallId } = await phoneYes();
    delete process.env[GATE];
    await expect(sweep()).resolves.toEqual({ skipped: true, scanned: 0, filed: 0, closed: 0 });
    expect(await cards(bookingCallId)).toEqual([]);
  });

  // The card's tap, "Accept as pay per application": the office's own accept (the real converter, the real accept),
  // with the visit the call booked linked inside it so the plan is booked from that visit.
  describe('the tap (POST /:id/accept-call-phone-yes)', () => {
    // planData: quarterly pest at $45 a visit.
    const PER_VISIT = 45;
    let reminderSpy;
    beforeEach(() => { reminderSpy = jest.spyOn(AppointmentReminders, 'registerAppointment').mockResolvedValue({}); });
    afterEach(() => { reminderSpy.mockRestore(); });
    async function post(path, body, headers = {}) {
      const res = await fetch(`${base}/admin/triage/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    }
    async function get(path, headers = {}) {
      const res = await fetch(`${base}/admin/triage/${path}`, { headers });
      return { status: res.status, body: await res.json() };
    }
    // The card as the list shows it, with what the tap can do now: the list only marks the card (call_phone_yes_tap);
    // the card reads the state from its own route, as the screen does.
    async function listed(cardId, headers = {}) {
      const { items } = await (await fetch(`${base}/admin/triage?status=open`, { headers })).json();
      const row = items.find((i) => i.id === cardId) || null;
      if (!row?.call_phone_yes_tap) return row;
      const read = await get(`${cardId}/call-phone-yes`, headers);
      expect(read.status).toBe(200);
      return { ...row, call_phone_yes: read.body };
    }
    async function filed(opts) {
      const ctx = await phoneYes(opts);
      await expect(sweep()).resolves.toMatchObject({ filed: 1 });
      const [card] = await cards(ctx.bookingCallId);
      return { ...ctx, card };
    }
    const unchanged = async ({ est, visitId, card }) => {
      expect(await statusOf('estimates', est.id)).toBe('sent');
      expect((await trx('scheduled_services').where({ id: visitId }).first()).source_estimate_id).toBeNull();
      expect(await statusOf('triage_items', card.id)).toBe('open');
      expect(sendMembershipStarted).not.toHaveBeenCalled();
    };

    test('accepts as Mark accepted does, books the plan from the visit the call booked, prices it and resolves the card; only the membership email goes out', async () => {
      const { customerId, est, visitId, bookingCallId, card } = await filed();
      const row = await listed(card.id);
      // The plan and its per-visit price as the accept bills them, read now; no terms warning and no fee on this estimate.
      expect(row.call_phone_yes).toMatchObject({
        can_accept: true, estimate_id: est.id, visit_id: visitId, visit_date: inDays(9), plan: 'Quarterly plan', per_visit: PER_VISIT,
        terms_note: null, fee_note: null, message: null,
      });
      expect(row.call_phone_yes.preview_token).toMatch(/^[0-9a-f]{32}$/);

      const out = await post(`${card.id}/accept-call-phone-yes`, { expected_updated_at: card.updated_at, preview_token: row.call_phone_yes.preview_token });
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ ok: true, status: 'resolved', estimate_id: est.id, visit_id: visitId, amount: PER_VISIT });

      expect(await statusOf('estimates', est.id)).toBe('accepted');
      const cust = await trx('customers').where({ id: customerId }).first('billing_mode', 'per_application_fee');
      expect(cust.billing_mode).toBe('per_application');
      expect(Number(cust.per_application_fee)).toBe(PER_VISIT);
      // The booked visit is the plan's first visit, on the pest cadence catalog row, with its label as booked.
      const catalog = await trx('services').where({ service_key: 'pest_general_quarterly' }).first('id');
      const first = await trx('scheduled_services').where({ id: visitId }).first();
      expect(first).toMatchObject({
        is_recurring: true, recurring_pattern: 'quarterly', source_estimate_id: est.id, service_id: catalog.id, service_type: 'General Pest Control', status: 'confirmed',
      });
      expect(Number(first.estimated_price)).toBe(PER_VISIT);
      const next = await trx('scheduled_services').where({ recurring_parent_id: visitId }).orderBy('scheduled_date').select('*');
      expect(next.length).toBeGreaterThan(0);
      for (const r of next) {
        expect(r).toMatchObject({ source_estimate_id: est.id, service_id: catalog.id });
        expect(Number(r.estimated_price)).toBe(PER_VISIT);
      }
      // Every visit linked to the estimate is this one series.
      const linked = await trx('scheduled_services').where({ source_estimate_id: est.id }).select('id');
      expect(linked.map((r) => r.id).sort()).toEqual([visitId, ...next.map((r) => r.id)].sort());
      expect(out.body.plan_visits).toBe(linked.length);

      // The plan visits' reminders: registered once the accept committed, with no confirmation text.
      const followUps = reminderSpy.mock.calls.filter((c) => c[4] === 'estimate_followup');
      expect(followUps.map((c) => c[0]).sort()).toEqual(next.filter((r) => r.window_start).map((r) => r.id).sort());
      expect(followUps.every((c) => c[5]?.sendConfirmation === false)).toBe(true);

      // What Mark accepted sends: the membership email. No text, no welcome text queued.
      expect(sendMembershipStarted).toHaveBeenCalledTimes(1);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(await trx('sms_sequences').where({ customer_id: customerId }).first('id')).toBeUndefined();
      const audit = await trx('activity_log').where({ estimate_id: est.id, action: 'estimate_manual_accept' }).first('metadata');
      expect(JSON.parse(typeof audit.metadata === 'string' ? audit.metadata : JSON.stringify(audit.metadata)).source).toBe(ACCEPT_SOURCE);
      expect(await cards(bookingCallId)).toEqual([expect.objectContaining({ status: 'resolved', resolution_source: 'human' })]);
    });

    test('another change holds the property-preferences lock: the whole accept refuses at once (customer_busy), never waiting while it holds customer-comms', async () => {
      const ctx = await filed();
      const row = await listed(ctx.card.id);
      // A bounded wait on this connection: a blocking take anywhere in the accept would fail as a lock timeout (another
      // reason), not as customer_busy.
      const prior = (await trx.raw("SELECT current_setting('lock_timeout') AS v")).rows[0].v;
      await trx.raw("SELECT set_config('lock_timeout', '2s', true)");
      const other = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
      try {
        await other.transaction(async (o) => {
          await o.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['property-preferences', String(ctx.customerId)]);
          const out = await post(`${ctx.card.id}/accept-call-phone-yes`, { expected_updated_at: ctx.card.updated_at, preview_token: row.call_phone_yes.preview_token });
          expect(out.status).toBe(409);
          expect(out.body).toEqual({ code: 'customer_busy', error: TAP_REFUSALS.customer_busy });
        });
      } finally {
        await other.destroy();
        await trx.raw("SELECT set_config('lock_timeout', ?, true)", [prior]);
      }
      await unchanged(ctx);
      // The lock released, the same tap goes through.
      const out = await post(`${ctx.card.id}/accept-call-phone-yes`, { expected_updated_at: ctx.card.updated_at, preview_token: row.call_phone_yes.preview_token });
      expect(out.status).toBe(200);
    });

    test('an estimate with no send time on record offers no tap: the accept would stamp one and move the word window', async () => {
      // An older row: open, no send time, created before the call (the card files from its creation time).
      const ctx = await filed({ estimateOver: { sent_at: null, created_at: new Date(Date.now() - 3 * DAY) } });
      const row = await listed(ctx.card.id);
      expect(row.call_phone_yes).toMatchObject({ can_accept: false, preview_token: null });
      expect(row.call_phone_yes.message).toBe(`The tap cannot accept this one. ${TAP_REFUSALS.estimate_no_send_time.replace(/^Nothing was accepted\. /, '')}`);
      const out = await post(`${ctx.card.id}/accept-call-phone-yes`, { expected_updated_at: ctx.card.updated_at, preview_token: 'tok' });
      expect(out).toMatchObject({ status: 409, body: { code: 'estimate_no_send_time', error: TAP_REFUSALS.estimate_no_send_time } });
      await unchanged(ctx);
    });

    test("a rate the booking call quoted that is the plan's per-visit price still offers the tap (another rate refuses)", async () => {
      const ctx = await filed({ visitOver: { internal_notes: callRateNote('45.00') } });
      expect((await listed(ctx.card.id)).call_phone_yes).toMatchObject({ can_accept: true });
    });

    test('no yes heard: the tap is still offered (the person decides) and accepts the same way', async () => {
      const { est, card } = await filed({ yesChoice: null });
      expect(payloadOf(card).yes_heard).toBe(false);
      const row = await listed(card.id);
      expect(row.call_phone_yes).toMatchObject({ can_accept: true });
      const out = await post(`${card.id}/accept-call-phone-yes`, { expected_updated_at: card.updated_at, preview_token: row.call_phone_yes.preview_token });
      expect(out.status).toBe(200);
      expect(await statusOf('estimates', est.id)).toBe('accepted');
    });

    test('a visit moved since the list loaded is refused with a plain message: nothing accepted, the card stays open', async () => {
      const ctx = await filed();
      const row = await listed(ctx.card.id);
      await trx('scheduled_services').where({ id: ctx.visitId }).update({ window_start: '16:00', window_end: '18:00' });
      const out = await post(`${ctx.card.id}/accept-call-phone-yes`, { expected_updated_at: ctx.card.updated_at, preview_token: row.call_phone_yes.preview_token });
      expect(out.status).toBe(409);
      expect(out.body).toEqual({ code: 'changed_since_check', error: TAP_REFUSALS.changed_since_check });
      await unchanged(ctx);
    });

    test('when the accept would not go ahead, the list says why and the tap refuses with that reason', async () => {
      const ctx = await filed();
      // Since the card was filed, the customer got a live plan.
      await visit(ctx.customerId, null, { source_action: 'admin', is_recurring: true, recurring_pattern: 'quarterly', scheduled_date: inDays(30) });
      const row = await listed(ctx.card.id);
      expect(row.call_phone_yes).toMatchObject({ can_accept: false, preview_token: null });
      expect(row.call_phone_yes.message).toContain(REASONS.existing_plan);
      const out = await post(`${ctx.card.id}/accept-call-phone-yes`, { expected_updated_at: ctx.card.updated_at, preview_token: 'tok' });
      expect(out.status).toBe(409);
      expect(out.body).toEqual({ code: 'existing_plan', error: `Nothing was accepted. ${REASONS.existing_plan}` });
      await unchanged(ctx);
    });

    test('an estimate the office accepted by hand (the visit still unlinked): the card stays open and offers no tap', async () => {
      const ctx = await filed();
      await trx('estimates').where({ id: ctx.est.id }).update({ status: 'accepted', accepted_at: new Date() });
      await sweep();
      expect(await statusOf('triage_items', ctx.card.id)).toBe('open');
      const row = await listed(ctx.card.id);
      expect(row.call_phone_yes).toEqual({
        can_accept: false, preview_token: null, message: 'The tap cannot accept this one. The customer has no open estimate that was sent before the call.',
      });
      const out = await post(`${ctx.card.id}/accept-call-phone-yes`, { expected_updated_at: row.updated_at, preview_token: 'tok' });
      expect(out).toMatchObject({ status: 409, body: { code: 'no_open_estimate', error: TAP_REFUSALS.no_open_estimate } });
      expect(TAP_REFUSALS.no_open_estimate).toMatch(/^Nothing was accepted\. /);
      expect((await trx('scheduled_services').where({ id: ctx.visitId }).first()).source_estimate_id).toBeNull();
    });

    test('a later call takes the yes back before the sweep updates the card: no tap from the old words; once updated, the person decides', async () => {
      const ctx = await filed();
      const before = await listed(ctx.card.id);
      expect(before.call_phone_yes.can_accept).toBe(true);
      await call(ctx.customerId, null, { created_at: new Date() }, 'cancellation_request');
      const row = await listed(ctx.card.id);
      expect(row.call_phone_yes).toMatchObject({ can_accept: false, preview_token: null });
      expect(row.call_phone_yes.message).toBe(`The tap cannot accept this one. ${TAP_REFUSALS.word_not_current.replace(/^Nothing was accepted\. /, '')}`);
      const out = await post(`${ctx.card.id}/accept-call-phone-yes`, { expected_updated_at: ctx.card.updated_at, preview_token: before.call_phone_yes.preview_token });
      expect(out).toMatchObject({ status: 409, body: { code: 'word_not_current', error: TAP_REFUSALS.word_not_current } });
      await unchanged(ctx);
      // The sweep shows the new word on the card (no yes, the word named); the tap is offered again, from what it shows.
      await sweep();
      const updated = await listed(ctx.card.id);
      expect(payloadOf(updated)).toMatchObject({ yes_heard: false, no_yes_reason: 'caller_took_back' });
      expect(updated.call_phone_yes.can_accept).toBe(true);
    });

    test("the booking call's own annual prepay choice leaves it to the prepay card, also behind a later call's word", async () => {
      const ctx = await filed();
      await trx('call_log').where({ id: ctx.bookingCallId })
        .update({ ai_extraction_enriched: JSON.stringify(extractionWith('annual_prepay')), transcription: transcriptWith('annual_prepay') });
      // A later call asks to cancel: the customer's latest word is that call, not the booking call's choice.
      await call(ctx.customerId, null, { created_at: new Date() }, 'cancellation_request');
      await sweep();
      const card = (await cards(ctx.bookingCallId))[0];
      expect(card.status).toBe('open');
      const row = await listed(card.id);
      expect(row.call_phone_yes).toMatchObject({ can_accept: false, preview_token: null });
      expect(row.call_phone_yes.message).toContain('Use the annual prepay card.');
      const out = await post(`${card.id}/accept-call-phone-yes`, { expected_updated_at: row.updated_at, preview_token: 'tok' });
      expect(out).toMatchObject({ status: 409, body: { code: 'chose_annual_prepay', error: TAP_REFUSALS.chose_annual_prepay } });
      await unchanged({ ...ctx, card });
    });

    test('a card that also names a lapsed estimate can show a yes given before this estimate was sent: no tap from those words', async () => {
      // Estimate A sent 3 days ago; the yes (about A) 2 days ago; estimate B sent 12 hours ago; the booking call 2 hours ago.
      const customerId = await customer();
      const estA = await estimate(customerId, { sent_at: new Date(Date.now() - 3 * DAY) });
      await call(customerId, 'per_application', { created_at: new Date(Date.now() - 2 * DAY) });
      const estB = await estimate(customerId, { sent_at: new Date(Date.now() - 12 * 3600000) });
      const bookingCallId = await call(customerId, null, { created_at: new Date(Date.now() - 2 * 3600000) });
      const visitId = await visit(customerId, bookingCallId);
      await expect(sweep()).resolves.toMatchObject({ filed: 1 });
      // A lapses: B is the one open estimate, and the yes was said before B was sent.
      await trx('estimates').where({ id: estA.id }).update({ expires_at: new Date(Date.now() - 3600000) });
      await sweep();
      const [card] = await cards(bookingCallId);
      expect(payloadOf(card)).toMatchObject({ yes_heard: true, estimate_ids: expect.arrayContaining([String(estA.id), String(estB.id)]) });
      const ev = await evaluatePhoneYes({ callLogId: bookingCallId, customerId });
      expect(ev).toMatchObject({ card: true, acceptProblem: null, yes: null });
      const row = await listed(card.id);
      expect(row.call_phone_yes).toMatchObject({ can_accept: false, preview_token: null });
      expect(row.call_phone_yes.message).toBe(`The tap cannot accept this one. ${TAP_REFUSALS.word_not_current.replace(/^Nothing was accepted\. /, '')}`);
      const out = await post(`${card.id}/accept-call-phone-yes`, { expected_updated_at: card.updated_at, preview_token: 'tok' });
      expect(out).toMatchObject({ status: 409, body: { code: 'word_not_current' } });
      expect(await statusOf('estimates', estB.id)).toBe('sent');
      expect((await trx('scheduled_services').where({ id: visitId }).first()).source_estimate_id).toBeNull();
      expect(sendMembershipStarted).not.toHaveBeenCalled();
    });

    test('a card the next sweep would rewrite (an estimate on it declined since) offers no tap until it is updated', async () => {
      // Two estimates open at the booking call, both sent before the yes: the sweep files one card that names both.
      const customerId = await customer();
      const estA = await estimate(customerId, { sent_at: new Date(Date.now() - 3 * DAY) });
      const estB = await estimate(customerId, { sent_at: new Date(Date.now() - 2 * DAY) });
      await call(customerId, 'per_application', { created_at: new Date(Date.now() - DAY) });
      const bookingCallId = await call(customerId, null, { created_at: new Date(Date.now() - 2 * 3600000) });
      await visit(customerId, bookingCallId);
      await expect(sweep()).resolves.toMatchObject({ filed: 1 });
      const [card] = await cards(bookingCallId);
      expect(payloadOf(card).estimate_ids).toHaveLength(2);
      // A is declined: B is the one open estimate, but the card names A until the next sweep.
      await trx('estimates').where({ id: estA.id }).update({ status: 'declined' });
      const row = await listed(card.id);
      expect(row.call_phone_yes).toMatchObject({ can_accept: false, preview_token: null });
      expect(row.call_phone_yes.message).toBe(`The tap cannot accept this one. ${TAP_REFUSALS.card_out_of_date.replace(/^Nothing was accepted\. /, '')}`);
      const out = await post(`${card.id}/accept-call-phone-yes`, { expected_updated_at: card.updated_at, preview_token: 'tok' });
      expect(out).toMatchObject({ status: 409, body: { code: 'card_out_of_date', error: TAP_REFUSALS.card_out_of_date } });
      expect(await statusOf('estimates', estB.id)).toBe('sent');
      // The sweep drops A from the card; the tap is then offered for B, the estimate the card names.
      await sweep();
      const updated = await listed(card.id);
      expect(payloadOf(updated).estimate_ids).toEqual([String(estB.id)]);
      expect(updated.call_phone_yes).toMatchObject({ can_accept: true, estimate_id: String(estB.id) });
    });

    test('an estimate that joins a group after the tap\'s check (with no version bump) is refused on the locked row; nothing is accepted', async () => {
      const { est, card } = await filed();
      const row = await listed(card.id);
      expect(row.call_phone_yes).toMatchObject({ can_accept: true });
      const real = acceptance.markEstimateManuallyAccepted;
      let passed = null;
      const spy = jest.spyOn(acceptance, 'markEstimateManuallyAccepted').mockImplementation(async (args) => {
        passed = args.expected;
        // A group forms between the tap's own check and the accept's row lock, and the row keeps its version.
        const { updated_at: version } = await trx('estimates').where({ id: est.id }).first('updated_at');
        await trx('estimates').where({ id: est.id }).update({ estimate_group_id: randomUUID(), updated_at: version });
        expect((await trx('estimates').where({ id: est.id }).first('updated_at')).updated_at).toEqual(version);
        return real(args);
      });
      try {
        const out = await post(`${card.id}/accept-call-phone-yes`, { expected_updated_at: card.updated_at, preview_token: row.call_phone_yes.preview_token });
        expect(out).toMatchObject({ status: 409, body: { code: 'changed_since_check' } });
        expect(passed).toMatchObject({ ungrouped: true });
        expect(await statusOf('estimates', est.id)).toBe('sent');
        expect((await trx('scheduled_services').where({ id: card.related_scheduled_service_id }).first('source_estimate_id')).source_estimate_id).toBeNull();
      } finally { spy.mockRestore(); }
    });

    test('a WaveGuard membership fee: the card says the accept does not bill it and names the completion hold, before the tap and after it', async () => {
      const withFee = planData({ setupFeeQuote: { amount: 99, waived: false }, result: { ...planData().result, oneTime: { items: [], membershipFee: 99 } } });
      // The fee is the estimate's whole one-time total (the evaluation refuses any other one-time charge).
      const { customerId, est, visitId, card } = await filed({ estimateOver: { estimate_data: JSON.stringify(withFee), onetime_total: 99 } });
      const row = await listed(card.id);
      expect(row.call_phone_yes).toMatchObject({ can_accept: true, fee_note: FEE_NOTE });
      // No amount and no "invoice it now": a fee paid or billed elsewhere by then is not owed.
      expect(FEE_NOTE).not.toMatch(/\$|invoice/i);
      const out = await post(`${card.id}/accept-call-phone-yes`, { expected_updated_at: card.updated_at, preview_token: row.call_phone_yes.preview_token });
      expect(out).toMatchObject({ status: 200, body: { ok: true } });
      expect(out.body.warnings).toContain(FEE_NOTE);
      expect(await statusOf('estimates', est.id)).toBe('accepted');
      // The hold the note names: completion's own check finds the fee owed on the plan's first visit.
      const first = await trx('scheduled_services').where({ id: visitId }).first();
      const { findUnmintedSetupFeeObligation } = require('../services/setup-fee-obligation');
      await expect(findUnmintedSetupFeeObligation({ sourceEstimateId: est.id, customerId, visitPlanRow: first }, trx)).resolves.toMatchObject({ owed: true });
    });

    test('a yes whose time moved (a recording recovery) is not the word the card shows: an old preview is refused, and the sweep rewrites the card', async () => {
      const { card } = await filed();
      const before = await listed(card.id);
      expect(before.call_phone_yes).toMatchObject({ can_accept: true });
      // The same call and the same words, read again as a post-call row: its derived start moves ten minutes earlier.
      await trx('call_log').where({ id: payloadOf(card).yes_call_log_id })
        .update({ metadata: JSON.stringify({ source: 'twilio_recording_status_recovered' }), duration_seconds: 600 });
      expect((await listed(card.id)).call_phone_yes).toMatchObject({ can_accept: false, preview_token: null });
      const out = await post(`${card.id}/accept-call-phone-yes`, { expected_updated_at: card.updated_at, preview_token: before.call_phone_yes.preview_token });
      expect(out.status).toBe(409);
      await sweep();
      const [rewritten] = await cards(card.call_log_id);
      expect(payloadOf(rewritten).yes_at).not.toBe(payloadOf(card).yes_at);
      expect((await listed(card.id)).call_phone_yes).toMatchObject({ can_accept: true });
    });

    test('the terms warning is read live: an estimate re-priced after its last delivery shows it before the tap (the shadow line is from filing), and a token read before it no longer accepts', async () => {
      const ctx = await filed();
      const { est, card } = ctx;
      const before = (await listed(card.id)).call_phone_yes;
      expect(before).toMatchObject({ can_accept: true, terms_note: null });
      const data = typeof est.estimate_data === 'string' ? JSON.parse(est.estimate_data) : est.estimate_data;
      await trx('estimates').where({ id: est.id }).update({ estimate_data: JSON.stringify({ ...data, sendSnapshot: { priced: { repriced: true } } }) });
      const after = (await listed(card.id)).call_phone_yes;
      expect(after).toMatchObject({ can_accept: true, terms_note: REASONS.terms_may_differ });
      // The office has not seen the warning: the token it read before refuses, and nothing is accepted.
      expect(after.preview_token).not.toBe(before.preview_token);
      const out = await post(`${card.id}/accept-call-phone-yes`, { expected_updated_at: card.updated_at, preview_token: before.preview_token });
      expect(out).toMatchObject({ status: 409, body: { code: 'changed_since_check', error: TAP_REFUSALS.changed_since_check } });
      await unchanged(ctx);
    });

    test('an estimate the card does not name is never the one the tap accepts', async () => {
      const ctx = await filed();
      // The card's estimate lapses, and another estimate sent before the call is open (it reopened).
      await trx('estimates').where({ id: ctx.est.id }).update({ expires_at: new Date(Date.now() - 3600000) });
      const other = await estimate(ctx.customerId, { sent_at: new Date(Date.now() - 3 * DAY) });
      const row = await listed(ctx.card.id);
      expect(row.call_phone_yes).toMatchObject({ can_accept: false, preview_token: null });
      expect(row.call_phone_yes.message).toContain('not one this card names');
      const out = await post(`${ctx.card.id}/accept-call-phone-yes`, { expected_updated_at: ctx.card.updated_at, preview_token: 'tok' });
      expect(out).toMatchObject({ status: 409, body: { code: 'estimate_not_on_card', error: TAP_REFUSALS.estimate_not_on_card } });
      expect(await statusOf('estimates', other.id)).toBe('sent');
      await unchanged(ctx);
    });

    test('a card closed by another admin during the accept rolls the whole accept back', async () => {
      const ctx = await filed();
      const row = await listed(ctx.card.id);
      const out = await acceptPhoneYesCard({
        item: ctx.card, previewToken: row.call_phone_yes.preview_token, expectedUpdatedAt: ctx.card.updated_at, resolveCard: async () => 'conflict',
      });
      expect(out).toEqual({ ok: false, reason: 'card_changed', message: TAP_REFUSALS.card_changed });
      await unchanged(ctx);
      expect(await trx('scheduled_services').where({ recurring_parent_id: ctx.visitId }).first('id')).toBeUndefined();
      expect((await trx('customers').where({ id: ctx.customerId }).first('billing_mode')).billing_mode).not.toBe('per_application');
      expect(reminderSpy).not.toHaveBeenCalled();
    });

    test('a non-admin, a stale card, a card of another reason, a closed card and a gate that is off all refuse and accept nothing', async () => {
      const spy = jest.spyOn(acceptance, 'markEstimateManuallyAccepted');
      try {
        const ctx = await filed();
        const { card } = ctx;
        const tech = await listed(card.id, { 'x-test-role': 'technician' });
        expect(tech).toBeNull();
        expect((await get(`${card.id}/call-phone-yes`, { 'x-test-role': 'technician' })).status).toBe(403);
        // The list reads nothing for the tap: it marks the open card; the card's own route reads the state.
        const { items } = await (await fetch(`${base}/admin/triage?status=open`)).json();
        const row = items.find((i) => i.id === card.id);
        expect(row).toMatchObject({ call_phone_yes_tap: true });
        expect(row).not.toHaveProperty('call_phone_yes');
        expect((await post(`${card.id}/accept-call-phone-yes`, { expected_updated_at: card.updated_at }, { 'x-test-role': 'technician' })).status).toBe(403);
        expect((await post(`${card.id}/accept-call-phone-yes`, { expected_updated_at: '2020-01-01T00:00:00Z' })).status).toBe(409);
        expect((await post(`${card.id}/accept-call-phone-yes`, {})).status).toBe(409);
        const other = randomUUID();
        await trx('triage_items').insert({ id: other, call_log_id: ctx.bookingCallId, category: 'service_unknown', reason_code: 'quote_promised', status: 'open', payload: '{}' });
        expect((await post(`${other}/accept-call-phone-yes`, { expected_updated_at: new Date().toISOString() })).status).toBe(400);
        expect((await get(`${other}/call-phone-yes`)).status).toBe(400);
        process.env[GATE] = 'false';
        expect((await post(`${card.id}/accept-call-phone-yes`, { expected_updated_at: card.updated_at })).status).toBe(404);
        expect((await get(`${card.id}/call-phone-yes`)).status).toBe(404);
        const { items: gateOff } = await (await fetch(`${base}/admin/triage?status=open`)).json();
        expect(gateOff.find((i) => i.id === card.id)).not.toHaveProperty('call_phone_yes_tap');
        process.env[GATE] = 'true';
        // Without a token the tap refuses before the accept.
        const noToken = await post(`${card.id}/accept-call-phone-yes`, { expected_updated_at: card.updated_at });
        expect(noToken).toMatchObject({ status: 409, body: { code: 'changed_since_check' } });
        await trx('triage_items').where({ id: card.id }).update({ status: 'resolved' });
        expect((await post(`${card.id}/accept-call-phone-yes`, { expected_updated_at: card.updated_at })).status).toBe(409);
        expect(await get(`${card.id}/call-phone-yes`)).toMatchObject({ status: 200, body: { can_accept: false, preview_token: null } });
        expect(spy).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
    });

    // The two steps inside the accept read every fact again under their locks (a change between the list and the
    // accept's locks). Driven directly here, each inside its own savepoint.
    test('the link step locks the card, then reads the call, the visit, the estimate links, the other open estimates, the plan and the word window again, then links (the last step reads the word)', async () => {
      const { customerId, est, bookingCallId, visitId, card } = await filed();
      const ev = await evaluatePhoneYes({ callLogId: bookingCallId, customerId });
      expect(ev).toMatchObject({ card: true, acceptProblem: null });
      const version = async () => (await trx('triage_items').where({ id: card.id }).first('updated_at')).updated_at;
      const step = (over = {}) => PhoneYesPrivate.linkVisitStepForTest({
        visit: ev.visit, customerId, bookingCallId, cardId: card.id, expectedUpdatedAt: card.updated_at, word: PhoneYesPrivate.tapWordOfForTest(ev), ...over,
      });
      const run = async (over = {}, estimateRow = est) => {
        const expectedUpdatedAt = await version();
        return trx.transaction((t) => step({ expectedUpdatedAt, ...over })(t, { estimate: estimateRow }));
      };
      // Another transaction holds a lock the step takes WITHOUT waiting, so the step refuses at once, never waiting while
      // the accept holds its own locks: property-preferences (a property-role change takes it before customer-comms), or
      // the call's triage lock (call processing takes it before a lead row the accept may hold). The triage case names a
      // call this test's transaction never locked: the filing's own take of the real call's lock lasts until rollback.
      const lockedCallId = randomUUID();
      for (const [lock, over, code] of [
        [['property-preferences', String(customerId)], {}, 'customer_busy'],
        [[TRIAGE_LOCK_NAMESPACE, lockedCallId], { bookingCallId: lockedCallId }, 'call_busy'],
      ]) {
        const other = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
        try {
          await other.transaction(async (o) => {
            await o.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', lock);
            await expect(run(over)).rejects.toMatchObject({ phoneYesRefusal: code });
          });
        } finally { await other.destroy(); }
      }
      // The card: another version than the screen showed, closed by another admin, or not naming this estimate.
      await expect(run({ expectedUpdatedAt: new Date(Date.now() - DAY) })).rejects.toMatchObject({ phoneYesRefusal: 'card_changed' });
      await trx('triage_items').where({ id: card.id }).update({ status: 'dismissed' });
      await expect(run()).rejects.toMatchObject({ phoneYesRefusal: 'card_changed' });
      await trx('triage_items').where({ id: card.id }).update({ status: 'open' });
      await expect(run({}, { ...est, id: randomUUID() })).rejects.toMatchObject({ phoneYesRefusal: 'estimate_not_on_card' });
      // The booking call, read again under the lock: it now says annual prepay (the prepay card's)…
      await trx('call_log').where({ id: bookingCallId })
        .update({ ai_extraction_enriched: JSON.stringify(extractionWith('annual_prepay')), transcription: transcriptWith('annual_prepay') });
      await expect(run()).rejects.toMatchObject({ phoneYesRefusal: 'chose_annual_prepay' });
      // …also when a later call is the customer's latest word (the booking call is still the prepay card's).
      const laterCancel = await call(customerId, null, { created_at: new Date() }, 'cancellation_request');
      await expect(run()).rejects.toMatchObject({ phoneYesRefusal: 'chose_annual_prepay' });
      await trx('call_log').where({ id: laterCancel }).del();
      await trx('call_log').where({ id: bookingCallId })
        .update({ ai_extraction_enriched: JSON.stringify(extractionWith(null)), transcription: transcriptWith(null) });
      // The caller's word is read again once, by the accept's last step (wordStillStep, its calls locked to the commit):
      // a later call takes the yes back, or a call is still being read.
      const wordStill = () => trx.transaction((t) => PhoneYesPrivate.wordStillStepForTest({ customerId, word: PhoneYesPrivate.tapWordOfForTest(ev) })(t));
      const cancelCall = await call(customerId, null, { created_at: new Date() }, 'cancellation_request');
      await expect(wordStill()).rejects.toMatchObject({ phoneYesRefusal: 'word_changed' });
      await trx('call_log').where({ id: cancelCall }).del();
      const unreadCall = await call(customerId, null, { created_at: new Date(Date.now() - 3600000), processing_status: 'processing' });
      await expect(wordStill()).rejects.toMatchObject({ phoneYesRefusal: 'call_still_processing' });
      await trx('call_log').where({ id: unreadCall }).del();
      await expect(wordStill()).resolves.toBeUndefined();
      // A send that started since the check (a draft now 'sending').
      const draft = await estimate(customerId, { status: 'sending', sent_at: null, updated_at: new Date() });
      await expect(run()).rejects.toMatchObject({ phoneYesRefusal: 'estimate_being_sent' });
      await trx('estimates').where({ id: draft.id }).update({ status: 'draft' });
      // The visit as read no longer matches the row.
      await expect(run({ visit: { ...ev.visit, window_start: '08:00' } })).rejects.toMatchObject({ phoneYesRefusal: 'changed_since_check' });
      // A price decision the bill honors, or an invoice, on the visit since the check (read again under its lock).
      await trx('scheduled_services').where({ id: visitId }).update({ primary_line_price: 99 });
      await expect(run()).rejects.toMatchObject({ phoneYesRefusal: 'changed_since_check' });
      await trx('scheduled_services').where({ id: visitId }).update({ primary_line_price: null });
      const invoiceId = await invoiceOn(customerId, visitId);
      await expect(run()).rejects.toMatchObject({ phoneYesRefusal: 'changed_since_check' });
      await trx('invoices').where({ id: invoiceId }).del();
      await trx('scheduled_services').where({ id: visitId }).update({ self_pay_override: true });
      await expect(run()).rejects.toMatchObject({ phoneYesRefusal: 'changed_since_check' });
      await trx('scheduled_services').where({ id: visitId }).update({ self_pay_override: false });
      // Another estimate was opened.
      const second = await estimate(customerId, { sent_at: new Date() });
      await expect(run()).rejects.toMatchObject({ phoneYesRefusal: 'more_than_one_estimate' });
      await trx('estimates').where({ id: second.id }).update({ status: 'declined' });
      // Declined, its send still bounds the caller's word (a call since may be about it): the window the check read moved.
      await expect(run()).rejects.toMatchObject({ phoneYesRefusal: 'changed_since_check' });
      await trx('estimates').where({ id: second.id }).del();
      // The call moved to another customer.
      const otherCustomer = await customer();
      await trx('call_log').where({ id: bookingCallId }).update({ customer_id: otherCustomer });
      await expect(run()).rejects.toMatchObject({ phoneYesRefusal: 'customer_changed' });
      await trx('call_log').where({ id: bookingCallId }).update({ customer_id: customerId });
      // A recording recovery moved the booking call's derived start before the estimate's send (a post-call row whose
      // length grew): the call could not have answered this estimate, though the word reads the same.
      const callBefore = await trx('call_log').where({ id: bookingCallId }).first('metadata', 'duration_seconds');
      await trx('call_log').where({ id: bookingCallId })
        .update({ metadata: JSON.stringify({ source: 'twilio_recording_status_recovered' }), duration_seconds: 3 * 24 * 3600 });
      await expect(run()).rejects.toMatchObject({ phoneYesRefusal: 'changed_since_check' });
      await trx('call_log').where({ id: bookingCallId })
        .update({ metadata: callBefore.metadata == null ? null : JSON.stringify(callBefore.metadata), duration_seconds: callBefore.duration_seconds });
      // A word window other than the one the check read (a newer send it did not see) refuses too.
      await expect(run({ word: { ...PhoneYesPrivate.tapWordOfForTest(ev), until: new Date().toISOString() } })).rejects.toMatchObject({ phoneYesRefusal: 'changed_since_check' });
      // Nothing was linked by a refused run; a clean run links the visit.
      expect((await trx('scheduled_services').where({ id: visitId }).first()).source_estimate_id).toBeNull();
      await run();
      expect((await trx('scheduled_services').where({ id: visitId }).first()).source_estimate_id).toBe(est.id);
    });

    test("the card's plan is the cadence the converter books: a quarterly line with no visit count is offered; a twice-a-year line, which books no series, offers no tap", () => {
      const terms = (data) => PhoneYesPrivate.planTermsOfForTest(
        { estimate_data: JSON.stringify(data), monthly_total: 15, annual_total: 180 }, { service_type: 'General Pest Control' },
      );
      const withLine = (line, over) => planData({ result: { ...planData().result, recurring: { ...planData().result.recurring, services: [line] } }, ...over });
      expect(terms(planData())).toEqual({ plan: 'Quarterly plan', cadence: 'quarterly', perVisit: 45 });
      // No visit count and no selection: the converter books the line's own cadence and bills its cadence amount.
      expect(terms(withLine({ name: 'Pest Control', service: 'pest_control', mo: 15, frequency: 'quarterly', perTreatment: 45 }, { customerSelection: undefined })))
        .toEqual({ plan: 'Quarterly plan', cadence: 'quarterly', perVisit: 45 });
      // Two visits a year: the converter seeds no pest series on it, so the card shows no plan to accept.
      expect(terms(withLine({ name: 'Pest Control', service: 'pest_control', mo: 15, visitsPerYear: 2, perTreatment: 90 }, { customerSelection: { frequency: 'semiannual' } })))
        .toBeNull();
    });

    test('the price step refuses notes the card did not show, a short schedule, a price it cannot resolve, a series the converter did not book, and a price decision on the series', async () => {
      const { customerId, est, visitId } = await phoneYes();
      const visitRow = await trx('scheduled_services').where({ id: visitId }).first();
      const shownPlan = { perVisit: PER_VISIT, cadence: 'quarterly', yes: null, notesKey: PhoneYesPrivate.notesKeyOfForTest(est, null) };
      const run = (conversion, shown = shownPlan) => trx.transaction((t) => PhoneYesPrivate.priceSeriesStepForTest({ customerId, visit: visitRow, seen: {}, shown })(t, { estimate: est, conversion }));
      // The card names every cadence the converter seeds a residential pest plan on, and no other.
      const Converter = require('../services/estimate-converter');
      const seeded = Object.keys(Converter.PEST_CADENCE_CATALOG_KEYS)
        .filter((cadence) => Converter.supportsConverterFollowUpSeeding({ name: 'Pest Control', service: 'pest_control' }, {}, cadence));
      expect(Object.keys(PhoneYesPrivate.PEST_CADENCE_PLANS).sort()).toEqual(seeded.sort());
      const conversion = { membershipEmail: { perApplicationAmount: PER_VISIT }, recurringScheduleCheck: { ok: true, gaps: [] } };
      // The card showed a terms warning that the accept's own locked row no longer reads: nothing is priced.
      await expect(run(conversion, { ...shownPlan, notesKey: JSON.stringify([true, null]) })).rejects.toMatchObject({ phoneYesRefusal: 'changed_since_check' });
      // The converter's own check found the plan short of visits (or could not run): nothing is priced.
      await expect(run({ ...conversion, recurringScheduleCheck: { ok: false, gaps: [{ kind: 'missing_application' }] } }))
        .rejects.toMatchObject({ phoneYesRefusal: 'series_incomplete' });
      await expect(run({ membershipEmail: conversion.membershipEmail })).rejects.toMatchObject({ phoneYesRefusal: 'series_incomplete' });
      // The customer-level fee was not stamped at the conversion's amount.
      await expect(run(conversion)).rejects.toMatchObject({ phoneYesRefusal: 'price_unresolved' });
      await trx('customers').where({ id: customerId }).update({ billing_mode: 'per_application', per_application_fee: PER_VISIT });
      await expect(run({ ...conversion, membershipEmail: { perApplicationAmount: null } })).rejects.toMatchObject({ phoneYesRefusal: 'price_unresolved' });
      // A converter price that is not the one the card showed before the tap (planTermsOf).
      await expect(run(conversion, { ...shownPlan, perVisit: PER_VISIT + 1 })).rejects.toMatchObject({ phoneYesRefusal: 'plan_not_shown' });
      // The visit is still a one-off: no series was booked from it.
      await expect(run(conversion)).rejects.toMatchObject({ phoneYesRefusal: 'series_not_booked' });
      expect((await trx('scheduled_services').where({ id: visitId }).first()).estimated_price).toBeNull();
      // A series as the converter books it: the visit as the recurring parent on the pest cadence row, one next visit
      // on the same row, both linked to the estimate.
      const catalog = await trx('services').where({ service_key: 'pest_general_quarterly' }).first('id');
      const series = { is_recurring: true, recurring_pattern: 'quarterly', source_estimate_id: est.id, service_id: catalog.id };
      await trx('scheduled_services').where({ id: visitId }).update(series);
      const childId = await visit(customerId, null, { ...series, recurring_parent_id: visitId, scheduled_date: inDays(100) });
      // A price decision the bill honors over estimated_price, on any row of the series, refuses the stamp.
      await trx('scheduled_services').where({ id: childId }).update({ primary_line_price: 99 });
      await expect(run(conversion)).rejects.toMatchObject({ phoneYesRefusal: 'visit_priced' });
      await trx('scheduled_services').where({ id: childId }).update({ primary_line_price: null, discount_type: 'fixed_amount', discount_amount: 10, discount_dollars: 10 });
      await expect(run(conversion)).rejects.toMatchObject({ phoneYesRefusal: 'visit_priced' });
      await trx('scheduled_services').where({ id: childId }).update({ discount_type: null, discount_amount: null, discount_dollars: null });
      // A series on another cadence's catalog row than the one booked (a quarterly series with a monthly identity).
      const monthly = await trx('services').where({ service_key: 'pest_general_monthly' }).first('id');
      await trx('scheduled_services').whereIn('id', [visitId, childId]).update({ service_id: monthly.id });
      await expect(run(conversion)).rejects.toMatchObject({ phoneYesRefusal: 'series_not_booked' });
      await trx('scheduled_services').whereIn('id', [visitId, childId]).update({ service_id: catalog.id });
      // A row of the series with a billing party of its own.
      await trx('scheduled_services').where({ id: childId }).update({ self_pay_override: true });
      await expect(run(conversion)).rejects.toMatchObject({ phoneYesRefusal: 'visit_payer' });
      await trx('scheduled_services').where({ id: childId }).update({ self_pay_override: false });
      // A series booked on another cadence than the card showed (the card named the plan by the line's visit count).
      await expect(run(conversion, { ...shownPlan, cadence: 'monthly' })).rejects.toMatchObject({ phoneYesRefusal: 'plan_not_shown' });
      // A clean series is stamped at the plan price.
      await run(conversion);
      const stamped = await trx('scheduled_services').whereIn('id', [visitId, childId]).select('estimated_price');
      expect(stamped.map((r) => Number(r.estimated_price))).toEqual([PER_VISIT, PER_VISIT]);
    });

    describe('the final word check, on two connections', () => {
      // These rows are committed, on a pool of their own, so a second connection sees them; each test deletes its own.
      let pool; let made = null;
      beforeAll(() => { pool = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } }); });
      // The deadline for a step that must refuse at once: no lock timeout (it raises 55P03, the code NOWAIT raises, which
      // the step maps to its refusal), and a statement timeout instead, so a take that waits fails as a cancel (57014).
      // Long, since it bounds each whole statement: a loaded machine can stretch one past a few seconds.
      const waitNoLonger = async (conn) => {
        await conn.raw('SET LOCAL lock_timeout = 0');
        await conn.raw("SET LOCAL statement_timeout = '30s'");
      };
      afterAll(async () => { await pool.destroy(); });
      afterEach(async () => {
        if (!made) return;
        const { customerId } = made;
        made = null;
        await pool('scheduled_services').where({ customer_id: customerId }).del();
        await pool('call_log').where({ customer_id: customerId }).del();
        await pool('estimates').where({ customer_id: customerId }).del();
        await pool('customers').where({ id: customerId }).del();
      });

      test("a send claim or an unarchive on another of the customer's estimates: in flight, the tap's lock refuses at once; after the lock, it waits for the commit", async () => {
        const perTest = trx;
        let draft;
        let archived;
        try {
          trx = pool;
          mockConn = pool;
          const customerId = await customer();
          made = { customerId };
          await estimate(customerId);
          draft = await estimate(customerId, { status: 'draft', sent_at: null });
          // A sent estimate the office archived: an unarchive (a direct update of the row) makes it open again.
          archived = await estimate(customerId, { archived_at: new Date() });
        } finally {
          trx = perTest;
          mockConn = perTest;
        }
        const lock = (conn) => PhoneYesPrivate.lockCustomerEstimatesForTest(conn, made.customerId);
        // Each write with the update that puts its row back, so each case starts from the same rows.
        const writes = [
          [draft.id, { status: 'sending' }, { status: 'draft' }],
          [archived.id, { archived_at: null }, { archived_at: archived.archived_at }],
        ];
        for (const [id, change, undo] of writes) {
          const write = (conn) => conn('estimates').where({ id }).update(change);
          // The write in flight on another connection (not committed): the lock refuses at once.
          const other = await pool.transaction();
          let accept = await pool.transaction();
          try {
            await write(other);
            await expect(lock(accept)).rejects.toMatchObject({ phoneYesRefusal: 'estimate_being_sent' });
          } finally {
            await accept.rollback();
            await other.rollback();
          }
          // The tap's lock first: the write after it waits until the accept ends.
          accept = await pool.transaction();
          try {
            await lock(accept);
            await expect(pool.transaction(async (later) => {
              await later.raw("SET LOCAL lock_timeout = '300ms'");
              await write(later);
            })).rejects.toMatchObject({ code: '55P03' });
          } finally {
            await accept.rollback();
          }
          await expect(write(pool)).resolves.toBe(1);
          await pool('estimates').where({ id }).update(undo);
        }
      });

      test("a re-read of the booking call holds its row: the link step refuses at once (call_busy), never waiting while it holds the accept's locks", async () => {
        const perTest = trx;
        try {
          trx = pool;
          mockConn = pool;
          made = await phoneYes();
        } finally {
          trx = perTest;
          mockConn = perTest;
        }
        const { customerId, bookingCallId } = made;
        // The step refuses before it reads the card, the visit or the estimate, so none is needed here.
        const step = PhoneYesPrivate.linkVisitStepForTest({ visit: {}, customerId, bookingCallId, cardId: null, expectedUpdatedAt: null, word: {} });
        const other = await pool.transaction();
        const accept = await pool.transaction();
        try {
          await other('call_log').where({ id: bookingCallId }).forUpdate().first('id');
          await waitNoLonger(accept);
          await expect(step(accept, { estimate: {} })).rejects.toMatchObject({ phoneYesRefusal: 'call_busy' });
        } finally {
          await accept.rollback();
          await other.rollback();
        }
      });

      test("the call's visits, locked without waiting: a status change in flight refuses (visit_busy), one after waits for the commit, a staff visit only attached never stops the step, and a booked visit moved to another call refuses without waiting on it", async () => {
        const perTest = trx;
        let ev; let card; let firstId; let staffId; let movedTo;
        try {
          trx = pool;
          mockConn = pool;
          made = await phoneYes();
          // The call's other visit, cancelled: bringing it back would make two visits on the calendar.
          firstId = await visit(made.customerId, made.bookingCallId, { scheduled_date: inDays(5), status: 'cancelled' });
          // A visit the office booked that the call was attached to: not one the call booked, so neither count reads it.
          staffId = await visit(made.customerId, made.bookingCallId, { scheduled_date: inDays(20), source_action: 'admin' });
          // Another call of the customer's, before the estimate was sent (outside the word's window): where the booked
          // visit moves below.
          movedTo = await call(made.customerId, null, { created_at: new Date(Date.now() - 3 * DAY) });
          // This call's card alone, filed as the sweep files one (a sweep on committed rows would act on every call).
          ev = await evaluatePhoneYes({ callLogId: made.bookingCallId, customerId: made.customerId });
          const bookingRow = await trx('call_log').where({ id: made.bookingCallId }).first('id', 'customer_id', 'ai_extraction_enriched');
          const extraction = require('../services/call-held-visits').parseExtraction(bookingRow.ai_extraction_enriched);
          await expect(PhoneYesPrivate.fileCardForTest({ call: bookingRow, extraction, evaluation: ev })).resolves.toBeTruthy();
          [card] = await cards(made.bookingCallId);
        } finally {
          trx = perTest;
          mockConn = perTest;
        }
        expect(ev).toMatchObject({ card: true, acceptProblem: null });
        const step = PhoneYesPrivate.linkVisitStepForTest({
          visit: ev.visit, customerId: made.customerId, bookingCallId: made.bookingCallId, cardId: card.id,
          expectedUpdatedAt: card.updated_at, word: PhoneYesPrivate.tapWordOfForTest(ev),
        });
        const other = await pool.transaction();
        let accept = await pool.transaction();
        try {
          await other('scheduled_services').where({ id: firstId }).forUpdate().first('id');
          await waitNoLonger(accept);
          await expect(step(accept, { estimate: ev.estimate })).rejects.toMatchObject({ phoneYesRefusal: 'visit_busy' });
        } finally {
          await accept.rollback();
          await other.rollback();
        }
        const staffEdit = await pool.transaction();
        accept = await pool.transaction();
        try {
          // An office edit in flight on the attached staff visit: the step still goes ahead.
          await staffEdit('scheduled_services').where({ id: staffId }).forUpdate().first('id');
          await waitNoLonger(accept);
          await step(accept, { estimate: ev.estimate });
          await expect(pool.transaction(async (later) => {
            await later.raw("SET LOCAL lock_timeout = '300ms'");
            await later('scheduled_services').where({ id: firstId }).update({ status: 'confirmed' });
          })).rejects.toMatchObject({ code: '55P03' });
        } finally {
          await accept.rollback();
          await staffEdit.rollback();
        }
        // The booked visit moved to another call since the check, with an edit to it in flight: it is not among the call's
        // visits, so the step refuses at once instead of waiting on its row.
        await pool('scheduled_services').where({ id: made.visitId }).update({ source_call_log_id: movedTo });
        const movedEdit = await pool.transaction();
        accept = await pool.transaction();
        try {
          await movedEdit('scheduled_services').where({ id: made.visitId }).forUpdate().first('id');
          await waitNoLonger(accept);
          await expect(step(accept, { estimate: ev.estimate })).rejects.toMatchObject({ phoneYesRefusal: 'changed_since_check' });
        } finally {
          await accept.rollback();
          await movedEdit.rollback();
        }
      });

      test("a re-read of a call the word is read from: in flight, it refuses at once; committed first, it refuses; after, it waits for the accept's commit", async () => {
        const perTest = trx;
        let ev;
        try {
          trx = pool;
          mockConn = pool;
          made = await phoneYes();
          ev = await evaluatePhoneYes({ callLogId: made.bookingCallId, customerId: made.customerId });
        } finally {
          trx = perTest;
          mockConn = perTest;
        }
        const { customerId, yesCallId, bookingCallId } = made;
        expect(ev).toMatchObject({ card: true, acceptProblem: null });
        const word = PhoneYesPrivate.tapWordOfForTest(ev);
        const check = (conn) => PhoneYesPrivate.wordStillStepForTest({ customerId, word })(conn);
        const asJson = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
        const readOf = async (id) => asJson((await pool('call_log').where({ id }).first('ai_extraction_enriched')).ai_extraction_enriched);
        const yesRead = await readOf(yesCallId);
        const noYesRead = await readOf(bookingCallId);

        // The word as checked: the accept's last check passes.
        let accept = await pool.transaction();
        await expect(check(accept)).resolves.toBeUndefined();
        await accept.rollback();

        // A re-read of the yes call in flight on another connection (written, not yet committed): the check refuses at
        // once, without waiting on the call row.
        const reread = await pool.transaction();
        await reread('call_log').where({ id: yesCallId }).update({ ai_extraction_enriched: noYesRead });
        accept = await pool.transaction();
        await expect(check(accept)).rejects.toMatchObject({ phoneYesRefusal: 'call_still_processing' });
        await accept.rollback();
        // The re-read committed first: the check reads it and refuses.
        await reread.commit();
        accept = await pool.transaction();
        await expect(check(accept)).rejects.toMatchObject({ phoneYesRefusal: 'word_changed' });
        await accept.rollback();

        // The yes back. The check passes and holds the calls to the commit: a re-read that comes after waits.
        await pool('call_log').where({ id: yesCallId }).update({ ai_extraction_enriched: yesRead });
        accept = await pool.transaction();
        await check(accept);
        await expect(pool.transaction(async (later) => {
          await later.raw("SET LOCAL lock_timeout = '300ms'");
          await later('call_log').where({ id: yesCallId }).update({ ai_extraction_enriched: noYesRead });
        })).rejects.toMatchObject({ code: '55P03' });
        await accept.commit();
        // Once the accept committed, the re-read goes through.
        await expect(pool('call_log').where({ id: yesCallId }).update({ ai_extraction_enriched: noYesRead })).resolves.toBe(1);
      });
    });
  });
});
