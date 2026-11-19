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

const knex = require('knex');
const { randomUUID } = require('crypto');
const acceptance = require('../services/estimate-manual-acceptance');
const { sendMembershipStarted } = require('../services/account-membership-email');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { notifyAdmin } = require('../services/notification-service');
const { runCallPhoneYesSweep, evaluatePhoneYes, REASON_CODE, REASONS } = require('../services/call-phone-yes-accept');

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
  let database; let trx;
  const savedGate = process.env[GATE];

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  afterAll(async () => {
    await database.destroy();
    if (savedGate === undefined) delete process.env[GATE]; else process.env[GATE] = savedGate;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env[GATE] = 'true';
    trx = await database.transaction();
    mockConn = trx;
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
    expect(notifyAdmin).not.toHaveBeenCalled();
    // One card per call, ever.
    await expect(sweep()).resolves.toMatchObject({ filed: 0, closed: 0 });
    spy.mockRestore();
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
    ['a later call chose annual prepay (the prepay card owns it)', { bookingChoice: 'annual_prepay' }, 'chose_annual_prepay'],
    ['the booking call asked for a one-time visit instead', { bookingIntent: 'preventative_one_time' }, 'took_back'],
    ['the booking call asked to cancel', { bookingIntent: 'cancellation_request' }, 'took_back'],
    ['the yes call itself also asked for a one-time visit', { yesIntent: 'preventative_one_time' }, 'took_back'],
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

  test.each([
    ['the visit is already a series', { visitOver: { is_recurring: true, recurring_pattern: 'quarterly' } }, 'visit_not_one_off'],
    ['the visit is at another address', { visitOver: { service_address_line1: '200 Other Road' } }, 'property_mismatch'],
    ['the visit carries a setup fee', { visitOver: { pending_setup_fee: 99 } }, 'setup_fee_stamped'],
    ['the visit carries a price', { visitOver: { estimated_price: 99 } }, 'visit_priced'],
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
    ['another live plan', ({ customerId }) => visit(customerId, null, {
      source_action: 'admin', is_recurring: true, recurring_pattern: 'quarterly', scheduled_date: inDays(30),
    }), 'existing_plan'],
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

  test("the latest word is found past fifty calls with none: a cancellation before them takes the yes back", async () => {
    const { customerId, bookingCallId } = await phoneYes();
    await call(customerId, null, { created_at: new Date(Date.now() - 90 * 60000) }, 'cancellation_request');
    for (let n = 0; n < 55; n += 1) await call(customerId, null, { created_at: new Date(Date.now() - 3600000 + n * 1000) });
    await expect(evaluatePhoneYes({ callLogId: bookingCallId, customerId })).resolves.toEqual({ card: false, reason: 'took_back' });
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

  test('a re-read that turns the yes into a cancel closes the card in the same pass', async () => {
    const { yesCallId, bookingCallId } = await phoneYes();
    await sweep();
    await trx('call_log').where({ id: yesCallId }).update({ ai_extraction_enriched: JSON.stringify(extractionWith(null, 'cancellation_request')) });
    await expect(sweep()).resolves.toMatchObject({ closed: 1 });
    const [card] = await cards(bookingCallId);
    expect(card).toMatchObject({ status: 'dismissed', resolution_rule: 'call_phone_yes_moot' });
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
  test('a newer estimate whose send was held back bounds nothing: a later cancel still closes the card', async () => {
    const { customerId, bookingCallId } = await phoneYes();
    await sweep();
    await estimate(customerId, {
      sent_at: new Date(Date.now() - 3600000),
      estimate_data: JSON.stringify({ ...planData(), deliveryState: { attemptedAt: new Date(Date.now() - 3600000).toISOString(), sentChannels: [], failedChannels: ['sms'], channels: [] } }),
    });
    await call(customerId, null, { created_at: new Date(Date.now() - 1200000) }, 'cancellation_request');
    await expect(sweep()).resolves.toMatchObject({ closed: 1 });
    const [card] = await cards(bookingCallId);
    expect(card).toMatchObject({ status: 'dismissed', resolution_rule: 'call_phone_yes_moot' });
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

  // The close is read again under the lock: evidence that changed after the first read keeps the card.
  test('a close whose evidence changed before the write keeps the card open', async () => {
    const { bookingCallId } = await phoneYes();
    await sweep();
    const [card] = await cards(bookingCallId);
    const { applyCardStateForTest } = require('../services/call-phone-yes-accept')._private;
    await expect(applyCardStateForTest(card, { close: 'No longer applies: test.' })).resolves.toBe(false);
    const [after] = await cards(bookingCallId);
    expect(after.status).toBe('open');
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
    ['the estimate is accepted', ({ est }) => trx('estimates').where({ id: est.id }).update({ status: 'accepted', accepted_at: new Date() }), 'was accepted'],
    ['the estimate is declined', ({ est }) => trx('estimates').where({ id: est.id }).update({ status: 'declined', declined_at: new Date() }), 'declined'],
    ['every visit the call booked is cancelled', ({ bookingCallId }) => trx('scheduled_services').where({ source_call_log_id: bookingCallId }).update({ status: 'cancelled' }),
      'off the calendar'],
    ['the customer chooses annual prepay on a later call', ({ customerId }) => call(customerId, 'annual_prepay', { created_at: new Date() }), 'annual prepay'],
    ['the customer asks to cancel on a later call', ({ customerId }) => call(customerId, null, { created_at: new Date() }, 'cancellation_request'),
      'asked to cancel'],
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

  test('gate off: no card', async () => {
    const { bookingCallId } = await phoneYes();
    delete process.env[GATE];
    await expect(sweep()).resolves.toEqual({ skipped: true, scanned: 0, filed: 0, closed: 0 });
    expect(await cards(bookingCallId)).toEqual([]);
  });
});
