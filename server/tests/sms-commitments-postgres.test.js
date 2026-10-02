/** Transaction proof against an explicitly selected synthetic QA database. */
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
const { recordMessageOperations, loadMessageContext, runSmsOperationalActions, replaySmsProfile, refreshSmsCommitments, listSmsCommitments, applySmsCommitmentUpdate } = require('../services/sms-operational-actions');
const numbers = require('../config/twilio-numbers');
const { dispatchWithFallback } = require('../services/llm/call');
const { loadSmsFulfillmentEvidence, admissibleWitness, groundFulfillment, verifySmsFulfillment, revalidateSmsFulfillment, fulfillmentFingerprint, FULFILLMENT_POLICY } = require('../services/sms-commitment-fulfillment');
const NotificationService = require('../services/notification-service');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const migration = require('../models/migrations/20260906000001_sms_operational_actions');
const replayMigration = require('../models/migrations/20260907000021_sms_replay_contact_preference');
const irrigationRevisionMigration = require('../models/migrations/20260907000020_property_irrigation_revision');
const { listOpenCommitments } = require('../services/call-commitments');
const connection = process.env.SMS_OPERATIONS_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `sms_commitments_${randomUUID().replaceAll('-', '')}`;
const TABLES = ['customers', 'customer_properties', 'property_preferences', 'sms_log', 'call_log',
  'call_commitments', 'data_hygiene_source_extractions', 'data_hygiene_proposals', 'data_hygiene_sensitive_vault',
  'conversations', 'messages', 'notifications', 'audit_log',
  'emails', 'email_messages', 'estimates', 'estimate_deposits', 'invoices', 'payments', 'payment_methods', 'payers', 'setup_fee_claims', 'annual_prepay_terms', 'scheduled_services', 'job_status_history', 'reschedule_log', 'system_settings', 'leads', 'messaging_audit_log'];
let mockPg;
let admin;
// A property the customer no longer has: with it on file their scoped asks
// rest on a payment's explicit links, never on the only-property rule.
const giveFormerProperty = (customerId) => mockPg('customer_properties').insert({ id: randomUUID(), customer_id: customerId,
  address_line1: '300 Former Lane', city: 'Sarasota', zip: '34236', active: false });
let message;
let result;
let context;
jest.setTimeout(60000);

postgres('SMS commitments on PostgreSQL', () => {
  beforeAll(async () => {
    if (!/^\/(waves_test|waves_qa_[a-f0-9]+)$/.test(new URL(connection).pathname)) {
      throw new Error('Use an explicitly selected synthetic Waves QA database');
    }
    process.env.DATA_HYGIENE_VAULT_KEY = 'sms-operations-synthetic-key';
    admin = knex({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 5 } });
    await admin.raw('CREATE FUNCTION ??.pgp_sym_encrypt(text, text) RETURNS bytea LANGUAGE sql AS $$ SELECT public.pgp_sym_encrypt($1, $2) $$', [schema]);
    await admin.raw('CREATE FUNCTION ??.pgp_sym_decrypt(bytea, text) RETURNS text LANGUAGE sql AS $$ SELECT public.pgp_sym_decrypt($1, $2) $$', [schema]);
    // Clone the MIGRATED schema, never application records. This catches real
    // column/type/CHECK drift; no simplified hand-written table definitions.
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
    process.env.GATE_SMS_OPERATIONAL_ACTIONS = 'true';
    process.env.GATE_SMS_COMMITMENT_FOLLOWUP = 'true';
    const customerId = randomUUID();
    const propertyId = randomUUID();
    await mockPg('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      phone: '+12025550101', address_line1: '100 Example Lane', city: 'Sarasota', zip: '34236' });
    await mockPg('customer_properties').insert({ id: propertyId, customer_id: customerId, is_primary: true,
      address_line1: '100 Example Lane', city: 'Sarasota', zip: '34236', active: true });
    message = { id: randomUUID(), customer_id: customerId, direction: 'inbound',
      message_body: 'The controller is beside the garage. Please send the estimate.',
      from_phone: '+12025550101', to_phone: numbers.locations.parrish.number, created_at: new Date(), status: 'received' };
    process.env.GATE_SMS_OPERATIONAL_ACTIONS_SINCE = new Date(message.created_at.getTime() - 1000).toISOString();
    await mockPg('sms_log').insert(message);
    result = { dropped: 0, facts: [{ field: 'irrigation_controller_location', value: 'The controller is beside the garage',
      quote: 'The controller is beside the garage', duration: 'durable', property_id: propertyId }],
    obligations: [{ party: 'waves', kind: 'send_estimate', description: 'send the estimate',
      quote: 'Please send the estimate', basis: 'request', property_id: propertyId, due_text: null, due_at: null }] };
    context = await loadMessageContext(mockPg, message);
  });
  afterAll(async () => {
    delete process.env.GATE_SMS_OPERATIONAL_ACTIONS;
    delete process.env.DATA_HYGIENE_VAULT_KEY;
    delete process.env.GATE_SMS_COMMITMENT_FOLLOWUP;
    delete process.env.GATE_SMS_OPERATIONAL_ACTIONS_SINCE;
    if (mockPg) await mockPg.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  

  test('automated manual messages neither reach extraction nor starve a customer request', async () => {
    const automated = Array.from({ length: 30 }, () => ({ ...message, id: randomUUID(),
      direction: 'outbound', message_type: 'manual', admin_user_id: null,
      message_body: "No problem. We'll give you a call shortly.",
      from_phone: message.to_phone, to_phone: message.from_phone, status: 'sent',
      created_at: new Date(message.created_at.getTime() - 500) }));
    await mockPg('sms_log').insert(automated);
    const extract = jest.fn(async () => ({ facts: [], obligations: [], dropped: 0 }));
    expect(await runSmsOperationalActions({ conn: mockPg, extract })).toMatchObject({ processed: 1, failed: 0 });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0][0].message.id).toBe(message.id);
    expect(await mockPg('call_commitments')).toEqual([]);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test.each(['failed', 'pre-activation', 'automated'])('thirty %s scheduled deliveries cannot starve new inbound capture', async (reason) => {
    const queues = Array.from({ length: 30 }, () => ({ ...message, id: randomUUID(),
      direction: 'outbound', message_type: 'manual', admin_user_id: '00000000-0000-4000-8000-000000000104', message_body: 'I will call with an update.',
      from_phone: message.to_phone, to_phone: message.from_phone, status: 'sent',
      created_at: new Date(message.created_at.getTime() - 500), scheduled_for: new Date(message.created_at.getTime() - 600) }));
    const deliveries = queues.map((queue) => ({ ...queue, id: randomUUID(), scheduled_for: null,
      admin_user_id: reason === 'automated' ? null : queue.admin_user_id,
      status: reason === 'failed' ? 'undelivered' : 'sent', metadata: { scheduled_sms_log_id: queue.id },
      created_at: new Date(message.created_at.getTime() - (reason === 'pre-activation' ? 2000 : 550)) }));
    await mockPg('sms_log').insert([...queues, ...deliveries]);
    const extract = jest.fn(async () => ({ facts: [], obligations: [], dropped: 0 }));
    expect(await runSmsOperationalActions({ conn: mockPg, extract, now: new Date(message.created_at.getTime() + 1000) }))
      .toMatchObject({ processed: 1, failed: 0 });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0][0].message.id).toBe(message.id);
    expect(await mockPg('data_hygiene_source_extractions')).toHaveLength(1);
    // A later successful delivery becomes eligible without deleting receipts.
    if (reason === 'failed') {
      await mockPg('sms_log').where({ id: deliveries[0].id }).update({ status: 'delivered' });
      expect(await runSmsOperationalActions({ conn: mockPg, extract, now: new Date(message.created_at.getTime() + 1000) }))
        .toMatchObject({ processed: 1, failed: 0 });
      expect(extract.mock.calls[1][0].message.id).toBe(queues[0].id);
    }
  });

  test('the locked writer retains a multiple-property request without assigning a model-selected property', async () => {
    await mockPg('customer_properties').insert({ id: randomUUID(), customer_id: message.customer_id,
      address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236', active: true });
    await recordMessageOperations(mockPg, message, result, context);
    const commitment = await mockPg('call_commitments').first();
    expect(commitment.sms_context).toMatchObject({ property_id: null, property_ambiguous: true });
    expect(commitment.evidence[0].quote).toBe(result.obligations[0].quote);
    expect(await listSmsCommitments(mockPg, { customerId: message.customer_id })).toHaveLength(1);
  });

  test.each([false, true])('profile replay with commitment capture enabled never records obligations (execute=%s)', async (execute) => {
    await mockPg('sms_log').where({ id: message.id }).update({ operational_analysis: { version: 'previous' } });
    const extract = jest.fn(async (input) => {
      expect(input.captureCommitments).toBe(false);
      return result; // Even a provider returning obligations cannot extend replay's scope.
    });
    const args = { conn: mockPg, smsLogId: message.id, extract };
    const preview = await replaySmsProfile(args);
    expect(execute ? await replaySmsProfile({ ...args, execute: true, previewHash: preview.preview_hash }) : preview)
      .toMatchObject({ recorded: 0, applied: 0, proposed: 1 });
    expect(extract).toHaveBeenCalledTimes(execute ? 2 : 1);
    expect(await mockPg('call_commitments')).toHaveLength(0);
    expect(await mockPg('data_hygiene_proposals')).toHaveLength(execute ? 1 : 0);
    expect(await mockPg('property_preferences')).toHaveLength(0);
  });

  test('profile replay excludes outbound promises even while commitment capture is enabled', async () => {
    await mockPg('sms_log').where({ id: message.id }).update({
      direction: 'outbound', from_phone: message.to_phone, to_phone: message.from_phone,
      message_type: 'manual', admin_user_id: '00000000-0000-4000-8000-000000000104', status: 'sent', operational_analysis: { version: 'previous' },
    });
    const extract = jest.fn();
    expect(await replaySmsProfile({ conn: mockPg, smsLogId: message.id, execute: true, extract }))
      .toEqual({ skipped: 'source_unavailable' });
    expect(extract).not.toHaveBeenCalled();
    expect(await mockPg('call_commitments')).toHaveLength(0);
  });

  test.each([
    'We do not have an irrigation system.', "We don't have sprinklers.",
    'There is no controller here.', 'The irrigation system was removed.',
    'Maybe this house has irrigation.',
  ])('an uncertain irrigation report cannot enable a system: %s', async (quote) => {
    await mockPg('property_preferences').insert({ customer_id: message.customer_id, irrigation_system: false });
    context = await loadMessageContext(mockPg, message);
    message.message_body = quote;
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: quote });
    result.facts = [{ field: 'irrigation_issues', quote, value: quote,
      property_id: context.properties[0].id, duration: 'durable' }];
    await recordMessageOperations(mockPg, message, result, context);
    expect((await mockPg('property_preferences').first()).irrigation_system).toBe(false);
    expect((await mockPg('sms_log').first()).operational_analysis.facts[0].outcome).toBe('irrigation_needs_review');
    expect(NotificationService.notifyAdmin).toHaveBeenCalled();
  });

  

  test.each([
    'We do not have any pets.', "We don't have a dog anymore.", 'No pets.',
    'Our dog passed away.', 'Not sure whether the cat will be out.',
  ])('a negated or uncertain pet report cannot become a pet alert: %s', async (quote) => {
    message.message_body = quote;
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: quote });
    result.facts = [{ field: 'pet_details', quote, value: quote, property_id: context.properties[0].id, duration: 'durable' }];
    await recordMessageOperations(mockPg, message, result, context);
    expect(await mockPg('property_preferences')).toHaveLength(0);
    expect((await mockPg('sms_log').first()).operational_analysis.facts[0].outcome).toBe('pet_needs_review');
    expect(NotificationService.notifyAdmin).toHaveBeenCalled();
  });

  

  test('access-code audits contain only ids and field provenance', async () => {
    message.message_body = 'Lockbox code is #0123';
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: message.message_body });
    result.facts = [{ field: 'lockbox_code', value: '#0123', quote: message.message_body,
      duration: 'durable', property_id: context.properties[0].id }];
    await recordMessageOperations(mockPg, message, result, context);
    const audit = await mockPg('audit_log').where({ action: 'sms.property_preference.updated' }).first();
    expect(Object.keys(audit.metadata).sort()).toEqual([
      'customer_id', 'extractor_version', 'field', 'property_id', 'sms_log_id',
    ]);
    expect(JSON.stringify(audit)).not.toContain('#0123');
  });

  test('temporary source qualifiers prevent permanent writes despite durable model output', async () => {
    message.message_body = `For tomorrow only. ${message.message_body}`;
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: message.message_body });
    await recordMessageOperations(mockPg, message, result, context);
    expect(await mockPg('property_preferences')).toHaveLength(0);
    expect((await mockPg('sms_log').first()).operational_analysis.facts[0].outcome).toBe('temporary_instruction');
    // Codex #4816 r27: labelled durable, held back only by wording that
    // cannot be tied to the fact — staff review it. R4 silence covers facts
    // the extractor itself labels temporary or visit-only.
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('an excluded source type discovered under lock cannot update the profile', async () => {
    await mockPg('sms_log').where({ id: message.id }).update({ message_type: 'opt_out' });
    expect(await recordMessageOperations(mockPg, message, result, context)).toEqual({ skipped: 'source_changed' });
    expect(await mockPg('property_preferences')).toEqual([]);
    expect((await mockPg('sms_log').first()).operational_analysis).toBeNull();
  });

  test('intake does not hold SMS while waiting for a merge-owned customer lock', async () => {
    const merge = await mockPg.transaction();
    let signal;
    const waitingForCustomer = new Promise((resolve) => { signal = resolve; });
    const onQuery = (query) => {
      if (/from "customers".*for update/.test(query.sql)) signal();
    };
    let worker;
    try {
      await merge('customers').where({ id: message.customer_id }).forUpdate().first();
      mockPg.on('query', onQuery);
      worker = recordMessageOperations(mockPg, message, result, context);
      await waitingForCustomer;
      // executeMerge owns customers before it repoints sms_log FKs. The
      // worker must not block this child lock while awaiting the customer.
      await merge('sms_log').where({ id: message.id }).forUpdate().noWait().first();
      await merge('sms_log').where({ id: message.id }).update({ customer_id: null });
      await merge.commit();
      expect(await worker).toEqual({ skipped: 'source_changed' });
      expect(await mockPg('property_preferences')).toHaveLength(0);
    } finally {
      mockPg.removeListener('query', onQuery);
      if (!merge.isCompleted()) await merge.rollback();
      if (worker) await worker;
    }
  });

  test.each(['provider-first', 'queue-first', 'missing-provider'])(
    'one scheduled promise creates one obligation and bell with %s', async (order) => {
      await mockPg('sms_log').where({ id: message.id }).update({ operational_analysis: { version: 'already-analyzed' } });
      const queue = { ...message, id: randomUUID(), direction: 'outbound', message_type: 'manual', admin_user_id: '00000000-0000-4000-8000-000000000104',
        message_body: 'I will call tomorrow at 10 AM.', from_phone: message.to_phone, to_phone: message.from_phone,
        created_at: new Date(message.created_at.getTime() - 600), scheduled_for: new Date(message.created_at.getTime() - 800),
        status: order === 'provider-first' ? 'sending' : 'sent' };
      const provider = { ...queue, id: randomUUID(), scheduled_for: null, status: 'sent',
        created_at: new Date(message.created_at.getTime() - 500), metadata: { scheduled_sms_log_id: queue.id } };
      await mockPg('sms_log').insert(queue);
      const due = require('../utils/datetime-et').parseQuotedETDeadline('tomorrow at 10 AM', queue.created_at);
      const extracted = { facts: [], dropped: 0, obligations: [{ party: 'waves', kind: 'callback', description: 'call',
        quote: queue.message_body, basis: 'promise', property_id: context.properties[0].id,
        due_text: 'tomorrow at 10 AM', due_at: due.toISOString() }] };
      const extract = jest.fn(async () => extracted);
      const run = () => runSmsOperationalActions({ conn: mockPg, extract });
      if (order === 'provider-first') {
        await mockPg('sms_log').insert(provider);
        await run();
        expect(extract).not.toHaveBeenCalled();
        await mockPg('sms_log').where({ id: queue.id }).update({ status: 'sent' });
      } else if (order === 'queue-first') {
        await run();
        await mockPg('sms_log').insert(provider);
      }
      await run(); await run();
      expect(extract).toHaveBeenCalledTimes(1);
      expect(extract.mock.calls[0][0].message.id).toBe(queue.id);
      expect(extract.mock.calls[0][0].message).not.toHaveProperty('metadata');
      const rows = await mockPg('call_commitments');
      expect(rows).toHaveLength(1);
      expect(rows[0].sms_log_id).toBe(queue.id);
      expect(await mockPg('data_hygiene_source_extractions').whereIn('source_id', [queue.id, provider.id])).toHaveLength(1);
      // A direct caller cannot bypass the same canonical-source guard under lock.
      if (order !== 'missing-provider') {
        expect(await recordMessageOperations(mockPg, provider, extracted, await loadMessageContext(mockPg, provider)))
          .toEqual({ skipped: 'source_changed' });
      }
      NotificationService.notifyAdmin.mockClear();
      await refreshSmsCommitments({ conn: mockPg, now: new Date(due.getTime() + 1000), verify: async () => ({ verdict: 'open' }) });
      expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
      expect(NotificationService.notifyAdmin.mock.calls[0][3].metadata).toMatchObject({ sms_log_id: queue.id, commitment_id: rows[0].id });
    },
  );

  test('a recovered queue uses actual delivery time and endpoints with one canonical source id', async () => {
    await mockPg('sms_log').where({ id: message.id }).update({ operational_analysis: { version: 'already-analyzed' } });
    const sentAt = new Date(message.created_at.getTime() - 86400000);
    process.env.GATE_SMS_OPERATIONAL_ACTIONS_SINCE = new Date(sentAt.getTime() - 1000).toISOString();
    const queue = { ...message, id: randomUUID(), direction: 'outbound', message_type: 'manual', admin_user_id: '00000000-0000-4000-8000-000000000104',
      message_body: 'Queued template.', from_phone: numbers.locations.bradenton.number, to_phone: '+12025550199',
      scheduled_for: sentAt, status: 'sent' };
    const provider = { ...queue, id: randomUUID(), message_body: 'I will call tomorrow at 10 AM.',
      from_phone: message.to_phone, to_phone: message.from_phone, created_at: sentAt, scheduled_for: null,
      metadata: { scheduled_sms_log_id: queue.id } };
    await mockPg('sms_log').insert([queue, provider]);
    const extract = jest.fn(async (matched) => {
      expect(matched.message).toMatchObject({ id: queue.id, created_at: sentAt, message_body: provider.message_body,
        from_phone: provider.from_phone, to_phone: provider.to_phone });
      return require('../services/sms-operational-extractor').groundExtraction({ facts: [], additional_properties: [], obligations: [{
        party: 'waves', kind: 'callback', description: 'call', quote: provider.message_body, basis: 'promise', promise_firm: true, due_date: null, answered_by_payment: false,
        property_id: context.properties[0].id, due_text: 'tomorrow at 10 AM', due_at: null,
      }] }, matched);
    });
    await runSmsOperationalActions({ conn: mockPg, extract });
    expect(extract).toHaveBeenCalledTimes(1);
    const row = await mockPg('call_commitments').first();
    const due = require('../utils/datetime-et').parseQuotedETDeadline('tomorrow at 10 AM', sentAt);
    expect(row.sms_log_id).toBe(queue.id);
    expect(row.due_at).toEqual(due);
    expect(new Date(row.sms_context.source_at)).toEqual(sentAt);
  });

  test('post-activation queue recovery never imports a message sent before activation', async () => {
    await mockPg('sms_log').where({ id: message.id }).update({ operational_analysis: { version: 'already-analyzed' } });
    const queue = { ...message, id: randomUUID(), direction: 'outbound', message_type: 'manual', admin_user_id: '00000000-0000-4000-8000-000000000104',
      from_phone: message.to_phone, to_phone: message.from_phone, scheduled_for: new Date(), status: 'sent' };
    const provider = { ...queue, id: randomUUID(), created_at: new Date(message.created_at.getTime() - 86400000),
      scheduled_for: null, metadata: { scheduled_sms_log_id: queue.id } };
    await mockPg('sms_log').insert([queue, provider]);
    const extract = jest.fn();
    await runSmsOperationalActions({ conn: mockPg, extract });
    expect(extract).not.toHaveBeenCalled();
    const matched = await loadMessageContext(mockPg, queue);
    expect(await recordMessageOperations(mockPg, matched.message, result, matched)).toEqual({ skipped: 'outside_activation_window' });
    expect(await mockPg('call_commitments')).toHaveLength(0);
  });

  test('separate scheduled sends with identical text keep separate obligations', async () => {
    await mockPg('sms_log').where({ id: message.id }).update({ operational_analysis: { version: 'already-analyzed' } });
    const rows = [1, 2].map(() => ({ ...message, id: randomUUID(), direction: 'outbound', message_type: 'manual', admin_user_id: '00000000-0000-4000-8000-000000000104',
      message_body: 'I will call.', from_phone: message.to_phone, to_phone: message.from_phone,
      created_at: new Date(message.created_at.getTime() - 600), scheduled_for: new Date(message.created_at.getTime() - 800), status: 'sent' }));
    await mockPg('sms_log').insert(rows);
    const extract = async () => ({ facts: [], dropped: 0, obligations: [{ party: 'waves', kind: 'callback', description: 'call',
      quote: 'I will call.', basis: 'promise', property_id: context.properties[0].id, due_text: null, due_at: null }] });
    await runSmsOperationalActions({ conn: mockPg, extract });
    expect(await mockPg('call_commitments')).toHaveLength(2);
  });

  test.each(['failed', 'undelivered'])('a queued source cannot hide its %s provider delivery', async (status) => {
    message = { ...message, direction: 'outbound', message_type: 'manual', admin_user_id: '00000000-0000-4000-8000-000000000104', status: 'sent',
      from_phone: message.to_phone, to_phone: message.from_phone, scheduled_for: new Date() };
    await mockPg('sms_log').where({ id: message.id }).update(message);
    const provider = { ...message, id: randomUUID(), scheduled_for: null, status, metadata: { scheduled_sms_log_id: message.id } };
    await mockPg('sms_log').insert(provider);
    const extract = jest.fn();
    expect(await runSmsOperationalActions({ conn: mockPg, extract })).toMatchObject({ processed: 0, skipped: 0 });
    expect(extract).not.toHaveBeenCalled();
    expect(await mockPg('data_hygiene_source_extractions')).toHaveLength(0);
    context = await loadMessageContext(mockPg, message);
    expect(await recordMessageOperations(mockPg, message, result, context)).toEqual({ skipped: 'source_changed' });
    expect(await mockPg('call_commitments')).toHaveLength(0);
  });

  test('a later provider failure preserves the one already captured scheduled promise', async () => {
    message = { ...message, direction: 'outbound', message_type: 'manual', admin_user_id: '00000000-0000-4000-8000-000000000104', status: 'sent',
      from_phone: message.to_phone, to_phone: message.from_phone, scheduled_for: new Date() };
    await mockPg('sms_log').where({ id: message.id }).update(message);
    const provider = { ...message, id: randomUUID(), scheduled_for: null, metadata: { scheduled_sms_log_id: message.id } };
    await mockPg('sms_log').insert(provider);
    context = await loadMessageContext(mockPg, message);
    result.facts = [];
    await recordMessageOperations(mockPg, context.message, result, context);
    await mockPg('sms_log').where({ id: provider.id }).update({ status: 'undelivered' });
    const rows = await listSmsCommitments(mockPg, { customerId: message.customer_id });
    expect(rows).toHaveLength(1);
    await applySmsCommitmentUpdate(mockPg, rows[0].id, { customerId: message.customer_id, action: 'dismiss', reviewedBy: randomUUID() });
    expect(await mockPg('call_commitments').first()).toMatchObject({ status: 'dismissed' });
  });

  test('profile-only processing does not call a provider for human outbound SMS', async () => {
    delete process.env.GATE_SMS_COMMITMENT_FOLLOWUP;
    await mockPg('sms_log').where({ id: message.id }).update({ direction: 'outbound',
      from_phone: numbers.locations.parrish.number, to_phone: '+12025550101',
      message_type: 'manual', admin_user_id: '00000000-0000-4000-8000-000000000104', status: 'delivered' });
    const extract = jest.fn();
    await runSmsOperationalActions({ conn: mockPg, extract });
    expect(extract).not.toHaveBeenCalled();
    expect(await mockPg('data_hygiene_source_extractions').first()).toMatchObject({ status: 'no_fields' });
  });

  test('concurrent retries commit one profile proposal, obligation and extraction receipt', async () => {
    await Promise.all([
      recordMessageOperations(mockPg, message, result, context),
      recordMessageOperations(mockPg, message, result, context),
    ]);
    expect(await mockPg('call_commitments')).toHaveLength(1);
    expect(await mockPg('data_hygiene_source_extractions')).toHaveLength(1);
    expect(await mockPg('audit_log')).toHaveLength(0);
    expect(await mockPg('property_preferences')).toHaveLength(0);
    expect(await mockPg('data_hygiene_proposals')).toHaveLength(1);
    expect((await mockPg('sms_log').first()).operational_analysis.facts[0].outcome).toBe('proposed');
    // Existing Owed/call readers remain call-scoped. No new portal queue.
    expect(await listOpenCommitments(mockPg)).toEqual([]);
  });

  test('media metadata never reaches the extraction prompt', async () => {
    await mockPg('sms_log').where({ id: message.id }).update({ metadata: JSON.stringify({
      media: [{ url: 'https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/MM0/Media/ME0', key: 'sms-media/abc.jpg' }],
    }) });
    const extract = jest.fn().mockResolvedValue({ obligations: [], facts: [], dropped: 0 });
    await runSmsOperationalActions({ conn: mockPg, extract });
    expect(extract).toHaveBeenCalledTimes(1);
    const { message: current, history } = extract.mock.calls[0][0];
    expect(current).not.toHaveProperty('metadata');
    expect(JSON.stringify([current, ...history])).not.toContain('sms-media');
  });

  test('call-profile enrichment cannot overwrite a value written under the shared preference lock', async () => {
    const gates = require('../config/feature-gates').gates;
    gates.callProfileEnrichment = true;
    try {
      const { enrichFromCall } = require('../services/call-profile-enrichment');
      let lockTaken;
      const locked = new Promise((resolve) => { lockTaken = resolve; });
      const held = mockPg.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['property-preferences', String(message.customer_id)]);
        lockTaken();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await trx('property_preferences').insert({ customer_id: message.customer_id, access_notes: 'Use the side gate.' });
      });
      await locked;
      const enriched = enrichFromCall({ customerId: message.customer_id, callCreatedAt: '2026-09-06T00:00:00Z',
        extraction: { property: { access_notes: 'front gate code is 4545' } } });
      await Promise.all([held, enriched]);
      const prefs = await mockPg('property_preferences').where({ customer_id: message.customer_id });
      expect(prefs).toHaveLength(1);
      expect(prefs[0].access_notes).toContain('Use the side gate.');
      expect(prefs[0].access_notes).toContain('[call 2026-09-06] front gate code is 4545');
      expect(prefs[0].property_gate_code).toBe('4545');
    } finally {
      gates.callProfileEnrichment = false;
    }
  });

  test('a failed receipt rolls back profile proposal, commitment and processed marker together', async () => {
    await mockPg.schema.renameTable('data_hygiene_source_extractions', 'sms_receipts_unavailable');
    try {
      await expect(recordMessageOperations(mockPg, message, result, context)).rejects.toThrow();
      expect(await mockPg('property_preferences')).toHaveLength(0);
      expect(await mockPg('call_commitments')).toHaveLength(0);
      expect((await mockPg('sms_log').first()).operational_analysis).toBeNull();
    } finally {
      await mockPg.schema.renameTable('sms_receipts_unavailable', 'data_hygiene_source_extractions');
    }
  });

  test('an all-property request is retained once without accepting two guessed property assignments', async () => {
    const secondProperty = randomUUID();
    await mockPg('customer_properties').insert({ id: secondProperty, customer_id: message.customer_id,
      address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236', active: true });
    message.message_body = 'Please send an estimate for both properties';
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: message.message_body });
    const first = { ...result.obligations[0], quote: message.message_body };
    result = { dropped: 0, facts: [], obligations: [first, { ...first, property_id: secondProperty }] };
    await recordMessageOperations(mockPg, message, result, context);
    const rows = await mockPg('call_commitments');
    expect(rows).toHaveLength(1);
    expect(rows[0].sms_context).toMatchObject({ property_id: null, property_ambiguous: true });
    expect(rows[0].evidence[0].quote).toBe(message.message_body);
  });

  test('different deliverables in the same quote retain separate obligations', async () => {
    message.message_body = 'Please send the inspection report and the treatment report';
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: message.message_body });
    const first = { ...result.obligations[0], kind: 'send_report', quote: message.message_body,
      description: 'the inspection report' };
    result = { dropped: 0, facts: [], obligations: [first, { ...first, description: 'the treatment report' }] };
    await recordMessageOperations(mockPg, message, result, context);
    expect(await mockPg('call_commitments')).toHaveLength(2);
  });

  test('a source relink during extraction does not update the originally matched customer', async () => {
    await mockPg('sms_log').where({ id: message.id }).update({ customer_id: null });
    expect(await recordMessageOperations(mockPg, message, result, context)).toEqual({ skipped: 'source_changed' });
    expect(await mockPg('property_preferences')).toHaveLength(0);
    expect(await mockPg('call_commitments')).toHaveLength(0);
  });

  

  test('all cross-channel query shapes execute against the migrated schema', async () => {
    const evidence = await loadSmsFulfillmentEvidence(mockPg, {}, message, new Date());
    expect(evidence.failures).toEqual([]);
    expect(evidence.records).toEqual([]);
  });

  test('an old email row retried after the request is selected by its delivery event', async () => {
    const before = new Date(message.created_at.getTime() - 1000);
    const after = new Date(message.created_at.getTime() + 1000);
    const base = { recipient_type: 'customer', recipient_id: message.customer_id,
      recipient_email_snapshot: 'synthetic@example.invalid', created_at: before,
      text_snapshot: 'Your appointment is confirmed', status: 'delivered' };
    const [retried] = await mockPg('email_messages').insert({ ...base, sent_at: after, delivered_at: after }).returning('id');
    await mockPg('email_messages').insert({ ...base, sent_at: before, delivered_at: before });
    const evidence = await loadSmsFulfillmentEvidence(mockPg, {}, message, new Date(after.getTime() + 1000));
    expect(evidence.failures).toEqual([]);
    expect(evidence.records.filter((r) => r.type === 'email_delivery').map((r) => r.id)).toEqual([retried.id]);
    expect(evidence.records[0].recipient_email_snapshot).toBe(base.recipient_email_snapshot);
    expect(admissibleWitness(evidence.records[0], { kind: 'send_appointment_confirmation',
      evidence: [{ quote: 'Send the confirmation to synthetic@example.invalid' }] })).toBe(true);
    expect(admissibleWitness(evidence.records[0], { kind: 'send_appointment_confirmation',
      evidence: [{ quote: 'Send the confirmation to another@example.invalid' }] })).toBe(false);
  });

  test.each([
    [{ opened_at: true }, true], [{ clicked_at: true }, true], [{}, false], [{ opened_at: true, bounced_at: true }, false],
  ])('an opened or clicked email whose delivery event was lost still proves receipt: %j → %s', async (marks, admissible) => {
    const after = new Date(message.created_at.getTime() + 1000);
    const stamps = Object.fromEntries(Object.keys(marks).map((k) => [k, after]));
    await mockPg('email_messages').insert({ recipient_type: 'customer', recipient_id: message.customer_id,
      recipient_email_snapshot: 'synthetic@example.invalid', text_snapshot: 'Your appointment is confirmed',
      status: 'sent', sent_at: after, ...stamps });
    const evidence = await loadSmsFulfillmentEvidence(mockPg, {}, message, new Date(after.getTime() + 1000));
    expect(evidence.records.filter((r) => r.type === 'email_delivery')).toHaveLength(1);
    expect(admissibleWitness(evidence.records[0], { kind: 'send_appointment_confirmation',
      evidence: [{ quote: 'Send the confirmation to synthetic@example.invalid' }] })).toBe(admissible);
  });

  test('persisted evidence checks avoid repeated LLM calls and rerun after a delivery changes', async () => {
    // R3 (owner ruling 2026-09-24): a delivered staff SMS no longer closes an
    // `other` ask. This test's own subject is the evidence-hash cache/rerun
    // behavior, so it runs against a kind that still admits an sms witness.
    result.obligations[0] = { ...result.obligations[0], kind: 'send_appointment_confirmation',
      due_at: new Date(message.created_at.getTime() + 1000).toISOString() };
    await recordMessageOperations(mockPg, message, result, context);
    const [reply] = await mockPg('sms_log').insert({ ...message, id: randomUUID(), direction: 'outbound',
      from_phone: message.to_phone, to_phone: message.from_phone, message_body: 'Still checking',
      message_type: 'manual', admin_user_id: '00000000-0000-4000-8000-000000000104', status: 'sent', created_at: new Date(message.created_at.getTime() + 1000) }).returning('id');
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    const now = new Date(message.created_at.getTime() + 2000);
    await refreshSmsCommitments({ conn: mockPg, now });
    await refreshSmsCommitments({ conn: mockPg, now: new Date(now.getTime() + 300000) });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect((await mockPg('call_commitments').first()).sms_context.fulfillment_check.evidence_hash).toBeTruthy();
    await mockPg('sms_log').where({ id: reply.id }).update({ status: 'delivered', message_body: 'The issue is resolved' });
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'fulfilled', record_ref: `sms:${reply.id}`, quote: 'The issue is resolved' } });
    await refreshSmsCommitments({ conn: mockPg, now: new Date(now.getTime() + 600000) });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(2);
    expect((await mockPg('call_commitments').first()).status).toBe('fulfilled');
  });

  test('a verdict cached under an earlier fulfillment policy is rechecked', async () => {
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true,
      due_at: new Date(message.created_at.getTime() + 1000).toISOString() };
    await recordMessageOperations(mockPg, message, result, context);
    const now = new Date(message.created_at.getTime() + 2000);
    const commitment = await mockPg('call_commitments').first();
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const current = fulfillmentFingerprint(commitment, evidence).evidenceHash;
    const stale = { verdict: 'uncertain', reason: 'incomplete_sources', evidence_hash: current, retry_after: null };
    // Same evidence, same hash: the cache holds. A policy bump changes the
    // hash for identical evidence, so the stale verdict is not reused.
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    const cached = { ...commitment, sms_context: { ...commitment.sms_context, fulfillment_check: stale } };
    expect(await verifySmsFulfillment(cached, evidence, { now })).toMatchObject({ reason: 'incomplete_sources' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(typeof FULFILLMENT_POLICY).toBe('number');
    const previousPolicyHash = require('../services/data-hygiene/source-extraction-store').hashExtractionSource(
      JSON.stringify({ version: require('../services/sms-operational-extractor').VERSION,
        fulfillmentPolicy: FULFILLMENT_POLICY - 1, policy: require('../config/models').TEXT_POLICIES.highStakes,
        obligation: fulfillmentFingerprint(commitment, evidence).obligation,
        records: [...evidence.records].sort((a, b) => a.ref.localeCompare(b.ref)), failures: [] }));
    expect(previousPolicyHash).not.toBe(current);
    const older = { ...commitment, sms_context: { ...commitment.sms_context, fulfillment_check: { ...stale, evidence_hash: previousPolicyHash } } };
    const rechecked = await verifySmsFulfillment(older, evidence, { now });
    expect(rechecked).toMatchObject({ verdict: 'open', evidence_hash: current });
    expect(rechecked.reason).toBeUndefined();
  });

  test('archived owners stop processing until restoration without losing the obligation', async () => {
    result.obligations[0].due_at = new Date(message.created_at.getTime() + 1000).toISOString();
    await recordMessageOperations(mockPg, message, result, context);
    const verify = jest.fn().mockResolvedValue({ verdict: 'open' });
    const now = new Date(message.created_at.getTime() + 2000);
    await mockPg('customers').where({ id: message.customer_id }).update({ deleted_at: now });
    await refreshSmsCommitments({ conn: mockPg, verify, now });
    expect(verify).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    await mockPg('customers').where({ id: message.customer_id }).update({ deleted_at: null });
    await refreshSmsCommitments({ conn: mockPg, verify, now });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('archiving during verification suppresses the result and bell', async () => {
    result.obligations[0].due_at = new Date(message.created_at.getTime() + 1000).toISOString();
    await recordMessageOperations(mockPg, message, result, context);
    const now = new Date(message.created_at.getTime() + 2000);
    const verify = jest.fn(async () => {
      await mockPg('customers').where({ id: message.customer_id }).update({ deleted_at: now });
      return { verdict: 'fulfilled' };
    });
    await refreshSmsCommitments({ conn: mockPg, verify, now });
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('visit witnesses distinguish old work from post-request creation and transitions', async () => {
    const before = new Date(message.created_at.getTime() - 1000);
    const after = new Date(message.created_at.getTime() + 1000);
    const base = { customer_id: message.customer_id, property_id: context.properties[0].id,
      service_type: 'Quarterly Lawn', scheduled_date: etDateString(message.created_at),
      window_start: '09:00:00', created_at: before };
    const rows = await mockPg('scheduled_services').insert([
      { ...base, status: 'confirmed', completed_at: null },
      { ...base, status: 'confirmed', created_at: after, completed_at: null },
      { ...base, status: 'completed', completed_at: before },
      { ...base, status: 'completed', completed_at: after },
      { ...base, status: 'rescheduled', completed_at: null },
    ]).returning('id');
    await mockPg('job_status_history').insert({ job_id: rows[4].id, from_status: 'confirmed',
      to_status: 'rescheduled', transitioned_at: after });
    const evidence = await loadSmsFulfillmentEvidence(mockPg, {}, message, new Date(after.getTime() + 1000));
    expect(evidence.failures).toEqual([]);
    const sms_context = { property_id: base.property_id, source_at: message.created_at.toISOString(), money_answerable: true };
    const allowed = (kind) => evidence.records.filter((r) => admissibleWitness(r, { kind, sms_context })).map((r) => r.id).sort();
    expect(allowed('schedule_visit')).toEqual([rows[1].id, rows[4].id].sort());
    expect(allowed('technician_follow_up')).toEqual([rows[3].id]);
  });

  test('a same-status date move proves a scheduling request only through a logged before/after date', async () => {
    const before = new Date(message.created_at.getTime() - 1000);
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const base = { customer_id: message.customer_id, property_id: context.properties[0].id,
      service_type: 'Quarterly Lawn', scheduled_date: etDateString(after), window_start: '09:00:00',
      status: 'confirmed', created_at: before, updated_at: after };
    const nextWeek = etDateString(new Date(after.getTime() + 7 * 86400000));
    const [moved, touched, sameDate, earlyMove, noShow, movedBeforeRequest] = await mockPg('scheduled_services')
      .insert([{ ...base, scheduled_date: nextWeek }, base, base, { ...base, scheduled_date: nextWeek }, base,
        { ...base, scheduled_date: nextWeek, updated_at: before }]).returning('id');
    await mockPg('reschedule_log').insert([
      // The log row lands after the move commits: a row last changed before
      // the request was moved before it, whatever the log's insert time.
      { scheduled_service_id: movedBeforeRequest.id, customer_id: message.customer_id, original_date: etDateString(after),
        new_date: nextWeek, initiated_by: 'admin_ib', created_at: after },
      // A no-show entry records the missed date with no new date: not a move.
      { scheduled_service_id: noShow.id, customer_id: message.customer_id, original_date: etDateString(after),
        new_date: null, reason_code: 'customer_noshow', initiated_by: 'system', created_at: after },
      { scheduled_service_id: moved.id, customer_id: message.customer_id, original_date: etDateString(after),
        new_date: nextWeek, initiated_by: 'admin', created_at: after },
      { scheduled_service_id: sameDate.id, customer_id: message.customer_id, original_date: etDateString(after),
        new_date: etDateString(after), initiated_by: 'admin', created_at: after },
      { scheduled_service_id: earlyMove.id, customer_id: message.customer_id, original_date: etDateString(after),
        new_date: nextWeek, initiated_by: 'admin', created_at: before },
    ]);
    const evidence = await loadSmsFulfillmentEvidence(mockPg, {}, message, now);
    expect(evidence.failures).toEqual([]);
    const ids = evidence.records.filter((r) => r.type === 'visit').map((r) => r.id);
    expect(ids).toEqual([moved.id]);
    expect(ids).not.toContain(touched.id);
    expect(ids).not.toContain(noShow.id);
    expect(ids).not.toContain(movedBeforeRequest.id);
    const record = evidence.records.find((r) => r.id === moved.id);
    expect(record.text).toContain('moved after the request');
    const sms_context = { property_id: base.property_id, source_at: message.created_at.toISOString(), money_answerable: true };
    expect(admissibleWitness(record, { kind: 'schedule_visit', sms_context })).toBe(true);
    expect(admissibleWitness(record, { kind: 'technician_follow_up', sms_context })).toBe(false);
  });

  test.each([
    ['a forward chain landing on the current date', ['A>B', 'B>C'], 'C', true],
    ['a chain reverted to the original date', ['A>B', 'B>A'], 'A', false],
    ['a latest move that does not describe the current row', ['A>B'], 'C', false],
  ])('move chains prove a move only by their net result: %s', async (_label, chain, current, admissible) => {
    const before = new Date(message.created_at.getTime() - 1000);
    const after = new Date(message.created_at.getTime() + 1000);
    const day = (letter) => etDateString(new Date(after.getTime() + { A: 0, B: 7, C: 14 }[letter] * 86400000));
    const [visit] = await mockPg('scheduled_services').insert({ customer_id: message.customer_id, property_id: context.properties[0].id,
      service_type: 'Quarterly Lawn', scheduled_date: day(current), window_start: '09:00:00', status: 'confirmed', created_at: before }).returning('id');
    await mockPg('reschedule_log').insert(chain.map((step, i) => ({ scheduled_service_id: visit.id, customer_id: message.customer_id,
      original_date: day(step[0]), new_date: day(step[2]), initiated_by: 'admin', created_at: new Date(after.getTime() + i * 1000) })));
    const evidence = await loadSmsFulfillmentEvidence(mockPg, {}, message, new Date(after.getTime() + 60000));
    const record = evidence.records.find((r) => r.type === 'visit' && r.id === visit.id);
    expect(!!record).toBe(true);
    const sms_context = { property_id: context.properties[0].id, source_at: message.created_at.toISOString(), money_answerable: true };
    expect(admissibleWitness(record, { kind: 'schedule_visit', sms_context })).toBe(admissible);
    expect(record.text.includes('moved after the request')).toBe(admissible);
  });

  test.each([
    ['a same-day change', [['09:00-11:00', '13:00-15:00']], '13:00:00', true],
    ['a forward same-day chain', [['09:00-11:00', '11:00-13:00'], ['11:00-13:00', '13:00-15:00']], '13:00:00', true],
    ['a reverted same-day chain', [['09:00-11:00', '13:00-15:00'], ['13:00-15:00', '09:00-11:00']], '09:00:00', false],
    ['a latest window that does not describe the current row', [['09:00-11:00', '13:00-15:00']], '15:00:00', false],
    ['a missing original window', [[null, '13:00-15:00']], '13:00:00', false],
  ])('window-move evidence requires a net change: %s', async (_label, chain, current, admissible) => {
    const before = new Date(message.created_at.getTime() - 1000);
    const after = new Date(message.created_at.getTime() + 1000);
    const day = etDateString(after);
    const [visit] = await mockPg('scheduled_services').insert({ customer_id: message.customer_id,
      property_id: context.properties[0].id, service_type: 'Quarterly Lawn', scheduled_date: day,
      window_start: current, status: 'confirmed', created_at: before, updated_at: after }).returning('id');
    await mockPg('reschedule_log').insert(chain.map(([original_window, new_window], i) => ({
      scheduled_service_id: visit.id, customer_id: message.customer_id,
      original_date: day, new_date: day, original_window, new_window, initiated_by: 'admin',
      created_at: new Date(after.getTime() + i * 1000),
    })));
    const evidence = await loadSmsFulfillmentEvidence(mockPg, {}, message, new Date(after.getTime() + 60000));
    expect(evidence.failures).toEqual([]);
    const record = evidence.records.find((r) => r.type === 'visit' && r.id === visit.id);
    const sms_context = { property_id: context.properties[0].id, source_at: message.created_at.toISOString(), money_answerable: true };
    expect(Boolean(record && admissibleWitness(record, { kind: 'schedule_visit', sms_context }))).toBe(admissible);
    expect(Boolean(record?.text.includes('moved after the request'))).toBe(admissible);
  });

  test.each(['send_report', 'send_paperwork'])('%s keeps its empty witness allowlist: a delivered staff text is no proof', async (kind) => {
    const after = new Date(message.created_at.getTime() + 1000);
    const [reply] = await mockPg('sms_log').insert({ ...message, id: randomUUID(), direction: 'outbound',
      from_phone: message.to_phone, to_phone: message.from_phone, message_body: 'I sent the report and paperwork',
      message_type: 'manual', admin_user_id: '00000000-0000-4000-8000-000000000104', status: 'delivered', created_at: after }).returning('id');
    const evidence = await loadSmsFulfillmentEvidence(mockPg, {}, message, new Date(after.getTime() + 1000));
    const commitment = { kind, evidence: [{ quote: 'Please send the report and paperwork' }],
      sms_context: { property_id: context.properties[0].id, source_at: message.created_at.toISOString(), money_answerable: true } };
    const witness = evidence.records.find((r) => r.id === reply.id);
    expect(admissibleWitness(witness, commitment, evidence.records)).toBe(false);
    expect(groundFulfillment({ verdict: 'fulfilled', record_ref: witness.ref, quote: 'I sent the report' }, evidence, commitment))
      .toMatchObject({ verdict: 'uncertain', reason: 'invalid_witness' });
    expect(groundFulfillment({ verdict: 'fulfilled', record_ref: witness.ref, quote: 'I sent the report' },
      { ...evidence, failures: ['sms_truncated'] }, commitment)).toMatchObject({ verdict: 'uncertain' });
  });

  test('a recipient-specific estimate request treats estimate-delivery email truncation as fatal', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [estimate] = await mockPg('estimates').insert({ customer_id: message.customer_id, property_id: context.properties[0].id,
      status: 'sent', service_interest: 'Lawn', estimate_data: { deliveryState: { lastDeliveredAt: after.toISOString() } } }).returning('id');
    const [email] = await mockPg('email_messages').insert({ recipient_type: 'customer', recipient_id: message.customer_id,
      recipient_email_snapshot: 'synthetic@example.invalid', trigger_event_id: `estimate_delivery:${estimate.id}`,
      status: 'delivered', sent_at: after, delivered_at: after, text_snapshot: 'Your lawn estimate is attached' }).returning('id');
    const evidence = await loadSmsFulfillmentEvidence(mockPg, {}, message, now);
    const commitment = { kind: 'send_estimate', evidence: [{ quote: 'Email the lawn estimate to synthetic@example.invalid' }],
      sms_context: { property_id: context.properties[0].id, source_at: message.created_at.toISOString(), money_answerable: true } };
    const witness = evidence.records.find((r) => r.id === email.id);
    const complete = groundFulfillment({ verdict: 'fulfilled', record_ref: witness.ref, quote: 'lawn estimate' }, evidence, commitment);
    expect(complete).toMatchObject({ verdict: 'fulfilled', linked_record_type: 'estimate', linked_record_id: estimate.id });
    const truncated = { ...evidence, failures: ['email_delivery_truncated'] };
    expect(groundFulfillment({ verdict: 'fulfilled', record_ref: witness.ref, quote: 'lawn estimate' }, truncated, commitment))
      .toMatchObject({ verdict: 'uncertain', reason: 'incomplete_sources', failures: ['email_delivery_truncated'] });
  });

  test.each(['same', 'other'])('an estimate-delivery email cited for a plain quote ask grounds on its estimate (%s property)', async (which) => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'send_estimate', quote: 'Can I get a quote please',
      description: 'get a quote', due_at: after.toISOString() };
    await recordMessageOperations(mockPg, message, result, context);
    const commitment = await mockPg('call_commitments').first();
    const propertyId = which === 'same' ? context.properties[0].id
      : (await mockPg('customer_properties').insert({ customer_id: message.customer_id, address_line1: '400 Other Lane',
        city: 'Sarasota', zip: '34236', active: true }).returning('id'))[0].id;
    const [estimate] = await mockPg('estimates').insert({ customer_id: message.customer_id, property_id: propertyId,
      status: 'sent', service_interest: 'Pest Control', estimate_data: { deliveryState: { lastDeliveredAt: after.toISOString() } } }).returning('id');
    const [email] = await mockPg('email_messages').insert({ recipient_type: 'customer', recipient_id: message.customer_id,
      recipient_email_snapshot: 'synthetic@example.invalid', trigger_event_id: `estimate_delivery:${estimate.id}`,
      status: 'delivered', sent_at: after, delivered_at: after, text_snapshot: 'Your customized Waves estimate is ready for review' }).returning('id');
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'fulfilled', record_ref: `email_delivery:${email.id}`, quote: 'estimate is ready for review' } });
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const verdict = await verifySmsFulfillment(commitment, evidence, { now });
    if (which === 'other') {
      expect(verdict).toMatchObject({ verdict: 'uncertain', reason: 'invalid_witness' });
      return;
    }
    expect(verdict).toMatchObject({ verdict: 'fulfilled', record_type: 'estimate', record_id: estimate.id });
    await mockPg.transaction(async (trx) => {
      await trx('customers').where({ id: message.customer_id }).forUpdate().first();
      expect(await revalidateSmsFulfillment(trx, commitment, message, verdict, now)).toBe(true);
    });
  });

  test('owner ruling 2026-09-28: the check is told a late record still keeps a promise (keptLate rings first)', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], basis: 'promise', kind: 'other', party: 'waves',
      quote: result.obligations[0].quote, due_at: new Date(message.created_at.getTime() + 1000).toISOString() };
    await recordMessageOperations(mockPg, message, result, context);
    const commitment = await mockPg('call_commitments').first();
    const now = new Date(message.created_at.getTime() + 5000);
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    await verifySmsFulfillment(commitment, { records: [{ ref: 'sms:x', type: 'sms', id: 'x', text: 'hi', created_at: now }], failures: [] }, { now });
    const prompt = dispatchWithFallback.mock.calls.at(-1)?.[1]?.text || '';
    expect(prompt).toContain('a record after the promised day still fulfills it');
    expect(prompt).not.toContain('on the promised day when sms_context.due_date names one');
  });

  test('revalidation of an estimate-delivery witness also holds the linked estimate without waiting', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], quote: 'Please email the estimate to synthetic@example.invalid',
      description: 'email the estimate to synthetic@example.invalid', due_at: after.toISOString() };
    await recordMessageOperations(mockPg, message, result, context);
    const commitment = await mockPg('call_commitments').first();
    const [estimate] = await mockPg('estimates').insert({ customer_id: message.customer_id, property_id: context.properties[0].id,
      status: 'sent', service_interest: 'Lawn', estimate_data: { deliveryState: { lastDeliveredAt: after.toISOString() } } }).returning('id');
    const [email] = await mockPg('email_messages').insert({ recipient_type: 'customer', recipient_id: message.customer_id,
      recipient_email_snapshot: 'synthetic@example.invalid', trigger_event_id: `estimate_delivery:${estimate.id}`,
      status: 'delivered', sent_at: after, delivered_at: after, text_snapshot: 'Your lawn estimate is attached' }).returning('id');
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'fulfilled', record_ref: `email_delivery:${email.id}`, quote: 'lawn estimate' } });
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const verdict = await verifySmsFulfillment(commitment, evidence, { now });
    expect(verdict).toMatchObject({ verdict: 'fulfilled', record_type: 'email_delivery', linked_record_id: estimate.id });
    const estimateWriter = await mockPg.transaction();
    try {
      await estimateWriter('estimates').where({ id: estimate.id }).forUpdate().first();
      await mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '500ms'");
        await trx('customers').where({ id: message.customer_id }).forUpdate().first();
        expect(await revalidateSmsFulfillment(trx, commitment, message, verdict, now)).toBe(false);
      });
    } finally {
      await estimateWriter.rollback();
    }
    await mockPg.transaction(async (trx) => {
      expect(await revalidateSmsFulfillment(trx, commitment, message, verdict, now)).toBe(true);
    });
  });

  test('a lead-addressed proposal delivery is reached through the customer\'s estimate', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [estimate] = await mockPg('estimates').insert({ customer_id: message.customer_id, property_id: context.properties[0].id,
      status: 'sent', service_interest: 'Commercial', estimate_data: { deliveryState: { lastDeliveredAt: after.toISOString() } } }).returning('id');
    const [email] = await mockPg('email_messages').insert({ recipient_type: 'lead', recipient_id: null,
      recipient_email_snapshot: 'synthetic@example.invalid', trigger_event_id: `estimate_delivery:${estimate.id}`,
      status: 'delivered', sent_at: after, delivered_at: after, text_snapshot: 'Your commercial proposal is attached' }).returning('id');
    await mockPg('email_messages').insert({ recipient_type: 'lead', recipient_id: null,
      recipient_email_snapshot: 'synthetic@example.invalid', trigger_event_id: `estimate_delivery:${randomUUID()}`,
      status: 'delivered', sent_at: after, delivered_at: after, text_snapshot: 'Another business\'s proposal' });
    const evidence = await loadSmsFulfillmentEvidence(mockPg, {}, message, now);
    expect(evidence.records.filter((r) => r.type === 'email_delivery').map((r) => r.id)).toEqual([email.id]);
    const commitment = { kind: 'send_estimate', evidence: [{ quote: 'Email the proposal to synthetic@example.invalid' }],
      sms_context: { property_id: context.properties[0].id, source_at: message.created_at.toISOString(), money_answerable: true } };
    expect(admissibleWitness(evidence.records.find((r) => r.id === email.id), commitment, evidence.records)).toBe(true);
  });

  test.each([
    ['delivery email names an admissible estimate', 'ok', true],
    ['delivery email names an estimate handed off before the request', 'early', false],
    ['delivery email names an estimate for another property', 'other_property', false],
    ['a non-estimate email to the recipient', 'unrelated', false],
    ['the estimate delivery went to a different address', 'other_recipient', false],
  ])('recipient-specific estimate closure: %s', async (_label, variant, admissible) => {
    const before = new Date(message.created_at.getTime() - 1000);
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [otherProperty] = await mockPg('customer_properties').insert({ customer_id: message.customer_id,
      address_line1: '200 Other Lane', city: 'Sarasota', zip: '34236', active: true }).returning('id');
    const handoff = variant === 'early' ? before : after;
    const [estimate] = await mockPg('estimates').insert({ customer_id: message.customer_id,
      property_id: variant === 'other_property' ? otherProperty.id : context.properties[0].id, status: 'sent', service_interest: 'Lawn',
      estimate_data: { deliveryState: { lastDeliveredAt: handoff.toISOString() } }, created_at: before }).returning('id');
    // Keep the linkage fixture stable: a random UUID can coincidentally
    // match the conservative PAN scrubber (covered separately below).
    const [email] = await mockPg('email_messages').insert({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', recipient_type: 'customer', recipient_id: message.customer_id,
      recipient_email_snapshot: variant === 'other_recipient' ? 'someone.else@example.invalid' : 'synthetic@example.invalid',
      trigger_event_id: variant === 'unrelated' ? 'appointment_reminder:1' : `estimate_delivery:${estimate.id}`,
      status: 'delivered', sent_at: after, delivered_at: after, text_snapshot: 'Your lawn estimate is attached' }).returning('id');
    const evidence = await loadSmsFulfillmentEvidence(mockPg, {}, message, now);
    expect(evidence.failures).toEqual([]);
    const witness = evidence.records.find((r) => r.type === 'email_delivery' && r.id === email.id);
    const commitment = { kind: 'send_estimate', evidence: [{ quote: 'Email the lawn estimate to synthetic@example.invalid' }],
      sms_context: { property_id: context.properties[0].id, source_at: message.created_at.toISOString(), money_answerable: true } };
    expect(admissibleWitness(witness, commitment, evidence.records)).toBe(admissible);
    const verdict = groundFulfillment({ verdict: 'fulfilled', record_ref: witness.ref, quote: 'lawn estimate' }, evidence, commitment);
    expect(verdict).toMatchObject({ verdict: admissible ? 'fulfilled' : 'uncertain' });
    if (admissible) expect(verdict).toMatchObject({ record_type: 'email_delivery', record_id: email.id });
    if (admissible) {
      // A UUID's digit groups can collide with PAN detection (~1 in 500).
      // The ref is an id this codebase generates, so it is exempt from the
      // scrubber and still proves the delivery it names.
      const ref = 'email_delivery:32ceafcc-2687-4973-8880-53182e45a0ce';
      expect(groundFulfillment({ verdict: 'fulfilled', record_ref: ref, quote: 'lawn estimate' },
        { ...evidence, records: evidence.records.map((r) => r === witness ? { ...r, ref } : r) }, commitment))
        .toMatchObject({ verdict: 'fulfilled', record_type: 'email_delivery' });
      // A card number in the model's own quote is still fatal.
      expect(groundFulfillment({ verdict: 'fulfilled', record_ref: witness.ref, quote: '4242 4242 4242 4242' },
        evidence, commitment)).toMatchObject({ verdict: 'uncertain', reason: 'sensitive_model_output' });
    }
  });

  test('estimate and visit truncation stays fatal because those queries are not activity-ordered', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const [call] = await mockPg('call_log').insert({ customer_id: message.customer_id, direction: 'outbound',
      from_phone: numbers.locations.parrish.number, to_phone: message.from_phone, status: 'completed', duration_seconds: 90,
      transcription: 'Returned your call about the gate code', created_at: new Date(after.getTime() + 120000) }).returning('id');
    await mockPg('scheduled_services').insert(Array.from({ length: 51 }, (_, i) => ({ customer_id: message.customer_id,
      property_id: context.properties[0].id, service_type: 'Quarterly Lawn', status: 'confirmed', window_start: '09:00:00',
      scheduled_date: etDateString(new Date(after.getTime() + i * 86400000)), created_at: new Date(after.getTime() + i * 1000) })));
    const evidence = await loadSmsFulfillmentEvidence(mockPg, {}, message, new Date(after.getTime() + 240000));
    expect(evidence.failures).toEqual(['visit_truncated']);
    const commitment = { kind: 'callback', evidence: [{ quote: 'Please call me back' }],
      sms_context: { property_id: context.properties[0].id, source_at: message.created_at.toISOString(), money_answerable: true } };
    expect(groundFulfillment({ verdict: 'fulfilled', record_ref: `call:${call.id}`, quote: 'Returned your call' }, evidence, commitment))
      .toMatchObject({ verdict: 'uncertain', reason: 'incomplete_sources', failures: ['visit_truncated'] });
  });

  test.each([
    ['witness channel truncated', 'call', 60, false],
    ['supporting channel truncated but its window reaches before the witness', 'sms', 60, true],
    ['supporting channel truncated with its oldest retained row tied at the witness instant', 'sms', 59, false],
    ['supporting channel truncated past the witness', 'sms', 0, false],
    // Codex #4996 r1: a truncated payment leg relaxes like any ordered source
    // for a kind that can never cite a payment.
    ['payment leg truncated but its window reaches before the witness', 'payment', 60, true],
    ['payment leg truncated past the witness', 'payment', 0, false],
  ])('evidence completeness: %s', async (_label, channel, witnessOffsetSeconds, fulfilled) => {
    const after = new Date(message.created_at.getTime() + 1000);
    const witnessAt = new Date(after.getTime() + witnessOffsetSeconds * 1000);
    const now = new Date(after.getTime() + 120000);
    const [call] = await mockPg('call_log').insert({ customer_id: message.customer_id, direction: 'outbound',
      from_phone: numbers.locations.parrish.number, to_phone: message.from_phone, status: 'completed', duration_seconds: 90,
      transcription: 'Returned your call about the gate code', created_at: witnessAt }).returning('id');
    // 51 rows of the truncated channel: the oldest is dropped. When the window
    // must reach the witness, the second-oldest row sits one second before
    // the witness; otherwise every row postdates a witness the cut hides.
    const rows = Array.from({ length: 51 }, (_, i) => ({ customer_id: message.customer_id, direction: 'outbound',
      from_phone: numbers.locations.parrish.number, to_phone: message.from_phone, status: 'delivered',
      created_at: new Date(after.getTime() + (channel === 'call' || witnessOffsetSeconds === 0 ? 1 : 58) * 1000 + i * 1000) }));
    if (channel === 'call') {
      await mockPg('call_log').insert(rows.map((r) => ({ ...r, duration_seconds: 5, transcription: 'voicemail' })));
    } else if (channel === 'payment') {
      await mockPg('payments').insert(rows.map((r) => ({ customer_id: r.customer_id, amount: 10, status: 'paid', payment_date: etDateString(r.created_at),
        metadata: JSON.stringify({ source: 'account_credit_prepayment', method: 'cash' }), created_at: r.created_at })));
    } else {
      await mockPg('sms_log').insert(rows.map((r) => ({ ...r, message_type: 'manual', message_body: 'Context message' })));
    }
    const evidence = await loadSmsFulfillmentEvidence(mockPg, {}, message, now);
    expect(evidence.failures).toEqual([`${channel}_truncated`]);
    const commitment = { kind: 'callback', evidence: [{ quote: 'Please call me back' }],
      sms_context: { property_id: context.properties[0].id, source_at: message.created_at.toISOString(), money_answerable: true } };
    const verdict = groundFulfillment({ verdict: 'fulfilled', record_ref: `call:${call.id}`, quote: 'Returned your call' }, evidence, commitment);
    expect(verdict.verdict).toBe(fulfilled ? 'fulfilled' : 'uncertain');
    if (!fulfilled) expect(verdict).toMatchObject({ reason: 'incomplete_sources', failures: [`${channel}_truncated`] });
  });

  test('progressed visits preserve booking proof without inventing it from progress', async () => {
    const before = new Date(message.created_at.getTime() - 1000);
    const after = new Date(message.created_at.getTime() + 1000);
    const base = { customer_id: message.customer_id, property_id: context.properties[0].id,
      service_type: 'Quarterly Lawn', scheduled_date: etDateString(message.created_at),
      window_start: '09:00:00', created_at: after };
    const statuses = ['en_route', 'on_site', 'completed', 'cancelled', 'skipped'];
    const rows = await mockPg('scheduled_services').insert([
      ...statuses.map((status) => ({ ...base, status })),
      { ...base, status: 'en_route', created_at: before },
      { ...base, status: 'completed', created_at: before },
    ]).returning('id');
    await mockPg('job_status_history').insert([
      { job_id: rows[5].id, from_status: 'confirmed', to_status: 'en_route', transitioned_at: after },
      { job_id: rows[6].id, from_status: 'confirmed', to_status: 'rescheduled', transitioned_at: after },
      { job_id: rows[6].id, from_status: 'on_site', to_status: 'completed', transitioned_at: new Date(after.getTime() + 100) },
    ]);
    const commitment = { kind: 'schedule_visit', sms_context: {
      property_id: base.property_id, source_at: message.created_at.toISOString(),
    } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, new Date(after.getTime() + 1000));
    expect(evidence.failures).toEqual([]);
    expect(evidence.records.filter((r) => admissibleWitness(r, commitment)).map((r) => r.id).sort())
      .toEqual([rows[0].id, rows[1].id, rows[2].id, rows[6].id].sort());
  });

  test.each([['other', 'en_route'], ['callback', 'on_site']])(
    'owner ruling 2026-09-24: real post-request field progress nullifies a %s ask; before it or a mere booking does not',
    async (kind, status) => {
      const before = new Date(message.created_at.getTime() - 1000);
      const after = new Date(message.created_at.getTime() + 1000);
      const base = { customer_id: message.customer_id, property_id: context.properties[0].id,
        service_type: 'Quarterly Lawn', scheduled_date: etDateString(message.created_at),
        window_start: '09:00:00', created_at: before };
      const [progressed, bookedOnly] = await mockPg('scheduled_services').insert([
        { ...base, status }, // reaches en_route/on_site after the request
        { ...base, status: 'confirmed', created_at: after }, // merely (re)booked after the request
      ]).returning('id');
      await mockPg('job_status_history').insert({
        job_id: progressed.id, from_status: 'confirmed', to_status: status, transitioned_at: after,
      });
      const commitment = { kind, sms_context: { property_id: base.property_id, source_at: message.created_at.toISOString(), money_answerable: true } };
      const now = new Date(after.getTime() + 1000);
      const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
      expect(evidence.failures).toEqual([]);
      const progressedRecord = evidence.records.find((r) => r.id === progressed.id);
      expect(progressedRecord.text).toContain('en route/on site/completed after the request');
      const admissible = evidence.records.filter((r) => admissibleWitness(r, commitment));
      expect(admissible.map((r) => r.id)).toEqual([progressed.id]);
      expect(bookedOnly.id).not.toBe(progressed.id);
      expect(new Date(admissible[0].progressed_at).toISOString()).toBe(after.toISOString());

      // The identical transition, logged before the request, cannot clear it.
      await mockPg('job_status_history').where({ job_id: progressed.id }).update({ transitioned_at: before });
      const staleEvidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
      expect(staleEvidence.records.filter((r) => admissibleWitness(r, commitment))).toEqual([]);
    },
  );

  test('owner ruling 2026-09-24: an "other" ask with no stated property accepts any of the customer\'s own visits', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const otherProperty = await mockPg('customer_properties').insert({ customer_id: message.customer_id,
      is_primary: false, address_line1: '300 Example Lane', city: 'Sarasota', zip: '34236', active: true }).returning('id');
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: message.customer_id, property_id: otherProperty[0].id, service_type: 'Quarterly Lawn',
      scheduled_date: etDateString(message.created_at), window_start: '09:00:00', status: 'completed',
      created_at: new Date(message.created_at.getTime() - 1000),
    }).returning('id');
    await mockPg('job_status_history').insert({
      job_id: visit.id, from_status: 'on_site', to_status: 'completed', transitioned_at: after,
    });
    const commitment = { kind: 'other', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    expect(evidence.failures).toEqual([]);
    const record = evidence.records.find((r) => r.id === visit.id);
    expect(record).toBeTruthy();
    expect(admissibleWitness(record, commitment)).toBe(true);
  });

  test('merge and merge undo retain open obligations on the source SMS’s current owner', async () => {
    result.obligations[0].due_at = new Date(message.created_at.getTime() + 1000).toISOString();
    await recordMessageOperations(mockPg, message, result, context);
    const winner = randomUUID();
    await mockPg('customers').insert({ id: winner, first_name: 'Synthetic', last_name: 'Fixture',
      phone: '+12025550103', address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236' });
    // The merge executor's FK sweep and retirement; JSON snapshots do not move.
    await mockPg.transaction(async (trx) => {
      await trx('sms_log').where({ id: message.id }).update({ customer_id: winner });
      await trx('customer_properties').where({ customer_id: message.customer_id }).update({ customer_id: winner });
      await trx('customers').where({ id: message.customer_id }).update({ deleted_at: new Date() });
    });
    const verify = jest.fn().mockResolvedValue({ verdict: 'open' });
    const now = new Date(message.created_at.getTime() + 2000);
    await refreshSmsCommitments({ conn: mockPg, verify, now });
    expect(verify.mock.calls[0][0].sms_context.customer_id).toBe(winner);
    expect((await mockPg('call_commitments').first()).sms_context.customer_id).toBe(winner);
    expect(NotificationService.notifyAdmin.mock.calls[0][3].link).toBe(`/admin/customers?customerId=${winner}&tab=comms`);
    await mockPg.transaction(async (trx) => {
      await trx('sms_log').where({ id: message.id }).update({ customer_id: message.customer_id });
      await trx('customer_properties').where({ customer_id: winner }).update({ customer_id: message.customer_id });
      await trx('customers').where({ id: message.customer_id }).update({ deleted_at: null });
    });
    await refreshSmsCommitments({ conn: mockPg, verify, now });
    expect((await mockPg('call_commitments').first()).sms_context.customer_id).toBe(message.customer_id);
    expect(NotificationService.notifyAdmin.mock.calls[1][3].link).toBe(`/admin/customers?customerId=${message.customer_id}&tab=comms`);
  });

  test('an ownership move during verification cannot complete or notify the former account', async () => {
    result.obligations[0].due_at = new Date(message.created_at.getTime() + 1000).toISOString();
    await recordMessageOperations(mockPg, message, result, context);
    const winner = randomUUID();
    await mockPg('customers').insert({ id: winner, first_name: 'Synthetic', last_name: 'Fixture',
      phone: '+12025550103', address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236' });
    const verify = jest.fn(async () => {
      await mockPg('sms_log').where({ id: message.id }).update({ customer_id: winner });
      return { verdict: 'fulfilled' };
    });
    await refreshSmsCommitments({ conn: mockPg, verify, now: new Date(message.created_at.getTime() + 2000) });
    expect(verify).toHaveBeenCalledTimes(1);
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('R1 owner ruling 2026-09-24 (settled r10): field progress sends a NULL-due "other" ask to the model at once; a grounded verdict closes it, no bell', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, due_at: null,
      quote: 'You still coming this morning?', description: 'You still coming this morning?' };
    await recordMessageOperations(mockPg, message, result, context);
    // R5 assigns a per-kind default due_at at insert time; force this back
    // to a legacy NULL-due row so the scan picks it up on this tick instead
    // of waiting out the default 24h window.
    await mockPg('call_commitments').update({ due_at: null, due_basis: null });
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: message.customer_id, property_id: context.properties[0].id, service_type: 'Quarterly Lawn',
      scheduled_date: etDateString(message.created_at), window_start: '09:00:00', status: 'en_route',
      created_at: new Date(message.created_at.getTime() - 1000),
    }).returning('id');
    await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'confirmed', to_status: 'en_route', transitioned_at: after });
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'fulfilled', record_ref: `visit:${visit.id}`,
      quote: 'en route/on site/completed after the request' } });
    const outcome = await refreshSmsCommitments({ conn: mockPg, now });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ scanned: 1, fulfilled: 1 });
    const commitment = await mockPg('call_commitments').first();
    expect(commitment.status).toBe('fulfilled');
    expect(commitment.fulfillment).toMatchObject({ verdict: 'fulfilled', basis: 'grounded_sms_request_outcome', record_type: 'visit', record_id: visit.id });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('R1 owner ruling 2026-09-24 (settled r10): field progress reaches the model INSIDE the default 24h window, the moment it happens', async () => {
    result.facts = [];
    // "this morning" would be stated timing (Codex #4816 r20) and leave the
    // row undated; this test is about the open default window.
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, due_at: null,
      quote: 'You still coming?', description: 'You still coming?' };
    await recordMessageOperations(mockPg, message, result, context);
    const inserted = await mockPg('call_commitments').first();
    expect(inserted.due_basis).toBe('default_kind');
    const after = new Date(message.created_at.getTime() + 1000);
    // Two seconds after the text: the 24h window is nowhere near over.
    const now = new Date(after.getTime() + 1000);
    expect(new Date(inserted.due_at) > now).toBe(true);
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: message.customer_id, property_id: context.properties[0].id, service_type: 'Quarterly Lawn',
      scheduled_date: etDateString(message.created_at), window_start: '09:00:00', status: 'en_route',
      created_at: new Date(message.created_at.getTime() - 1000),
    }).returning('id');
    await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'confirmed', to_status: 'en_route', transitioned_at: after });
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'fulfilled', record_ref: `visit:${visit.id}`,
      quote: 'en route/on site/completed after the request' } });
    const outcome = await refreshSmsCommitments({ conn: mockPg, now });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ scanned: 1, fulfilled: 1, skipped_not_due: 0 });
    const commitment = await mockPg('call_commitments').first();
    expect(commitment.status).toBe('fulfilled');
    expect(commitment.fulfillment).toMatchObject({ verdict: 'fulfilled', basis: 'grounded_sms_request_outcome', record_type: 'visit', record_id: visit.id });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('Codex #4816 r4: a backlog of future-dated rows never crowds a due row out of the tick (separate pages and cursors)', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'callback', basis: 'request', due_at: null,
      quote: 'Please call me back', description: 'Please call me back' };
    await recordMessageOperations(mockPg, message, result, context);
    const seed = await mockPg('call_commitments').first();
    const now = new Date(message.created_at.getTime() + 2000);
    const { id: _id, created_at: _c, updated_at: _u, ...template } = seed;
    const clone = (i, due_at) => ({ ...template, commitment_key: `${seed.commitment_key}:${i}`, due_at,
      evidence: JSON.stringify(seed.evidence), sms_context: JSON.stringify(seed.sms_context) });
    // 25 more future-dated rows (26 with the seed) and ONE row whose deadline has passed.
    await mockPg('call_commitments').insert([...Array.from({ length: 25 }, (_, i) => clone(i, new Date(now.getTime() + 3600000))),
      clone('due', new Date(now.getTime() - 1000))]);
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'no_answer', evidence_hash: 'x', retry_after: null }));
    const outcome = await refreshSmsCommitments({ conn: mockPg, verify, now });
    // Due page: the one overdue row (verified, belled). Future page: 25 of the
    // 26, each skipped before any model call since nothing on file answers it.
    expect(outcome).toMatchObject({ scanned: 26, fulfilled: 0, skipped_no_witness: 25, skipped_not_due: 0 });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const cursors = Object.fromEntries((await mockPg('system_settings').whereIn('key', ['sms_operations.fulfillment_cursor', 'sms_operations.future_cursor'])).map((r) => [r.key, r.value]));
    expect(cursors['sms_operations.fulfillment_cursor']).toBeNull();
    expect(cursors['sms_operations.future_cursor']).toMatch(/^[a-f0-9-]{36}$/);
  });

  test('Codex #4816 r15–r17: rows with unseen visit activity are drained ahead of the cursors, watermarked, and return only on new activity', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'callback', basis: 'request', due_at: null,
      quote: 'Please call me back', description: 'Please call me back' };
    await recordMessageOperations(mockPg, message, result, context);
    const seed = await mockPg('call_commitments').first();
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const { id: _id, created_at: _c, updated_at: _u, ...template } = seed;
    await mockPg('call_commitments').update({ due_at: new Date(now.getTime() + 3600000) });
    await mockPg('call_commitments').insert(Array.from({ length: 29 }, (_, i) => ({ ...template,
      commitment_key: `${seed.commitment_key}:${i}`, due_at: new Date(now.getTime() + 3600000),
      evidence: JSON.stringify(seed.evidence), sms_context: JSON.stringify(seed.sms_context) })));
    const ids = await mockPg('call_commitments').orderBy('id').pluck('id');
    const [target, last] = [ids[0], ids[ids.length - 1]];
    // The future cursor already sits on the target: its page starts after it.
    const parkCursor = () => mockPg('system_settings').insert({ key: 'sms_operations.future_cursor', value: target, category: 'sms_operations' })
      .onConflict('key').merge({ value: target });
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'no_answer', evidence_hash: 'x', retry_after: null }));
    const verified = () => verify.mock.calls.map(([row]) => row.id);
    const tick = async (at = now) => { verify.mockClear(); await parkCursor(); return refreshSmsCommitments({ conn: mockPg, verify, now: at }); };
    expect(await tick()).toMatchObject({ scanned: 25, skipped_no_witness: 25 });
    expect(verify).not.toHaveBeenCalled();
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: message.customer_id, property_id: context.properties[0].id, service_type: 'Quarterly Pest Control',
      scheduled_date: etDateString(after), window_start: '09:00:00', status: 'en_route',
      created_at: new Date(message.created_at.getTime() - 86400000), updated_at: after,
    }).returning('id');
    await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'confirmed', to_status: 'en_route', transitioned_at: after });
    // Tick 1: the event page takes the first 25 rows, the target among them;
    // inside the window only the event may ground the check.
    await tick();
    expect(verified()).toContain(target);
    expect(verified()).not.toContain(last);
    expect(verify.mock.calls.every(([, , opts]) => opts.eventOnly === true)).toBe(true);
    // Stamped through the activity read, capped at the commit grace (r20):
    // the event is younger than ten minutes, so the cap holds the watermark.
    expect(new Date((await mockPg('call_commitments').where({ id: target }).first()).sms_context.event_seen_at).getTime())
      .toBe(now.getTime() - 10 * 60 * 1000);
    // Tick 2: never-stamped rows come first, so the page drains the other
    // five (the parked future cursor cannot reach the last row this tick).
    await tick(new Date(now.getTime() + 1000));
    expect(verified()).toContain(last);
    // Hours later the cap has passed the event: one settling tick stamps it
    // fully, then nothing is re-verified until new activity lands — and
    // then the target comes straight back.
    const later = new Date(now.getTime() + 2 * 3600000);
    await mockPg('call_commitments').update({ due_at: new Date(later.getTime() + 3600000) });
    await tick(later);
    await tick(new Date(later.getTime() + 1000));
    expect(verified()).not.toContain(target);
    await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'en_route', to_status: 'on_site',
      transitioned_at: new Date(later.getTime() - 1000) });
    await mockPg('scheduled_services').where({ id: visit.id }).update({ status: 'on_site' });
    await tick(new Date(later.getTime() + 2000));
    expect(verified()).toContain(target);
  });

  test('Codex #4816 r17: an undated row behind the due cursor is verified on the next tick after a visit event', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, basis: 'request', due_at: null, due_text: 'sometime soon',
      quote: 'You still coming?', description: 'You still coming?' };
    await recordMessageOperations(mockPg, message, result, context);
    await mockPg('call_commitments').update({ due_at: null });
    const [target] = await mockPg('call_commitments').pluck('id');
    // A cursor already past the target: the due page cannot reach it.
    await mockPg('system_settings').insert({ key: 'sms_operations.fulfillment_cursor', value: 'ffffffff-ffff-4fff-bfff-ffffffffffff', category: 'sms_operations' })
      .onConflict('key').merge({ value: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
    const after = new Date(message.created_at.getTime() + 1000);
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: message.customer_id, property_id: context.properties[0].id, service_type: 'Quarterly Pest Control',
      scheduled_date: etDateString(after), window_start: '09:00:00', status: 'en_route',
      created_at: new Date(message.created_at.getTime() - 86400000), updated_at: after,
    }).returning('id');
    await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'confirmed', to_status: 'en_route', transitioned_at: after });
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'no_answer', evidence_hash: 'x', retry_after: null }));
    await refreshSmsCommitments({ conn: mockPg, verify, now: new Date(after.getTime() + 1000) });
    expect(verify.mock.calls.map(([row, , opts]) => [row.id, opts.eventOnly])).toEqual([[target, false]]);
  });

  test.each(['revalidation refuses the close', 'the source text changes under the lock', 'the provider fails',
    'new activity lands during the provider backoff', 'an earlier-stamped write commits during the provider backoff',
    'a non-witness evidence source fails'])(
    'Codex #4816 r18/r19: a verdict the transaction does not persist leaves the event unseen for the next tick (%s)', async (cause) => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, basis: 'request', due_at: null, due_text: 'sometime soon',
      quote: 'You still coming?', description: 'You still coming?' };
    await recordMessageOperations(mockPg, message, result, context);
    await mockPg('call_commitments').update({ due_at: null });
    const [target] = await mockPg('call_commitments').pluck('id');
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: message.customer_id, property_id: context.properties[0].id, service_type: 'Quarterly Pest Control',
      scheduled_date: etDateString(after), window_start: '09:00:00', status: 'en_route',
      created_at: new Date(message.created_at.getTime() - 86400000), updated_at: after,
    }).returning('id');
    await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'confirmed', to_status: 'en_route', transitioned_at: after });
    // A stale evidence hash: revalidation refuses the close, as it does for a
    // witness that changed or is locked by another writer.
    const verify = jest.fn(async () => {
      if (['the provider fails', 'new activity lands during the provider backoff', 'an earlier-stamped write commits during the provider backoff'].includes(cause)) {
        return { verdict: 'uncertain', reason: 'provider_failed', evidence_hash: 'x', retry_after: new Date(now.getTime() + 3600000).toISOString() };
      }
      if (cause === 'the source text changes under the lock') {
        await mockPg('sms_log').where({ id: message.id }).update({ message_body: `${message.message_body} (edited)` });
        return { verdict: 'open', reason: 'no_answer', evidence_hash: 'x', retry_after: null };
      }
      if (cause === 'a non-witness evidence source fails') {
        // Codex #4816 r26: the visit witness loaded but the call source did
        // not; verify settles as incomplete_sources with no retry_after.
        return { verdict: 'uncertain', reason: 'incomplete_sources', failures: ['call'], evidence_hash: 'x', retry_after: null };
      }
      return { verdict: 'fulfilled', record_type: 'visit', record_id: visit.id, quote: 'en route', evidence_hash: 'stale', retry_after: null };
    });
    const conn = cause === 'a non-witness evidence source fails'
      ? new Proxy(mockPg, { apply: (_t, _this, [table, ...rest]) => (table === 'call_log' ? mockPg('call_log_unavailable') : mockPg(table, ...rest)) })
      : mockPg;
    expect(await refreshSmsCommitments({ conn, verify, now })).toMatchObject({ scanned: 1, fulfilled: 0 });
    const row = await mockPg('call_commitments').where({ id: target }).first();
    expect(row.status).toBe('open');
    expect(row.sms_context.event_seen_at).toBeUndefined();
    // The due cursor has moved on; the event page still brings it back.
    await mockPg('system_settings').insert({ key: 'sms_operations.fulfillment_cursor', value: 'ffffffff-ffff-4fff-bfff-ffffffffffff', category: 'sms_operations' })
      .onConflict('key').merge({ value: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
    const parkDue = () => mockPg('system_settings').insert({ key: 'sms_operations.fulfillment_cursor', value: 'ffffffff-ffff-4fff-bfff-ffffffffffff', category: 'sms_operations' })
      .onConflict('key').merge({ value: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
    let retryAt = new Date(now.getTime() + 1000);
    if (cause === 'the provider fails') {
      // Inside the ten-minute commit grace the fresh event may still bring
      // the row back (verify reuses the stored failure — no model call);
      // once the grace has passed what the failed attempt read, the row
      // yields its event-page slot through the backoff...
      await refreshSmsCommitments({ conn: mockPg, verify, now: new Date(now.getTime() + 11 * 60000) });
      await parkDue();
      verify.mockClear();
      await refreshSmsCommitments({ conn: mockPg, verify, now: new Date(now.getTime() + 12 * 60000) });
      expect(verify).not.toHaveBeenCalled();
      await parkDue();
      // ...and returns, event still unseen, once the retry is due.
      retryAt = new Date(now.getTime() + 3601000);
    }
    if (cause === 'an earlier-stamped write commits during the provider backoff') {
      // Codex #4816 r30: stamped at transaction start, before the failed
      // attempt, committed after it — still new evidence.
      await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'en_route', to_status: 'on_site',
        transitioned_at: new Date(now.getTime() - 500) });
      await mockPg('scheduled_services').where({ id: visit.id }).update({ status: 'on_site' });
    }
    if (cause === 'new activity lands during the provider backoff') {
      // Codex #4816 r21: activity after the failed attempt changes the
      // evidence, so the row comes back before retry_after.
      await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'en_route', to_status: 'on_site',
        transitioned_at: new Date(now.getTime() + 500) });
      await mockPg('scheduled_services').where({ id: visit.id }).update({ status: 'on_site' });
    }
    verify.mockClear();
    await refreshSmsCommitments({ conn: mockPg, verify, now: retryAt });
    expect(verify.mock.calls.map(([r]) => r.id)).toEqual([target]);
  },
  );

  test('Codex #4816 r38: a skipped/no_show transition is not an event the page picks up', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, basis: 'request', due_at: null, due_text: 'sometime soon',
      quote: 'You still coming?', description: 'You still coming?' };
    await recordMessageOperations(mockPg, message, result, context);
    await mockPg('call_commitments').update({ due_at: null });
    const minutes = (m) => new Date(message.created_at.getTime() + m * 60000);
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: message.customer_id, property_id: context.properties[0].id, service_type: 'Quarterly Pest Control',
      scheduled_date: etDateString(minutes(5)), window_start: '09:00:00', status: 'no_show',
      created_at: new Date(message.created_at.getTime() - 86400000), updated_at: minutes(5),
    }).returning('id');
    await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'confirmed', to_status: 'no_show', transitioned_at: minutes(5) });
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'no_answer', evidence_hash: 'x', retry_after: null }));
    const tick = async (at) => {
      await mockPg('system_settings').insert({ key: 'sms_operations.fulfillment_cursor', value: 'ffffffff-ffff-4fff-bfff-ffffffffffff', category: 'sms_operations' })
        .onConflict('key').merge({ value: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
      return refreshSmsCommitments({ conn: mockPg, verify, now: at });
    };
    expect(await tick(minutes(20))).toMatchObject({ scanned: 0 });
    // A witness status on the same visit is an event.
    await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'no_show', to_status: 'rescheduled', transitioned_at: minutes(21) });
    expect(await tick(minutes(40))).toMatchObject({ scanned: 1 });
  });

  test('Codex #4816 r49: an automated notice keeps the property snapshotted at send time after its visit moves', async () => {
    const [visit] = await mockPg('scheduled_services').insert({ customer_id: message.customer_id, property_id: context.properties[0].id,
      service_type: 'Quarterly Pest Control', scheduled_date: etDateString(message.created_at), window_start: '09:00:00', status: 'confirmed',
      created_at: new Date(message.created_at.getTime() - 86400000) }).returning('id');
    const [notice] = await mockPg('sms_log').insert({ ...message, id: randomUUID(), direction: 'outbound',
      from_phone: message.to_phone, to_phone: message.from_phone, message_body: 'Your appointment is confirmed.',
      message_type: 'confirmation', status: 'delivered', created_at: new Date(message.created_at.getTime() + 1000),
      metadata: JSON.stringify({ scheduled_service_id: visit.id, property_id: context.properties[0].id }) }).returning('id');
    // The visit is switched to another property after the notice went out.
    await mockPg('scheduled_services').where({ id: visit.id }).update({ property_id: randomUUID() });
    const commitment = { kind: 'send_appointment_confirmation', sms_context: { property_id: context.properties[0].id, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, new Date(message.created_at.getTime() + 5000));
    const record = evidence.records.find((r) => r.id === notice.id);
    expect(String(record.linked_property_id)).toBe(String(context.properties[0].id));
    expect(admissibleWitness(record, commitment)).toBe(true);
    // A notice with no send-time snapshot cannot vouch for a scoped promise.
    await mockPg('sms_log').where({ id: notice.id }).update({ metadata: JSON.stringify({ scheduled_service_id: visit.id }) });
    const unscoped = (await loadSmsFulfillmentEvidence(mockPg, commitment, message, new Date(message.created_at.getTime() + 5000)))
      .records.find((r) => r.id === notice.id);
    expect(admissibleWitness(unscoped, commitment)).toBe(false);
  });

  test('Codex #4816 r40: a no-show reschedule_log row (no new date) is not an event; a logged move is', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, basis: 'request', due_at: null, due_text: 'sometime soon',
      quote: 'You still coming?', description: 'You still coming?' };
    await recordMessageOperations(mockPg, message, result, context);
    await mockPg('call_commitments').update({ due_at: null });
    const minutes = (m) => new Date(message.created_at.getTime() + m * 60000);
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: message.customer_id, property_id: context.properties[0].id, service_type: 'Quarterly Pest Control',
      scheduled_date: etDateString(minutes(5)), window_start: '09:00:00', status: 'confirmed',
      created_at: new Date(message.created_at.getTime() - 86400000), updated_at: minutes(5),
    }).returning('id');
    await mockPg('reschedule_log').insert({ scheduled_service_id: visit.id, customer_id: message.customer_id,
      original_date: etDateString(minutes(5)), new_date: null, initiated_by: 'admin', created_at: minutes(5) });
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'no_answer', evidence_hash: 'x', retry_after: null }));
    const tick = async (at) => {
      await mockPg('system_settings').insert({ key: 'sms_operations.fulfillment_cursor', value: 'ffffffff-ffff-4fff-bfff-ffffffffffff', category: 'sms_operations' })
        .onConflict('key').merge({ value: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
      return refreshSmsCommitments({ conn: mockPg, verify, now: at });
    };
    expect(await tick(minutes(20))).toMatchObject({ scanned: 0 });
    await mockPg('reschedule_log').insert({ scheduled_service_id: visit.id, customer_id: message.customer_id,
      original_date: etDateString(minutes(5)), new_date: etDateString(new Date(minutes(5).getTime() + 7 * 86400000)),
      initiated_by: 'admin', created_at: minutes(21) });
    expect(await tick(minutes(40))).toMatchObject({ scanned: 1 });
  });

  test('Codex #4816 r38: an uncertain pet report still rings its safety review when the batch repeats the field', async () => {
    const body = 'We have a cat. Not sure whether the dog will be out.';
    message.message_body = body;
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: body });
    result.obligations = [];
    result.facts = [
      { field: 'pet_details', quote: 'We have a cat.', value: 'cat', property_id: context.properties[0].id, duration: 'visit_only' },
      { field: 'pet_details', quote: 'Not sure whether the dog will be out.', value: 'dog', property_id: context.properties[0].id, duration: 'visit_only' },
    ];
    await recordMessageOperations(mockPg, message, result, context);
    const outcomes = (await mockPg('sms_log').first()).operational_analysis.facts.map((f) => f.outcome);
    expect(outcomes).toEqual(['pet_needs_review', 'pet_needs_review']);
    expect(NotificationService.notifyAdmin).toHaveBeenCalled();
  });

  test('Codex #4816 r27: the event page counts activity from the effective source time, not the queue row', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, basis: 'request', due_at: null, due_text: 'sometime soon',
      quote: 'You still coming?', description: 'You still coming?' };
    await recordMessageOperations(mockPg, message, result, context);
    await mockPg('call_commitments').update({ due_at: null });
    const [target] = await mockPg('call_commitments').pluck('id');
    const minutes = (m) => new Date(message.created_at.getTime() + m * 60000);
    // A scheduled send: queued at the sms_log row's time, delivered 10 min later.
    await mockPg('call_commitments').update({ sms_context: mockPg.raw("jsonb_set(sms_context, '{source_at}', to_jsonb(?::text))", [minutes(10).toISOString()]) });
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: message.customer_id, property_id: context.properties[0].id, service_type: 'Quarterly Pest Control',
      scheduled_date: etDateString(minutes(5)), window_start: '09:00:00', status: 'en_route',
      created_at: new Date(message.created_at.getTime() - 86400000), updated_at: minutes(5),
    }).returning('id');
    await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'confirmed', to_status: 'en_route', transitioned_at: minutes(5) });
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'no_answer', evidence_hash: 'x', retry_after: null }));
    const tick = async (at) => {
      await mockPg('system_settings').insert({ key: 'sms_operations.fulfillment_cursor', value: 'ffffffff-ffff-4fff-bfff-ffffffffffff', category: 'sms_operations' })
        .onConflict('key').merge({ value: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
      verify.mockClear();
      return refreshSmsCommitments({ conn: mockPg, verify, now: at });
    };
    // Activity between enqueue and delivery predates the promise: no event.
    expect(await tick(minutes(12))).toMatchObject({ scanned: 0 });
    // Activity after delivery is a new event: the page picks the row up.
    await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'en_route', to_status: 'on_site', transitioned_at: minutes(15) });
    expect(await tick(minutes(16))).toMatchObject({ scanned: 1 });
    expect(new Date((await mockPg('call_commitments').where({ id: target }).first()).sms_context.event_seen_at).getTime())
      .toBe(minutes(6).getTime());
  });

  test('Codex #4816 r28: deferred rows move behind untried rows on the event page', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, basis: 'request', due_at: null, due_text: 'sometime soon',
      quote: 'You still coming?', description: 'You still coming?' };
    await recordMessageOperations(mockPg, message, result, context);
    const seed = await mockPg('call_commitments').first();
    const { id: _id, created_at: _c, updated_at: _u, ...template } = seed;
    await mockPg('call_commitments').insert(Array.from({ length: 29 }, (_, i) => ({ ...template, commitment_key: `${seed.commitment_key}:${i}`,
      evidence: JSON.stringify(seed.evidence), sms_context: JSON.stringify(seed.sms_context) })));
    await mockPg('call_commitments').update({ due_at: null });
    const ids = await mockPg('call_commitments').orderBy('id').pluck('id');
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: message.customer_id, property_id: context.properties[0].id, service_type: 'Quarterly Pest Control',
      scheduled_date: etDateString(after), window_start: '09:00:00', status: 'en_route',
      created_at: new Date(message.created_at.getTime() - 86400000), updated_at: after,
    }).returning('id');
    await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'confirmed', to_status: 'en_route', transitioned_at: after });
    // Every revalidation is refused: each attempted row is deferred.
    const verify = jest.fn(async () => ({ verdict: 'fulfilled', record_type: 'visit', record_id: visit.id,
      quote: 'en route', evidence_hash: 'stale', retry_after: null }));
    const tick = async (at) => {
      await mockPg('system_settings').insert({ key: 'sms_operations.fulfillment_cursor', value: 'ffffffff-ffff-4fff-bfff-ffffffffffff', category: 'sms_operations' })
        .onConflict('key').merge({ value: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
      verify.mockClear();
      await refreshSmsCommitments({ conn: mockPg, verify, now: at });
      return verify.mock.calls.map(([r]) => r.id);
    };
    const first = await tick(now);
    expect(first).toEqual(ids.slice(0, 25));
    // The five never-tried rows come first on the next tick; the deferred
    // ones stay eligible behind them.
    const second = await tick(new Date(now.getTime() + 1000));
    expect(second.slice(0, 5)).toEqual(ids.slice(25));
    expect((await mockPg('call_commitments').where({ id: ids[0] }).first()).sms_context.event_seen_at).toBeUndefined();
  });

  test('Codex #4816 r32: a provider-failure backoff reached for a previous owner does not hold after a merge', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, basis: 'request', due_at: null, due_text: 'sometime soon',
      property_id: null, quote: 'You still coming?', description: 'You still coming?' };
    await recordMessageOperations(mockPg, message, result, context);
    await mockPg('call_commitments').update({ due_at: null });
    const [target] = await mockPg('call_commitments').pluck('id');
    const minutes = (m) => new Date(message.created_at.getTime() + m * 60000);
    const visitFor = async (customerId, propertyId, at) => {
      const [v] = await mockPg('scheduled_services').insert({ customer_id: customerId, property_id: propertyId, service_type: 'Quarterly Pest Control',
        scheduled_date: etDateString(at), window_start: '09:00:00', status: 'en_route', created_at: new Date(message.created_at.getTime() - 86400000), updated_at: at,
      }).returning('id');
      await mockPg('job_status_history').insert({ job_id: v.id, from_status: 'confirmed', to_status: 'en_route', transitioned_at: at });
    };
    const other = { id: randomUUID() };
    await mockPg('customers').insert({ id: other.id, first_name: 'Synthetic', last_name: 'Fixture',
      phone: '+12025550105', address_line1: '300 Example Lane', city: 'Sarasota', zip: '34236' });
    const [otherProperty] = await mockPg('customer_properties').insert({ customer_id: other.id, address_line1: '300 Example Lane',
      city: 'Sarasota', zip: '34236', active: true }).returning('id');
    // The new owner's event (minute 3) is older than what the failed attempt
    // read for the old owner (minute 5).
    await visitFor(other.id, otherProperty.id, minutes(3));
    await visitFor(message.customer_id, context.properties[0].id, minutes(5));
    const verify = jest.fn(async (_row, _evidence, { now }) => ({ verdict: 'uncertain', reason: 'provider_failed', evidence_hash: 'x',
      retry_after: new Date(now.getTime() + 3600000).toISOString() }));
    const tick = async (at) => {
      await mockPg('system_settings').insert({ key: 'sms_operations.fulfillment_cursor', value: 'ffffffff-ffff-4fff-bfff-ffffffffffff', category: 'sms_operations' })
        .onConflict('key').merge({ value: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
      verify.mockClear();
      await refreshSmsCommitments({ conn: mockPg, verify, now: at });
      return verify.mock.calls.map(([r]) => r.id);
    };
    expect(await tick(minutes(40))).toEqual([target]);
    // Inside the backoff, with nothing new, the row yields its slot.
    expect(await tick(minutes(41))).toEqual([]);
    await mockPg('sms_log').where({ id: message.id }).update({ customer_id: other.id });
    expect(await tick(minutes(42))).toEqual([target]);
  });

  test('Codex #4816 r28: an ownership change resets the event watermark', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, basis: 'request', due_at: null, due_text: 'sometime soon',
      property_id: null, quote: 'You still coming?', description: 'You still coming?' };
    await recordMessageOperations(mockPg, message, result, context);
    await mockPg('call_commitments').update({ due_at: null });
    const [target] = await mockPg('call_commitments').pluck('id');
    const minutes = (m) => new Date(message.created_at.getTime() + m * 60000);
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'no_answer', evidence_hash: 'x', retry_after: null }));
    const tick = async (at) => {
      await mockPg('system_settings').insert({ key: 'sms_operations.fulfillment_cursor', value: 'ffffffff-ffff-4fff-bfff-ffffffffffff', category: 'sms_operations' })
        .onConflict('key').merge({ value: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
      verify.mockClear();
      await refreshSmsCommitments({ conn: mockPg, verify, now: at });
      return verify.mock.calls.map(([r]) => r.id);
    };
    const visitFor = async (customerId, propertyId, at) => {
      const [v] = await mockPg('scheduled_services').insert({ customer_id: customerId, property_id: propertyId, service_type: 'Quarterly Pest Control',
        scheduled_date: etDateString(at), window_start: '09:00:00', status: 'en_route', created_at: new Date(message.created_at.getTime() - 86400000), updated_at: at,
      }).returning('id');
      await mockPg('job_status_history').insert({ job_id: v.id, from_status: 'confirmed', to_status: 'en_route', transitioned_at: at });
    };
    // The other customer's visit event lands at minute 5, before the old
    // owner's watermark (minute 20) — invisible until ownership moves.
    const other = { id: randomUUID() };
    await mockPg('customers').insert({ id: other.id, first_name: 'Synthetic', last_name: 'Fixture',
      phone: '+12025550104', address_line1: '300 Example Lane', city: 'Sarasota', zip: '34236' });
    const [otherProperty] = await mockPg('customer_properties').insert({ customer_id: other.id, address_line1: '300 Example Lane',
      city: 'Sarasota', zip: '34236', active: true }).returning('id');
    await visitFor(other.id, otherProperty.id, minutes(5));
    await visitFor(message.customer_id, context.properties[0].id, minutes(20));
    expect(await tick(minutes(40))).toEqual([target]);
    expect(await tick(minutes(41))).toEqual([]);
    await mockPg('sms_log').where({ id: message.id }).update({ customer_id: other.id });
    expect(await tick(minutes(42))).toEqual([target]);
  });

  test('Codex #4816 r34: a failed visit query defers an in-window row that has only a message witness', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'callback', basis: 'request', due_at: null, property_id: null,
      quote: 'Please call me back', description: 'Please call me back' };
    await recordMessageOperations(mockPg, message, result, context);
    const [target] = await mockPg('call_commitments').pluck('id');
    expect((await mockPg('call_commitments').first()).due_basis).toBe('default_kind');
    const minutes = (m) => new Date(message.created_at.getTime() + m * 60000);
    // An admissible call (a message witness: waits for the deadline) and a
    // visit event older than the commit grace, so a stamp would stick.
    await mockPg('call_log').insert({ customer_id: message.customer_id, direction: 'outbound',
      from_phone: numbers.locations.parrish.number, to_phone: message.from_phone, status: 'completed', duration_seconds: 90,
      transcription: 'Returned your call', created_at: minutes(2) });
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: message.customer_id, property_id: context.properties[0].id, service_type: 'Quarterly Pest Control',
      scheduled_date: etDateString(minutes(1)), window_start: '09:00:00', status: 'en_route',
      created_at: new Date(message.created_at.getTime() - 86400000), updated_at: minutes(1),
    }).returning('id');
    await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'confirmed', to_status: 'en_route', transitioned_at: minutes(1) });
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'no_answer', evidence_hash: 'x', retry_after: null }));
    const parkFuture = () => mockPg('system_settings').insert({ key: 'sms_operations.future_cursor', value: 'ffffffff-ffff-4fff-bfff-ffffffffffff', category: 'sms_operations' })
      .onConflict('key').merge({ value: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
    // Tick 1: the loader's visit query fails, so no event witness is seen and
    // the call must wait for the deadline — the row is deferred, not stamped.
    const failingConn = new Proxy(mockPg, { apply: (_t, _this, [table, ...rest]) => (
      table === 'scheduled_services' ? mockPg('scheduled_services_unavailable') : mockPg(table, ...rest)) });
    await parkFuture();
    await refreshSmsCommitments({ conn: failingConn, verify, now: minutes(20) });
    expect(verify).not.toHaveBeenCalled();
    expect((await mockPg('call_commitments').where({ id: target }).first()).sms_context.event_seen_at).toBeUndefined();
    // Tick 2: the query recovers and the event page still brings the row.
    await parkFuture();
    await refreshSmsCommitments({ conn: mockPg, verify, now: minutes(21) });
    expect(verify.mock.calls.map(([r, , opts]) => [r.id, opts.eventOnly])).toEqual([[target, true]]);
  });

  test('Codex #4816 r21: a failed evidence query leaves the visit event pending for the next tick', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, basis: 'request', due_at: null, due_text: 'sometime soon',
      quote: 'You still coming?', description: 'You still coming?' };
    await recordMessageOperations(mockPg, message, result, context);
    await mockPg('call_commitments').update({ due_at: null });
    const [target] = await mockPg('call_commitments').pluck('id');
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: message.customer_id, property_id: context.properties[0].id, service_type: 'Quarterly Pest Control',
      scheduled_date: etDateString(after), window_start: '09:00:00', status: 'en_route',
      created_at: new Date(message.created_at.getTime() - 86400000), updated_at: after,
    }).returning('id');
    await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'confirmed', to_status: 'en_route', transitioned_at: after });
    // The visit source query fails outright this tick.
    const failingConn = new Proxy(mockPg, { apply: (target_, thisArg, [table, ...rest]) => (
      table === 'scheduled_services' ? mockPg('scheduled_services_unavailable') : mockPg(table, ...rest)) });
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'no_answer', evidence_hash: 'x', retry_after: null }));
    expect(await refreshSmsCommitments({ conn: failingConn, verify, now })).toMatchObject({ scanned: 1, skipped_no_witness: 0 });
    expect((await mockPg('call_commitments').where({ id: target }).first()).sms_context.event_seen_at).toBeUndefined();
    await mockPg('system_settings').insert({ key: 'sms_operations.fulfillment_cursor', value: 'ffffffff-ffff-4fff-bfff-ffffffffffff', category: 'sms_operations' })
      .onConflict('key').merge({ value: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
    await refreshSmsCommitments({ conn: mockPg, verify, now: new Date(now.getTime() + 1000) });
    expect(verify.mock.calls.map(([r]) => r.id)).toEqual([target]);
  });

  test('Codex #4816 r19/r20: the watermark never passes now minus the commit grace, and keeps microseconds', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, basis: 'request', due_at: null, due_text: 'sometime soon',
      quote: 'You still coming?', description: 'You still coming?' };
    await recordMessageOperations(mockPg, message, result, context);
    await mockPg('call_commitments').update({ due_at: null });
    const [target] = await mockPg('call_commitments').pluck('id');
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'no_answer', evidence_hash: 'x', retry_after: null }));
    // Park the due cursor past the row before every tick (an empty page
    // wraps it), so only the event page can reach the row.
    const tick = async (at) => {
      await mockPg('system_settings').insert({ key: 'sms_operations.fulfillment_cursor', value: 'ffffffff-ffff-4fff-bfff-ffffffffffff', category: 'sms_operations' })
        .onConflict('key').merge({ value: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
      verify.mockClear();
      await refreshSmsCommitments({ conn: mockPg, verify, now: at });
    };
    const minutes = (m) => new Date(message.created_at.getTime() + m * 60000);
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: message.customer_id, property_id: context.properties[0].id, service_type: 'Quarterly Pest Control',
      scheduled_date: etDateString(minutes(30)), window_start: '09:00:00', status: 'on_site',
      created_at: new Date(message.created_at.getTime() - 86400000), updated_at: minutes(30),
    }).returning('id');
    // The newer transition, microsecond-stamped as database defaults are.
    await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'en_route', to_status: 'on_site',
      transitioned_at: mockPg.raw("?::timestamptz + interval '456 microseconds'", [minutes(30)]) });
    await tick(minutes(31));
    expect(verify.mock.calls.map(([r]) => r.id)).toEqual([target]);
    // A transaction that began before that read (transition stamped at
    // minute 25) commits after it. The watermark sits at minute 21, not 30.
    await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'confirmed', to_status: 'en_route', transitioned_at: minutes(25) });
    await tick(new Date(minutes(31).getTime() + 1000));
    expect(verify.mock.calls.map(([r]) => r.id)).toEqual([target]);
    // Once the cap passes both, the watermark is the newest transition with
    // its microseconds, and the same events are never re-selected.
    await tick(minutes(50));
    await tick(new Date(minutes(50).getTime() + 1000));
    expect(verify).not.toHaveBeenCalled();
  });

  test('inside an open window a message witness waits for the deadline: no model call, no bell, then verified once due', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'callback', basis: 'request', due_at: null,
      quote: 'Please call me back', description: 'Please call me back' };
    await recordMessageOperations(mockPg, message, result, context);
    const after = new Date(message.created_at.getTime() + 1000);
    await mockPg('call_log').insert({ customer_id: message.customer_id, direction: 'outbound',
      from_phone: numbers.locations.parrish.number, to_phone: message.from_phone, status: 'completed', duration_seconds: 90,
      transcription: 'Returned your call about the gate code', created_at: after });
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'not_yet', evidence_hash: 'x', retry_after: null }));
    const early = await refreshSmsCommitments({ conn: mockPg, verify, now: new Date(after.getTime() + 1000) });
    expect(verify).not.toHaveBeenCalled();
    expect(early).toMatchObject({ scanned: 1, fulfilled: 0, skipped_not_due: 1 });
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    // Past the 4h callback window the same row reaches the model as before.
    await mockPg('system_settings').where({ key: 'sms_operations.fulfillment_cursor' }).del();
    const late = await refreshSmsCommitments({ conn: mockPg, verify, now: new Date(message.created_at.getTime() + 4 * 3600000 + 1000) });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(late).toMatchObject({ scanned: 1, fulfilled: 0, skipped_not_due: 0 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('Codex #4816 r1: a logged reschedule move is a witness for "schedule_visit" but still goes through the model (service match), never a system-event close', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'schedule_visit', due_at: null,
      quote: 'Can we move to next week?', description: 'Can we move to next week?' };
    await recordMessageOperations(mockPg, message, result, context);
    await mockPg('call_commitments').update({ due_at: null, due_basis: null });
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const nextWeek = etDateString(new Date(after.getTime() + 7 * 86400000));
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: message.customer_id, property_id: context.properties[0].id, service_type: 'Quarterly Lawn',
      scheduled_date: nextWeek, window_start: '09:00:00', status: 'confirmed',
      created_at: new Date(message.created_at.getTime() - 1000), updated_at: after,
    }).returning('id');
    await mockPg('reschedule_log').insert({ scheduled_service_id: visit.id, customer_id: message.customer_id,
      original_date: etDateString(message.created_at), new_date: nextWeek, initiated_by: 'admin', created_at: after });
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'different_service', evidence_hash: 'x', retry_after: null }));
    const outcome = await refreshSmsCommitments({ conn: mockPg, verify, now });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ scanned: 1, fulfilled: 0 });
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('R1 owner ruling 2026-09-24 (settled r10): on-site field progress sends a NULL-due "callback" to the model, which may close it', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'callback', due_at: null,
      quote: 'Can you call me back?', description: 'Can you call me back?' };
    await recordMessageOperations(mockPg, message, result, context);
    await mockPg('call_commitments').update({ due_at: null, due_basis: null });
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: message.customer_id, property_id: context.properties[0].id, service_type: 'Quarterly Lawn',
      scheduled_date: etDateString(message.created_at), window_start: '09:00:00', status: 'on_site',
      created_at: new Date(message.created_at.getTime() - 1000),
    }).returning('id');
    await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'en_route', to_status: 'on_site', transitioned_at: after });
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'fulfilled', record_ref: `visit:${visit.id}`,
      quote: 'en route/on site/completed after the request' } });
    const outcome = await refreshSmsCommitments({ conn: mockPg, now });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ scanned: 1, fulfilled: 1 });
    const commitment = await mockPg('call_commitments').first();
    expect(commitment.status).toBe('fulfilled');
    expect(commitment.fulfillment).toMatchObject({ verdict: 'fulfilled', basis: 'grounded_sms_request_outcome', record_type: 'visit', record_id: visit.id });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('owner ruling 2026-09-24: a NULL-due commitment with no admissible witness is never sent to the model and never bells', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, due_at: null,
      quote: 'You still coming this morning?', description: 'You still coming this morning?' };
    await recordMessageOperations(mockPg, message, result, context);
    await mockPg('call_commitments').update({ due_at: null, due_basis: null });
    const now = new Date(message.created_at.getTime() + 2000);
    const outcome = await refreshSmsCommitments({ conn: mockPg, now });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ scanned: 1, fulfilled: 0, skipped_no_witness: 1 });
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('Codex #4816 r2: a logged reschedule inside the 24h window reaches the model at once (service check), no bell', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'schedule_visit', due_at: null,
      quote: 'Can we move to next week?', description: 'Can we move to next week?' };
    await recordMessageOperations(mockPg, message, result, context);
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const nextWeek = etDateString(new Date(after.getTime() + 7 * 86400000));
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: message.customer_id, property_id: context.properties[0].id, service_type: 'Quarterly Lawn',
      scheduled_date: nextWeek, window_start: '09:00:00', status: 'confirmed',
      created_at: new Date(message.created_at.getTime() - 1000), updated_at: after,
    }).returning('id');
    await mockPg('reschedule_log').insert({ scheduled_service_id: visit.id, customer_id: message.customer_id,
      original_date: etDateString(message.created_at), new_date: nextWeek, initiated_by: 'admin', created_at: after });
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'different_service', evidence_hash: 'x', retry_after: null }));
    const outcome = await refreshSmsCommitments({ conn: mockPg, verify, now });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ scanned: 1, fulfilled: 0, skipped_not_due: 0 });
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('Codex #4816 r7: a visit cancelled after a cancel ask is evidence for the model, never a no-model close', async () => {
    result.facts = [];
    // Scoped to the property: an unscoped cancel ask is never answered by a
    // cancellation (Codex #4816 r27).
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, due_at: null, property_id: context.properties[0].id,
      quote: 'Please cancel my appointment', description: 'Please cancel my appointment' };
    await recordMessageOperations(mockPg, message, result, context);
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: message.customer_id, property_id: context.properties[0].id, service_type: 'Quarterly Pest Control',
      scheduled_date: etDateString(new Date(after.getTime() + 3 * 86400000)), window_start: '09:00:00', status: 'cancelled',
      created_at: new Date(message.created_at.getTime() - 86400000), updated_at: after,
    }).returning('id');
    await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'confirmed', to_status: 'cancelled', transitioned_at: after });
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'model_says_open', evidence_hash: 'x', retry_after: null }));
    const outcome = await refreshSmsCommitments({ conn: mockPg, verify, now });
    expect(verify).toHaveBeenCalledTimes(1);
    const cancelled = verify.mock.calls[0][1].records.find((r) => r.type === 'visit');
    expect(cancelled).toMatchObject({ id: visit.id, status: 'cancelled' });
    expect(cancelled.text).toContain('cancelled after the request');
    expect(outcome).toMatchObject({ scanned: 1, fulfilled: 0 });
  });

  test('R2 rules 1–3: an invoice paid via a settled payment after a payment "other" question reaches the model at once — money landing never closes an ask on its own', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, due_at: null, property_id: null,
      quote: 'What is the Zelle number?', description: 'What is the Zelle number?' };
    await recordMessageOperations(mockPg, message, result, context);
    await mockPg('call_commitments').update({ due_at: null, due_basis: null });
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(),
      invoice_number: 'WPC-2026-0407', title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]',
      status: 'paid', paid_at: after, created_at: new Date(message.created_at.getTime() - 86400000) }).returning('id');
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(after),
      metadata: JSON.stringify({ invoice_id: invoice.id, settled_event_at: after.toISOString() }), created_at: after });
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'model_says_open', evidence_hash: 'x', retry_after: null }));
    const outcome = await refreshSmsCommitments({ conn: mockPg, verify, now });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0][1].records.find((r) => r.type === 'payment')).toMatchObject({ payment_source: 'invoice', invoice_id: invoice.id });
    expect(outcome).toMatchObject({ scanned: 1, fulfilled: 0 });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('R2 rule 3: a payment whose settled_event_at predates the request is not evidence even though the invoice\'s own paid_at falls after it', async () => {
    const before = new Date(message.created_at.getTime() - 1000);
    const after = new Date(message.created_at.getTime() + 1000);
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0410',
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'paid', paid_at: after }).returning('id');
    // The invoice write looks like it lands after the request, but the
    // underlying payment actually settled BEFORE it — rule 3 keys off the
    // payment's own settlement, never the invoice's paid_at stamp alone.
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(before),
      metadata: JSON.stringify({ invoice_id: invoice.id, settled_event_at: before.toISOString() }), created_at: before });
    const commitment = { kind: 'other', description: 'Did you receive my payment?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, new Date(after.getTime() + 1000));
    expect(evidence.records.filter((r) => r.type === 'payment')).toHaveLength(0);
  });

  test('R2 rule 3: an ACH row created before the request but settled after it (settled_event_at, never created_at) still counts', async () => {
    const before = new Date(message.created_at.getTime() - 86400000);
    const after = new Date(message.created_at.getTime() + 1000);
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0414',
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'paid', paid_at: after }).returning('id');
    // Inserted while still 'processing' (created_at predates the request);
    // the webhook flips it to paid in place without touching created_at.
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(after),
      metadata: JSON.stringify({ invoice_id: invoice.id, settled_event_at: after.toISOString() }), created_at: before, updated_at: after });
    const commitment = { kind: 'other', description: 'Did my ACH payment go through?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, new Date(after.getTime() + 1000));
    expect(evidence.records.filter((r) => r.type === 'payment' && r.payment_source === 'invoice').map((r) => r.invoice_id)).toEqual([invoice.id]);
  });

  test('R2 rule 4: a staff-recorded ledger prepayment with no invoice is loaded as payment evidence the model may weigh', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, due_at: null, property_id: null,
      quote: 'Did you receive my Zelle prepayment?', description: 'Did you receive my Zelle prepayment?' };
    await recordMessageOperations(mockPg, message, result, context);
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    // No metadata.settled_event_at — the real write never sets one (it is
    // inserted already 'paid', with no async settlement lag), so this also
    // covers the COALESCE-to-created_at fallback.
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 200, status: 'paid', payment_date: etDateString(after),
      description: 'Account credit prepayment — zelle', metadata: JSON.stringify({ source: 'account_credit_prepayment', method: 'zelle' }), created_at: after });
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'model_says_open', evidence_hash: 'x', retry_after: null }));
    const outcome = await refreshSmsCommitments({ conn: mockPg, verify, now });
    expect(verify).toHaveBeenCalledTimes(1);
    const ledger = verify.mock.calls[0][1].records.find((r) => r.type === 'payment');
    expect(ledger).toMatchObject({ payment_source: 'ledger' });
    expect(ledger.text).toContain('Payment of $200.00 by Zelle recorded');
    expect(outcome).toMatchObject({ scanned: 1, fulfilled: 0 });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('R2 rule 4: a payment linked to an invoice is invoice-source evidence, never double-counted on the ledger leg', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0411',
      title: 'Quarterly Pest Control', total: 50, subtotal: 50, line_items: '[]', status: 'paid', paid_at: after }).returning('id');
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 50, status: 'paid', payment_date: etDateString(after),
      metadata: JSON.stringify({ invoice_id: invoice.id, settled_event_at: after.toISOString() }), created_at: after });
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 200, status: 'paid', payment_date: etDateString(after),
      description: 'Account credit prepayment — cash', metadata: JSON.stringify({ source: 'account_credit_prepayment', method: 'cash' }), created_at: after });
    const commitment = { kind: 'other', description: 'Did you receive my payment?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, new Date(after.getTime() + 1000));
    const payments = evidence.records.filter((r) => r.type === 'payment');
    expect(payments.filter((r) => r.payment_source === 'invoice')).toHaveLength(1);
    expect(payments.filter((r) => r.payment_source === 'ledger')).toHaveLength(1);
  });

  test('R2 rule 5: money a third-party payer settles is not the customer\'s own payment (invoices.payer_id, payments.payer_id and payments.metadata.payer_id)', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const [payer] = await mockPg('payers').insert({ display_name: 'Synthetic Property Manager' }).returning('id');
    const [payerInvoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0412',
      title: 'Termite Bond', total: 400, subtotal: 400, line_items: '[]', status: 'paid', paid_at: after, payer_id: payer.id }).returning('id');
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 400, status: 'paid', payment_date: etDateString(after),
      metadata: JSON.stringify({ invoice_id: payerInvoice.id, settled_event_at: after.toISOString() }), created_at: after });
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 300, status: 'paid', payment_date: etDateString(after),
      metadata: JSON.stringify({ payer_id: String(payer.id) }), created_at: after });
    // The payer column that customer-keyed payment readers exclude (waves-billing invariant 12).
    await mockPg('payments').insert({ customer_id: message.customer_id, payer_id: payer.id, amount: 200, status: 'paid',
      payment_date: etDateString(after), metadata: JSON.stringify({}), created_at: after });
    const commitment = { kind: 'other', description: 'Did you receive my payment?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, new Date(after.getTime() + 1000));
    expect(evidence.records.filter((r) => r.type === 'payment')).toHaveLength(0);
  });

  test('R2 rule 6: for a customer with a property history, a property-scoped ask takes the invoice\'s own visit property and an unlinked ledger payment, never a payment for another property', async () => {
    await giveFormerProperty(message.customer_id);
    const [former] = await mockPg('customer_properties').where({ customer_id: message.customer_id, active: false }).pluck('id');
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, due_at: null, property_id: context.properties[0].id,
      quote: 'Did you receive my payment?', description: 'Did you receive my payment?' };
    await recordMessageOperations(mockPg, message, result, context);
    const before = new Date(message.created_at.getTime() - 86400000);
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [visit] = await mockPg('scheduled_services').insert({ customer_id: message.customer_id, property_id: context.properties[0].id,
      service_type: 'Quarterly Pest Control', scheduled_date: etDateString(after), window_start: '09:00:00', status: 'completed', created_at: before }).returning('id');
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0413',
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'paid', paid_at: after, scheduled_service_id: visit.id }).returning('id');
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(after),
      metadata: JSON.stringify({ invoice_id: invoice.id, settled_event_at: after.toISOString() }), created_at: after });
    // An unlinked ledger prepayment, same customer, tied to no property at all.
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 50, status: 'paid', payment_date: etDateString(after),
      metadata: JSON.stringify({ source: 'account_credit_prepayment', method: 'cash' }), created_at: after });
    // A payment toward a visit at the customer's former property.
    const [elsewhere] = await mockPg('scheduled_services').insert({ customer_id: message.customer_id, property_id: former,
      service_type: 'Quarterly Pest Control', scheduled_date: etDateString(after), window_start: '09:00:00', status: 'completed', created_at: before }).returning('id');
    const [elsewhereInvoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0414',
      title: 'Quarterly Pest Control', total: 95, subtotal: 95, line_items: '[]', status: 'paid', paid_at: after, scheduled_service_id: elsewhere.id }).returning('id');
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 95, status: 'paid', payment_date: etDateString(after),
      metadata: JSON.stringify({ invoice_id: elsewhereInvoice.id, settled_event_at: after.toISOString() }), created_at: after });
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'model_says_open', evidence_hash: 'x', retry_after: null }));
    const outcome = await refreshSmsCommitments({ conn: mockPg, verify, now });
    expect(verify).toHaveBeenCalledTimes(1);
    const paymentRecords = verify.mock.calls[0][1].records.filter((r) => r.type === 'payment');
    const linked = paymentRecords.find((r) => r.invoice_id === invoice.id);
    const other = paymentRecords.find((r) => r.invoice_id === elsewhereInvoice.id);
    const ledger = paymentRecords.find((r) => r.payment_source === 'ledger');
    expect(linked.property_id).toBe(context.properties[0].id);
    expect(other.property_id).toBe(former);
    expect(ledger.property_id).toBeNull();
    const scopedAsk = { kind: 'other', sms_context: { property_id: context.properties[0].id, money_answerable: true } };
    expect(admissibleWitness(linked, scopedAsk)).toBe(true);
    expect(admissibleWitness(ledger, scopedAsk)).toBe(true);
    expect(admissibleWitness(other, scopedAsk)).toBe(false);
    expect(outcome).toMatchObject({ scanned: 1, fulfilled: 0 });
  });

  test('R2 rule 8: revalidation re-reads the payment under lock — a payment reversed since the check never grounds a fulfilled verdict', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, due_at: null,
      quote: 'Did you receive my payment?', description: 'Did you receive my payment?' };
    await recordMessageOperations(mockPg, message, result, context);
    await mockPg('call_commitments').update({ due_at: null, due_basis: null });
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [payment] = await mockPg('payments').insert({ customer_id: message.customer_id, amount: 200, status: 'paid', payment_date: etDateString(after),
      metadata: JSON.stringify({ source: 'account_credit_prepayment', method: 'cash' }), created_at: after }).returning('id');
    const commitment = { kind: 'other', description: 'Did you receive my payment?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const witness = evidence.records.find((r) => r.type === 'payment');
    expect(witness).toMatchObject({ payment_source: 'ledger', id: payment.id });
    const verdict = { verdict: 'fulfilled', record_type: 'payment', record_id: payment.id, payment_source: 'ledger', quote: witness.text,
      evidence_hash: fulfillmentFingerprint(commitment, evidence).evidenceHash };
    await mockPg.transaction(async (trx) => {
      expect(await revalidateSmsFulfillment(trx, commitment, message, verdict, now)).toBe(true);
    });
    // A refund lands between the check and the close: revalidation fails closed.
    await mockPg('payments').where({ id: payment.id }).update({ status: 'refunded' });
    await mockPg.transaction(async (trx) => {
      expect(await revalidateSmsFulfillment(trx, commitment, message, verdict, now)).toBe(false);
    });
  });

  test('R2 rule 8: an invoice-source payment locks its settling payments row; a dispute holding or reversing it fails the close', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0802',
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'paid', paid_at: after }).returning('id');
    const [payment] = await mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(after),
      metadata: JSON.stringify({ invoice_id: invoice.id }), created_at: after }).returning('id');
    const commitment = { kind: 'other', description: 'Did you receive my payment?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const witness = evidence.records.find((r) => r.type === 'payment' && r.payment_source === 'invoice');
    expect(witness).toMatchObject({ id: payment.id, invoice_id: invoice.id });
    const grounded = groundFulfillment({ verdict: 'fulfilled', record_ref: witness.ref, quote: witness.text }, evidence, commitment);
    expect(grounded).toMatchObject({ verdict: 'fulfilled', record_id: payment.id, linked_record_type: 'invoice', linked_record_id: invoice.id });
    const verdict = { ...grounded, evidence_hash: fulfillmentFingerprint(commitment, evidence).evidenceHash };
    await mockPg.transaction(async (trx) => {
      expect(await revalidateSmsFulfillment(trx, commitment, message, verdict, now)).toBe(true);
    });
    // A dispute holding the payments row (it updates payments before the invoice): no wait, no close.
    const disputer = await mockPg.transaction();
    try {
      await disputer('payments').where({ id: payment.id }).forUpdate().first('id');
      await mockPg.transaction(async (trx) => {
        expect(await revalidateSmsFulfillment(trx, commitment, message, verdict, now)).toBe(false);
      });
    } finally { await disputer.rollback(); }
    // The dispute commits the reversal: the reread evidence no longer matches.
    await mockPg('payments').where({ id: payment.id }).update({ status: 'disputed' });
    await mockPg.transaction(async (trx) => {
      expect(await revalidateSmsFulfillment(trx, commitment, message, verdict, now)).toBe(false);
    });
  });

  test('R2 rule 10: an invoice paid on an Eastern evening reads as that Eastern day, not the next UTC day', async () => {
    const at = new Date(Math.max(message.created_at.getTime() + 1000, Date.parse('2026-01-01T00:00:00Z')));
    // 9:30 PM Eastern on the day after the text is already the next UTC day.
    const evening = new Date(`${etDateString(new Date(at.getTime() + 86400000))}T21:30:00-05:00`);
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0801',
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'paid', paid_at: evening }).returning('id');
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(evening),
      metadata: JSON.stringify({ invoice_id: invoice.id, settled_event_at: evening.toISOString() }), created_at: evening });
    const commitment = { kind: 'other', description: 'Did you receive my payment?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, new Date(evening.getTime() + 1000));
    const row = evidence.records.find((r) => r.type === 'payment' && r.payment_source === 'invoice');
    expect(row.text).toContain(`received ${etDateString(evening)}`);
    expect(row.text).not.toContain(evening.toISOString().slice(0, 10));
  });

  test('Codex #4996 r1: a cash, check or Zelle payment recorded against a self-pay invoice is that invoice\'s evidence at its visit\'s property, not an unlinked ledger row', async () => {
    const [visit] = await mockPg('scheduled_services').insert({ customer_id: message.customer_id, property_id: context.properties[0].id,
      service_type: 'Quarterly Pest Control', scheduled_date: etDateString(message.created_at), window_start: '09:00:00', status: 'completed',
      created_at: new Date(message.created_at.getTime() - 86400000) }).returning('id');
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0901',
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'sent', scheduled_service_id: visit.id,
      stripe_payment_intent_id: 'pi_retired_pay_page' }).returning('id');
    // What recordManualPayment (invoice-manual-payment.js) writes for a
    // self-pay invoice with no credit applied, in ONE transaction: the
    // invoice's paid and recorded stamps, its PaymentIntent cleared, and a
    // ledger row that names no invoice.
    const [manual] = await mockPg.transaction(async (trx) => {
      await trx('invoices').where({ id: invoice.id }).update({ status: 'paid', paid_at: trx.fn.now(), payment_method: 'check',
        payment_recorded_at: trx.fn.now(), stripe_payment_intent_id: null });
      return trx('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid',
        description: 'Invoice WPC-2026-0901 — check', payment_date: etDateString(new Date()) }).returning('id');
    });
    // A prepayment recorded on its own stays an unlinked ledger row.
    const [prepayment] = await mockPg('payments').insert({ customer_id: message.customer_id, amount: 40, status: 'paid',
      payment_date: etDateString(new Date()), metadata: JSON.stringify({ source: 'account_credit_prepayment', method: 'cash' }),
      created_at: new Date(Date.now() + 1000) }).returning('id');
    const commitment = { kind: 'other', description: 'Did you get my check?',
      sms_context: { property_id: context.properties[0].id, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, new Date(Date.now() + 60000));
    const payments = evidence.records.filter((r) => r.type === 'payment');
    const linked = payments.find((r) => r.payment_source === 'invoice');
    expect(linked).toMatchObject({ id: manual.id, invoice_id: invoice.id, property_id: context.properties[0].id });
    // The tender rides on the invoice this payment settled.
    expect(linked.text).toContain('Payment of $125.00 by check toward invoice WPC-2026-0901');
    expect(admissibleWitness(linked, commitment)).toBe(true);
    expect(payments.filter((r) => r.payment_source === 'ledger').map((r) => r.id)).toEqual([prepayment.id]);
  });

  test('Codex #4996 r1: a staff note typed on a ledger payment (a name, phone number, email) never reaches the model', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 200, status: 'paid', payment_date: etDateString(after),
      description: 'Account credit prepayment — zelle (from Pat Example 941-555-0123 pat.example@example.invalid)',
      metadata: JSON.stringify({ source: 'account_credit_prepayment', method: 'zelle' }), created_at: after });
    const commitment = { kind: 'other', description: 'Did you receive my Zelle?',
      sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    expect(evidence.records.find((r) => r.payment_source === 'ledger').text).toBe(`Payment of $200.00 by Zelle recorded ${etDateString(after)}`);
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    await verifySmsFulfillment(commitment, evidence, { now });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    const prompt = JSON.stringify(dispatchWithFallback.mock.calls[0]);
    for (const note of ['Pat Example', '941-555-0123', 'pat.example@example.invalid']) expect(prompt).not.toContain(note);
    expect(prompt).toContain('by Zelle');
  });

  test('Codex #4996 r1: an invoice payment reads as its number, title and settled amount, dated when the money settled — not when a late webhook stamped the invoice paid', async () => {
    const settled = new Date(message.created_at.getTime() + 1000);
    const stamped = new Date(settled.getTime() + 2 * 86400000);
    const now = new Date(stamped.getTime() + 1000);
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0902',
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'paid', paid_at: stamped }).returning('id');
    const [payment] = await mockPg('payments').insert({ customer_id: message.customer_id, amount: 118.75, status: 'paid', payment_date: etDateString(settled),
      metadata: JSON.stringify({ invoice_id: invoice.id, settled_event_at: settled.toISOString() }), created_at: stamped }).returning('id');
    const commitment = { kind: 'other', description: 'Did my $118.75 payment go through?',
      sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const witness = evidence.records.find((r) => r.payment_source === 'invoice');
    expect(witness.text).toBe(`Payment of $118.75 toward invoice WPC-2026-0902 (Quarterly Pest Control) received ${etDateString(settled)}; the invoice is paid in full`);
    const grounded = groundFulfillment({ verdict: 'fulfilled', record_ref: witness.ref, quote: witness.text }, evidence, commitment);
    expect(grounded).toMatchObject({ verdict: 'fulfilled', record_id: payment.id, linked_record_type: 'invoice', linked_record_id: invoice.id });
    expect(new Date(grounded.matched_at).getTime()).toBe(settled.getTime());
  });

  test('Codex #4996 r1: a payment on another customer\'s account never settles this customer\'s invoice', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const otherCustomer = randomUUID();
    await mockPg('customers').insert({ id: otherCustomer, first_name: 'Other', last_name: 'Fixture', phone: '+12025550199',
      address_line1: '300 Example Lane', city: 'Sarasota', zip: '34236' });
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0903',
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'paid', paid_at: after }).returning('id');
    const settledRow = (customerId) => ({ customer_id: customerId, amount: 125, status: 'paid', payment_date: etDateString(after),
      metadata: JSON.stringify({ invoice_id: invoice.id, settled_event_at: after.toISOString() }), created_at: after });
    await mockPg('payments').insert(settledRow(otherCustomer));
    const commitment = { kind: 'other', description: 'Did you receive my payment?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    expect((await loadSmsFulfillmentEvidence(mockPg, commitment, message, now)).records.filter((r) => r.type === 'payment')).toEqual([]);
    const [own] = await mockPg('payments').insert(settledRow(message.customer_id)).returning('id');
    expect((await loadSmsFulfillmentEvidence(mockPg, commitment, message, now)).records.filter((r) => r.type === 'payment'))
      .toMatchObject([{ id: own.id, invoice_id: invoice.id }]);
  });

  test('Codex #4996 r1/r12: a combined balance charge is not evidence (its partial refunds are parked off its rows); a row naming no invoice still links by its PaymentIntent', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const invoiceRow = (number, pi) => ({ customer_id: message.customer_id, token: randomUUID(), invoice_number: number,
      title: 'Quarterly Pest Control', total: 60, subtotal: 60, line_items: '[]', status: 'paid', paid_at: after, stripe_payment_intent_id: pi });
    // The third invoice shares the combined PaymentIntent with no allocation row of its own.
    const [first, second, , legacy] = await mockPg('invoices').insert([invoiceRow('WPC-2026-0911', 'pi_combined'),
      invoiceRow('WPC-2026-0912', 'pi_combined'), invoiceRow('WPC-2026-0913', 'pi_combined'), invoiceRow('WPC-2026-0914', 'pi_legacy')]).returning('id');
    // One settlement instant for every allocation of the combined charge.
    const paymentRow = (pi, metadata) => ({ customer_id: message.customer_id, amount: 60, status: 'paid', payment_date: etDateString(after),
      stripe_payment_intent_id: pi, metadata: JSON.stringify({ ...metadata, settled_event_at: after.toISOString() }), created_at: after });
    // pay-combined.js books one row per invoice the charge covers, each marked combined_payment.
    const combined = { combined_payment: true, combined_anchor_invoice_id: first.id };
    const [, , legacyPaid] = await mockPg('payments').insert([paymentRow('pi_combined', { ...combined, invoice_id: first.id }),
      paymentRow('pi_combined', { ...combined, invoice_id: second.id }), paymentRow('pi_legacy', {})]).returning('id');
    const commitment = { kind: 'other', description: 'Did both payments go through?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    for (let read = 0; read < 2; read += 1) {
      const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
      expect(Object.fromEntries(evidence.records.filter((r) => r.type === 'payment').map((r) => [r.invoice_id, r.id])))
        .toEqual({ [legacy.id]: legacyPaid.id });
    }
  });

  test('Codex #4996 r1: a deposit received after the question is payment evidence at its estimate\'s property; pending, refunding, refunded and earlier deposits, and other customers\', are not', async () => {
    const before = new Date(message.created_at.getTime() - 1000);
    const after = new Date(message.created_at.getTime() + 1000);
    const otherCustomer = randomUUID();
    await mockPg('customers').insert({ id: otherCustomer, first_name: 'Other', last_name: 'Fixture', phone: '+12025550199',
      address_line1: '300 Example Lane', city: 'Sarasota', zip: '34236' });
    const [estimate, foreign] = await mockPg('estimates').insert([
      { customer_id: message.customer_id, property_id: context.properties[0].id, status: 'accepted', service_interest: 'Termite' },
      { customer_id: otherCustomer, status: 'accepted', service_interest: 'Lawn' }]).returning('id');
    const deposit = (estimateId, status, receivedAt) => ({ estimate_id: estimateId, amount: 150, status, received_at: receivedAt,
      stripe_payment_intent_id: `pi_deposit_${randomUUID()}` });
    const [received, credited] = await mockPg('estimate_deposits').insert([{ ...deposit(estimate.id, 'received', after), amount: 49, card_surcharge: 1.42 },
      deposit(estimate.id, 'credited', after)]).returning('id');
    await mockPg('estimate_deposits').insert([deposit(estimate.id, 'pending', null), deposit(estimate.id, 'refunding', after),
      deposit(estimate.id, 'refunded', after), deposit(estimate.id, 'received', before), deposit(foreign.id, 'received', after)]);
    const commitment = { kind: 'other', description: 'Did my deposit go through?',
      sms_context: { property_id: context.properties[0].id, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, new Date(after.getTime() + 1000));
    const deposits = evidence.records.filter((r) => r.payment_source === 'deposit');
    expect(deposits.map((r) => r.id).sort()).toEqual([received.id, credited.id].sort());
    const byId = Object.fromEntries(deposits.map((r) => [r.id, r]));
    // A card deposit shows the surcharge and the charged total its statement carries.
    expect(byId[received.id]).toMatchObject({ estimate_id: estimate.id, property_id: context.properties[0].id,
      text: `Deposit of $49.00 plus a $1.42 card surcharge ($50.42 charged) on the Termite estimate received ${etDateString(after)}` });
    expect(byId[credited.id].text).toBe(`Deposit of $150.00 on the Termite estimate received ${etDateString(after)}`);
    expect(admissibleWitness(byId[received.id], commitment)).toBe(true);
  });

  test('Codex #4996 r1: a deposit witness holds its estimate at close — an estimate writer holding it, the estimate passing to another customer, or a refund starting fails the close', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const otherCustomer = randomUUID();
    await mockPg('customers').insert({ id: otherCustomer, first_name: 'Other', last_name: 'Fixture', phone: '+12025550199',
      address_line1: '300 Example Lane', city: 'Sarasota', zip: '34236' });
    const [estimate] = await mockPg('estimates').insert({ customer_id: message.customer_id, status: 'accepted', service_interest: 'Termite' }).returning('id');
    const [deposit] = await mockPg('estimate_deposits').insert({ estimate_id: estimate.id, amount: 150, status: 'received', received_at: after,
      stripe_payment_intent_id: `pi_deposit_${randomUUID()}` }).returning('id');
    const commitment = { kind: 'other', description: 'Did my deposit go through?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const witness = evidence.records.find((r) => r.payment_source === 'deposit');
    const grounded = groundFulfillment({ verdict: 'fulfilled', record_ref: witness.ref, quote: witness.text }, evidence, commitment);
    expect(grounded).toMatchObject({ verdict: 'fulfilled', record_id: deposit.id, payment_source: 'deposit',
      linked_record_type: 'estimate', linked_record_id: estimate.id });
    const verdict = { ...grounded, evidence_hash: fulfillmentFingerprint(commitment, evidence).evidenceHash };
    const closes = () => mockPg.transaction((trx) => revalidateSmsFulfillment(trx, commitment, message, verdict, now));
    expect(await closes()).toBe(true);
    const writer = await mockPg.transaction();
    try {
      await writer('estimates').where({ id: estimate.id }).forUpdate().first('id');
      expect(await closes()).toBe(false);
    } finally { await writer.rollback(); }
    await mockPg('estimates').where({ id: estimate.id }).update({ customer_id: otherCustomer });
    expect(await closes()).toBe(false);
    await mockPg('estimates').where({ id: estimate.id }).update({ customer_id: message.customer_id });
    expect(await closes()).toBe(true);
    await mockPg('estimate_deposits').where({ id: deposit.id }).update({ status: 'refunding' });
    expect(await closes()).toBe(false);
  });

  test('Codex #4996 r1: payment legs are capped on their own — a full ledger leg beside deposits is complete; one leg past its cap truncates and the other legs are cut at its floor', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const at = (seconds) => new Date(after.getTime() + seconds * 1000);
    const ledger = (seconds) => ({ customer_id: message.customer_id, amount: 10, status: 'paid', payment_date: etDateString(after),
      metadata: JSON.stringify({ source: 'account_credit_prepayment', method: 'cash' }), created_at: at(seconds) });
    const [estimate] = await mockPg('estimates').insert({ customer_id: message.customer_id, status: 'accepted', service_interest: 'Termite' }).returning('id');
    const deposit = (seconds) => ({ estimate_id: estimate.id, amount: 150, status: 'received', received_at: at(seconds),
      stripe_payment_intent_id: `pi_deposit_${seconds}` });
    await mockPg('payments').insert(Array.from({ length: 50 }, (_, i) => ledger(10 + i)));
    await mockPg('estimate_deposits').insert([1, 2, 3, 70, 71, 72].map(deposit));
    const commitment = { kind: 'other', description: 'Did my payments go through?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const now = at(120);
    const complete = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    expect(complete.failures).toEqual([]);
    expect(complete.records.filter((r) => r.type === 'payment')).toHaveLength(56);
    // A 51st ledger row, older than the rest: that leg keeps seconds 10–59,
    // so deposits from before second 10 are cut with it.
    await mockPg('payments').insert(ledger(9));
    const truncated = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    expect(truncated.failures).toEqual(['payment_truncated']);
    const kept = truncated.records.filter((r) => r.type === 'payment');
    expect(kept.filter((r) => r.payment_source === 'ledger')).toHaveLength(50);
    expect(kept.filter((r) => r.payment_source === 'deposit').map((r) => new Date(r.received_at).getTime()).sort((a, b) => a - b))
      .toEqual([70, 71, 72].map((seconds) => at(seconds).getTime()));
  });

  test('Codex #4996 r3 pre-push: two installments toward one invoice after the question are two witnesses, each its own payment', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 60000);
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0962',
      title: 'Termite Bond', total: 300, subtotal: 300, line_items: '[]', status: 'sent' }).returning('id');
    const installment = (amount, at) => ({ customer_id: message.customer_id, amount, status: 'paid', payment_date: etDateString(at),
      metadata: JSON.stringify({ invoice_id: invoice.id }), created_at: at });
    const [first, second] = await mockPg('payments').insert([installment(100, after), installment(150, new Date(after.getTime() + 30000))]).returning('id');
    const commitment = { kind: 'other', description: 'Did you get my $100 payment?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const witnesses = evidence.records.filter((r) => r.payment_source === 'invoice');
    expect(witnesses.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(new Set(witnesses.map((r) => r.ref)).size).toBe(2);
    expect(witnesses.find((r) => r.id === first.id).text).toContain('Payment of $100.00 toward invoice WPC-2026-0962');
    const grounded = groundFulfillment({ verdict: 'fulfilled', record_ref: `payment:${first.id}`, quote: 'Payment of $100.00' }, evidence, commitment);
    expect(grounded).toMatchObject({ verdict: 'fulfilled', record_id: first.id, linked_record_type: 'invoice', linked_record_id: invoice.id });
  });

  test('Codex #4996 r4 pre-push: a partial refund is shown to the model and fails a close it races; money refunded in full is never evidence', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0971',
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'paid', paid_at: after }).returning('id');
    const [payment] = await mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(after),
      metadata: JSON.stringify({ invoice_id: invoice.id }), created_at: after }).returning('id');
    // Refunded in full but left 'paid': never money landing.
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 40, refund_amount: 40, refund_status: 'full', status: 'paid',
      payment_date: etDateString(after), metadata: JSON.stringify({ source: 'account_credit_prepayment', method: 'cash' }), created_at: after });
    const [estimate] = await mockPg('estimates').insert({ customer_id: message.customer_id, status: 'accepted', service_interest: 'Termite' }).returning('id');
    await mockPg('estimate_deposits').insert({ estimate_id: estimate.id, amount: 150, refunded_amount: 50, status: 'received', received_at: after,
      stripe_payment_intent_id: 'pi_deposit_partly_refunded' });
    const commitment = { kind: 'other', description: 'Did my payment go through?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const payments = evidence.records.filter((r) => r.type === 'payment');
    expect(payments.map((r) => r.payment_source).sort()).toEqual(['deposit', 'invoice']);
    expect(payments.find((r) => r.payment_source === 'deposit').text).toContain('; $50.00 of it refunded');
    const witness = payments.find((r) => r.payment_source === 'invoice');
    expect(witness.text).not.toContain('refunded');
    const grounded = groundFulfillment({ verdict: 'fulfilled', record_ref: witness.ref, quote: witness.text }, evidence, commitment);
    const verdict = { ...grounded, evidence_hash: fulfillmentFingerprint(commitment, evidence).evidenceHash };
    const closes = () => mockPg.transaction((trx) => revalidateSmsFulfillment(trx, commitment, message, verdict, now));
    expect(await closes()).toBe(true);
    // A partial refund lands between the check and the close.
    await mockPg('payments').where({ id: payment.id }).update({ refund_amount: 25, refund_status: 'partial' });
    expect(await closes()).toBe(false);
    const recheck = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    expect(recheck.records.find((r) => r.id === payment.id).text).toContain('; $25.00 of it refunded');
  });

  test('Codex #4996 r3: a partial payment on an invoice still open is money landing, and reads as partial', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0961',
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'sent' }).returning('id');
    const [payment] = await mockPg('payments').insert({ customer_id: message.customer_id, amount: 50, status: 'paid', payment_date: etDateString(after),
      metadata: JSON.stringify({ invoice_id: invoice.id }), created_at: after }).returning('id');
    const commitment = { kind: 'other', description: 'Did you get my $50?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const witness = evidence.records.find((r) => r.payment_source === 'invoice');
    expect(witness).toMatchObject({ id: payment.id, invoice_id: invoice.id,
      text: `Payment of $50.00 toward invoice WPC-2026-0961 (Quarterly Pest Control) received ${etDateString(after)}` });
    expect(witness).not.toHaveProperty('paid_in_full');
    expect(admissibleWitness(witness, commitment)).toBe(true);
    expect(evidence.records.filter((r) => r.payment_source === 'ledger')).toEqual([]);
  });

  test('Codex #4996 r8 pre-push: a visit prepayment stamp is a balance, not a receipt — neither the stamp nor its application at completion is evidence', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const completedAt = new Date(message.created_at.getTime() + 2 * 3600000);
    const now = new Date(completedAt.getTime() + 1000);
    // Stamped after the question, then applied to its invoice at completion (complete-scheduled-service.js).
    const [visit] = await mockPg('scheduled_services').insert({ customer_id: message.customer_id, property_id: context.properties[0].id,
      service_type: 'Quarterly Pest Control', scheduled_date: etDateString(completedAt), window_start: '09:00:00', status: 'completed',
      prepaid_amount: 125, prepaid_method: 'cash', prepaid_at: after, created_at: new Date(message.created_at.getTime() - 86400000) }).returning('id');
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0952',
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'paid', paid_at: completedAt,
      scheduled_service_id: visit.id }).returning('id');
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(completedAt),
      description: 'Prepaid credit applied to invoice WPC-2026-0952', created_at: completedAt,
      metadata: JSON.stringify({ invoice_id: invoice.id, scheduled_service_id: visit.id, source: 'scheduled_service_prepaid', method: 'cash' }) });
    // A staff-recorded payment whose method was typed free-form: counted, but the text never carries the typed method.
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 40, status: 'paid', payment_date: etDateString(after),
      metadata: JSON.stringify({ method: 'Zelle from Pat Example 941-555-0123' }), created_at: after });
    const commitment = { kind: 'other', description: 'Did you get my cash payment?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const payments = evidence.records.filter((r) => r.type === 'payment');
    expect(payments.map((r) => r.payment_source)).toEqual(['ledger']);
    expect(payments[0].text).toBe(`Payment of $40.00 recorded ${etDateString(after)}`);
    expect(JSON.stringify(evidence.records)).not.toContain('941-555-0123');
  });

  test('Codex #4996 r8/r9: a payment shows the invoice amount beside the surcharged charge and what paid it — the card, the saved method, or the bank — and an untitled invoice shows its service', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-1001',
      title: null, service_type: 'Termite Treatment', total: 100, subtotal: 100, line_items: '[]', status: 'paid', paid_at: after }).returning('id');
    // The saved card the monthly dues charge ran on; the payment row carries no snapshot of its own.
    const [savedCard, savedBank] = await mockPg('payment_methods').insert([{ customer_id: message.customer_id, stripe_payment_method_id: `pm_synthetic_${randomUUID()}`,
      card_brand: 'MASTERCARD', last_four: '5454', method_type: 'card' },
    { customer_id: message.customer_id, stripe_payment_method_id: `pm_synthetic_${randomUUID()}`, method_type: 'ach', bank_last_four: '4321' }]).returning('id');
    // Stripe rows carry the settlement moment their writers stamp from Stripe.
    const stamped = (metadata) => JSON.stringify({ ...metadata, settled_event_at: after.toISOString() });
    const card = (extra) => ({ customer_id: message.customer_id, status: 'paid', payment_date: etDateString(after), processor: 'stripe', created_at: after,
      ...extra, metadata: stamped(JSON.parse(extra.metadata || '{}')) });
    const [, dues, bank, savedBankDues] = await mockPg('payments').insert([
      card({ amount: 102.90, base_amount_cents: 10000, surcharge_amount_cents: 290, stripe_payment_intent_id: 'pi_card_invoice',
        card_brand: 'visa', card_last_four: '4242', metadata: JSON.stringify({ invoice_id: invoice.id, payment_method: 'card' }) }),
      card({ amount: 92.57, base_amount_cents: 9000, surcharge_amount_cents: 257, stripe_payment_intent_id: 'pi_card_dues',
        payment_method_id: savedCard.id, metadata: JSON.stringify({ billed_month: '2026-09' }) }),
      card({ amount: 60, stripe_payment_intent_id: 'pi_bank', card_last_four: '6789', metadata: JSON.stringify({ payment_method: 'us_bank_account' }) }),
      // A bank autopay charge on a saved ACH method: the digits live in the method's own bank column (Codex #4996 r12).
      card({ amount: 45, stripe_payment_intent_id: 'pi_saved_bank', payment_method_id: savedBank.id, metadata: JSON.stringify({ billed_month: '2026-09' }) })]).returning('id');
    const commitment = { kind: 'other', description: 'Did my $100 termite payment go through?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    expect(evidence.records.find((r) => r.payment_source === 'invoice').text)
      .toBe(`Payment of $102.90 ($100.00 plus a $2.90 card surcharge) by Visa ending 4242 toward invoice WPC-2026-1001 (Termite Treatment) received ${etDateString(after)}; the invoice is paid in full`);
    const ledger = Object.fromEntries(evidence.records.filter((r) => r.payment_source === 'ledger').map((r) => [r.id, r]));
    expect(ledger[dues.id].text)
      .toBe(`Payment of $92.57 ($90.00 plus a $2.57 card surcharge) by Mastercard ending 5454 recorded ${etDateString(after)} (monthly plan charge for 2026-09)`);
    expect(ledger[bank.id].text).toBe(`Payment of $60.00 by bank account (ACH) ending 6789 recorded ${etDateString(after)}`);
    expect(ledger[savedBankDues.id].text).toBe(`Payment of $45.00 by bank account (ACH) ending 4321 recorded ${etDateString(after)} (monthly plan charge for 2026-09)`);
    // The tender reaches the model only as text, never as fields of its own.
    for (const record of evidence.records.filter((r) => r.type === 'payment')) {
      for (const field of ['method', 'method_type', 'card_brand', 'last_four']) expect(record).not.toHaveProperty(field);
    }
  });

  test('Codex #4996 r9 review: a reconciled payment reads its tender from the invoice it settled; an earlier installment on an invoice never borrows the invoice\'s tender', async () => {
    const at = (seconds) => new Date(message.created_at.getTime() + seconds * 1000);
    const now = at(10);
    const invoiceRow = (number, extra) => ({ customer_id: message.customer_id, token: randomUUID(), invoice_number: number,
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'paid', paid_at: at(3), ...extra });
    // Staff settled one invoice after the fact through the reconcile route (admin-payments-reconcile.js), and the
    // other with a check (recordManualPayment) after a Stripe installment that left no tender on its own row.
    const [reconciled, installments] = await mockPg('invoices').insert([invoiceRow('WPC-2026-0997', { payment_method: 'zelle' }),
      invoiceRow('WPC-2026-0998', { payment_method: 'check', payment_recorded_at: at(3) })]).returning('id');
    const row = (amount, createdAt, metadata) => ({ customer_id: message.customer_id, amount, status: 'paid', payment_date: etDateString(createdAt),
      created_at: createdAt, metadata: JSON.stringify(metadata) });
    const [reconciledPaid, installment, settling] = await mockPg('payments').insert([
      row(125, at(2), { invoice_id: reconciled.id, source: 'admin_payment_reconcile' }),
      row(50, at(1), { invoice_id: installments.id }),
      row(75, at(3), {})]).returning('id');
    const commitment = { kind: 'other', description: 'Did you get my payment?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const text = Object.fromEntries(evidence.records.filter((r) => r.type === 'payment').map((r) => [r.id, r.text]));
    expect(text[reconciledPaid.id]).toContain('Payment of $125.00 by Zelle toward invoice WPC-2026-0997');
    expect(text[settling.id]).toContain('Payment of $75.00 by check toward invoice WPC-2026-0998');
    expect(text[installment.id]).toContain('Payment of $50.00 toward invoice WPC-2026-0998');
  });

  test('Codex #4996 r10: an annual-prepay invoice takes its property from the estimate its term came from, and a scoped close holds the term and that estimate', async () => {
    await giveFormerProperty(message.customer_id);
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const propertyId = context.properties[0].id;
    const [estimate] = await mockPg('estimates').insert({ customer_id: message.customer_id, property_id: propertyId,
      status: 'accepted', service_interest: 'Pest Control' }).returning('id');
    // No visit and no setup-fee claim: only the term ties this invoice to a property.
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-1002',
      title: 'Annual prepay', total: 600, subtotal: 600, line_items: '[]', status: 'paid', paid_at: after }).returning('id');
    const [term] = await mockPg('annual_prepay_terms').insert({ customer_id: message.customer_id, term_start: '2026-10-01', term_end: '2027-09-30',
      source_estimate_id: estimate.id, prepay_invoice_id: invoice.id }).returning('id');
    const [payment] = await mockPg('payments').insert({ customer_id: message.customer_id, amount: 600, status: 'paid', payment_date: etDateString(after),
      created_at: after, metadata: JSON.stringify({ invoice_id: invoice.id, settled_event_at: after.toISOString() }) }).returning('id');
    const commitment = { kind: 'other', description: 'Did my annual payment go through?', sms_context: { property_id: propertyId, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const witness = evidence.records.find((r) => r.id === payment.id);
    expect(witness).toMatchObject({ invoice_id: invoice.id, property_id: propertyId });
    expect(admissibleWitness(witness, commitment)).toBe(true);
    const grounded = groundFulfillment({ verdict: 'fulfilled', record_ref: witness.ref, quote: witness.text }, evidence, commitment);
    const verdict = { ...grounded, evidence_hash: fulfillmentFingerprint(commitment, evidence).evidenceHash };
    const closes = () => mockPg.transaction((trx) => revalidateSmsFulfillment(trx, commitment, message, verdict, now));
    expect(await closes()).toBe(true);
    for (const [table, id] of [['annual_prepay_terms', term.id], ['estimates', estimate.id]]) {
      const writer = await mockPg.transaction();
      try {
        await writer(table).where({ id }).forUpdate().first('id');
        expect(await closes()).toBe(false);
      } finally { await writer.rollback(); }
    }
  });

  test('Codex #4996 r11: a Customer 360 prepay for a direct series takes its property from the series visit its setup-fee claim names, and a scoped close holds that visit', async () => {
    await giveFormerProperty(message.customer_id);
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const propertyId = context.properties[0].id;
    const [seriesRoot] = await mockPg('scheduled_services').insert({ customer_id: message.customer_id, property_id: propertyId,
      service_type: 'Rodent Bait Stations', scheduled_date: etDateString(message.created_at), window_start: '09:00:00', status: 'confirmed',
      created_at: new Date(message.created_at.getTime() - 86400000) }).returning('id');
    // No visit on the invoice and no estimate on the claim: the series root is the only link (secure-appointment-plans.js).
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-1003',
      title: 'Rodent annual prepay', total: 480, subtotal: 480, line_items: '[]', status: 'paid', paid_at: after }).returning('id');
    await mockPg('setup_fee_claims').insert({ invoice_id: invoice.id, scheduled_service_id: seriesRoot.id, amount: 99 });
    const [payment] = await mockPg('payments').insert({ customer_id: message.customer_id, amount: 480, status: 'paid', payment_date: etDateString(after),
      created_at: after, metadata: JSON.stringify({ invoice_id: invoice.id, settled_event_at: after.toISOString() }) }).returning('id');
    const commitment = { kind: 'other', description: 'Did my prepayment go through?', sms_context: { property_id: propertyId, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const witness = evidence.records.find((r) => r.id === payment.id);
    expect(witness).toMatchObject({ invoice_id: invoice.id, property_id: propertyId });
    const grounded = groundFulfillment({ verdict: 'fulfilled', record_ref: witness.ref, quote: witness.text }, evidence, commitment);
    const verdict = { ...grounded, evidence_hash: fulfillmentFingerprint(commitment, evidence).evidenceHash };
    const closes = () => mockPg.transaction((trx) => revalidateSmsFulfillment(trx, commitment, message, verdict, now));
    expect(await closes()).toBe(true);
    const writer = await mockPg.transaction();
    try {
      await writer('scheduled_services').where({ id: seriesRoot.id }).forUpdate().first('id');
      expect(await closes()).toBe(false);
    } finally { await writer.rollback(); }
  });

  test('Codex #4996 r11: money no link ties to a property belongs to the customer\'s only property, and still counts for a scoped ask once they have had another', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const propertyId = context.properties[0].id;
    // An office invoice with no visit, and the monthly autopay on no invoice.
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-1004',
      title: 'Service call', total: 95, subtotal: 95, line_items: '[]', status: 'paid', paid_at: after }).returning('id');
    const row = (amount, metadata) => ({ customer_id: message.customer_id, amount, status: 'paid', payment_date: etDateString(after),
      created_at: after, metadata: JSON.stringify({ ...metadata, settled_event_at: after.toISOString() }) });
    const [office, autopay] = await mockPg('payments').insert([row(95, { invoice_id: invoice.id }),
      row(89, { billed_month: '2026-09' })]).returning('id');
    const scoped = { kind: 'other', description: 'Did my payment go through?', sms_context: { property_id: propertyId, source_at: message.created_at.toISOString(), money_answerable: true } };
    const unscoped = { ...scoped, sms_context: { property_id: null, source_at: scoped.sms_context.source_at } };
    const payments = async (commitment) => Object.fromEntries((await loadSmsFulfillmentEvidence(mockPg, commitment, message, now)).records
      .filter((r) => r.type === 'payment').map((r) => [r.id, r]));
    const only = await payments(scoped);
    for (const id of [office.id, autopay.id]) {
      expect(only[id].property_id).toBe(propertyId);
      expect(admissibleWitness(only[id], scoped)).toBe(true);
    }
    // An unscoped ask attributes nothing: it needs no property.
    expect((await payments(unscoped))[autopay.id].property_id).toBeNull();
    // Once the customer has had another property, a payment with no link is
    // no longer attributed to either, but nothing ties it to the other one,
    // so it still counts (owner ruling 2026-09-27).
    await giveFormerProperty(message.customer_id);
    const history = await payments(scoped);
    for (const id of [office.id, autopay.id]) {
      expect(history[id].property_id).toBeNull();
      expect(admissibleWitness(history[id], scoped)).toBe(true);
    }
  });

  test('Codex #4996 r9 review: a payment naming its invoice stays on it even when another invoice\'s manual stamp shares its instant', async () => {
    const at = new Date(message.created_at.getTime() + 1000);
    const now = new Date(at.getTime() + 1000);
    // Fixed ids put the stamped invoice first in id order, so only the link ranking can pick the named one.
    const stamped = 'aaaaaaaa-0000-4000-8000-000000000001';
    const named = 'ffffffff-0000-4000-8000-000000000002';
    const invoiceRow = (id, number, extra) => ({ id, customer_id: message.customer_id, token: randomUUID(), invoice_number: number,
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'paid', paid_at: at, ...extra });
    await mockPg('invoices').insert([invoiceRow(stamped, 'WPC-2026-0999', { payment_recorded_at: at }), invoiceRow(named, 'WPC-2026-1000', {})]);
    const [payment] = await mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(at),
      created_at: at, metadata: JSON.stringify({ invoice_id: named, source: 'admin_payment_reconcile' }) }).returning('id');
    const commitment = { kind: 'other', description: 'Did you get my payment?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    expect(evidence.records.filter((r) => r.type === 'payment').map((r) => [r.id, r.invoice_id])).toEqual([[payment.id, named]]);
  });

  test('Codex #4996 r13 pre-push: a Stripe row counts only from Stripe\'s own settlement moment — a /confirm repair recorded after the question for money that landed before it never passes as new', async () => {
    const landed = new Date(message.created_at.getTime() - 3 * 86400000);
    const repaired = new Date(message.created_at.getTime() + 1000);
    const now = new Date(repaired.getTime() + 1000);
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-1005',
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'paid', paid_at: repaired }).returning('id');
    // Booked after the question with no settlement moment: its charge could not be read.
    const [payment] = await mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(repaired),
      processor: 'stripe', stripe_payment_intent_id: 'pi_repaired', created_at: repaired, metadata: JSON.stringify({ invoice_id: invoice.id }) }).returning('id');
    // Money staff record at the same moment lands when it is recorded.
    const [cash] = await mockPg('payments').insert({ customer_id: message.customer_id, amount: 40, status: 'paid', payment_date: etDateString(repaired),
      created_at: repaired, metadata: JSON.stringify({ method: 'cash' }) }).returning('id');
    const commitment = { kind: 'other', description: 'Did my payment go through?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const ids = async () => (await loadSmsFulfillmentEvidence(mockPg, commitment, message, now)).records.filter((r) => r.type === 'payment').map((r) => r.id);
    expect(await ids()).toEqual([cash.id]);
    // The succeeded webhook stamps Stripe's moment: before the question, so it still never counts.
    const stamp = (at) => mockPg('payments').where({ id: payment.id })
      .update({ metadata: JSON.stringify({ invoice_id: invoice.id, settled_event_at: at.toISOString() }) });
    await stamp(landed);
    expect(await ids()).toEqual([cash.id]);
    // Money that truly landed after the question counts once its moment is recorded.
    await stamp(repaired);
    expect((await ids()).sort()).toEqual([payment.id, cash.id].sort());
  });

  test('Codex #4996 r9: a no-show or late-cancellation fee is not payment evidence — the webhook books it when it runs, with no settlement time of its own', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const invoiceRow = (number, title) => ({ customer_id: message.customer_id, token: randomUUID(), invoice_number: number,
      title, total: 50, subtotal: 50, line_items: '[]', status: 'paid', paid_at: after });
    const [cardHoldFee, appointmentFee, service] = await mockPg('invoices').insert([invoiceRow('WPC-2026-0991', 'One-time visit — no-show fee'),
      invoiceRow('WPC-2026-0992', 'Late-cancellation fee'), invoiceRow('WPC-2026-0993', 'Quarterly Pest Control')]).returning('id');
    // Booked by a redelivered webhook after the question, for captures that landed before it.
    const payment = (metadata) => ({ customer_id: message.customer_id, amount: 50, status: 'paid', payment_date: etDateString(after),
      processor: 'stripe', stripe_payment_intent_id: `pi_${randomUUID()}`, created_at: after,
      metadata: JSON.stringify({ ...metadata, settled_event_at: after.toISOString() }) });
    const [, , , paid] = await mockPg('payments').insert([
      payment({ purpose: 'card_hold_no_show_fee', invoice_id: cardHoldFee.id, reason: 'no_show' }),
      payment({ purpose: 'appointment_card_no_show_fee', invoice_id: appointmentFee.id }),
      // A fee's partial-refund marker names no invoice; it is still a fee.
      payment({ purpose: 'appointment_card_no_show_fee' }),
      payment({ invoice_id: service.id })]).returning('id');
    const commitment = { kind: 'other', description: 'Did my payment go through?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    expect(evidence.records.filter((r) => r.type === 'payment').map((r) => [r.id, r.payment_source])).toEqual([[paid.id, 'invoice']]);
  });

  test('Codex #4996 r9: a payment with a refund in flight is not evidence, and a refund starting after the check fails the close', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0994',
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'paid', paid_at: after }).returning('id');
    const metadata = { invoice_id: invoice.id, settled_event_at: after.toISOString() };
    const [payment] = await mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(after),
      processor: 'stripe', stripe_payment_intent_id: 'pi_refund_in_flight', created_at: after, metadata: JSON.stringify(metadata) }).returning('id');
    const commitment = { kind: 'other', description: 'Did my payment go through?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const witness = evidence.records.find((r) => r.id === payment.id);
    const grounded = groundFulfillment({ verdict: 'fulfilled', record_ref: witness.ref, quote: witness.text }, evidence, commitment);
    const verdict = { ...grounded, evidence_hash: fulfillmentFingerprint(commitment, evidence).evidenceHash };
    const closes = () => mockPg.transaction((trx) => revalidateSmsFulfillment(trx, commitment, message, verdict, now));
    expect(await closes()).toBe(true);
    // What StripeService.refund persists before it calls Stripe; the row stays 'paid' until Stripe answers.
    const inFlight = { ...metadata, pending_refund_key: `refund_pay_${payment.id}_rest_0`, pending_refund_request: 'rest',
      pending_refund_at: now.toISOString() };
    await mockPg('payments').where({ id: payment.id }).update({ metadata: JSON.stringify(inFlight) });
    expect((await loadSmsFulfillmentEvidence(mockPg, commitment, message, now)).records.filter((r) => r.type === 'payment')).toEqual([]);
    expect(await closes()).toBe(false);
    // Stripe rejected the refund outright: the marker is cleared and the payment stands.
    await mockPg('payments').where({ id: payment.id }).update({ metadata: JSON.stringify(metadata) });
    expect(await closes()).toBe(true);
  });

  test('Codex #4996 r9: a close on a property-scoped ask holds the visit or setup-claim estimate that ties the payment to the property', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const propertyId = context.properties[0].id;
    const [visit] = await mockPg('scheduled_services').insert({ customer_id: message.customer_id, property_id: propertyId,
      service_type: 'Quarterly Pest Control', scheduled_date: etDateString(message.created_at), window_start: '09:00:00', status: 'completed',
      created_at: new Date(message.created_at.getTime() - 86400000) }).returning('id');
    const [estimate] = await mockPg('estimates').insert({ customer_id: message.customer_id, property_id: propertyId,
      status: 'accepted', service_interest: 'Rodent' }).returning('id');
    const invoiceRow = (number, extra) => ({ customer_id: message.customer_id, token: randomUUID(), invoice_number: number,
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'paid', paid_at: after, ...extra });
    const [visitInvoice, setupInvoice] = await mockPg('invoices').insert([invoiceRow('WPC-2026-0995', { scheduled_service_id: visit.id }),
      invoiceRow('WPC-2026-0996', { title: 'Rodent setup' })]).returning('id');
    const [claim] = await mockPg('setup_fee_claims').insert({ invoice_id: setupInvoice.id, estimate_id: estimate.id, amount: 125 }).returning('id');
    const paymentRow = (invoiceId) => ({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(after),
      created_at: after, metadata: JSON.stringify({ invoice_id: invoiceId, settled_event_at: after.toISOString() }) });
    const [visitPaid, setupPaid] = await mockPg('payments').insert([paymentRow(visitInvoice.id), paymentRow(setupInvoice.id)]).returning('id');
    const closer = (sms_context, paymentId) => async () => {
      const commitment = { kind: 'other', description: 'Did my payment go through?', sms_context: { ...sms_context, source_at: message.created_at.toISOString(), money_answerable: true } };
      const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
      const witness = evidence.records.find((r) => r.id === paymentId);
      const grounded = groundFulfillment({ verdict: 'fulfilled', record_ref: witness.ref, quote: witness.text }, evidence, commitment);
      const verdict = { ...grounded, evidence_hash: fulfillmentFingerprint(commitment, evidence).evidenceHash };
      return mockPg.transaction((trx) => revalidateSmsFulfillment(trx, commitment, message, verdict, now));
    };
    const held = async (table, id, run) => {
      const writer = await mockPg.transaction();
      try {
        await writer(table).where({ id }).forUpdate().first('id');
        return await run();
      } finally { await writer.rollback(); }
    };
    const scopedVisit = closer({ property_id: propertyId }, visitPaid.id);
    const scopedSetup = closer({ property_id: propertyId }, setupPaid.id);
    expect(await scopedVisit()).toBe(true);
    expect(await scopedSetup()).toBe(true);
    // A geocode review repointing the visit, or an estimate writer, holds the row mid-close.
    expect(await held('scheduled_services', visit.id, scopedVisit)).toBe(false);
    expect(await held('setup_fee_claims', claim.id, scopedSetup)).toBe(false);
    expect(await held('estimates', estimate.id, scopedSetup)).toBe(false);
    // An unscoped ask depends on no property, so it takes no such lock.
    expect(await held('scheduled_services', visit.id, closer({ property_id: null }, visitPaid.id))).toBe(true);
  });

  test('Codex #4996 r5: a setup-only invoice from an estimate is scoped to the estimate\'s property through its setup-fee claim', async () => {
    await giveFormerProperty(message.customer_id);
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [estimate] = await mockPg('estimates').insert({ customer_id: message.customer_id, property_id: context.properties[0].id,
      status: 'accepted', service_interest: 'Rodent' }).returning('id');
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0981',
      title: 'Rodent setup', total: 199, subtotal: 199, line_items: '[]', status: 'paid', paid_at: after }).returning('id');
    await mockPg('setup_fee_claims').insert({ invoice_id: invoice.id, estimate_id: estimate.id, amount: 199 });
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 199, status: 'paid', payment_date: etDateString(after),
      metadata: JSON.stringify({ invoice_id: invoice.id }), created_at: after });
    const commitment = { kind: 'other', description: 'Did the setup payment go through?', sms_context: { property_id: context.properties[0].id, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const witness = evidence.records.find((r) => r.payment_source === 'invoice');
    expect(witness).toMatchObject({ invoice_id: invoice.id, property_id: context.properties[0].id });
    expect(admissibleWitness(witness, commitment)).toBe(true);
  });

  test('Codex #4996 r2: a customer-level Stripe charge such as the monthly autopay is payment evidence; one an invoice claims by its PaymentIntent, or names through a dispute, counts once, on the invoice', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const invoiceRow = (number, pi) => ({ customer_id: message.customer_id, token: randomUUID(), invoice_number: number,
      title: 'Quarterly Pest Control', total: 89, subtotal: 89, line_items: '[]', status: 'paid', paid_at: after, stripe_payment_intent_id: pi });
    // The second invoice's PaymentIntent was cleared when a dispute reopened it; the won dispute restored its payment.
    const [claimed, disputed] = await mockPg('invoices').insert([invoiceRow('WPC-2026-0931', 'pi_invoice'),
      invoiceRow('WPC-2026-0932', null)]).returning('id');
    const stripeRow = (pi, metadata) => ({ customer_id: message.customer_id, amount: 89, status: 'paid', payment_date: etDateString(after),
      processor: 'stripe', stripe_payment_intent_id: pi, metadata: JSON.stringify({ ...metadata, settled_event_at: after.toISOString() }), created_at: after });
    const [autopay, claimedPaid, disputedPaid] = await mockPg('payments').insert([
      // StripeService.charge stamps the month it collects for, and no type; a retry keeps the original month.
      stripeRow('pi_autopay', { base_amount: 89, card_surcharge: 0, idempotency_key: 'monthly:synthetic:2026-08', billed_month: '2026-08' }),
      stripeRow('pi_invoice', {}),
      stripeRow('pi_disputed', { dispute_id: 'dp_synthetic', dispute_invoice_id: disputed.id })]).returning('id');
    const commitment = { kind: 'other', description: "Did this month's autopay go through?", sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const ledger = evidence.records.filter((r) => r.payment_source === 'ledger');
    expect(ledger.map((r) => r.id)).toEqual([autopay.id]);
    expect(ledger[0]).toMatchObject({ property_id: null, text: `Payment of $89.00 recorded ${etDateString(after)} (monthly plan charge for 2026-08)` });
    expect(admissibleWitness(ledger[0], commitment)).toBe(true);
    expect(Object.fromEntries(evidence.records.filter((r) => r.payment_source === 'invoice').map((r) => [r.invoice_id, r.id])))
      .toEqual({ [claimed.id]: claimedPaid.id, [disputed.id]: disputedPaid.id });
  });

  describe('Codex #4996 r1: money landing puts a payment question on the event page ahead of the cursors', () => {
    let target;
    let verify;
    const minutes = (m) => new Date(message.created_at.getTime() + m * 60000);
    const tick = async (at) => {
      // A due cursor already past the target: only the event page can reach it.
      await mockPg('system_settings').insert({ key: 'sms_operations.fulfillment_cursor', value: 'ffffffff-ffff-4fff-bfff-ffffffffffff', category: 'sms_operations' })
        .onConflict('key').merge({ value: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
      verify.mockClear();
      return refreshSmsCommitments({ conn: mockPg, verify, now: at });
    };
    beforeEach(async () => {
      result.facts = [];
      result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, basis: 'request', due_at: null, due_text: 'sometime soon', property_id: null,
        quote: 'Did you get my payment?', description: 'Did you get my payment?' };
      await recordMessageOperations(mockPg, message, result, context);
      await mockPg('call_commitments').update({ due_at: null });
      [target] = await mockPg('call_commitments').pluck('id');
      verify = jest.fn(async () => ({ verdict: 'open', reason: 'no_answer', evidence_hash: 'x', retry_after: null }));
    });

    test.each([
      ['a paid payment', (at) => mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(at),
        metadata: JSON.stringify({ source: 'account_credit_prepayment', method: 'zelle' }), created_at: at, updated_at: at })],
      ['a received estimate deposit', async (at) => {
        const [estimate] = await mockPg('estimates').insert({ customer_id: message.customer_id, status: 'accepted', service_interest: 'Termite' }).returning('id');
        await mockPg('estimate_deposits').insert({ estimate_id: estimate.id, amount: 150, status: 'received', received_at: at, updated_at: at,
          stripe_payment_intent_id: `pi_deposit_${randomUUID()}` });
      }],
    ])('%s', async (_label, land) => {
      expect(await tick(minutes(1))).toMatchObject({ scanned: 0 });
      await land(minutes(2));
      expect(await tick(minutes(3))).toMatchObject({ scanned: 1 });
      expect(verify.mock.calls.map(([row]) => row.id)).toEqual([target]);
      expect(verify.mock.calls[0][1].records.filter((r) => r.type === 'payment')).toHaveLength(1);
    });

    test('a late webhook flipping an ACH payment to paid counts from the flip, not its settlement stamp the watermark already passed', async () => {
      await mockPg('call_commitments').where({ id: target }).update({ sms_context: mockPg.raw(
        "jsonb_set(jsonb_set(sms_context, '{event_seen_at}', to_jsonb(?::text)), '{event_seen_customer_id}', to_jsonb(?::text))",
        [minutes(5).toISOString(), message.customer_id]) });
      const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0921',
        title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'paid', paid_at: minutes(30),
        stripe_payment_intent_id: 'pi_ach' }).returning('id');
      // Inserted 'processing' an hour before the question; settled at minute
      // 2; the webhook that flips it lands at minute 30.
      await mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(minutes(2)),
        stripe_payment_intent_id: 'pi_ach', metadata: JSON.stringify({ invoice_id: invoice.id, payment_state: 'paid', settled_event_at: minutes(2).toISOString() }),
        created_at: minutes(-60), updated_at: minutes(30) });
      expect(await tick(minutes(31))).toMatchObject({ scanned: 1 });
      expect(verify.mock.calls[0][1].records.find((r) => r.type === 'payment')).toMatchObject({ invoice_id: invoice.id, payment_source: 'invoice' });
    });

    test('Codex #4996 r4: money landing wakes only a row that can cite it, never a callback or report beside it', async () => {
      const { id: _id, created_at: _c, updated_at: _u, ...seed } = await mockPg('call_commitments').where({ id: target }).first();
      const [callback] = await mockPg('call_commitments').insert({ ...seed, kind: 'callback', commitment_key: `${seed.commitment_key}:callback`,
        description: 'Please call me back', evidence: JSON.stringify(seed.evidence), sms_context: JSON.stringify(seed.sms_context) }).returning('id');
      await mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(minutes(2)),
        metadata: JSON.stringify({ source: 'account_credit_prepayment', method: 'zelle' }), created_at: minutes(2), updated_at: minutes(2) });
      expect(await tick(minutes(3))).toMatchObject({ scanned: 1 });
      expect(verify.mock.calls.map(([row]) => row.id)).toEqual([target]);
      expect(verify.mock.calls.map(([row]) => row.id)).not.toContain(callback.id);
    });

    test('Codex #4996 r6: an ask money can never answer (a refund request) is stamped so at intake and never woken by money', async () => {
      expect((await mockPg('call_commitments').where({ id: target }).first()).sms_context).toMatchObject({ money_answerable: true });
      // A second text from the same customer asks for a refund.
      const refundText = { ...message, id: randomUUID(), message_body: 'Please refund the double charge' };
      await mockPg('sms_log').insert(refundText);
      await recordMessageOperations(mockPg, refundText, { dropped: 0, facts: [], obligations: [{ ...result.obligations[0],
        quote: 'Please refund the double charge', description: 'Refund the double charge', answered_by_payment: false }] }, await loadMessageContext(mockPg, refundText));
      const refund = await mockPg('call_commitments').where({ sms_log_id: refundText.id }).first();
      expect(refund.sms_context).toMatchObject({ money_answerable: false });
      await mockPg('call_commitments').update({ due_at: null });
      await mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(minutes(2)),
        metadata: JSON.stringify({ source: 'account_credit_prepayment', method: 'zelle' }), created_at: minutes(2), updated_at: minutes(2) });
      expect(await tick(minutes(3))).toMatchObject({ scanned: 1 });
      expect(verify.mock.calls.map(([row]) => row.id)).toEqual([target]);
    });

    test('an ask recorded without the extraction\'s judgement is never woken by money', async () => {
      await mockPg('call_commitments').where({ id: target }).update({ sms_context: mockPg.raw("sms_context - 'money_answerable'") });
      await mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(minutes(2)),
        metadata: JSON.stringify({ source: 'account_credit_prepayment', method: 'zelle' }), created_at: minutes(2), updated_at: minutes(2) });
      expect(await tick(minutes(3))).toMatchObject({ scanned: 0 });
    });

    test('another customer\'s payment, a fee, a refund in flight, and a deposit being refunded, are not events', async () => {
      const otherCustomer = randomUUID();
      await mockPg('customers').insert({ id: otherCustomer, first_name: 'Other', last_name: 'Fixture', phone: '+12025550199',
        address_line1: '300 Example Lane', city: 'Sarasota', zip: '34236' });
      const paid = (customerId, metadata) => ({ customer_id: customerId, amount: 125, status: 'paid', payment_date: etDateString(minutes(2)),
        created_at: minutes(2), updated_at: minutes(2), metadata: JSON.stringify(metadata) });
      await mockPg('payments').insert([paid(otherCustomer, {}), paid(message.customer_id, { purpose: 'card_hold_no_show_fee' }),
        paid(message.customer_id, { pending_refund_key: 'refund_pay_synthetic_rest_0' }), paid(message.customer_id, { combined_payment: true })]);
      const [estimate] = await mockPg('estimates').insert({ customer_id: message.customer_id, status: 'accepted', service_interest: 'Termite' }).returning('id');
      await mockPg('estimate_deposits').insert({ estimate_id: estimate.id, amount: 150, status: 'refunding', received_at: minutes(2), updated_at: minutes(2),
        stripe_payment_intent_id: `pi_deposit_${randomUUID()}` });
      expect(await tick(minutes(3))).toMatchObject({ scanned: 0 });
    });
  });

  test('R2 rule 2: a non-payment "other" question is never answered by an unrelated invoice payment — the extraction did not mark it, so the payment is no witness and costs no model call', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: false, due_at: null, property_id: null,
      quote: 'Can my son be there for the visit?', description: 'Can my son be there for the visit?' };
    await recordMessageOperations(mockPg, message, result, context);
    await mockPg('call_commitments').update({ due_at: null, due_basis: null });
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0408',
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'paid', paid_at: after }).returning('id');
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(after),
      metadata: JSON.stringify({ invoice_id: invoice.id, settled_event_at: after.toISOString() }), created_at: after });
    const verify = jest.fn(async () => ({ verdict: 'open', reason: 'unrelated_payment', evidence_hash: 'x', retry_after: null }));
    expect((await mockPg('call_commitments').first()).sms_context).toMatchObject({ money_answerable: false });
    const outcome = await refreshSmsCommitments({ conn: mockPg, now, verify });
    expect(verify).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ scanned: 1, fulfilled: 0 });
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('R2: an invoice paid before the request is not payment evidence', async () => {
    const before = new Date(message.created_at.getTime() - 1000);
    const [invoice] = await mockPg('invoices').insert({ customer_id: message.customer_id, token: randomUUID(), invoice_number: 'WPC-2026-0409',
      title: 'Quarterly Pest Control', total: 125, subtotal: 125, line_items: '[]', status: 'paid', paid_at: before }).returning('id');
    await mockPg('payments').insert({ customer_id: message.customer_id, amount: 125, status: 'paid', payment_date: etDateString(before),
      metadata: JSON.stringify({ invoice_id: invoice.id, settled_event_at: before.toISOString() }), created_at: before });
    const commitment = { kind: 'other', description: 'What is the Zelle number?', sms_context: { property_id: null, source_at: message.created_at.toISOString(), money_answerable: true } };
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, new Date(message.created_at.getTime() + 2000));
    expect(evidence.records.filter((r) => r.type === 'payment')).toHaveLength(0);
  });

  test.each([
    ['an unscoped ask, one active property', null, false],
    ['an unscoped ask, two active properties', null, false],
    ['an ask scoped to the cancelled visit\'s property', 'scoped', true],
  ])('Codex #4816 r14–r27: a cancellation answers a cancel ask only when its property was resolved (%s)',
    async (label, scope, admissible) => {
      result.facts = [];
      result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: true, due_at: null,
        property_id: scope === 'scoped' ? context.properties[0].id : null,
        quote: 'Please cancel my appointment', description: 'Please cancel my appointment' };
      if (label.includes('two active')) {
        await mockPg('customer_properties').insert({ id: randomUUID(), customer_id: message.customer_id,
          address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236', active: true });
      }
      await recordMessageOperations(mockPg, message, result, context);
      const [commitment] = await mockPg('call_commitments').select('*');
      expect(commitment.sms_context.property_id).toBe(scope === 'scoped' ? context.properties[0].id : null);
      expect(commitment.sms_context).not.toHaveProperty('sole_property_id');
      const after = new Date(message.created_at.getTime() + 1000);
      const [visit] = await mockPg('scheduled_services').insert({
        customer_id: message.customer_id, property_id: context.properties[0].id, service_type: 'Quarterly Pest Control',
        scheduled_date: etDateString(new Date(after.getTime() + 3 * 86400000)), window_start: '09:00:00', status: 'cancelled',
        created_at: new Date(message.created_at.getTime() - 86400000), updated_at: after,
      }).returning('id');
      await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'confirmed', to_status: 'cancelled', transitioned_at: after });
      const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, new Date(after.getTime() + 1000));
      const record = evidence.records.find((r) => r.type === 'visit');
      expect(admissibleWitness(record, commitment, evidence.records)).toBe(admissible);
    },
  );

  // Owner ruling 2026-09-28 (reverses R3, 2026-09-24): any text a person sends,
  // or a call back a person places, after a general `other` ask closes it —
  // no model judges whether it was enough, so the bell means nobody responded.
  const generalAsk = async (quote, dueInMs = 1000) => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: false, quote, description: quote,
      due_at: dueInMs == null ? null : new Date(message.created_at.getTime() + dueInMs).toISOString() };
    await recordMessageOperations(mockPg, message, result, context);
    return new Date(message.created_at.getTime() + 1000);
  };
  const staffText = async (body, created_at, extra = {}) => (await mockPg('sms_log').insert({ ...message, id: randomUUID(),
    direction: 'outbound', from_phone: message.to_phone, to_phone: message.from_phone, message_body: body, message_type: 'manual',
    admin_user_id: '00000000-0000-4000-8000-000000000104', status: 'delivered', created_at, ...extra }).returning('id'))[0];
  const outboundCall = async (created_at, extra = {}) => (await mockPg('call_log').insert({ customer_id: message.customer_id,
    direction: 'outbound', from_phone: numbers.locations.parrish.number, to_phone: message.from_phone, status: 'completed',
    duration_seconds: 120, transcription: 'Talked it through with the customer.', v2_extraction_status: 'valid',
    ai_extraction_enriched: { meta: { is_voicemail: false } }, created_at, ...extra }).returning('id'))[0];

  test('owner ruling 2026-09-28 (reverses R3): the split-billing ask "separate the charges" closes on the person\'s "Done" reply, with no model call and no bell', async () => {
    const after = await generalAsk('Can you separate the charges under two payment methods?', null);
    await mockPg('call_commitments').update({ due_at: null, due_basis: null });
    const reply = await staffText('Done: your card is now the Auto Pay method.', after);
    const outcome = await refreshSmsCommitments({ conn: mockPg, now: new Date(after.getTime() + 1000) });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ scanned: 1, fulfilled: 1 });
    const row = await mockPg('call_commitments').first();
    expect(row.status).toBe('fulfilled');
    expect(row.fulfillment).toMatchObject({ verdict: 'fulfilled', basis: 'person_reply', record_type: 'sms', record_id: reply.id, quote: null });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('owner ruling 2026-09-28: a DUE general ask closes at its deadline on whatever a person replied, instead of ringing', async () => {
    const after = await generalAsk('I thought it was 125 a quarter or something');
    await staffText('You got it, let us know if you want to swap to annual prepay', after);
    expect(await refreshSmsCommitments({ conn: mockPg, now: new Date(after.getTime() + 2000) })).toMatchObject({ scanned: 1, fulfilled: 1 });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('owner ruling 2026-09-28: inside the window a reply waits for the deadline (R1), then closes the ask without a bell', async () => {
    const after = await generalAsk('Did you treat my house yesterday?', 3600000);
    await staffText('Currently en route!', after);
    expect(await refreshSmsCommitments({ conn: mockPg, now: new Date(after.getTime() + 1000) })).toMatchObject({ skipped_not_due: 1, fulfilled: 0 });
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    const due = new Date((await mockPg('call_commitments').first()).due_at);
    expect(await refreshSmsCommitments({ conn: mockPg, now: new Date(due.getTime() + 300000) })).toMatchObject({ fulfilled: 1 });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('Codex #5169 r1 P1: a text with no person\'s mark never closes a general ask — the composer\'s stamp does', async () => {
    const after = await generalAsk("What's the Zelle number?");
    const reply = await staffText('The Zelle number is 941-555-0101.', after, { admin_user_id: null });
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'fulfilled', record_ref: `sms:${reply.id}`, quote: 'The Zelle number is 941-555-0101.' } });
    const now = new Date(after.getTime() + 2000);
    expect(await refreshSmsCommitments({ conn: mockPg, now })).toMatchObject({ scanned: 1, fulfilled: 0 });
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    await mockPg('sms_log').where({ id: reply.id }).update({ metadata: JSON.stringify({ human_authored: true }) });
    expect(await refreshSmsCommitments({ conn: mockPg, now: new Date(now.getTime() + 1000) })).toMatchObject({ fulfilled: 1 });
    // The model saw the unmarked text once; the marked one closed without it.
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  });

  test('owner ruling 2026-09-28: a call back that reached the customer closes a general ask; a robocall, a short call, voicemail, an unprocessed call or an unanswered card call never does', async () => {
    const after = await generalAsk('Do you want to assess or should I contact a rodent specialist?');
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    const now = new Date(after.getTime() + 10000);
    const at = (seconds) => new Date(after.getTime() + seconds * 1000);
    await outboundCall(at(0), { source: 'collections_voice' });
    await outboundCall(at(1), { source: 'tech-click', duration_seconds: 30 });
    // Codex #5220 r1 P1: the staff leg ran 60 s or more, but the customer never talked.
    await outboundCall(at(2), { source: 'admin-click', ai_extraction_enriched: { meta: { is_voicemail: true } } });
    await outboundCall(at(3), { source: 'admin-click', v2_extraction_status: null, ai_extraction_enriched: null });
    await outboundCall(at(4), { source: 'admin-callback', metadata: { customer_leg: { status: 'no-answer', duration_seconds: 0 } } });
    expect(await refreshSmsCommitments({ conn: mockPg, now })).toMatchObject({ scanned: 1, fulfilled: 0 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const staffCall = await outboundCall(at(5), { source: 'admin-callback', metadata: { customer_leg: { status: 'completed', duration_seconds: 90 } } });
    expect(await refreshSmsCommitments({ conn: mockPg, now: new Date(now.getTime() + 1000) })).toMatchObject({ fulfilled: 1 });
    expect((await mockPg('call_commitments').first()).fulfillment).toMatchObject({ basis: 'person_reply', record_type: 'call', record_id: staffCall.id });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  });

  test('owner ruling 2026-09-28: a text a person queued before the ask and that went out after it is no reply; one queued after it is', async () => {
    const after = await generalAsk('Did you treat my house yesterday?');
    const now = new Date(after.getTime() + 2000);
    const scheduledText = async (queuedAt) => {
      const queue = await staffText('We will be there Tuesday.', queuedAt, { scheduled_for: after, status: 'sent' });
      return staffText('We will be there Tuesday.', after, { metadata: { scheduled_sms_log_id: queue.id, human_authored: true } });
    };
    await scheduledText(new Date(message.created_at.getTime() - 60000));
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    expect(await refreshSmsCommitments({ conn: mockPg, now })).toMatchObject({ scanned: 1, fulfilled: 0 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const reply = await scheduledText(new Date(message.created_at.getTime() + 500));
    expect(await refreshSmsCommitments({ conn: mockPg, now: new Date(now.getTime() + 1000) })).toMatchObject({ fulfilled: 1 });
    expect((await mockPg('call_commitments').first()).fulfillment).toMatchObject({ basis: 'person_reply', record_type: 'sms' });
    expect([reply.id]).toContain((await mockPg('call_commitments').first()).fulfillment.record_id);
  });

  test('Codex #5169 r1 P2: a general ask that names an email address still closes on a person\'s reply', async () => {
    const after = await generalAsk('Is sample.customer@example.com the email on my account?');
    await staffText('Yes, that is the email we have on file.', after);
    expect(await refreshSmsCommitments({ conn: mockPg, now: new Date(after.getTime() + 2000) })).toMatchObject({ scanned: 1, fulfilled: 1 });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('owner ruling 2026-09-28: an automated notice never closes a general ask, even when the model cites it', async () => {
    const after = await generalAsk("What's the Zelle number?");
    const notice = await staffText('Your appointment is confirmed for Tuesday.', after, { message_type: 'confirmation', admin_user_id: null });
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'fulfilled', record_ref: `sms:${notice.id}`, quote: 'Your appointment is confirmed for Tuesday.' } });
    expect(await refreshSmsCommitments({ conn: mockPg, now: new Date(after.getTime() + 2000) })).toMatchObject({ scanned: 1, fulfilled: 0 });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('staff-promise plan (2026-09-28): a promise naming a day is due 8 PM ET that day, and its bell says a promise is owed', async () => {
    message = { ...message, direction: 'outbound', from_phone: message.to_phone, to_phone: message.from_phone, message_type: 'manual',
      admin_user_id: '00000000-0000-4000-8000-000000000104', status: 'delivered', message_body: 'Gonna knock out your quarterly spray tomorrow' };
    await mockPg('sms_log').where({ id: message.id }).update(message);
    context = await loadMessageContext(mockPg, message);
    const tomorrow = etDateString(addETDays(message.created_at, 1));
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: false, basis: 'promise', promise_firm: true,
      quote: message.message_body, description: 'knock out your quarterly spray tomorrow', due_text: 'tomorrow', due_date: tomorrow };
    await recordMessageOperations(mockPg, message, result, context);
    const row = await mockPg('call_commitments').first();
    expect(new Date(row.due_at).toISOString()).toBe(parseETDateTime(`${tomorrow}T20:00`).toISOString());
    expect(row.due_basis).toBe('default_kind');
    // The completion check reads the promised day (due_at is a UTC instant).
    expect(row.sms_context).toMatchObject({ basis: 'promise', due_date: tomorrow });
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    await refreshSmsCommitments({ conn: mockPg, now: new Date(new Date(row.due_at).getTime() + 60000) });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('alert', 'A promise texted to a customer needs follow-up',
      expect.any(String), expect.objectContaining({ bell: true }));
  });

  test('Codex #5248 r2: the promised item sent by an automated text closes a general staff promise', async () => {
    message = { ...message, direction: 'outbound', from_phone: message.to_phone, to_phone: message.from_phone, message_type: 'manual',
      admin_user_id: '00000000-0000-4000-8000-000000000104', status: 'delivered', message_body: "Ok, we'll get the prep guide today" };
    await mockPg('sms_log').where({ id: message.id }).update(message);
    context = await loadMessageContext(mockPg, message);
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: false, basis: 'promise', promise_firm: true,
      quote: message.message_body, description: 'get the prep guide today', due_at: new Date(message.created_at.getTime() + 1000).toISOString() };
    await recordMessageOperations(mockPg, message, result, context);
    const after = new Date(message.created_at.getTime() + 1000);
    const [guide] = await mockPg('sms_log').insert({ ...message, id: randomUUID(), message_type: 'prep_guide', admin_user_id: null,
      message_body: 'Your treatment prep guide: portal.example.invalid/prep', created_at: after }).returning('id');
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'fulfilled', record_ref: `sms:${guide.id}`, quote: 'Your treatment prep guide' } });
    expect(await refreshSmsCommitments({ conn: mockPg, now: new Date(after.getTime() + 2000) })).toMatchObject({ scanned: 1, fulfilled: 1 });
    expect((await mockPg('call_commitments').first()).fulfillment).toMatchObject({ record_type: 'sms', record_id: guide.id });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test.each([false, true])('owner ruling 2026-09-28 (Codex #5248 r3): a promise kept after its deadline rings the bell, then clears (bell suppressed: %s)', async (suppressed) => {
    const actualNotifications = jest.requireActual('../services/notification-service');
    NotificationService.notifyAdmin.mockImplementation(suppressed
      ? async () => ({ id: null, suppressed: true })
      : actualNotifications.notifyAdmin.bind(actualNotifications));
    message = { ...message, direction: 'outbound', from_phone: message.to_phone, to_phone: message.from_phone, message_type: 'manual',
      admin_user_id: '00000000-0000-4000-8000-000000000104', status: 'delivered', message_body: "Ok, we'll get the prep guide today" };
    await mockPg('sms_log').where({ id: message.id }).update(message);
    context = await loadMessageContext(mockPg, message);
    result.facts = [];
    const dueAt = new Date(message.created_at.getTime() + 1000);
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: false, basis: 'promise', promise_firm: true,
      quote: message.message_body, description: 'get the prep guide today', due_at: dueAt.toISOString() };
    await recordMessageOperations(mockPg, message, result, context);
    // The guide goes out after the deadline, and no tick ran in between.
    const late = new Date(dueAt.getTime() + 60000);
    const [guide] = await mockPg('sms_log').insert({ ...message, id: randomUUID(), message_type: 'prep_guide', admin_user_id: null,
      message_body: 'Your treatment prep guide: portal.example.invalid/prep', created_at: late }).returning('id');
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'fulfilled', record_ref: `sms:${guide.id}`, quote: 'Your treatment prep guide' } });
    const first = await refreshSmsCommitments({ conn: mockPg, now: new Date(late.getTime() + 2000) });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('alert', 'A promise texted to a customer needs follow-up',
      expect.stringContaining('only after the promised deadline'), expect.objectContaining({ bell: true,
        metadata: expect.objectContaining({ verification: 'kept_late' }) }));
    if (suppressed) {
      // No bell row to find next tick, so the row closes now.
      expect(first).toMatchObject({ fulfilled: 1 });
      expect((await mockPg('call_commitments').first()).status).toBe('fulfilled');
      return;
    }
    expect(first).toMatchObject({ scanned: 1, fulfilled: 0 });
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    expect(await mockPg('notifications').whereNull('read_at')).toHaveLength(1);
    await mockPg('system_settings').where({ key: 'sms_operations.fulfillment_cursor' }).del();
    const second = await refreshSmsCommitments({ conn: mockPg, now: new Date(late.getTime() + 5 * 60000) });
    expect(second).toMatchObject({ fulfilled: 1 });
    // The system closed it on proof: the bell is done, not only read.
    expect(await mockPg('notifications').whereNull('done_at')).toHaveLength(0);
    expect((await mockPg('call_commitments').first()).fulfillment).toMatchObject({ record_type: 'sms', record_id: guide.id });
    expect(await mockPg('notifications')).toHaveLength(1);
    expect(await mockPg('notifications').whereNull('read_at')).toHaveLength(0);
  });

  test('owner ruling 2026-09-28: a promise staff texted is kept by doing it — a later text carrying no person mark (a bare manual type) never closes it; the model judges', async () => {
    message = { ...message, direction: 'outbound', from_phone: message.to_phone, to_phone: message.from_phone, message_type: 'manual',
      admin_user_id: '00000000-0000-4000-8000-000000000104', status: 'delivered', message_body: "Ok, we'll get the prep guide today" };
    await mockPg('sms_log').where({ id: message.id }).update(message);
    context = await loadMessageContext(mockPg, message);
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: false, basis: 'promise',
      quote: message.message_body, description: "we'll get the prep guide today", due_at: new Date(message.created_at.getTime() + 1000).toISOString() };
    await recordMessageOperations(mockPg, message, result, context);
    expect((await mockPg('call_commitments').first()).sms_context).toMatchObject({ basis: 'promise' });
    const after = new Date(message.created_at.getTime() + 1000);
    await mockPg('sms_log').insert({ ...message, id: randomUUID(), admin_user_id: null, message_body: 'Thanks!', created_at: after });
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    expect(await refreshSmsCommitments({ conn: mockPg, now: new Date(after.getTime() + 2000) })).toMatchObject({ scanned: 1, fulfilled: 0 });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  // Owner 2026-10-01 (false overdue bells). A promise staff made ("let us
  // shift this") that the office then resolved by a text of its own, which
  // the customer thumbed-up, rang as still owed.
  test('owner 2026-10-01: a promise staff texted is closed by a LATER staff-authored text in the thread, with no model call and no bell', async () => {
    message = { ...message, direction: 'outbound', from_phone: message.to_phone, to_phone: message.from_phone, message_type: 'manual',
      admin_user_id: '00000000-0000-4000-8000-000000000104', status: 'delivered', message_body: "You're right, let us shift this" };
    await mockPg('sms_log').where({ id: message.id }).update(message);
    context = await loadMessageContext(mockPg, message);
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: false, basis: 'promise',
      quote: message.message_body, description: 'let us shift this', due_at: new Date(message.created_at.getTime() + 1000).toISOString() };
    await recordMessageOperations(mockPg, message, result, context);
    const after = new Date(message.created_at.getTime() + 1000);
    const [resolution] = await mockPg('sms_log').insert({ ...message, id: randomUUID(), message_body: 'No change: your inspection is Thursday.', created_at: after }).returning('id');
    // The customer's thumbs-up is no evidence either way.
    await mockPg('sms_log').insert({ ...message, id: randomUUID(), direction: 'inbound', from_phone: message.to_phone, to_phone: message.from_phone,
      message_type: 'sms', admin_user_id: null, status: 'received', message_body: '👍', created_at: new Date(after.getTime() + 1000) });
    const counts = await refreshSmsCommitments({ conn: mockPg, now: new Date(after.getTime() + 5000) });
    expect(counts).toMatchObject({ scanned: 1, fulfilled: 1 });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    const row = await mockPg('call_commitments').first();
    expect(row.status).toBe('fulfilled');
    expect(row.fulfillment).toMatchObject({ basis: 'person_text_after_promise', record_type: 'sms', record_id: resolution.id });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('owner 2026-10-01: an AUTOMATED text (not person-authored) after a staff promise does not close it', async () => {
    message = { ...message, direction: 'outbound', from_phone: message.to_phone, to_phone: message.from_phone, message_type: 'manual',
      admin_user_id: '00000000-0000-4000-8000-000000000104', status: 'delivered', message_body: "You're right, let us shift this" };
    await mockPg('sms_log').where({ id: message.id }).update(message);
    context = await loadMessageContext(mockPg, message);
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: false, basis: 'promise',
      quote: message.message_body, description: 'let us shift this', due_at: new Date(message.created_at.getTime() + 1000).toISOString() };
    await recordMessageOperations(mockPg, message, result, context);
    const after = new Date(message.created_at.getTime() + 1000);
    await mockPg('sms_log').insert({ ...message, id: randomUUID(), message_type: 'appointment_reminder', admin_user_id: null,
      message_body: 'Reminder: your visit is Thursday.', created_at: after });
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    expect(await refreshSmsCommitments({ conn: mockPg, now: new Date(after.getTime() + 2000) })).toMatchObject({ scanned: 1, fulfilled: 0 });
    expect((await mockPg('call_commitments').first()).status).toBe('open');
  });

  // Owner 2026-10-01: "Please cancel WDO" (unscoped: the customer has several
  // properties), the office cancelled the WDO visit the next morning and the
  // system texted the cancellation, yet the overdue bell rang 'uncertain'.
  describe('an unscoped cancel ask that names a service', () => {
    const cancelAskFor = async (quote) => {
      result.facts = [];
      result.obligations[0] = { ...result.obligations[0], kind: 'other', answered_by_payment: false, due_at: null, property_id: null, quote, description: quote };
      await mockPg('customer_properties').insert({ id: randomUUID(), customer_id: message.customer_id,
        address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236', active: true });
      await recordMessageOperations(mockPg, message, result, context);
      const [commitment] = await mockPg('call_commitments').select('*');
      expect(commitment.sms_context.property_id).toBeNull();
      return commitment;
    };
    const cancelledVisit = async (serviceType, propertyId = context.properties[0].id) => {
      const after = new Date(message.created_at.getTime() + 1000);
      const [visit] = await mockPg('scheduled_services').insert({
        customer_id: message.customer_id, property_id: propertyId, service_type: serviceType,
        scheduled_date: etDateString(new Date(after.getTime() + 3 * 86400000)), window_start: '09:00:00', status: 'cancelled',
        created_at: new Date(message.created_at.getTime() - 86400000), updated_at: after,
      }).returning('id');
      await mockPg('job_status_history').insert({ job_id: visit.id, from_status: 'confirmed', to_status: 'cancelled', transitioned_at: after });
      return new Date(after.getTime() + 1000);
    };

    test.each([
      ['Please cancel WDO', 'WDO Inspection', true],
      ['Please cancel the WDO inspection', 'WDO Inspection', true],
      ['Please cancel WDO', 'Quarterly Pest Control', false],
      ['Please cancel my appointment', 'WDO Inspection', false],
      ["Please don't cancel WDO", 'WDO Inspection', false],
    ])('%s vs a cancelled %s visit: admissible %s', async (quote, serviceType, admissible) => {
      const commitment = await cancelAskFor(quote);
      const now = await cancelledVisit(serviceType);
      const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
      const record = evidence.records.find((r) => r.type === 'visit');
      expect(admissibleWitness(record, commitment, evidence.records)).toBe(admissible);
    });

    test('the cancelled WDO visit closes the ask end to end (model cites the cancelled visit), with no overdue bell', async () => {
      await cancelAskFor('Please cancel WDO');
      const now = await cancelledVisit('WDO Inspection');
      const visit = (await loadSmsFulfillmentEvidence(mockPg, (await mockPg('call_commitments').first()), message, now)).records.find((r) => r.type === 'visit');
      dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'fulfilled', record_ref: visit.ref, quote: 'cancelled after the request' } });
      expect(await refreshSmsCommitments({ conn: mockPg, now: new Date(now.getTime() + 3600000) })).toMatchObject({ scanned: 1, fulfilled: 1 });
      expect((await mockPg('call_commitments').first()).status).toBe('fulfilled');
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    });
  });

  test('owner ruling 2026-09-28: intake stamps the ask\'s basis, no longer reply_answerable; money_answerable is unchanged', async () => {
    await generalAsk("What's the Zelle number?");
    const { sms_context: smsContext } = await mockPg('call_commitments').first();
    expect(smsContext).toMatchObject({ basis: 'request', money_answerable: false });
    expect(smsContext).not.toHaveProperty('reply_answerable');
  });

  test('owner ruling 2026-09-28: a person_reply verdict re-proves its reply when it commits; a reply that changed since never closes', async () => {
    const after = await generalAsk('Can you separate the charges under two payment methods?');
    const reply = await staffText('Done', after);
    const now = new Date(after.getTime() + 2000);
    const row = await mockPg('call_commitments').first();
    const evidence = await loadSmsFulfillmentEvidence(mockPg, row, message, now);
    const verdict = await verifySmsFulfillment(row, evidence, { now });
    expect(verdict).toMatchObject({ verdict: 'fulfilled', basis: 'person_reply', record_type: 'sms', record_id: reply.id });
    expect(await mockPg.transaction((trx) => revalidateSmsFulfillment(trx, row, message, verdict, now))).toBe(true);
    await mockPg('sms_log').where({ id: reply.id }).update({ status: 'failed' });
    expect(await mockPg.transaction((trx) => revalidateSmsFulfillment(trx, row, message, verdict, now))).toBe(false);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test.each([
    ['callback', 4], ['send_appointment_confirmation', 4],
    ['schedule_visit', 24], ['send_estimate', 24], ['other', 24],
    ['send_report', 48], ['send_paperwork', 48],
    ['technician_follow_up', 72],
  ])('R5 owner ruling 2026-09-24: a %s request with no stated due_at gets a %ih default deadline (due_basis default_kind)', async (kind, hours) => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind, basis: 'request', due_at: null,
      quote: `Please handle this ${kind} request`, description: `Please handle this ${kind} request` };
    await recordMessageOperations(mockPg, message, result, context);
    const row = await mockPg('call_commitments').first();
    expect(row.due_basis).toBe('default_kind');
    expect(new Date(row.due_at).getTime()).toBe(message.created_at.getTime() + hours * 3600000);
  });

  test('R5: any promise-basis obligation gets a 48h default deadline regardless of kind (owner ruling 2026-09-24, late)', async () => {
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: 'callback', basis: 'promise', due_at: null,
      quote: "I'll call you back", description: "I'll call you back" };
    await recordMessageOperations(mockPg, message, result, context);
    const row = await mockPg('call_commitments').first();
    expect(row.due_basis).toBe('default_kind');
    expect(new Date(row.due_at).getTime()).toBe(message.created_at.getTime() + 48 * 3600000);
  });

  test('R5: a stated due_at keeps due_basis "stated" and is never overridden by the per-kind default', async () => {
    result.facts = [];
    const stated = new Date(message.created_at.getTime() + 3600000).toISOString();
    result.obligations[0] = { ...result.obligations[0], kind: 'callback', basis: 'request', due_at: stated,
      quote: 'Call me back at 5pm', description: 'Call me back at 5pm' };
    await recordMessageOperations(mockPg, message, result, context);
    const row = await mockPg('call_commitments').first();
    expect(row.due_basis).toBe('stated');
    expect(new Date(row.due_at).toISOString()).toBe(stated);
  });

  test('reading a bell leaves work open and the real notification writer re-alerts after its rolling window', async () => {
    const actualNotifications = jest.requireActual('../services/notification-service');
    NotificationService.notifyAdmin.mockImplementation(actualNotifications.notifyAdmin.bind(actualNotifications));
    result.obligations[0].due_at = new Date(message.created_at.getTime() + 1000).toISOString();
    await recordMessageOperations(mockPg, message, result, context);
    const verify = jest.fn().mockResolvedValue({ verdict: 'open' });
    const now = new Date(message.created_at.getTime() + 2000);
    await refreshSmsCommitments({ conn: mockPg, verify, now });
    const first = await mockPg('notifications').first();
    expect(first.read_at).toBeNull();
    await mockPg('notifications').where({ id: first.id }).update({ read_at: now });
    await refreshSmsCommitments({ conn: mockPg, verify, now });
    expect(await mockPg('notifications')).toHaveLength(1);
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    await mockPg('notifications').where({ id: first.id }).update({ created_at: new Date(Date.now() - 25 * 3600000) });
    await refreshSmsCommitments({ conn: mockPg, verify, now });
    expect(await mockPg('notifications')).toHaveLength(2);
    expect(await mockPg('notifications').whereNull('read_at')).toHaveLength(1);
    expect((await mockPg('call_commitments').first()).status).toBe('open');
  });

  test('a merge updates bell ownership even after the rolling dedupe window expires', async () => {
    const actualNotifications = jest.requireActual('../services/notification-service');
    NotificationService.notifyAdmin.mockImplementation(actualNotifications.notifyAdmin.bind(actualNotifications));
    result.obligations[0].due_at = new Date(message.created_at.getTime() + 1000).toISOString();
    await recordMessageOperations(mockPg, message, result, context);
    const verify = jest.fn().mockResolvedValue({ verdict: 'open' });
    const now = new Date(message.created_at.getTime() + 2000);
    await refreshSmsCommitments({ conn: mockPg, verify, now });
    const oldBell = await mockPg('notifications').first();
    await mockPg('notifications').where({ id: oldBell.id }).update({ created_at: new Date(Date.now() - 25 * 3600000) });
    const winner = randomUUID();
    await mockPg('customers').insert({ id: winner, first_name: 'Synthetic', last_name: 'Fixture',
      phone: '+12025550103', address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236' });
    await mockPg('sms_log').where({ id: message.id }).update({ customer_id: winner });
    await refreshSmsCommitments({ conn: mockPg, verify, now });
    const bells = await mockPg('notifications');
    expect(bells).toHaveLength(2);
    for (const bell of bells) {
      expect(bell.link).toBe(`/admin/customers?customerId=${winner}&tab=comms`);
      expect(bell.metadata.customerId).toBe(winner);
    }
  });

  test('suppressed estimate sends and manual acceptance are not delivery witnesses', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const base = { customer_id: message.customer_id, property_id: context.properties[0].id,
      status: 'sent', service_interest: 'Quarterly lawn', sent_at: after };
    const [delivered] = await mockPg('estimates').insert({ ...base, sent_at: null,
      estimate_data: { deliveryState: { lastDeliveredAt: after.toISOString() } } }).returning('id');
    await mockPg('estimates').insert([
      { ...base, price_locked_by: null, accepted_at: null, estimate_data: {} },
      { ...base, price_locked_by: 'manual_accept', accepted_at: after, estimate_data: {} },
      { ...base, price_locked_by: null, accepted_at: null,
        estimate_data: { deliveryState: { lastDeliveredAt: new Date(message.created_at.getTime() - 1000).toISOString() } } },
    ]);
    const evidence = await loadSmsFulfillmentEvidence(mockPg, {}, message, new Date(after.getTime() + 1000));
    expect(evidence.failures).toEqual([]);
    expect(evidence.records.filter((r) => r.type === 'estimate').map((r) => r.id)).toEqual([delivered.id]);
  });

  test('thirty deleted-customer messages cannot block the next active customer', async () => {
    await mockPg('customers').where({ id: message.customer_id }).update({ deleted_at: new Date() });
    await mockPg('sms_log').insert(Array.from({ length: 29 }, () => ({ ...message, id: randomUUID() })));
    const customerId = randomUUID();
    await mockPg('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      phone: '+12025550103', address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236' });
    const active = { ...message, id: randomUUID(), customer_id: customerId, from_phone: '+12025550103',
      to_phone: numbers.locations.parrish.number, created_at: new Date(message.created_at.getTime() + 1000) };
    await mockPg('sms_log').insert(active);
    process.env.GATE_SMS_OPERATIONAL_ACTIONS_SINCE = new Date(message.created_at.getTime() - 1000).toISOString();
    const extract = jest.fn().mockResolvedValue({ facts: [], obligations: [], dropped: 0 });
    const outcome = await runSmsOperationalActions({ conn: mockPg, extract, now: new Date(active.created_at.getTime() + 1000) });
    expect(outcome).toEqual({ processed: 1, failed: 0, skipped: 0 });
    expect(extract).toHaveBeenCalledTimes(1);
    expect((await mockPg('sms_log').where({ id: active.id }).first()).operational_analysis).not.toBeNull();
  });

  test('rollback refuses to destroy recorded SMS obligations and analysis', async () => {
    await recordMessageOperations(mockPg, message, result, context);
    await expect(migration.down(mockPg)).rejects.toThrow('disable the gate');
    expect(await mockPg('call_commitments')).toHaveLength(1);
  });

  test.each([
    ['lead FK', 'fk', false, false, true],
    ['lead mirror', 'mirror', false, false, true],
    ['conflicting unknown owner', 'fk', true, false, false],
    ['phone only', 'none', false, false, false],
    ['archived lead', 'fk', false, true, false],
  ])('commercial estimate ownership: %s', async (_label, link, conflict, archived, matches) => {
    const after = new Date(message.created_at.getTime() + 1000);
    const [lead] = await mockPg('leads').insert({ customer_id: message.customer_id,
      phone: message.from_phone, status: 'estimate_sent', deleted_at: archived ? after : null }).returning('id');
    const data = { deliveryState: { lastDeliveredAt: after.toISOString() }, ...(link === 'mirror' ? { lead_id: lead.id } : {}) };
    const [estimate] = await mockPg('estimates').insert({ customer_id: null, property_id: null,
      customer_phone: message.from_phone, status: 'sent', service_interest: 'Commercial lawn',
      address: '100 Example Lane, Sarasota, FL 34236', estimate_data: data }).returning('id');
    if (link === 'fk') await mockPg('leads').where({ id: lead.id }).update({ estimate_id: estimate.id });
    if (conflict) await mockPg('leads').insert({ customer_id: null, phone: message.from_phone,
      status: 'estimate_sent', estimate_id: estimate.id });
    const evidence = await loadSmsFulfillmentEvidence(mockPg, {}, message, new Date(after.getTime() + 1000));
    expect(evidence.failures).toEqual([]);
    const candidates = evidence.records.filter((row) => row.type === 'estimate');
    expect(candidates.map((row) => row.id)).toEqual(matches ? [estimate.id] : []);
    if (matches) {
      const commitment = { kind: 'send_estimate', sms_context: { source_at: message.created_at,
        property_id: context.properties[0].id } };
      expect(admissibleWitness(candidates[0], commitment)).toBe(true);
      await mockPg('customer_properties').where({ id: context.properties[0].id }).update({ address_line2: 'Unit 2' });
      const changed = await loadSmsFulfillmentEvidence(mockPg, {}, message, new Date(after.getTime() + 1000));
      expect(admissibleWitness(changed.records.find((row) => row.id === estimate.id), commitment)).toBe(false);
    }
  });

  test.each(['send_report', 'send_paperwork'])('staff can close verified %s and stop its rolling bell', async (kind) => {
    const actualNotifications = jest.requireActual('../services/notification-service');
    NotificationService.notifyAdmin.mockImplementation(actualNotifications.notifyAdmin.bind(actualNotifications));
    message.message_body = kind === 'send_report' ? 'Please send the report.' : 'Please send the paperwork.';
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: message.message_body });
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind, quote: message.message_body,
      description: message.message_body, due_at: new Date(message.created_at.getTime() + 1000).toISOString() };
    await recordMessageOperations(mockPg, message, result, context);
    const now = new Date(message.created_at.getTime() + 2000);
    await refreshSmsCommitments({ conn: mockPg, now, verify: async () => ({ verdict: 'uncertain' }) });
    const [row] = await listSmsCommitments(mockPg, { customerId: message.customer_id, now });
    expect(row).toMatchObject({ kind, overdue: true });
    expect(await listOpenCommitments(mockPg)).toEqual([]);
    expect((await mockPg('notifications').first()).read_at).toBeNull();
    await applySmsCommitmentUpdate(mockPg, row.id, { customerId: message.customer_id, action: 'fulfill', reviewedBy: randomUUID() });
    expect(await mockPg('call_commitments').first()).toMatchObject({ status: 'fulfilled', human_state: 'confirmed' });
    expect((await mockPg('notifications').first()).read_at).not.toBeNull();
    const audits = await mockPg('audit_log').where({ action: 'sms.commitment.fulfill' });
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_type).toBe('technician');
    expect(await listSmsCommitments(mockPg, { customerId: message.customer_id })).toEqual([]);
    expect(await refreshSmsCommitments({ conn: mockPg, now: new Date(now.getTime() + 25 * 3600000) })).toMatchObject({ scanned: 0 });
    expect(await mockPg('notifications')).toHaveLength(1);
  });

  test.each(['cancelled', 'bounced', 'changed_text'])('changed completion evidence stays open: %s', async (change) => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    const isVisit = change === 'cancelled';
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], kind: isVisit ? 'schedule_visit' : 'send_appointment_confirmation',
      quote: isVisit ? 'Schedule the visit' : 'Send confirmation to synthetic@example.invalid', due_at: after.toISOString() };
    await recordMessageOperations(mockPg, message, result, context);
    const table = isVisit ? 'scheduled_services' : 'email_messages';
    const [witness] = await mockPg(table).insert(isVisit ? {
      customer_id: message.customer_id, property_id: context.properties[0].id,
      service_type: 'Quarterly Lawn', scheduled_date: etDateString(now), window_start: '09:00:00', status: 'confirmed', created_at: after,
    } : { recipient_type: 'customer', recipient_id: message.customer_id, recipient_email_snapshot: 'synthetic@example.invalid',
      status: 'delivered', sent_at: after, delivered_at: after, text_snapshot: 'Your appointment is confirmed' }).returning('id');
    const type = isVisit ? 'visit' : 'email_delivery';
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'fulfilled', record_ref: `${type}:${witness.id}`,
      quote: isVisit ? 'Quarterly Lawn' : 'Your appointment is confirmed' } });
    const verify = async (row, evidence, opts) => {
      const verdict = await verifySmsFulfillment(row, evidence, opts);
      expect(verdict.verdict).toBe('fulfilled');
      await mockPg(table).where({ id: witness.id }).update(isVisit ? { status: 'cancelled' }
        : change === 'bounced' ? { status: 'bounced', bounced_at: now } : { text_snapshot: 'Please ignore the prior confirmation' });
      return verdict;
    };
    expect(await refreshSmsCommitments({ conn: mockPg, now, verify })).toMatchObject({ fulfilled: 0 });
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  });

  test('a busy estimate witness skips without waiting under the customer lock and can close later', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    result.facts = [];
    result.obligations[0].due_at = after.toISOString();
    await recordMessageOperations(mockPg, message, result, context);
    const commitment = await mockPg('call_commitments').first();
    const [estimate] = await mockPg('estimates').insert({ customer_id: message.customer_id,
      property_id: context.properties[0].id, status: 'sent', service_interest: 'Lawn',
      estimate_data: { deliveryState: { lastDeliveredAt: after.toISOString() } } }).returning('id');
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'fulfilled',
      record_ref: `estimate:${estimate.id}`, quote: 'Lawn' } });
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const verdict = await verifySmsFulfillment(commitment, evidence, { now });
    expect(verdict.verdict).toBe('fulfilled');
    const estimateWriter = await mockPg.transaction();
    try {
      await estimateWriter('estimates').where({ id: estimate.id }).forUpdate().first();
      await mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '500ms'");
        await trx('customers').where({ id: message.customer_id }).forUpdate().first();
        expect(await revalidateSmsFulfillment(trx, commitment, message, verdict, now)).toBe(false);
      });
    } finally {
      await estimateWriter.rollback();
    }
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    expect(await refreshSmsCommitments({ conn: mockPg, now })).toMatchObject({ fulfilled: 1 });
    expect((await mockPg('call_commitments').first()).status).toBe('fulfilled');
  });

  test('a lead-addressed proposal cannot close while the lead that owns it is being deleted', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const now = new Date(after.getTime() + 1000);
    result.facts = [];
    result.obligations[0].due_at = after.toISOString();
    await recordMessageOperations(mockPg, message, result, context);
    const commitment = await mockPg('call_commitments').first();
    // An unowned commercial proposal: the estimate carries no customer_id and
    // is this customer's only through the lead that names it.
    const [estimate] = await mockPg('estimates').insert({ customer_id: null,
      property_id: context.properties[0].id, status: 'sent', service_interest: 'Lawn',
      estimate_data: { deliveryState: { lastDeliveredAt: after.toISOString() } } }).returning('id');
    const [lead] = await mockPg('leads').insert({ customer_id: message.customer_id, estimate_id: estimate.id }).returning('id');
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'fulfilled',
      record_ref: `estimate:${estimate.id}`, quote: 'Lawn' } });
    const evidence = await loadSmsFulfillmentEvidence(mockPg, commitment, message, now);
    const verdict = await verifySmsFulfillment(commitment, evidence, { now });
    expect(verdict.verdict).toBe('fulfilled');
    const leadDeleter = await mockPg.transaction();
    try {
      // The soft delete holds the lead row; the estimate it points at is
      // untouched, so only a lock on the lead itself can fence this verdict.
      await leadDeleter('leads').where({ id: lead.id }).forUpdate().first();
      await mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '500ms'");
        await trx('customers').where({ id: message.customer_id }).forUpdate().first();
        expect(await revalidateSmsFulfillment(trx, commitment, message, verdict, now)).toBe(false);
      });
    } finally {
      await leadDeleter.rollback();
    }
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    expect(await refreshSmsCommitments({ conn: mockPg, now })).toMatchObject({ fulfilled: 1 });
    expect((await mockPg('call_commitments').first()).status).toBe('fulfilled');
  });

  test.each(['failed', 'undelivered', 'unattributed'])('outbound %s during extraction cannot create a promise', async (status) => {
    message = { ...message, direction: 'outbound', from_phone: message.to_phone, to_phone: message.from_phone,
      message_type: 'manual', admin_user_id: '00000000-0000-4000-8000-000000000104', status: 'sent', message_body: "I'll send the estimate" };
    await mockPg('sms_log').where({ id: message.id }).update(message);
    context = await loadMessageContext(mockPg, message);
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], quote: message.message_body, basis: 'promise' };
    await mockPg('sms_log').where({ id: message.id }).update(status === 'unattributed' ? { admin_user_id: null } : { status });
    expect(await recordMessageOperations(mockPg, message, result, context)).toEqual({ skipped: 'source_changed' });
    expect(await mockPg('call_commitments')).toEqual([]);
    expect((await mockPg('sms_log').first()).operational_analysis).toBeNull();
  });

  test.each(['failed', 'undelivered'])('a captured outbound promise still follows up after %s', async (status) => {
    message = { ...message, direction: 'outbound', from_phone: message.to_phone, to_phone: message.from_phone,
      message_type: 'manual', admin_user_id: '00000000-0000-4000-8000-000000000104', status: 'sent', message_body: "I'll send the estimate" };
    await mockPg('sms_log').where({ id: message.id }).update(message);
    context = await loadMessageContext(mockPg, message);
    result.facts = [];
    result.obligations[0] = { ...result.obligations[0], quote: message.message_body, basis: 'promise',
      due_at: new Date(message.created_at.getTime() + 1000).toISOString() };
    await recordMessageOperations(mockPg, message, result, context);
    await mockPg('sms_log').where({ id: message.id }).update({ status });
    const verify = jest.fn(async () => ({ verdict: 'open' }));
    await refreshSmsCommitments({ conn: mockPg, now: new Date(message.created_at.getTime() + 2000), verify });
    expect(verify).toHaveBeenCalledTimes(1);
    expect((await mockPg('call_commitments').first()).status).toBe('open');
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('alert', expect.any(String), expect.any(String),
      expect.objectContaining({ metadata: expect.objectContaining({ triggerKey: 'sms_operational_followup' }) }));
  });

  test('disabled automation keeps recorded open work readable', async () => {
    await recordMessageOperations(mockPg, message, result, context);
    process.env.GATE_SMS_COMMITMENT_FOLLOWUP = 'false';
    expect(await listSmsCommitments(mockPg, { customerId: message.customer_id })).toHaveLength(1);
  });

  test.each([
    ['100 Example Ln, Sarasota, FL 34236, USA', true],
    ['100 Example Lane, Sarasota, FL, 34236', true],
    ['100 Example Lane, Sarasota, 34236', true],
    ['100 Example Lane, Another City, FL 34236', false],
    ['100 Example Lane, Unit 2, Sarasota, FL 34236', false],
  ])('formatted estimate address is property scoped: %s', async (address, allowed) => {
    const after = new Date(message.created_at.getTime() + 1000);
    const [estimate] = await mockPg('estimates').insert({ customer_id: message.customer_id,
      address, service_interest: 'Lawn', estimate_data: { deliveryState: { lastDeliveredAt: after.toISOString() } } }).returning('id');
    const evidence = await loadSmsFulfillmentEvidence(mockPg, {}, message, new Date(after.getTime() + 1000));
    expect(evidence.failures).toEqual([]);
    expect(admissibleWitness(evidence.records.find((r) => r.id === estimate.id), { kind: 'send_estimate',
      sms_context: { source_at: message.created_at, property_id: context.properties[0].id } })).toBe(allowed);
  });

  test.each([
    ['100 Example Lane, Sarasota, FL', null, '34285', false],
    ['100 Example Lane, FL, 34236', 'Sarasota', null, false],
    ['100 Example Lane', 'Sarasota', '34236', false],
    ['100 Example Lane, Sarasota, FL', null, null, false],
    ['100 Example Lane, Sarasota, FL', 'Sarasota', null, true],
    ['100 Example Lane, FL, 34236', null, '34236', true],
    ['100 Example Lane', null, null, true],
  ])('estimate locality needs shared evidence: %s / %s / %s', async (address, city, zip, allowed) => {
    await mockPg('customer_properties').where({ id: context.properties[0].id }).update({ city, zip });
    const after = new Date(message.created_at.getTime() + 1000);
    const [estimate] = await mockPg('estimates').insert({ customer_id: message.customer_id,
      address, service_interest: 'Lawn', estimate_data: { deliveryState: { lastDeliveredAt: after.toISOString() } } }).returning('id');
    const evidence = await loadSmsFulfillmentEvidence(mockPg, {}, message, new Date(after.getTime() + 1000));
    expect(evidence.failures).toEqual([]);
    expect(admissibleWitness(evidence.records.find((r) => r.id === estimate.id), { kind: 'send_estimate',
      sms_context: { source_at: message.created_at, property_id: context.properties[0].id } })).toBe(allowed);
  });

  test('unrelated recurring schedules cannot truncate a scoped completion witness', async () => {
    const after = new Date(message.created_at.getTime() + 1000);
    const otherProperty = randomUUID();
    await mockPg('customer_properties').insert({ id: otherProperty, customer_id: message.customer_id,
      address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236', active: true });
    const base = { customer_id: message.customer_id, service_type: 'Lawn', status: 'confirmed',
      scheduled_date: etDateString(after), window_start: '09:00:00' };
    await mockPg('scheduled_services').insert(Array.from({ length: 60 }, () => ({ ...base,
      property_id: otherProperty, created_at: after })));
    await mockPg('scheduled_services').insert(Array.from({ length: 60 }, () => ({ ...base,
      property_id: context.properties[0].id, created_at: new Date(message.created_at.getTime() - 1000) })));
    const [visit] = await mockPg('scheduled_services').insert({ ...base, property_id: context.properties[0].id,
      created_at: after }).returning('id');
    const evidence = await loadSmsFulfillmentEvidence(mockPg, { kind: 'schedule_visit',
      sms_context: { property_id: context.properties[0].id } }, message, new Date(after.getTime() + 1000));
    expect(evidence.failures).toEqual([]);
    expect(evidence.records.filter((r) => r.type === 'visit').map((r) => r.id)).toEqual([visit.id]);
  });

  test('a human dismissal during verification wins over the stale automatic verdict', async () => {
    result.obligations[0].due_at = new Date(message.created_at.getTime() + 1000).toISOString();
    await recordMessageOperations(mockPg, message, result, context);
    const row = await mockPg('call_commitments').first();
    await refreshSmsCommitments({ conn: mockPg, now: new Date(message.created_at.getTime() + 2000), verify: async () => {
      await applySmsCommitmentUpdate(mockPg, row.id, { customerId: message.customer_id, action: 'dismiss', reviewedBy: randomUUID() });
      return { verdict: 'fulfilled' };
    } });
    expect((await mockPg('call_commitments').first()).status).toBe('dismissed');
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('staff closure preserves source ownership, archive and disabled-gate fences', async () => {
    await recordMessageOperations(mockPg, message, result, context);
    const row = await mockPg('call_commitments').first();
    const update = { customerId: message.customer_id, action: 'fulfill', reviewedBy: randomUUID() };
    await expect(applySmsCommitmentUpdate(mockPg, row.id, { ...update, customerId: randomUUID() })).rejects.toMatchObject({ status: 409 });
    await mockPg('customers').where({ id: message.customer_id }).update({ deleted_at: new Date() });
    await expect(applySmsCommitmentUpdate(mockPg, row.id, update)).rejects.toMatchObject({ status: 409 });
    await mockPg('customers').where({ id: message.customer_id }).update({ deleted_at: null });
    process.env.GATE_SMS_COMMITMENT_FOLLOWUP = 'false';
    await expect(applySmsCommitmentUpdate(mockPg, row.id, update)).rejects.toMatchObject({ status: 409 });
    expect((await mockPg('call_commitments').first()).status).toBe('open');
  });

  test('a missing critical closure audit rolls back the human verdict', async () => {
    await recordMessageOperations(mockPg, message, result, context);
    const row = await mockPg('call_commitments').first();
    await mockPg.schema.renameTable('audit_log', 'audit_log_unavailable');
    try {
      await expect(applySmsCommitmentUpdate(mockPg, row.id, { customerId: message.customer_id,
        action: 'fulfill', reviewedBy: randomUUID() })).rejects.toThrow();
      expect(await mockPg('call_commitments').first()).toMatchObject({ status: 'open', human_state: null });
    } finally {
      await mockPg.schema.renameTable('audit_log_unavailable', 'audit_log');
    }
  });

  test('changing the commitment gate during extraction retries before any profile or ledger write', async () => {
    process.env.GATE_SMS_COMMITMENT_FOLLOWUP = 'false';
    expect(await recordMessageOperations(mockPg, message, result, context)).toEqual({ skipped: 'gate_changed' });
    expect(await mockPg('property_preferences')).toHaveLength(0);
    expect(await mockPg('call_commitments')).toHaveLength(0);
    expect((await mockPg('sms_log').first()).operational_analysis).toBeNull();
    context = await loadMessageContext(mockPg, message);
    expect(context.captureCommitments).toBe(false);
    await recordMessageOperations(mockPg, message, { ...result, obligations: [] }, context);
    expect(await mockPg('property_preferences')).toHaveLength(0);
    expect(await mockPg('data_hygiene_proposals')).toHaveLength(1);
    expect(await mockPg('call_commitments')).toHaveLength(0);
  });

});
