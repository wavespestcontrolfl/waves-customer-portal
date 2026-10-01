/**
 * Email asks + staff promises (comms-promises plan PR 1) against an
 * explicitly selected synthetic QA database — same schema-cloning approach
 * as sms-commitments-postgres.test.js, reusing SMS_OPERATIONS_TEST_DATABASE_URL.
 */
jest.mock('../models/db', () => {
  const conn = (...args) => mockPg(...args);
  conn.transaction = (...args) => mockPg.transaction(...args);
  conn.raw = (...args) => mockPg.raw(...args);
  return conn;
});
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((name, work) => work()) }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(),
  // The real done writer: a system close is done, not just read (read is not done).
  _private: { doneColumns: (...args) => jest.requireActual('../services/notification-service')._private.doneColumns(...args) },
}));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { runEmailOperationalActions, refreshEmailCommitments } = require('../services/email-operational-actions');
const { listSmsCommitments, applySmsCommitmentUpdate } = require('../services/sms-operational-actions');
const { replyFulfillment, admissibleWitness } = require('../services/sms-commitment-fulfillment');
const { dispatchWithFallback } = require('../services/llm/call');
const NotificationService = require('../services/notification-service');
const emailMigration = require('../models/migrations/20260929010000_email_operational_actions');
const replayMigration = require('../models/migrations/20260907000021_sms_replay_contact_preference');
const irrigationRevisionMigration = require('../models/migrations/20260907000020_property_irrigation_revision');

const connection = process.env.SMS_OPERATIONS_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `email_commitments_${randomUUID().replaceAll('-', '')}`;
const TABLES = ['customers', 'customer_properties', 'property_preferences', 'sms_log', 'call_log',
  'call_commitments', 'data_hygiene_source_extractions', 'data_hygiene_proposals', 'data_hygiene_sensitive_vault',
  'conversations', 'messages', 'notifications', 'audit_log',
  'emails', 'email_messages', 'estimates', 'estimate_deposits', 'invoices', 'payments', 'payment_methods',
  'payers', 'setup_fee_claims', 'annual_prepay_terms', 'scheduled_services', 'job_status_history',
  'reschedule_log', 'system_settings', 'leads', 'messaging_audit_log'];
let mockPg;
let admin;
let customerId;

jest.setTimeout(60000);

// gmail_id is unique+notNullable; every fixture email gets its own.
const gmailId = () => `qa-${randomUUID()}`;
const insertEmail = (overrides = {}) => mockPg('emails').insert({
  id: randomUUID(), gmail_id: gmailId(), gmail_thread_id: overrides.gmail_thread_id || randomUUID(),
  from_address: 'customer@example.invalid', to_address: 'contact@wavespestcontrol.com',
  // Recipients captured ('' = no Cc/Bcc header); NULL means never captured.
  cc_address: '', bcc_address: '',
  // 20 minutes old by default: staff sends are read only after intake's
  // 15-minute link grace period.
  subject: 'Estimate', body_text: 'Please send the estimate', received_at: new Date(Date.now() - 20 * 60000),
  // Stored 20 minutes ago too: intake and subject history read a row only
  // once its thread has settled (15 minutes after it was stored).
  created_at: new Date(Date.now() - 20 * 60000),
  label_ids: JSON.stringify(['INBOX']), ...overrides,
}).returning('*').then(([row]) => row);

postgres('Email commitments on PostgreSQL', () => {
  beforeAll(async () => {
    if (!/^\/(waves_test|waves_qa_[a-f0-9]+)$/.test(new URL(connection).pathname)) {
      throw new Error('Use an explicitly selected synthetic Waves QA database');
    }
    process.env.DATA_HYGIENE_VAULT_KEY = 'email-operations-synthetic-key';
    admin = knex({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 5 } });
    await admin.raw('CREATE FUNCTION ??.pgp_sym_encrypt(text, text) RETURNS bytea LANGUAGE sql AS $$ SELECT public.pgp_sym_encrypt($1, $2) $$', [schema]);
    await admin.raw('CREATE FUNCTION ??.pgp_sym_decrypt(bytea, text) RETURNS text LANGUAGE sql AS $$ SELECT public.pgp_sym_decrypt($1, $2) $$', [schema]);
    for (const table of TABLES) {
      await admin.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    }
    await irrigationRevisionMigration.up(mockPg);
    await mockPg.transaction((trx) => replayMigration.up(trx));
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    NotificationService.notifyAdmin.mockResolvedValue({ id: randomUUID() });
    for (const table of TABLES) await mockPg(table).delete();
    process.env.GATE_EMAIL_OPERATIONAL_ACTIONS = 'true';
    process.env.GATE_SMS_OPERATIONAL_ACTIONS = 'true';
    process.env.GATE_SMS_COMMITMENT_FOLLOWUP = 'true';
    customerId = randomUUID();
    await mockPg('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      phone: '+12025550101', email: 'customer@example.invalid', address_line1: '100 Example Lane', city: 'Sarasota', zip: '34236' });
    const since = new Date(Date.now() - 3600000).toISOString();
    process.env.GATE_EMAIL_OPERATIONAL_ACTIONS_SINCE = since;
    process.env.GATE_SMS_OPERATIONAL_ACTIONS_SINCE = since;
  });
  afterAll(async () => {
    delete process.env.GATE_EMAIL_OPERATIONAL_ACTIONS;
    delete process.env.GATE_EMAIL_OPERATIONAL_ACTIONS_SINCE;
    delete process.env.GATE_SMS_OPERATIONAL_ACTIONS;
    delete process.env.GATE_SMS_OPERATIONAL_ACTIONS_SINCE;
    delete process.env.GATE_SMS_COMMITMENT_FOLLOWUP;
    delete process.env.DATA_HYGIENE_VAULT_KEY;
    if (mockPg) await mockPg.destroy();
    if (admin) { await admin.schema.dropSchema(schema, { cascade: true }); await admin.destroy(); }
  });

  test('sanity: the migrated schema carries email_id and the 3-way CHECK constraint', async () => {
    const row = await mockPg('call_commitments').insert({ email_id: null, sms_log_id: null, call_log_id: randomUUID(),
      commitment_key: 'x', party: 'waves', kind: 'other', description: 'x', channel: 'call' }).returning('id').catch((e) => e);
    expect(row).toBeTruthy();
  });

  test('intake: an inbound customer_request email becomes an ask (party waves, channel email)', async () => {
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: 'Please send the estimate for my house', subject: 'Estimate' });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [{ party: 'waves', kind: 'send_estimate',
      description: 'send the estimate', quote: 'Please send the estimate for my house', basis: 'request', property_id: null,
      due_text: null, due_at: null, due_date: null, promise_firm: false, answered_by_payment: false }], facts: [], additional_properties: [] } });
    const result = await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    const row = await mockPg('call_commitments').first();
    expect(row).toMatchObject({ email_id: email.id, party: 'waves', kind: 'send_estimate', channel: 'email' });
    expect(row.sms_context).toMatchObject({ channel: 'email', basis: 'request', customer_id: customerId });
    expect((await mockPg('emails').where({ id: email.id }).first()).operational_analysis).toMatchObject({ dropped: 0 });
  });

  test('intake: an emailed payment question keeps the payment-answerable stamp SMS intake writes', async () => {
    const { admissibleWitness } = require('../services/sms-commitment-fulfillment');
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: 'Did my payment go through? And can someone look at the ants', subject: 'Payment' });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [
      { party: 'waves', kind: 'other', description: 'did my payment go through', quote: 'Did my payment go through?',
        basis: 'request', property_id: null, due_text: null, due_at: null, due_date: null, promise_firm: false, answered_by_payment: true },
      { party: 'waves', kind: 'other', description: 'look at the ants', quote: 'can someone look at the ants',
        basis: 'request', property_id: null, due_text: null, due_at: null, due_date: null, promise_firm: false, answered_by_payment: false },
    ], facts: [], additional_properties: [] } });
    await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    const rows = await mockPg('call_commitments').where({ email_id: email.id });
    const payment = rows.find((r) => r.description === 'did my payment go through');
    const ants = rows.find((r) => r.description === 'look at the ants');
    expect(payment.sms_context.money_answerable).toBe(true);
    expect(ants.sms_context.money_answerable).toBe(false);
    const paid = { type: 'payment', ref: 'payment:p1', id: 'p1', text: 'payment succeeded' };
    expect(admissibleWitness(paid, payment, [paid])).toBe(true);
    expect(admissibleWitness(paid, ants, [paid])).toBe(false);
  });

  // Owner diagnostic, 2026-09-29: 6 of 9 real asks in one production week
  // were classified lead_inquiry on an EXISTING customer's reply thread —
  // included here only because customer_id is set; a genuine new lead
  // (customer_id NULL) stays excluded by the same gate, never a separate
  // classification check.
  test('intake: an inbound lead_inquiry email on an EXISTING customer becomes an ask too', async () => {
    const email = await insertEmail({ customer_id: customerId, classification: 'lead_inquiry',
      body_text: 'Does your lawn care include shrub and tree care?', subject: 'Re: Your Waves estimate is ready' });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [{ party: 'waves', kind: 'other',
      description: 'lawn care include shrub and tree care', quote: 'Does your lawn care include shrub and tree care?',
      basis: 'request', property_id: null, due_text: null, due_at: null, due_date: null, promise_firm: false, answered_by_payment: false }],
      facts: [], additional_properties: [] } });
    const result = await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    const row = await mockPg('call_commitments').where({ email_id: email.id }).first();
    expect(row).toMatchObject({ party: 'waves', channel: 'email' });
  });

  test('intake: a lead_inquiry email with NO customer_id (a genuine new lead) is never tracked as an ask', async () => {
    const email = await insertEmail({ customer_id: null, classification: 'lead_inquiry',
      body_text: 'I would like a quote please. 123 Test Ave, Sarasota FL', subject: 'New inquiry' });
    const result = await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(result).toMatchObject({ processed: 0, failed: 0 });
    expect(await mockPg('call_commitments').where({ email_id: email.id })).toHaveLength(0);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  // Coordinator diagnostic, 2026-09-29: email intake
  // always passed properties: [] to the extractor, so property_id could
  // never ground and an unscoped send_estimate ask could never be closed by
  // a delivered estimate (scopedToProperty refuses an unscoped one for that
  // record type). Full pipeline: intake stamps the property, then a
  // delivered estimate for that SAME property closes it end to end.
  test('property fix: a single-property customer\'s emailed quote ask closes on a delivered estimate for that property', async () => {
    const [property] = await mockPg('customer_properties').insert({ customer_id: customerId,
      address_line1: '100 Example Lane', city: 'Sarasota', zip: '34236', active: true }).returning('*');
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: 'Yes I would like a quote please', subject: 'Re: your estimate' });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [{ party: 'waves', kind: 'send_estimate',
      description: 'would like a quote', quote: 'Yes I would like a quote please', basis: 'request', property_id: property.id,
      due_text: null, due_at: null, due_date: null, promise_firm: false, answered_by_payment: false }], facts: [], additional_properties: [] } });
    const intake = await runEmailOperationalActions({ conn: mockPg, now: new Date(email.received_at.getTime() + 1000) });
    expect(intake).toMatchObject({ processed: 1, failed: 0 });
    const commitment = await mockPg('call_commitments').first();
    expect(commitment).toMatchObject({ kind: 'send_estimate' });
    // The fix under test: the model-named property, grounded against the
    // customer's own SOLE active property, actually reaches sms_context —
    // not silently dropped to null as it always was before this fix.
    expect(commitment.sms_context).toMatchObject({ property_id: property.id });
    const deliveredAt = new Date(email.received_at.getTime() + 10 * 60000);
    const [estimate] = await mockPg('estimates').insert({ customer_id: customerId, property_id: property.id,
      status: 'sent', service_interest: 'Lawn Care', estimate_data: { deliveryState: { lastDeliveredAt: deliveredAt.toISOString() } } }).returning('id');
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { verdict: 'fulfilled', record_ref: `estimate:${estimate.id}`, quote: 'Lawn Care' } });
    // By design (module header: "an email-sourced obligation is only
    // checked once its deadline has passed") a send_estimate ask with no
    // stated timing gets R5's 24h default (resolveDueDeadline) and is never
    // scanned before then, even with an early witness already on record —
    // the first tick after due_at is where the early delivery is picked up.
    const refresh = await refreshEmailCommitments({ conn: mockPg, now: new Date(commitment.due_at.getTime() + 60000) });
    expect(refresh).toMatchObject({ scanned: 1, fulfilled: 1 });
    expect((await mockPg('call_commitments').first())).toMatchObject({ status: 'fulfilled' });
  });

  test('a new lead asks for a quote before any property exists; the one property created later scopes the check', async () => {
    const email = await insertEmail({ customer_id: customerId, classification: 'lead_inquiry',
      body_text: 'Yes I would like a quote please', subject: 'Re: thanks for reaching out' });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [{ party: 'waves', kind: 'send_estimate',
      description: 'would like a quote', quote: 'Yes I would like a quote please', basis: 'request', property_id: null,
      due_text: null, due_at: null, due_date: null, promise_firm: false, answered_by_payment: false }], facts: [], additional_properties: [] } });
    await runEmailOperationalActions({ conn: mockPg, now: new Date(email.received_at.getTime() + 1000) });
    const commitment = await mockPg('call_commitments').first();
    expect(commitment.sms_context.property_id ?? null).toBeNull();
    // Accepting the estimate creates the property after the email arrived.
    const [property] = await mockPg('customer_properties').insert({ customer_id: customerId,
      address_line1: '100 Example Lane', city: 'Sarasota', zip: '34236', active: true }).returning('*');
    const deliveredAt = new Date(email.received_at.getTime() + 10 * 60000);
    const [estimate] = await mockPg('estimates').insert({ customer_id: customerId, property_id: property.id,
      status: 'accepted', service_interest: 'Pest Control', estimate_data: { deliveryState: { lastDeliveredAt: deliveredAt.toISOString() } } }).returning('id');
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { verdict: 'fulfilled', record_ref: `estimate:${estimate.id}`, quote: 'Pest Control' } });
    const refresh = await refreshEmailCommitments({ conn: mockPg, now: new Date(commitment.due_at.getTime() + 60000) });
    expect(refresh).toMatchObject({ scanned: 1, fulfilled: 1 });
    const closed = await mockPg('call_commitments').first();
    expect(closed).toMatchObject({ status: 'fulfilled' });
    expect(closed.sms_context).toMatchObject({ property_id: property.id, property_adopted: true });
  });

  test('an ask left unscoped because intake saw two properties never adopts the one left after the other is deactivated', async () => {
    const [first, second] = await mockPg('customer_properties').insert([
      { customer_id: customerId, address_line1: '100 Example Lane', city: 'Sarasota', zip: '34236', active: true },
      { customer_id: customerId, address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236', active: true },
    ]).returning('*');
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: 'Can I get a quote please', subject: 'Quote' });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [{ party: 'waves', kind: 'send_estimate',
      description: 'a quote', quote: 'Can I get a quote please', basis: 'request', property_id: null,
      due_text: null, due_at: null, due_date: null, promise_firm: false, answered_by_payment: false }], facts: [], additional_properties: [] } });
    await runEmailOperationalActions({ conn: mockPg, now: new Date(email.received_at.getTime() + 1000) });
    const commitment = await mockPg('call_commitments').first();
    expect(commitment.sms_context).toMatchObject({ properties_at_intake: 2 });
    await mockPg('customer_properties').where({ id: second.id }).update({ active: false });
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    await refreshEmailCommitments({ conn: mockPg, now: new Date(commitment.due_at.getTime() + 60000) });
    const after = await mockPg('call_commitments').first();
    expect(after.sms_context.property_id ?? null).toBeNull();
    expect(after.sms_context.property_adopted).toBeUndefined();
    expect(first.id).toBeTruthy();
  });

  test('an unscoped ask is never given a property when the customer now has two', async () => {
    const email = await insertEmail({ customer_id: customerId, classification: 'lead_inquiry', body_text: 'Yes I would like a quote please' });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [{ party: 'waves', kind: 'send_estimate',
      description: 'would like a quote', quote: 'Yes I would like a quote please', basis: 'request', property_id: null,
      due_text: null, due_at: null, due_date: null, promise_firm: false, answered_by_payment: false }], facts: [], additional_properties: [] } });
    await runEmailOperationalActions({ conn: mockPg, now: new Date(email.received_at.getTime() + 1000) });
    const commitment = await mockPg('call_commitments').first();
    await mockPg('customer_properties').insert([
      { customer_id: customerId, address_line1: '100 Example Lane', city: 'Sarasota', zip: '34236', active: true },
      { customer_id: customerId, address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236', active: true }]);
    await refreshEmailCommitments({ conn: mockPg, now: new Date(commitment.due_at.getTime() + 60000) });
    const row = await mockPg('call_commitments').first();
    expect(row.status).toBe('open');
    expect(row.sms_context.property_id ?? null).toBeNull();
  });

  // Same rule as SMS's own belt-and-suspenders check (sms-operational-actions.js
  // ~L569): a property is stamped only when it is the customer's SOLE active
  // property AND the model actually named that exact id — never guessed
  // among several, even when the model (or, as here, a hand-built extraction
  // bypassing groundExtraction's own redundant null-out) names one.
  test('property fix: a two-property customer\'s ask never gets a guessed property_id', async () => {
    const { recordEmailOperations } = require('../services/email-operational-actions');
    const [p1] = await mockPg('customer_properties').insert({ customer_id: customerId,
      address_line1: '100 Example Lane', city: 'Sarasota', zip: '34236', active: true }).returning('*');
    const [p2] = await mockPg('customer_properties').insert({ customer_id: customerId,
      address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236', active: true }).returning('*');
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: 'Please send a quote for my 100 Example Lane house' });
    const extracted = { dropped: 0, facts: [], obligations: [{ party: 'waves', kind: 'send_estimate', description: 'send a quote',
      quote: email.body_text, basis: 'request', property_id: p1.id, due_text: null, due_at: null, due_date: null,
      promise_firm: false, answered_by_payment: false }] };
    const outcome = await recordEmailOperations(mockPg, email, extracted, { properties: [p1, p2] });
    expect(outcome).toMatchObject({ recorded: 1 });
    const row = await mockPg('call_commitments').first();
    expect(row.sms_context).toMatchObject({ property_id: null });
  });

  test('intake: a person-sent Gmail SENT reply, threaded to a customer-linked inbound email, becomes a staff promise', async () => {
    const inbound = await insertEmail({ customer_id: customerId, classification: 'customer_request' });
    const sent = await insertEmail({ gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid',
      from_address: 'contact@wavespestcontrol.com', body_text: "I'll send the estimate tomorrow", customer_id: null,
      classification: null, label_ids: JSON.stringify(['SENT']) });
    // Two candidate rows this tick (the inbound ask AND the SENT reply), so
    // two dispatchWithFallback calls: the ask row first (intake order),
    // then the promise row.
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [], facts: [], additional_properties: [] } });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [{ party: 'waves', kind: 'send_estimate',
      description: 'send the estimate', quote: "I'll send the estimate tomorrow", basis: 'promise', property_id: null,
      due_text: 'tomorrow', due_at: null, due_date: null, promise_firm: true, answered_by_payment: false }], facts: [], additional_properties: [] } });
    const result = await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(result).toMatchObject({ processed: 2, failed: 0 }); // the inbound row is also read as an ask candidate
    const promiseRow = await mockPg('call_commitments').where({ email_id: sent.id }).first();
    expect(promiseRow).toMatchObject({ party: 'waves', channel: 'email' });
    expect(promiseRow.sms_context).toMatchObject({ basis: 'promise', customer_id: customerId });
    expect(promiseRow.email_customer_id).toBe(customerId);
  });

  test('an HTML-only staff send (portal Email tab / Intelligence Bar) is read from body_html, without its quoted thread', async () => {
    const inbound = await insertEmail({ customer_id: customerId, classification: 'customer_request' });
    const sent = await insertEmail({ gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid',
      from_address: 'contact@wavespestcontrol.com', body_text: '', customer_id: null, classification: null,
      body_html: '<div>I&#39;ll send the estimate tomorrow</div><div class="gmail_quote">On Tue wrote:<blockquote>quoted older request</blockquote></div>',
      label_ids: JSON.stringify(['SENT']) });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [], facts: [], additional_properties: [] } });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [{ party: 'waves', kind: 'send_estimate',
      description: 'send the estimate', quote: "I'll send the estimate tomorrow", basis: 'promise', property_id: null,
      due_text: 'tomorrow', due_at: null, due_date: null, promise_firm: true, answered_by_payment: false }], facts: [], additional_properties: [] } });
    await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    const sentPrompt = JSON.stringify(dispatchWithFallback.mock.calls[1]);
    expect(sentPrompt).toContain("I'll send the estimate tomorrow");
    expect(sentPrompt).not.toContain('quoted older request');
    expect(await mockPg('call_commitments').where({ email_id: sent.id }).first()).toMatchObject({ party: 'waves', channel: 'email' });
  });

  test('a staff send newer than the 15-minute link grace period is not read yet', async () => {
    const inbound = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      received_at: new Date(Date.now() - 30 * 60000) });
    const sent = await insertEmail({ gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid',
      from_address: 'contact@wavespestcontrol.com', body_text: "I'll send the estimate tomorrow", customer_id: null,
      classification: null, label_ids: JSON.stringify(['SENT']), received_at: new Date(Date.now() - 5 * 60000) });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [], facts: [], additional_properties: [] } });
    await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1); // the inbound ask only
    expect((await mockPg('emails').where({ id: sent.id }).first()).operational_analysis).toBeNull();
  });

  test('an email-sourced row counts a staff call to any of the customer\'s numbers; a text row still matches its own number', async () => {
    const { loadSmsFulfillmentEvidence } = require('../services/sms-commitment-fulfillment');
    const sourceAt = new Date(Date.now() - 60 * 60000);
    const [call] = await mockPg('call_log').insert({ id: randomUUID(), customer_id: customerId, direction: 'outbound',
      from_phone: '+19418889999', to_phone: '+12025557777', status: 'completed', duration_seconds: 120,
      created_at: new Date(sourceAt.getTime() + 60000) }).returning('*');
    const message = { id: randomUUID(), customer_id: customerId, direction: 'inbound', created_at: sourceAt,
      from_phone: '+12025550101', to_phone: '+12025550101' };
    const commitment = { kind: 'callback', party: 'waves', sms_context: { basis: 'request', customer_id: customerId } };
    const emailEvidence = await loadSmsFulfillmentEvidence(mockPg, commitment, { ...message, any_customer_phone: true }, new Date());
    expect(emailEvidence.records.some((r) => r.type === 'call' && r.id === call.id)).toBe(true);
    const smsEvidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, new Date());
    expect(smsEvidence.records.some((r) => r.type === 'call')).toBe(false);
  });

  test('an adopted sole property is re-read under the lock: a second property added mid-check leaves the row for the next tick', async () => {
    const email = await insertEmail({ customer_id: customerId, classification: 'lead_inquiry',
      body_text: 'Yes I would like a quote please', subject: 'Re: thanks for reaching out' });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [{ party: 'waves', kind: 'send_estimate',
      description: 'would like a quote', quote: 'Yes I would like a quote please', basis: 'request', property_id: null,
      due_text: null, due_at: null, due_date: null, promise_firm: false, answered_by_payment: false }], facts: [], additional_properties: [] } });
    await runEmailOperationalActions({ conn: mockPg, now: new Date(email.received_at.getTime() + 1000) });
    const commitment = await mockPg('call_commitments').first();
    const [property] = await mockPg('customer_properties').insert({ customer_id: customerId,
      address_line1: '100 Example Lane', city: 'Sarasota', zip: '34236', active: true }).returning('*');
    const deliveredAt = new Date(email.received_at.getTime() + 10 * 60000);
    const [estimate] = await mockPg('estimates').insert({ customer_id: customerId, property_id: property.id,
      status: 'accepted', service_interest: 'Pest Control', estimate_data: { deliveryState: { lastDeliveredAt: deliveredAt.toISOString() } } }).returning('id');
    dispatchWithFallback.mockImplementationOnce(async () => {
      await mockPg('customer_properties').insert({ customer_id: customerId, address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236', active: true });
      return { ok: true, json: { verdict: 'fulfilled', record_ref: `estimate:${estimate.id}`, quote: 'Pest Control' } };
    });
    const refresh = await refreshEmailCommitments({ conn: mockPg, now: new Date(commitment.due_at.getTime() + 60000) });
    expect(refresh).toMatchObject({ scanned: 1, fulfilled: 0 });
    // The verifier is told a person's matched email reply is an answer too.
    expect(JSON.stringify(dispatchWithFallback.mock.calls.at(-1))).toContain('or an email_reply record');
    const after = await mockPg('call_commitments').first();
    expect(after.status).toBe('open');
    expect(after.sms_context.fulfillment_check).toBeUndefined();
    expect(after.sms_context.property_id ?? null).toBeNull();
  });

  test('an adoption stored on the row keeps being checked on later ticks', async () => {
    const email = await insertEmail({ customer_id: customerId, classification: 'lead_inquiry',
      body_text: 'Yes I would like a quote please', subject: 'Re: thanks for reaching out' });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [{ party: 'waves', kind: 'send_estimate',
      description: 'would like a quote', quote: 'Yes I would like a quote please', basis: 'request', property_id: null,
      due_text: null, due_at: null, due_date: null, promise_firm: false, answered_by_payment: false }], facts: [], additional_properties: [] } });
    await runEmailOperationalActions({ conn: mockPg, now: new Date(email.received_at.getTime() + 1000) });
    const commitment = await mockPg('call_commitments').first();
    const [property] = await mockPg('customer_properties').insert({ customer_id: customerId,
      address_line1: '100 Example Lane', city: 'Sarasota', zip: '34236', active: true }).returning('*');
    // First tick: no witness yet, the deadline has passed → bell, and the adoption is stored.
    const first = new Date(commitment.due_at.getTime() + 60000);
    await refreshEmailCommitments({ conn: mockPg, now: first });
    expect((await mockPg('call_commitments').first()).sms_context).toMatchObject({ property_id: property.id, property_adopted: true });
    // Later: the estimate is delivered; the next tick must still check and close it.
    const [estimate] = await mockPg('estimates').insert({ customer_id: customerId, property_id: property.id,
      status: 'accepted', service_interest: 'Pest Control', estimate_data: { deliveryState: { lastDeliveredAt: new Date(first.getTime() + 60000).toISOString() } } }).returning('id');
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { verdict: 'fulfilled', record_ref: `estimate:${estimate.id}`, quote: 'Pest Control' } });
    const refresh = await refreshEmailCommitments({ conn: mockPg, now: new Date(first.getTime() + 3 * 60000) });
    expect(refresh).toMatchObject({ scanned: 1, fulfilled: 1 });
    expect((await mockPg('call_commitments').first()).status).toBe('fulfilled');
  });

  test('an inbound email keeps only asks made of Waves — the customer\'s own promise is not tracked', async () => {
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: "Please schedule Friday; I'll send the photos", subject: 'Schedule' });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [
      { party: 'waves', kind: 'schedule_visit', description: 'Please schedule Friday', quote: 'Please schedule Friday',
        basis: 'request', property_id: null, due_text: 'Friday', due_at: null, due_date: null, promise_firm: false, answered_by_payment: false },
      { party: 'customer', kind: 'send_photos', description: "I'll send the photos", quote: "I'll send the photos",
        basis: 'promise', property_id: null, due_text: null, due_at: null, due_date: null, promise_firm: true, answered_by_payment: false },
    ], facts: [], additional_properties: [] } });
    await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    const rows = await mockPg('call_commitments').where({ email_id: email.id });
    expect(rows.map((r) => r.party)).toEqual(['waves']);
  });

  test('a property added while the model reads the email leaves it for the next tick (no stale scope stamped)', async () => {
    const [property] = await mockPg('customer_properties').insert({ customer_id: customerId,
      address_line1: '100 Example Lane', city: 'Sarasota', zip: '34236', active: true }).returning('*');
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: 'Can I get a quote please', subject: 'Quote' });
    dispatchWithFallback.mockImplementationOnce(async () => {
      await mockPg('customer_properties').insert({ customer_id: customerId, address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236', active: true });
      return { ok: true, json: { obligations: [{ party: 'waves', kind: 'send_estimate', description: 'a quote',
        quote: 'Can I get a quote please', basis: 'request', property_id: property.id, due_text: null, due_at: null,
        due_date: null, promise_firm: false, answered_by_payment: false }], facts: [], additional_properties: [] } };
    });
    await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(await mockPg('call_commitments').where({ email_id: email.id })).toHaveLength(0);
    expect((await mockPg('emails').where({ id: email.id }).first()).operational_analysis).toBeNull();
  });

  test('rejected thread sends never crowd a valid older staff reply out of the evidence window', async () => {
    const { loadSmsFulfillmentEvidence } = require('../services/sms-commitment-fulfillment');
    const sourceAt = new Date(Date.now() - 3 * 3600000);
    process.env.GATE_EMAIL_OPERATIONAL_ACTIONS_SINCE = new Date(sourceAt.getTime() - 3600000).toISOString();
    const inbound = await insertEmail({ customer_id: customerId, classification: 'customer_request', received_at: new Date(sourceAt.getTime() - 60000) });
    const reply = await insertEmail({ gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid',
      from_address: 'contact@wavespestcontrol.com', customer_id: null, classification: null, body_text: 'Yes, booked you for Friday',
      label_ids: JSON.stringify(['SENT']), received_at: new Date(sourceAt.getTime() + 60000) });
    await mockPg('emails').insert(Array.from({ length: 55 }, (_, i) => ({ id: randomUUID(), gmail_id: gmailId(),
      gmail_thread_id: inbound.gmail_thread_id, from_address: 'contact@wavespestcontrol.com', to_address: 'office@wavespestcontrol.com',
      subject: 'Fwd', body_text: `internal note ${i}`, label_ids: JSON.stringify(['SENT']), received_at: new Date(sourceAt.getTime() + (2 + i) * 60000) })));
    const message = { id: randomUUID(), customer_id: customerId, direction: 'inbound', created_at: sourceAt,
      from_phone: '+12025550101', to_phone: '+12025550101', any_customer_phone: true };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, { kind: 'other', party: 'waves', sms_context: { basis: 'request' } }, message, new Date());
    expect(evidence.records.filter((r) => r.type === 'email_reply').map((r) => r.id)).toEqual([reply.id]);
    expect(evidence.failures).not.toContain('email_reply_truncated');
  });

  test('a staff promise follows a customer merge (email_customer_id is repointed; the jsonb snapshot is not)', async () => {
    const inbound = await insertEmail({ customer_id: customerId, classification: 'customer_request' });
    const sent = await insertEmail({ gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid',
      from_address: 'contact@wavespestcontrol.com', body_text: "I'll send the estimate tomorrow", customer_id: null,
      classification: null, label_ids: JSON.stringify(['SENT']) });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [], facts: [], additional_properties: [] } });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [{ party: 'waves', kind: 'send_estimate',
      description: 'send the estimate', quote: "I'll send the estimate tomorrow", basis: 'promise', property_id: null,
      due_text: 'tomorrow', due_at: null, due_date: null, promise_firm: true, answered_by_payment: false }], facts: [], additional_properties: [] } });
    await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    // What customer-dedupe's merge does: every *_customer_id column (and
    // emails.customer_id) moves to the winner, the loser is soft-deleted,
    // and the jsonb snapshot is left naming the loser.
    const winnerId = randomUUID();
    await mockPg('customers').insert({ id: winnerId, first_name: 'Winner', last_name: 'Fixture',
      phone: '+12025550102', email: 'winner@example.invalid', address_line1: '100 Example Lane', city: 'Sarasota', zip: '34236' });
    await mockPg('emails').where({ customer_id: customerId }).update({ customer_id: winnerId });
    await mockPg('call_commitments').where({ email_customer_id: customerId }).update({ email_customer_id: winnerId });
    await mockPg('customers').where({ id: customerId }).update({ deleted_at: new Date() });
    const promiseRow = await mockPg('call_commitments').where({ email_id: sent.id }).first();
    expect(promiseRow.sms_context.customer_id).toBe(customerId);
    const now = new Date();
    await mockPg('call_commitments').where({ id: promiseRow.id }).update({ due_at: new Date(now.getTime() - 3600000) });
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    const refresh = await refreshEmailCommitments({ conn: mockPg, now });
    expect(refresh.scanned).toBe(1);
    const after = await mockPg('call_commitments').where({ id: promiseRow.id }).first();
    expect(after.sms_context.customer_id).toBe(winnerId);
  });

  // Coordinator correction #2, 2026-09-29 (BUG): a provider outage used to
  // markSeen on the FIRST failure, dropping the email forever with nobody
  // ever knowing. Now it goes through the same receipt-store retry/backoff
  // as the SMS lane: operational_analysis stays NULL while retrying, and
  // only the terminal (3rd) failure marks it seen AND rings a bell.
  test('fix 2: a provider failure is retried on the next tick, and a terminal failure rings once', async () => {
    const actualNotifications = jest.requireActual('../services/notification-service');
    NotificationService.notifyAdmin.mockImplementation(actualNotifications.notifyAdmin.bind(actualNotifications));
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: 'Please send the estimate for my house' });
    dispatchWithFallback.mockRejectedValueOnce(new Error('provider down'));
    const first = await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(first).toMatchObject({ processed: 0, failed: 1 });
    let stored = await mockPg('emails').where({ id: email.id }).first('operational_analysis');
    expect(stored.operational_analysis).toBeNull(); // still retrying — never marked seen yet
    let receipt = await mockPg('data_hygiene_source_extractions').where({ source_type: 'email', source_id: email.id }).first();
    expect(receipt).toMatchObject({ status: 'failed', attempt_count: 1 });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();

    dispatchWithFallback.mockRejectedValueOnce(new Error('provider down'));
    const second = await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(second).toMatchObject({ processed: 0, failed: 1 });
    receipt = await mockPg('data_hygiene_source_extractions').where({ source_type: 'email', source_id: email.id }).first();
    expect(receipt).toMatchObject({ status: 'failed', attempt_count: 2 });
    stored = await mockPg('emails').where({ id: email.id }).first('operational_analysis');
    expect(stored.operational_analysis).toBeNull();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();

    // Third failure hits the retry cap (attempt_count + 1 >= 3): terminal.
    dispatchWithFallback.mockRejectedValueOnce(new Error('provider down'));
    const third = await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(third).toMatchObject({ processed: 0, failed: 1 });
    receipt = await mockPg('data_hygiene_source_extractions').where({ source_type: 'email', source_id: email.id }).first();
    expect(receipt).toMatchObject({ status: 'failed_max_retries', attempt_count: 3 });
    stored = await mockPg('emails').where({ id: email.id }).first('operational_analysis');
    expect(stored.operational_analysis).toMatchObject({ error: true, terminal: true });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('alert', 'An email needs a manual review',
      expect.any(String), expect.objectContaining({ bell: true, dedupeKey: `email-operations-failed:${email.id}` }));

    // A fourth tick never retries it again — excluded by BOTH the terminal
    // receipt AND its now-non-null operational_analysis.
    dispatchWithFallback.mockClear();
    const fourth = await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(fourth).toMatchObject({ processed: 0, failed: 0, skipped: 0 });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a SENT row to a non-customer address (SEO outreach shape) never resolves — no commitment, marked seen', async () => {
    const sent = await insertEmail({ to_address: 'prospect@somewebsite.invalid', from_address: 'contact@wavespestcontrol.com',
      body_text: 'We loved your article and would like to collaborate.', customer_id: null, classification: null,
      label_ids: JSON.stringify(['SENT']) });
    const result = await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(result.processed).toBe(0);
    expect(await mockPg('call_commitments')).toHaveLength(0);
    expect((await mockPg('emails').where({ id: sent.id }).first()).operational_analysis).toMatchObject({ skipped: 'no_customer_link' });
  });

  test('D1 (owner ruling 2026-09-28): a staff email reply closes an SMS-sourced general ask', async () => {
    const sourceAt = new Date();
    const [smsRow] = await mockPg('sms_log').insert({ id: randomUUID(), customer_id: customerId, direction: 'inbound',
      message_body: 'Did you come to my house today?', from_phone: '+12025550101', to_phone: '+19418889999',
      created_at: sourceAt, status: 'received' }).returning('*');
    const [commitment] = await mockPg('call_commitments').insert({ sms_log_id: smsRow.id, commitment_key: 'waves:other:ask1',
      party: 'waves', kind: 'other', description: 'Did you come to my house today?', channel: 'sms',
      due_at: null, due_basis: null, source: 'ai', extractor_version: 'sms-ops-v22',
      evidence: JSON.stringify([{ quote: 'Did you come to my house today?', sms_log_id: smsRow.id, matched: true, speaker: 'caller' }]),
      sms_context: { basis: 'request', due_text: null, property_id: null, customer_id: customerId, source_at: sourceAt.toISOString() } })
      .returning('*');
    // The reply, minutes later, threaded to an inbound email already linked
    // to this customer (thread-based resolution, email-customer-link.js).
    const inbound = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      received_at: new Date(sourceAt.getTime() - 60000) });
    const reply = await insertEmail({ gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid',
      from_address: 'contact@wavespestcontrol.com', customer_id: null, classification: null,
      body_text: 'Yes, all done — thanks!', label_ids: JSON.stringify(['SENT']),
      received_at: new Date(sourceAt.getTime() + 60000) });
    const result = await refreshEmailCommitments({ conn: mockPg, now: new Date(reply.received_at.getTime() + 2000) });
    expect(result).toMatchObject({ fulfilled: 0 }); // this sweep only reads call_commitments.email_id rows
    // Prove the underlying mechanism directly: replyFulfillment sees the
    // email_reply witness for the SMS-sourced ask.
    const { loadSmsFulfillmentEvidence } = require('../services/sms-commitment-fulfillment');
    const message = { id: smsRow.id, customer_id: customerId, direction: 'inbound', from_phone: '+12025550101', to_phone: '+19418889999', created_at: sourceAt };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, new Date(reply.received_at.getTime() + 2000));
    expect(evidence.records.some((r) => r.type === 'email_reply' && r.id === reply.id)).toBe(true);
    const fulfillment = replyFulfillment(evidence, commitment);
    expect(fulfillment).toMatchObject({ verdict: 'fulfilled', record_type: 'email_reply', record_id: reply.id, basis: 'person_reply' });
  });

  test('a reply with no body words counts only when its subject is new text, never the thread subject behind Re:', async () => {
    const { loadSmsFulfillmentEvidence } = require('../services/sms-commitment-fulfillment');
    const sourceAt = new Date(Date.now() - 10 * 60000);
    const inbound = await insertEmail({ customer_id: customerId, classification: 'customer_request', subject: 'Please reschedule Friday',
      received_at: new Date(sourceAt.getTime() - 60000) });
    const sent = (subject, minutes) => insertEmail({ gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid',
      from_address: 'contact@wavespestcontrol.com', customer_id: null, classification: null, subject, body_text: '',
      label_ids: JSON.stringify(['SENT']), received_at: new Date(sourceAt.getTime() + minutes * 60000) });
    const echo = await sent('Re: Please reschedule Friday', 1);
    const answer = await sent('Re: Booked you for Monday 9am', 2);
    const message = { id: randomUUID(), customer_id: customerId, direction: 'inbound', created_at: sourceAt,
      from_phone: '+12025550101', to_phone: '+12025550101', any_customer_phone: true };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, { kind: 'other', party: 'waves', sms_context: { basis: 'request' } }, message, new Date());
    const replies = evidence.records.filter((r) => r.type === 'email_reply');
    expect(replies.map((r) => r.id)).toEqual([answer.id]);
    expect(replies[0].text).toBe('Subject: Booked you for Monday 9am');
    expect(replies.some((r) => r.id === echo.id)).toBe(false);
  });

  test('a reply with body words still carries a new subject as evidence', async () => {
    const { loadSmsFulfillmentEvidence } = require('../services/sms-commitment-fulfillment');
    const sourceAt = new Date(Date.now() - 10 * 60000);
    const inbound = await insertEmail({ customer_id: customerId, classification: 'customer_request', subject: 'Please reschedule Friday',
      received_at: new Date(sourceAt.getTime() - 60000) });
    const answer = await insertEmail({ gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid',
      from_address: 'contact@wavespestcontrol.com', customer_id: null, classification: null, subject: 'Re: Booked you for Monday 9am',
      body_text: 'Thanks', label_ids: JSON.stringify(['SENT']), received_at: new Date(sourceAt.getTime() + 60000) });
    const message = { id: randomUUID(), customer_id: customerId, direction: 'inbound', created_at: sourceAt,
      from_phone: '+12025550101', to_phone: '+12025550101', any_customer_phone: true };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, { kind: 'other', party: 'waves', sms_context: { basis: 'request' } }, message, new Date());
    const reply = evidence.records.find((r) => r.type === 'email_reply' && r.id === answer.id);
    expect(reply.text).toBe('Subject: Booked you for Monday 9am\nThanks');
  });

  test('a subject first carried deep in a long thread is still no new text when a later reply repeats it', async () => {
    const { ownSubjectsInThreads } = require('../services/email/email-strip');
    const threadId = randomUUID();
    const start = Date.now() - 3 * 3600000;
    for (let i = 0; i < 60; i += 1) {
      await insertEmail({ gmail_thread_id: threadId, subject: 'Re: Estimate', received_at: new Date(start + i * 60000) });
    }
    await insertEmail({ gmail_thread_id: threadId, subject: 'Booked you for Monday 9am', received_at: new Date(start + 61 * 60000) });
    const echo = await insertEmail({ gmail_thread_id: threadId, subject: 'Re: Booked you for Monday 9am', received_at: new Date(start + 62 * 60000) });
    expect((await ownSubjectsInThreads(mockPg, [echo])).get(echo.id)).toBe('');
  });

  test('a row stored under 15 minutes ago waits for its thread to settle: not read by intake, its subject not new yet', async () => {
    const { ownSubjectsInThreads } = require('../services/email/email-strip');
    const fresh = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: '', subject: 'Please reschedule Friday', created_at: new Date() });
    const result = await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(result).toMatchObject({ processed: 0 });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect((await ownSubjectsInThreads(mockPg, [fresh])).get(fresh.id)).toBe('');
    await mockPg('emails').where({ id: fresh.id }).update({ created_at: new Date(Date.now() - 20 * 60000) });
    expect((await ownSubjectsInThreads(mockPg, [fresh])).get(fresh.id)).toBe('Please reschedule Friday');
  });

  test('an unsent draft is no earlier message: the sent subject stays new', async () => {
    const { ownSubjectsInThreads } = require('../services/email/email-strip');
    const threadId = randomUUID();
    const start = Date.now() - 3 * 3600000;
    await insertEmail({ gmail_thread_id: threadId, subject: 'Booked you for Friday', label_ids: JSON.stringify(['DRAFT']),
      received_at: new Date(start) });
    const sent = await insertEmail({ gmail_thread_id: threadId, subject: 'Booked you for Friday', label_ids: JSON.stringify(['SENT']),
      received_at: new Date(start + 60000) });
    expect((await ownSubjectsInThreads(mockPg, [sent])).get(sent.id)).toBe('Booked you for Friday');
  });

  test('with the email gate off, a staff Gmail reply is no evidence for a live SMS ask (dark launch)', async () => {
    const sourceAt = new Date();
    const inbound = await insertEmail({ customer_id: customerId, classification: 'customer_request', received_at: new Date(sourceAt.getTime() - 60000) });
    const reply = await insertEmail({ gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid',
      from_address: 'contact@wavespestcontrol.com', customer_id: null, classification: null, body_text: 'Yes, all done — thanks!',
      label_ids: JSON.stringify(['SENT']), received_at: new Date(sourceAt.getTime() + 60000) });
    const { loadSmsFulfillmentEvidence } = require('../services/sms-commitment-fulfillment');
    const message = { id: randomUUID(), customer_id: customerId, direction: 'inbound', from_phone: '+12025550101', to_phone: '+19418889999', created_at: sourceAt };
    const commitment = { kind: 'other', party: 'waves', sms_context: { basis: 'request' } };
    const at = new Date(reply.received_at.getTime() + 2000);
    process.env.GATE_EMAIL_OPERATIONAL_ACTIONS = 'false';
    expect((await loadSmsFulfillmentEvidence(mockPg, commitment, message, at)).records.some((r) => r.type === 'email_reply')).toBe(false);
    process.env.GATE_EMAIL_OPERATIONAL_ACTIONS = 'true';
    delete process.env.GATE_EMAIL_OPERATIONAL_ACTIONS_SINCE;
    expect((await loadSmsFulfillmentEvidence(mockPg, commitment, message, at)).records.some((r) => r.type === 'email_reply')).toBe(false);
    process.env.GATE_EMAIL_OPERATIONAL_ACTIONS_SINCE = new Date(reply.received_at.getTime() + 1000).toISOString();
    expect((await loadSmsFulfillmentEvidence(mockPg, commitment, message, at)).records.some((r) => r.type === 'email_reply')).toBe(false);
    process.env.GATE_EMAIL_OPERATIONAL_ACTIONS_SINCE = new Date(sourceAt.getTime() - 3600000).toISOString();
    expect((await loadSmsFulfillmentEvidence(mockPg, commitment, message, at)).records.some((r) => r.type === 'email_reply' && r.id === reply.id)).toBe(true);
  });

  test('a staff send with no words of its own (only quoted history) is not a reply witness', async () => {
    const sourceAt = new Date();
    const [smsRow] = await mockPg('sms_log').insert({ id: randomUUID(), customer_id: customerId, direction: 'inbound',
      message_body: 'Can someone call me?', from_phone: '+12025550101', to_phone: '+19418889999',
      created_at: sourceAt, status: 'received' }).returning('*');
    const [commitment] = await mockPg('call_commitments').insert({ sms_log_id: smsRow.id, commitment_key: 'waves:other:ask-empty',
      party: 'waves', kind: 'other', description: 'Can someone call me?', channel: 'sms',
      due_at: null, due_basis: null, source: 'ai', extractor_version: 'sms-ops-v22',
      evidence: JSON.stringify([{ quote: 'Can someone call me?', sms_log_id: smsRow.id, matched: true, speaker: 'caller' }]),
      sms_context: { basis: 'request', due_text: null, property_id: null, customer_id: customerId, source_at: sourceAt.toISOString() } })
      .returning('*');
    const inbound = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      received_at: new Date(sourceAt.getTime() - 60000) });
    const forward = await insertEmail({ gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid',
      from_address: 'contact@wavespestcontrol.com', customer_id: null, classification: null,
      body_text: 'On Tue, Sep 22, 2026 at 3:21 PM, Jane <customer@example.invalid> wrote: Can someone call me?',
      label_ids: JSON.stringify(['SENT']), received_at: new Date(sourceAt.getTime() + 60000) });
    const { loadSmsFulfillmentEvidence } = require('../services/sms-commitment-fulfillment');
    const message = { id: smsRow.id, customer_id: customerId, direction: 'inbound', from_phone: '+12025550101', to_phone: '+19418889999', created_at: sourceAt };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, new Date(forward.received_at.getTime() + 2000));
    expect(evidence.records.some((r) => r.type === 'email_reply')).toBe(false);
    expect(replyFulfillment(evidence, commitment)).toBeFalsy();
  });

  test('intake re-checks the gate under the lock: switched off during extraction, nothing is recorded', async () => {
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: 'Please send the estimate for my house', subject: 'Estimate' });
    dispatchWithFallback.mockImplementationOnce(async () => {
      process.env.GATE_EMAIL_OPERATIONAL_ACTIONS = 'false';
      return { ok: true, json: { obligations: [{ party: 'waves', kind: 'send_estimate',
        description: 'send the estimate', quote: 'Please send the estimate for my house', basis: 'request', property_id: null,
        due_text: null, due_at: null, due_date: null, promise_firm: false, answered_by_payment: false }], facts: [], additional_properties: [] } };
    });
    await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(await mockPg('call_commitments').where({ email_id: email.id })).toHaveLength(0);
    expect((await mockPg('emails').where({ id: email.id }).first()).operational_analysis).toBeNull();
  });

  test('intake re-checks the source under the lock: an ask reclassified during extraction is not recorded', async () => {
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: 'Please send the estimate for my house', subject: 'Estimate' });
    dispatchWithFallback.mockImplementationOnce(async () => {
      await mockPg('emails').where({ id: email.id }).update({ classification: 'spam' });
      return { ok: true, json: { obligations: [{ party: 'waves', kind: 'send_estimate',
        description: 'send the estimate', quote: 'Please send the estimate for my house', basis: 'request', property_id: null,
        due_text: null, due_at: null, due_date: null, promise_firm: false, answered_by_payment: false }], facts: [], additional_properties: [] } };
    });
    await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(await mockPg('call_commitments').where({ email_id: email.id })).toHaveLength(0);
  });

  // Coordinator correction #3, 2026-09-29 (BUG): to_address is the raw
  // header value ("Name <addr>", or a comma-separated list), never a bare
  // address — a plain `=` comparison never matched it, so 23 real SENT
  // rows to gmail.com resolved to no customer in production. These prove
  // the fix in BOTH resolveEmailCustomerLink directly and the evidence
  // loader's own SQL prefilter (which shares the same underlying bug).
  test('D1 via to_address resolution (no thread partner): a "Name <addr>" SENT reply still resolves and closes an SMS ask', async () => {
    const sourceAt = new Date();
    const [smsRow] = await mockPg('sms_log').insert({ id: randomUUID(), customer_id: customerId, direction: 'inbound',
      message_body: 'Did you come to my house today?', from_phone: '+12025550101', to_phone: '+19418889999',
      created_at: sourceAt, status: 'received' }).returning('*');
    const [commitment] = await mockPg('call_commitments').insert({ sms_log_id: smsRow.id, commitment_key: 'waves:other:ask-toaddr1',
      party: 'waves', kind: 'other', description: 'Did you come to my house today?', channel: 'sms',
      due_at: null, due_basis: null, source: 'ai', extractor_version: 'sms-ops-v22',
      evidence: JSON.stringify([{ quote: 'Did you come to my house today?', sms_log_id: smsRow.id, matched: true, speaker: 'caller' }]),
      sms_context: { basis: 'request', due_text: null, property_id: null, customer_id: customerId, source_at: sourceAt.toISOString() } })
      .returning('*');
    // No thread partner at all — resolution must come from to_address
    // alone, in the raw "Name <addr>" shape Gmail actually stores.
    const reply = await insertEmail({ gmail_thread_id: randomUUID(), to_address: 'Dryrun Fixture <customer@example.invalid>',
      from_address: 'contact@wavespestcontrol.com', customer_id: null, classification: null,
      body_text: 'Yes, all done — thanks!', label_ids: JSON.stringify(['SENT']),
      received_at: new Date(sourceAt.getTime() + 60000) });
    const { loadSmsFulfillmentEvidence, replyFulfillment } = require('../services/sms-commitment-fulfillment');
    const message = { id: smsRow.id, customer_id: customerId, direction: 'inbound', from_phone: '+12025550101', to_phone: '+19418889999', created_at: sourceAt };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, new Date(reply.received_at.getTime() + 2000));
    expect(evidence.records.some((r) => r.type === 'email_reply' && r.id === reply.id)).toBe(true);
    expect(replyFulfillment(evidence, commitment)).toMatchObject({ verdict: 'fulfilled', record_type: 'email_reply', record_id: reply.id });
  });

  test('resolveEmailCustomerLink: a two-recipient to_address resolves when exactly one is an active customer', async () => {
    const { resolveEmailCustomerLink } = require('../services/email/email-customer-link');
    const row = { id: randomUUID(), gmail_thread_id: randomUUID(), to_address: 'someone.else@nowhere.invalid, customer@example.invalid', cc_address: '', bcc_address: '' };
    await expect(resolveEmailCustomerLink(mockPg, row)).resolves.toBe(customerId);
  });

  test('resolveEmailCustomerLink: an unthreaded send naming the customer only in Cc or Bcc still resolves (Codex #5422 r6)', async () => {
    const { resolveEmailCustomerLink } = require('../services/email/email-customer-link');
    const base = { id: randomUUID(), gmail_thread_id: null, to_address: null, cc_address: '', bcc_address: '' };
    await expect(resolveEmailCustomerLink(mockPg, { ...base, bcc_address: 'customer@example.invalid' })).resolves.toBe(customerId);
    await expect(resolveEmailCustomerLink(mockPg, { ...base, to_address: '', cc_address: 'Synthetic <customer@example.invalid>' })).resolves.toBe(customerId);
    await expect(resolveEmailCustomerLink(mockPg, base)).resolves.toBeNull();
  });

  test('resolveEmailCustomerLink: two recipients matching two different customers resolves to nobody (never guesses)', async () => {
    const { resolveEmailCustomerLink } = require('../services/email/email-customer-link');
    const otherId = randomUUID();
    await mockPg('customers').insert({ id: otherId, first_name: 'Other', last_name: 'Fixture',
      phone: '+12025559999', email: 'other.customer@example.invalid', address_line1: '2 Fixture Way', city: 'Sarasota', zip: '34236' });
    const row = { id: randomUUID(), gmail_thread_id: randomUUID(), to_address: 'other.customer@example.invalid, customer@example.invalid', cc_address: '', bcc_address: '' };
    await expect(resolveEmailCustomerLink(mockPg, row)).resolves.toBeNull();
  });

  test('resolveEmailCustomerLink: a send in the customer\'s thread that never went to the customer (internal forward) resolves to nobody', async () => {
    const { resolveEmailCustomerLink } = require('../services/email/email-customer-link');
    const inbound = await insertEmail({ customer_id: customerId });
    const row = { id: randomUUID(), gmail_thread_id: inbound.gmail_thread_id, to_address: 'Office <office@wavespestcontrol.com>', cc_address: '', bcc_address: '' };
    await expect(resolveEmailCustomerLink(mockPg, row)).resolves.toBeNull();
    await expect(resolveEmailCustomerLink(mockPg, { ...row, to_address: null })).resolves.toBeNull();
  });

  test('resolveEmailCustomerLink: a thread send that also names another customer resolves to nobody', async () => {
    const { resolveEmailCustomerLink } = require('../services/email/email-customer-link');
    await mockPg('customers').insert({ id: randomUUID(), first_name: 'Third', last_name: 'Fixture',
      phone: '+12025559998', email: 'third.customer@example.invalid', address_line1: '3 Fixture Way', city: 'Sarasota', zip: '34236' });
    const inbound = await insertEmail({ customer_id: customerId });
    const row = { id: randomUUID(), gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid, third.customer@example.invalid', cc_address: '', bcc_address: '' };
    await expect(resolveEmailCustomerLink(mockPg, row)).resolves.toBeNull();
  });

  test('resolveEmailCustomerLink: a thread reply to the address the customer wrote in from resolves to that customer', async () => {
    const { resolveEmailCustomerLink } = require('../services/email/email-customer-link');
    const inbound = await insertEmail({ customer_id: customerId, from_address: 'Dryrun Fixture <work.inbox@example.invalid>' });
    const row = { id: randomUUID(), gmail_thread_id: inbound.gmail_thread_id, to_address: 'work.inbox@example.invalid', cc_address: '', bcc_address: '' };
    await expect(resolveEmailCustomerLink(mockPg, row)).resolves.toBe(customerId);
  });

  test('subject-only ask: an empty body with an actionable subject is eligible, and the quote grounds in the subject', async () => {
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: '', subject: 'Please reschedule Friday' });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [{ party: 'waves', kind: 'other',
      description: 'reschedule Friday', quote: 'Please reschedule Friday', basis: 'request', property_id: null,
      due_text: null, due_at: null, due_date: null, promise_firm: false, answered_by_payment: false }], facts: [], additional_properties: [] } });
    const result = await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    const row = await mockPg('call_commitments').first();
    expect(row).toMatchObject({ email_id: email.id, party: 'waves', channel: 'email', description: 'reschedule Friday' });
    // The subject rode inside the JSON payload, never the prompt text.
    const prompt = dispatchWithFallback.mock.calls[0][1].text;
    expect(prompt).toContain('"subject":"Please reschedule Friday"');
    expect(prompt.slice(0, prompt.indexOf('Return only JSON'))).not.toContain('Please reschedule Friday');
  });

  test('subject-only ask: a later reply repeating the subject behind Re: neither blanks the first email\'s subject nor re-asks', async () => {
    const at = Date.now() - 30 * 60000;
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: '', subject: 'Please reschedule Friday', received_at: new Date(at) });
    const echo = await insertEmail({ gmail_thread_id: email.gmail_thread_id, customer_id: customerId, classification: 'customer_request',
      body_text: '', subject: 'Re: Please reschedule Friday', received_at: new Date(at + 5 * 60000) });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [{ party: 'waves', kind: 'other',
      description: 'reschedule Friday', quote: 'Please reschedule Friday', basis: 'request', property_id: null,
      due_text: null, due_at: null, due_date: null, promise_firm: false, answered_by_payment: false }], facts: [], additional_properties: [] } });
    await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(dispatchWithFallback.mock.calls[0][1].text).toContain('"subject":"Please reschedule Friday"');
    const rows = await mockPg('call_commitments').select('email_id');
    expect(rows.map((r) => r.email_id)).toEqual([email.id]);
    expect(rows.some((r) => r.email_id === echo.id)).toBe(false);
  });

  test('subject-only ask: a quote grounded in neither the subject nor the body is still dropped', async () => {
    await insertEmail({ customer_id: customerId, classification: 'customer_request', body_text: '', subject: 'Please reschedule Friday' });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { obligations: [{ party: 'waves', kind: 'other',
      description: 'send the estimate', quote: 'Please send the estimate', basis: 'request', property_id: null,
      due_text: null, due_at: null, due_date: null, promise_firm: false, answered_by_payment: false }], facts: [], additional_properties: [] } });
    await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(await mockPg('call_commitments').count('* as n').first()).toMatchObject({ n: '0' });
  });

  test('the extraction receipt hash covers subject and body: same body, different subject = a different source', async () => {
    const { VERSION } = require('../services/email-operational-actions');
    const { hashExtractionSource } = require('../services/data-hygiene/source-extraction-store');
    const one = await insertEmail({ customer_id: customerId, classification: 'customer_request', body_text: 'Thanks', subject: 'Please reschedule Friday' });
    const two = await insertEmail({ customer_id: customerId, classification: 'customer_request', body_text: 'Thanks', subject: 'Please reschedule Monday' });
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { obligations: [], facts: [], additional_properties: [] } });
    await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    const hashOf = (id) => mockPg('data_hygiene_source_extractions').where({ source_id: id, extractor_version: VERSION }).first('source_hash').then((r) => r.source_hash);
    const [h1, h2] = [await hashOf(one.id), await hashOf(two.id)];
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(hashExtractionSource('Thanks')); // not the body alone
    dispatchWithFallback.mockReset();
  });

  test('an email with neither a body nor a subject is not eligible', async () => {
    await insertEmail({ customer_id: customerId, classification: 'customer_request', body_text: '', subject: '' });
    const result = await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(result).toMatchObject({ processed: 0 });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('cc/bcc: a staff send with customer A in To and customer B in Cc resolves to nobody', async () => {
    const { resolveEmailCustomerLink } = require('../services/email/email-customer-link');
    await mockPg('customers').insert({ id: randomUUID(), first_name: 'Cc', last_name: 'Fixture',
      phone: '+12025559997', email: 'cc.customer@example.invalid', address_line1: '4 Fixture Way', city: 'Sarasota', zip: '34236' });
    const inbound = await insertEmail({ customer_id: customerId });
    const row = { id: randomUUID(), gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid',
      cc_address: 'cc.customer@example.invalid', bcc_address: '' };
    await expect(resolveEmailCustomerLink(mockPg, row)).resolves.toBeNull();
    // Same without a thread partner (direct recipient branch).
    await expect(resolveEmailCustomerLink(mockPg, { ...row, gmail_thread_id: randomUUID() })).resolves.toBeNull();
  });

  test('cc/bcc: another customer in Bcc resolves to nobody; a non-customer Cc/Bcc still resolves', async () => {
    const { resolveEmailCustomerLink } = require('../services/email/email-customer-link');
    await mockPg('customers').insert({ id: randomUUID(), first_name: 'Bcc', last_name: 'Fixture',
      phone: '+12025559996', email: 'bcc.customer@example.invalid', address_line1: '5 Fixture Way', city: 'Sarasota', zip: '34236' });
    const inbound = await insertEmail({ customer_id: customerId });
    const row = { id: randomUUID(), gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid',
      cc_address: '', bcc_address: 'Bcc Fixture <bcc.customer@example.invalid>' };
    await expect(resolveEmailCustomerLink(mockPg, row)).resolves.toBeNull();
    await expect(resolveEmailCustomerLink(mockPg, { ...row, bcc_address: 'office@wavespestcontrol.com',
      cc_address: 'Office <office2@wavespestcontrol.com>' })).resolves.toBe(customerId);
  });

  test('cc/bcc: the customer only in Cc still counts as reached (the recipient set is To+Cc+Bcc)', async () => {
    const { resolveEmailCustomerLink } = require('../services/email/email-customer-link');
    const row = { id: randomUUID(), gmail_thread_id: randomUUID(), to_address: 'someone.else@nowhere.invalid',
      cc_address: 'customer@example.invalid', bcc_address: '' };
    await expect(resolveEmailCustomerLink(mockPg, row)).resolves.toBe(customerId);
  });

  test('cc/bcc: a SENT row whose cc or bcc was never captured (NULL) never links to a customer', async () => {
    const { resolveEmailCustomerLink } = require('../services/email/email-customer-link');
    const inbound = await insertEmail({ customer_id: customerId });
    const row = { id: randomUUID(), gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid' };
    await expect(resolveEmailCustomerLink(mockPg, { ...row, cc_address: null, bcc_address: '' })).resolves.toBeNull();
    await expect(resolveEmailCustomerLink(mockPg, { ...row, cc_address: '', bcc_address: null })).resolves.toBeNull();
    await expect(resolveEmailCustomerLink(mockPg, { ...row, cc_address: '', bcc_address: '' })).resolves.toBe(customerId);
  });

  test('cc/bcc: intake marks a NULL-recipient SENT row seen with no commitment, and links a captured one', async () => {
    const inbound = await insertEmail({ customer_id: customerId, classification: 'customer_request', body_text: '', subject: '' });
    const sent = await insertEmail({ gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid',
      cc_address: null, bcc_address: null, from_address: 'contact@wavespestcontrol.com', body_text: "I'll send the estimate tomorrow",
      customer_id: null, classification: null, label_ids: JSON.stringify(['SENT']) });
    const result = await runEmailOperationalActions({ conn: mockPg, now: new Date() });
    expect(result).toMatchObject({ failed: 0 });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(await mockPg('call_commitments').count('* as n').first()).toMatchObject({ n: '0' });
    expect((await mockPg('emails').where({ id: sent.id }).first()).operational_analysis).toMatchObject({ skipped: 'no_customer_link' });
  });

  test('D1 reverse: an SMS reply closes an email-sourced general ask (through refreshEmailCommitments end-to-end)', async () => {
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: 'Did you come to my house today?' });
    await mockPg('call_commitments').insert({ email_id: email.id, email_customer_id: customerId, commitment_key: 'waves:other:ask2',
      party: 'waves', kind: 'other', description: 'Did you come to my house today?', channel: 'email',
      due_at: null, due_basis: null, source: 'ai', extractor_version: 'sms-ops-v22:email',
      evidence: JSON.stringify([{ quote: 'Did you come to my house today?', email_id: email.id, matched: true, speaker: 'caller' }]),
      sms_context: { channel: 'email', basis: 'request', due_text: null, customer_id: customerId, source_at: email.received_at.toISOString() } });
    // A staff SMS reply, from an admin, minutes after the email arrived.
    await mockPg('sms_log').insert({ id: randomUUID(), customer_id: customerId, direction: 'outbound',
      message_body: 'Yes, all done today!', from_phone: '+19418889999', to_phone: '+12025550101',
      admin_user_id: randomUUID(), message_type: 'manual', status: 'delivered',
      created_at: new Date(email.received_at.getTime() + 60000) });
    const result = await refreshEmailCommitments({ conn: mockPg, now: new Date(email.received_at.getTime() + 120000) });
    expect(result).toMatchObject({ scanned: 1, fulfilled: 1 });
    const row = await mockPg('call_commitments').first();
    expect(row).toMatchObject({ status: 'fulfilled' });
    expect(row.fulfillment).toMatchObject({ record_type: 'sms', basis: 'person_reply' });
  });

  test('negative: an automated email_delivery (SendGrid) send never closes a general ask — never the person-reply path', async () => {
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: 'Did you come to my house today?' });
    const [commitment] = await mockPg('call_commitments').insert({ email_id: email.id, email_customer_id: customerId, commitment_key: 'waves:other:ask3',
      party: 'waves', kind: 'other', description: 'Did you come to my house today?', channel: 'email',
      due_at: null, due_basis: null, source: 'ai', extractor_version: 'sms-ops-v22:email',
      evidence: JSON.stringify([{ quote: 'Did you come to my house today?', email_id: email.id, matched: true, speaker: 'caller' }]),
      sms_context: { channel: 'email', basis: 'request', due_text: null, customer_id: customerId, source_at: email.received_at.toISOString() } })
      .returning('*');
    await mockPg('email_messages').insert({ id: randomUUID(), recipient_type: 'customer', recipient_id: customerId,
      recipient_email_snapshot: 'customer@example.invalid', status: 'delivered',
      sent_at: new Date(email.received_at.getTime() + 60000), delivered_at: new Date(email.received_at.getTime() + 61000) });
    const { loadSmsFulfillmentEvidence } = require('../services/sms-commitment-fulfillment');
    const message = { id: email.id, customer_id: customerId, direction: 'inbound', from_phone: '+12025550101', to_phone: '+12025550101', created_at: email.received_at };
    const now = new Date(email.received_at.getTime() + 120000);
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    expect(evidence.records.some((r) => r.type === 'email_delivery')).toBe(true);
    expect(replyFulfillment(evidence, commitment)).toBeNull();
    expect(admissibleWitness(evidence.records.find((r) => r.type === 'email_delivery'), commitment, evidence.records)).toBe(false);
  });

  // Coordinator correction #1, 2026-09-29 (BUG): refreshEmailCommitments'
  // sweep INNER-JOINed customers directly on e.customer_id — but a staff
  // promise's own email_id ALWAYS points at the person-sent (SENT) row
  // itself (recordEmailOperations's promise branch: `email_id: email.id`
  // where `email` is the SENT candidate), and email-sync.js NEVER sets
  // customer_id on a SENT row (design note §1). That join silently
  // dropped every staff-promise row from the whole refresh page. Every
  // fixture below therefore points email_id at a SENT row with
  // customer_id: null, exactly like production — never at the inbound ask
  // email (which DOES carry customer_id and would have masked the bug).
  test('fix 1: a staff email promise past its deadline with no proof rings "needs follow-up" (SENT row customer_id is NULL, as in prod)', async () => {
    const actualNotifications = jest.requireActual('../services/notification-service');
    NotificationService.notifyAdmin.mockImplementation(actualNotifications.notifyAdmin.bind(actualNotifications));
    const inbound = await insertEmail({ customer_id: customerId, classification: 'customer_request' });
    const sentAt = new Date(inbound.received_at.getTime() + 1000);
    const sent = await insertEmail({ gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid',
      from_address: 'contact@wavespestcontrol.com', customer_id: null, classification: null,
      body_text: "I'll send the estimate today", label_ids: JSON.stringify(['SENT']), received_at: sentAt });
    const dueAt = new Date(sentAt.getTime() + 1000);
    await mockPg('call_commitments').insert({ email_id: sent.id, email_customer_id: customerId, commitment_key: 'waves:other:promise-nofix1',
      party: 'waves', kind: 'other', description: 'send the estimate today', channel: 'email',
      due_at: dueAt, due_basis: 'default_kind', source: 'ai', extractor_version: 'sms-ops-v22:email',
      evidence: JSON.stringify([{ quote: "I'll send the estimate today", email_id: sent.id, matched: true, speaker: 'agent' }]),
      sms_context: { channel: 'email', basis: 'promise', customer_id: customerId, source_at: sentAt.toISOString() } });
    const now = new Date(dueAt.getTime() + 60000);
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    const result = await refreshEmailCommitments({ conn: mockPg, now });
    // Pre-fix, the sweep's own JOIN excluded this row entirely: scanned
    // would read 0 and no bell would ever ring.
    expect(result).toMatchObject({ scanned: 1, fulfilled: 0 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('alert', 'A promise emailed to a customer needs follow-up',
      expect.any(String), expect.objectContaining({ bell: true }));
    expect((await mockPg('call_commitments').first()).status).toBe('open');
  });

  test('fix 1: the same shape, with proof, closes — keptLate for email: rings the bell, then clears on the next tick', async () => {
    const actualNotifications = jest.requireActual('../services/notification-service');
    NotificationService.notifyAdmin.mockImplementation(actualNotifications.notifyAdmin.bind(actualNotifications));
    const inbound = await insertEmail({ customer_id: customerId, classification: 'customer_request' });
    const sentAt = new Date(inbound.received_at.getTime() + 1000);
    // The staff promise's OWN email_id points at this SENT row — its
    // customer_id is NULL, exactly as email-sync.js leaves it in prod.
    const promiseSent = await insertEmail({ gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid',
      from_address: 'contact@wavespestcontrol.com', customer_id: null, classification: null,
      body_text: "Ok, we'll get the prep guide today", label_ids: JSON.stringify(['SENT']), received_at: sentAt });
    const dueAt = new Date(sentAt.getTime() + 1000);
    await mockPg('call_commitments').insert({ email_id: promiseSent.id, email_customer_id: customerId, commitment_key: 'waves:other:promise1',
      party: 'waves', kind: 'other', description: "get the prep guide today", channel: 'email',
      due_at: dueAt, due_basis: 'default_kind', source: 'ai', extractor_version: 'sms-ops-v22:email',
      evidence: JSON.stringify([{ quote: "we'll get the prep guide today", email_id: promiseSent.id, matched: true, speaker: 'agent' }]),
      sms_context: { channel: 'email', basis: 'promise', customer_id: customerId, source_at: sentAt.toISOString() } });
    const late = new Date(dueAt.getTime() + 60000);
    // The actual proof — a LATER SENT row (also customer_id: null) —
    // arrives after the deadline.
    const guide = await insertEmail({ gmail_thread_id: inbound.gmail_thread_id, to_address: 'customer@example.invalid',
      from_address: 'contact@wavespestcontrol.com', customer_id: null, classification: null,
      body_text: 'Your treatment prep guide is attached', label_ids: JSON.stringify(['SENT']), received_at: late });
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'fulfilled', record_ref: `email_reply:${guide.id}`, quote: 'Your treatment prep guide' } });
    const first = await refreshEmailCommitments({ conn: mockPg, now: new Date(late.getTime() + 2000) });
    expect(first).toMatchObject({ scanned: 1, fulfilled: 0 });
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    expect(await mockPg('notifications').whereNull('read_at')).toHaveLength(1);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('alert', 'A promise emailed to a customer needs follow-up',
      expect.stringContaining('only after the promised deadline'), expect.objectContaining({ bell: true }));
    await mockPg('system_settings').where({ key: 'email_operations.fulfillment_cursor' }).del();
    const second = await refreshEmailCommitments({ conn: mockPg, now: new Date(late.getTime() + 5 * 60000) });
    expect(second).toMatchObject({ fulfilled: 1 });
    expect((await mockPg('call_commitments').first()).status).toBe('fulfilled');
    expect(await mockPg('notifications').whereNull('read_at')).toHaveLength(0);
  });

  test('rollback refuses to destroy recorded email obligations and analysis', async () => {
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request' });
    await mockPg('emails').where({ id: email.id }).update({ operational_analysis: { version: 'sms-ops-v22:email', processed_at: new Date().toISOString(), dropped: 0 } });
    await expect(emailMigration.down(mockPg)).rejects.toThrow('disable the gate');
  });

  // Coordinator correction #4, 2026-09-29: staff had no way to silence a
  // false email-follow-up bell (it re-rings every 24h until proof appears).
  // listSmsCommitments/applySmsCommitmentUpdate now cover email rows too, a
  // UNION ALL that keeps the SMS branch's own query and output columns
  // untouched (see the big sms-commitments-postgres.test.js suite for that
  // regression proof — 221 tests, all still green against this same change).
  test('fix 4: listSmsCommitments returns both an SMS row and an email row for the same customer', async () => {
    const [smsRow] = await mockPg('sms_log').insert({ id: randomUUID(), customer_id: customerId, direction: 'inbound',
      message_body: 'Please call me back', from_phone: '+12025550101', to_phone: '+19418889999',
      created_at: new Date(), status: 'received' }).returning('*');
    await mockPg('call_commitments').insert({ sms_log_id: smsRow.id, commitment_key: 'waves:callback:list1',
      party: 'waves', kind: 'callback', description: 'call me back', channel: 'sms', due_at: null, due_basis: null,
      source: 'ai', extractor_version: 'sms-ops-v22',
      evidence: JSON.stringify([{ quote: 'Please call me back', sms_log_id: smsRow.id, matched: true, speaker: 'caller' }]) });
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: 'Please send the estimate' });
    await mockPg('call_commitments').insert({ email_id: email.id, email_customer_id: customerId, commitment_key: 'waves:send_estimate:list1',
      party: 'waves', kind: 'send_estimate', description: 'send the estimate', channel: 'email', due_at: null, due_basis: null,
      source: 'ai', extractor_version: 'sms-ops-v22:email',
      evidence: JSON.stringify([{ quote: 'Please send the estimate', email_id: email.id, matched: true, speaker: 'caller' }]),
      sms_context: { channel: 'email', basis: 'request', customer_id: customerId, source_at: email.received_at.toISOString() } });
    const rows = await listSmsCommitments(mockPg, { customerId });
    expect(rows).toHaveLength(2);
    const bySmsLogId = rows.find((r) => r.sms_log_id === smsRow.id);
    const byEmailId = rows.find((r) => r.email_id === email.id);
    expect(bySmsLogId).toMatchObject({ channel: 'sms', kind: 'callback', email_id: null, customer_id: customerId });
    expect(byEmailId).toMatchObject({ channel: 'email', kind: 'send_estimate', sms_log_id: null, customer_id: customerId });
    expect(byEmailId.sms_started_at).toBeTruthy();
  });

  test('fix 4: applySmsCommitmentUpdate closes an email row (fulfill), and closes its bell', async () => {
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: 'Please send the estimate' });
    const [row] = await mockPg('call_commitments').insert({ email_id: email.id, email_customer_id: customerId, commitment_key: 'waves:send_estimate:close1',
      party: 'waves', kind: 'send_estimate', description: 'send the estimate', channel: 'email', due_at: null, due_basis: null,
      source: 'ai', extractor_version: 'sms-ops-v22:email',
      evidence: JSON.stringify([{ quote: 'Please send the estimate', email_id: email.id, matched: true, speaker: 'caller' }]),
      sms_context: { channel: 'email', basis: 'request', customer_id: customerId, source_at: email.received_at.toISOString() } })
      .returning('*');
    await mockPg('notifications').insert({ recipient_type: 'admin', category: 'alert', title: 'An email from a customer needs follow-up',
      metadata: { dedupeKey: `email-commitment:${row.id}` } });
    const updated = await applySmsCommitmentUpdate(mockPg, row.id, { customerId, action: 'fulfill', reviewedBy: randomUUID() });
    expect(updated).toMatchObject({ status: 'fulfilled' });
    expect((await mockPg('call_commitments').where({ id: row.id }).first()).status).toBe('fulfilled');
    // Staff settled the promise: the bell is done (by that person), not just read.
    const closedBell = await mockPg('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`email-commitment:${row.id}`]).first();
    expect(closedBell.read_at).toBeTruthy();
    expect(closedBell.done_at).toBeTruthy();
    expect(closedBell.done_by).toBeTruthy();
    expect(await mockPg('audit_log').where({ action: 'email.commitment.fulfill' })).toHaveLength(1);
  });

  test('fix 4: applySmsCommitmentUpdate refuses a send_reschedule_link email row (the one deliberate scope limit)', async () => {
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request',
      body_text: "I'll text you a link to reschedule" });
    const [row] = await mockPg('call_commitments').insert({ email_id: email.id, email_customer_id: customerId, commitment_key: 'waves:send_reschedule_link:refuse1',
      party: 'waves', kind: 'send_reschedule_link', description: 'text a reschedule link', channel: 'email', due_at: null, due_basis: null,
      source: 'ai', extractor_version: 'sms-ops-v22:email',
      evidence: JSON.stringify([{ quote: "I'll text you a link to reschedule", email_id: email.id, matched: true, speaker: 'caller' }]),
      sms_context: { channel: 'email', basis: 'request', customer_id: customerId, source_at: email.received_at.toISOString() } })
      .returning('*');
    await expect(applySmsCommitmentUpdate(mockPg, row.id, { customerId, action: 'fulfill', reviewedBy: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    expect((await mockPg('call_commitments').where({ id: row.id }).first()).status).toBe('open');
  });

  test('bell titles: ask vs promise', async () => {
    const actualNotifications = jest.requireActual('../services/notification-service');
    NotificationService.notifyAdmin.mockImplementation(actualNotifications.notifyAdmin.bind(actualNotifications));
    const email = await insertEmail({ customer_id: customerId, classification: 'customer_request' });
    await mockPg('call_commitments').insert({ email_id: email.id, email_customer_id: customerId, commitment_key: 'waves:other:ask4',
      party: 'waves', kind: 'other', description: 'Did you come today?', channel: 'email',
      due_at: new Date(email.received_at.getTime() + 1000), due_basis: 'default_kind', source: 'ai', extractor_version: 'sms-ops-v22:email',
      evidence: JSON.stringify([{ quote: 'Did you come today?', email_id: email.id, matched: true, speaker: 'caller' }]),
      sms_context: { channel: 'email', basis: 'request', customer_id: customerId, source_at: email.received_at.toISOString() } });
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    await refreshEmailCommitments({ conn: mockPg, now: new Date(email.received_at.getTime() + 60000) });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('alert', 'An email from a customer needs follow-up', expect.any(String), expect.anything());
  });
});
