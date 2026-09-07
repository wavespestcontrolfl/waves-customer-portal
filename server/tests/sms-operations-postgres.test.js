/** Transaction proof against an explicitly selected synthetic QA database. */
jest.mock('../models/db', () => {
  const conn = (...args) => mockPg(...args);
  conn.transaction = (...args) => mockPg.transaction(...args);
  conn.raw = (...args) => mockPg.raw(...args);
  // Writers that run outside a transaction (the extraction phase's receipts) use db.fn.now().
  Object.defineProperty(conn, 'fn', { get: () => mockPg.fn });
  return conn;
});
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((name, work) => work()) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { recordMessageOperations, loadMessageContext, runSmsOperationalActions } = require('../services/sms-operational-actions');
const numbers = require('../config/twilio-numbers');
const NotificationService = require('../services/notification-service');
const migration = require('../models/migrations/20260906000001_sms_operational_actions');
const irrigationRevisionMigration = require('../models/migrations/20260907000020_property_irrigation_revision');
const { listOpenCommitments } = require('../services/call-commitments');
const connection = process.env.SMS_OPERATIONS_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `sms_operations_${randomUUID().replaceAll('-', '')}`;
const TABLES = ['customers', 'customer_properties', 'property_preferences', 'sms_log', 'call_log',
  'call_commitments', 'data_hygiene_source_extractions', 'data_hygiene_proposals', 'data_hygiene_sensitive_vault',
  'conversations', 'messages', 'notifications', 'audit_log',
  'emails', 'email_messages', 'estimates', 'invoices', 'scheduled_services', 'job_status_history', 'system_settings'];
let mockPg;
let admin;
let message;
let result;
let context;
jest.setTimeout(60000);

postgres('SMS operations on PostgreSQL', () => {
  beforeAll(async () => {
    if (!/^\/(waves_test|waves_qa_[a-f0-9]+)$/.test(new URL(connection).pathname)) {
      throw new Error('Use an explicitly selected synthetic Waves QA database');
    }
    process.env.DATA_HYGIENE_VAULT_KEY = 'sms-operations-synthetic-key';
    admin = knex({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 5 } });
    // pgcrypto lives in public. Expose the two vault functions inside the private
    // schema so the search path stays isolated (an uncloned table is still an error).
    await admin.raw('CREATE FUNCTION ??.pgp_sym_encrypt(text, text) RETURNS bytea LANGUAGE sql AS $$ SELECT public.pgp_sym_encrypt($1, $2) $$', [schema]);
    await admin.raw('CREATE FUNCTION ??.pgp_sym_decrypt(bytea, text) RETURNS text LANGUAGE sql AS $$ SELECT public.pgp_sym_decrypt($1, $2) $$', [schema]);
    // Clone the MIGRATED schema, never application records. This catches real
    // column/type/CHECK drift; no simplified hand-written table definitions.
    for (const table of TABLES) {
      await admin.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    }
    // LIKE does not copy triggers. Exercise the real migration inside the
    // private schema so every profile writer uses its production counter.
    await irrigationRevisionMigration.up(mockPg);
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    NotificationService.notifyAdmin.mockResolvedValue({ id: randomUUID() });
    for (const table of TABLES) await mockPg(table).delete();
    process.env.GATE_SMS_OPERATIONAL_ACTIONS = 'true';
    delete process.env.GATE_SMS_COMMITMENT_FOLLOWUP;
    const customerId = randomUUID();
    const propertyId = randomUUID();
    await mockPg('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      phone: '+12025550101', address_line1: '100 Example Lane', city: 'Sarasota', zip: '34236' });
    await mockPg('customer_properties').insert({ id: propertyId, customer_id: customerId, is_primary: true,
      address_line1: '100 Example Lane', city: 'Sarasota', zip: '34236', active: true });
    message = { id: randomUUID(), customer_id: customerId, direction: 'inbound',
      twilio_sid: `SM${randomUUID().replaceAll('-', '')}`,
      message_body: 'The controller is beside the garage. Please send the estimate.',
      from_phone: '+12025550101', to_phone: numbers.locations.parrish.number, created_at: new Date(), status: 'received' };
    process.env.GATE_SMS_OPERATIONAL_ACTIONS_SINCE = new Date(message.created_at.getTime() - 1000).toISOString();
    await mockPg('sms_log').insert(message);
    result = { dropped: 0, facts: [{ field: 'irrigation_controller_location', value: 'The controller is beside the garage',
      quote: 'The controller is beside the garage', duration: 'durable', property_id: propertyId }],
    };
    context = await loadMessageContext(mockPg, message);
  });
  afterAll(async () => {
    delete process.env.GATE_SMS_OPERATIONAL_ACTIONS;
    delete process.env.GATE_SMS_OPERATIONAL_ACTIONS_SINCE;
    delete process.env.DATA_HYGIENE_VAULT_KEY;
    if (mockPg) await mockPg.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  test.each(['provider-first', 'queue-first', 'missing-provider'])(
    'scheduled SMS keeps one source through %s capture order', async (order) => {
      const queue = { ...message, id: randomUUID(), direction: 'outbound', message_type: 'manual',
        twilio_sid: null, from_phone: message.to_phone, to_phone: message.from_phone,
        message_body: 'I will call with an update.', created_at: new Date(message.created_at.getTime() - 600),
        scheduled_for: new Date(message.created_at.getTime() - 800), status: order === 'provider-first' ? 'sending' : 'sent' };
      const provider = { ...queue, id: randomUUID(), twilio_sid: `SM${randomUUID().replaceAll('-', '')}`,
        scheduled_for: null, status: 'sent', created_at: new Date(message.created_at.getTime() - 500),
        metadata: { scheduled_sms_log_id: queue.id, media_urls: ['https://invalid.example/private'] } };
      await mockPg('sms_log').insert(queue);
      const extract = jest.fn(async () => ({ facts: [], dropped: 0 }));
      const run = () => runSmsOperationalActions({ conn: mockPg, extract });
      if (order === 'provider-first') {
        await mockPg('sms_log').insert(provider);
        await run();
        expect(await mockPg('data_hygiene_source_extractions').whereIn('source_id', [queue.id, provider.id])).toHaveLength(0);
        await mockPg('sms_log').where({ id: queue.id }).update({ status: 'sent' });
      } else if (order === 'queue-first') {
        await run();
        await mockPg('sms_log').insert(provider);
      }
      await run();
      await run();
      // Main's profile-only lane records one outbound no-fields receipt;
      // the commitment child will use this same source selection for work.
      const receipts = await mockPg('data_hygiene_source_extractions').whereIn('source_id', [queue.id, provider.id]);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].source_id).toBe(queue.id);
      const loaded = await loadMessageContext(mockPg, message);
      expect(loaded.history.map((entry) => entry.id)).toEqual(order === 'missing-provider' ? [queue.id] : [queue.id, provider.id]);
      expect(JSON.stringify(loaded)).not.toContain('scheduled_sms_log_id');
      expect(JSON.stringify(loaded)).not.toContain('invalid.example');
    },
  );

  test('conversation history keeps provider evidence when scheduled send endpoints refresh', async () => {
    const queue = { ...message, id: randomUUID(), direction: 'outbound', message_type: 'manual',
      twilio_sid: null, from_phone: numbers.locations.bradenton.number, to_phone: '+12025550199',
      created_at: new Date(message.created_at.getTime() - 600),
      scheduled_for: new Date(message.created_at.getTime() - 800), status: 'sent' };
    const provider = { ...queue, id: randomUUID(), twilio_sid: `SM${randomUUID().replaceAll('-', '')}`,
      from_phone: message.to_phone, to_phone: message.from_phone, scheduled_for: null,
      created_at: new Date(message.created_at.getTime() - 500), metadata: { scheduled_sms_log_id: queue.id } };
    await mockPg('sms_log').insert([queue, provider]);
    const loaded = await loadMessageContext(mockPg, message);
    expect(loaded.history.map((entry) => entry.id)).toEqual([provider.id]);
    expect(loaded.history[0]).not.toHaveProperty('metadata');
  });

  test('identical separate sends and orphan or mismatched provider links stay distinct', async () => {
    const base = { ...message, direction: 'outbound', message_type: 'manual',
      from_phone: message.to_phone, to_phone: message.from_phone, message_body: 'I will call with an update.',
      created_at: new Date(message.created_at.getTime() - 500), status: 'sent' };
    const rows = [
      { metadata: {} }, { metadata: {} },
      { metadata: { scheduled_sms_log_id: randomUUID() } },
      { metadata: { scheduled_sms_log_id: 'malformed-link' } },
      // An inbound row is never the scheduled source of an outbound delivery.
      { metadata: { scheduled_sms_log_id: message.id } },
    ].map((data) => ({ ...base, ...data, id: randomUUID(), twilio_sid: `SM${randomUUID().replaceAll('-', '')}` }));
    await mockPg('sms_log').insert(rows);
    await runSmsOperationalActions({ conn: mockPg, extract: async () => ({ facts: [], dropped: 0 }) });
    expect(await mockPg('data_hygiene_source_extractions').whereIn('source_id', rows.map((row) => row.id))).toHaveLength(rows.length);
    const loaded = await loadMessageContext(mockPg, message);
    expect(new Set(loaded.history.map((entry) => entry.id))).toEqual(new Set(rows.map((row) => row.id)));
  });

  test('concurrent retries commit one free-form proposal and extraction receipt', async () => {
    await Promise.all([
      recordMessageOperations(mockPg, message, result, context),
      recordMessageOperations(mockPg, message, result, context),
    ]);
    expect(await mockPg('call_commitments')).toHaveLength(0);
    expect(await mockPg('data_hygiene_source_extractions')).toHaveLength(1);
    expect(await mockPg('audit_log')).toHaveLength(0);
    expect(await mockPg('property_preferences')).toHaveLength(0);
    const proposals = await mockPg('data_hygiene_proposals');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ field: 'irrigation_controller_location', status: 'pending', is_sensitive: true,
      source: 'message-extraction', resource_type: 'property_preferences', resource_id: null, scope_id: message.customer_id });
    expect(proposals[0].evidence).toMatchObject({ sms_log_id: message.id, channel: 'sms' });
    expect(JSON.stringify(proposals[0].evidence)).not.toContain('beside the garage');
    expect((await mockPg('sms_log').first()).operational_analysis.facts[0])
      .toMatchObject({ outcome: 'proposed', proposal_id: proposals[0].id });
    // Existing Owed/call readers remain call-scoped. No new portal queue.
    expect(await listOpenCommitments(mockPg)).toEqual([]);
  });

  test('an irrigation fact is proposed against the existing row and leaves the flag to approval', async () => {
    const [row] = await mockPg('property_preferences').insert({ customer_id: message.customer_id, irrigation_system: false }).returning('*');
    context = await loadMessageContext(mockPg, message);
    await recordMessageOperations(mockPg, message, result, context);
    expect(await mockPg('property_preferences').first()).toMatchObject({ irrigation_system: false, irrigation_controller_location: null });
    expect(await mockPg('data_hygiene_proposals').first()).toMatchObject({
      field: 'irrigation_controller_location', resource_id: row.id, status: 'pending',
    });
  });

  test('a free-form fact for a customer without a preferences row becomes a vaulted proposal', async () => {
    const quote = 'Please text before you arrive.';
    message.message_body = quote;
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: quote });
    result.facts = [{ field: 'special_instructions', quote, value: quote, property_id: context.properties[0].id, duration: 'durable' }];
    await recordMessageOperations(mockPg, message, result, context);
    expect(await mockPg('property_preferences')).toHaveLength(0);
    const [proposal] = await mockPg('data_hygiene_proposals');
    expect(proposal).toMatchObject({ field: 'special_instructions', resource_id: null, status: 'pending', is_sensitive: true });
    expect(proposal.proposed_value).toMatchObject({ length: quote.length });
    const [vault] = await mockPg('data_hygiene_sensitive_vault').where({ proposal_id: proposal.id });
    const decrypted = await mockPg.raw('SELECT pgp_sym_decrypt(?::bytea, ?) AS raw', [vault.after_encrypted, process.env.DATA_HYGIENE_VAULT_KEY]);
    expect(JSON.parse(decrypted.rows[0].raw)).toBe(quote);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
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

  test('an automatic write retires the pending extraction proposal for that field only', async () => {
    const proposal = (scope_id, field) => ({ rule_id: `extract.${field}`, rule_version: '1',
      resource_type: 'property_preferences', scope_type: 'customer', scope_id, field, source: 'message-extraction',
      proposed_value: JSON.stringify('Use the side gate'), confidence: 0.8, tier: 'medium', is_sensitive: true,
      status: 'pending', idempotency_key: randomUUID() });
    const otherCustomer = randomUUID();
    await mockPg('customers').insert({ id: otherCustomer, first_name: 'Other', last_name: 'Fixture',
      phone: '+12025550199', address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236' });
    await mockPg('data_hygiene_proposals').insert([
      proposal(message.customer_id, 'lockbox_code'), proposal(message.customer_id, 'pet_details'),
      proposal(otherCustomer, 'lockbox_code'),
    ]);
    message.message_body = 'Lockbox code is #4321';
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: message.message_body });
    result.facts = [{ field: 'lockbox_code', value: '#4321', quote: message.message_body,
      duration: 'durable', property_id: context.properties[0].id }];
    await recordMessageOperations(mockPg, message, result, context);
    expect((await mockPg('property_preferences').first()).lockbox_code).toBe('#4321');
    const stale = await mockPg('data_hygiene_proposals').where({ status: 'stale' }).select('scope_id', 'field');
    expect(stale).toEqual([{ scope_id: message.customer_id, field: 'lockbox_code' }]);
    expect(await mockPg('data_hygiene_proposals').where({ status: 'pending' })).toHaveLength(2);
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

  test('two free-form fields from one SMS are held as mixed topics, not proposed twice', async () => {
    const quote = 'Two dogs are in the yard. Park in the driveway.';
    message.message_body = quote;
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: quote });
    result.facts = ['pet_details', 'parking_notes'].map((field) => ({ field, quote, value: quote,
      property_id: context.properties[0].id, duration: 'durable' }));
    await recordMessageOperations(mockPg, message, result, context);
    expect(await mockPg('data_hygiene_proposals')).toHaveLength(0);
    expect(await mockPg('property_preferences')).toHaveLength(0);
    const outcomes = (await mockPg('sms_log').first()).operational_analysis.facts.map((fact) => fact.outcome);
    expect(outcomes).toEqual(['mixed_topics', 'mixed_topics']);
    expect(NotificationService.notifyAdmin).toHaveBeenCalled();
  });

  test('an SMS proposal retires the extraction phase\'s pending sibling for the same field', async () => {
    const sibling = (scope_id, field) => ({ rule_id: `extract.${field}`, rule_version: '1', resource_type: 'property_preferences',
      scope_type: 'customer', scope_id, field, source: 'message-extraction', proposed_value: JSON.stringify('dogs in the yard'),
      confidence: 0.82, tier: 'medium', is_sensitive: true, status: 'pending', idempotency_key: randomUUID(),
      evidence: JSON.stringify({ evidence_source_type: 'message', evidence_source_id: randomUUID() }) });
    const otherCustomer = randomUUID();
    await mockPg('customers').insert({ id: otherCustomer, first_name: 'Other', last_name: 'Fixture',
      phone: '+12025550199', address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236' });
    await mockPg('data_hygiene_proposals').insert([
      sibling(message.customer_id, 'pet_details'), sibling(message.customer_id, 'parking_notes'), sibling(otherCustomer, 'pet_details'),
    ]);
    const quote = 'Two friendly dogs in the yard.';
    message.message_body = quote;
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: quote });
    result.facts = [{ field: 'pet_details', quote, value: quote, property_id: context.properties[0].id, duration: 'durable' }];
    await recordMessageOperations(mockPg, message, result, context);
    const rows = await mockPg('data_hygiene_proposals').select('scope_id', 'field', 'status', 'rule_id').orderBy(['field', 'rule_id']);
    expect(rows.filter((row) => row.scope_id === message.customer_id && row.field === 'pet_details').map((row) => [row.rule_id, row.status]))
      .toEqual([['extract.pet_details', 'stale'], ['extract.sms_profile', 'pending']]);
    expect(rows.filter((row) => row.status === 'pending')).toHaveLength(3);
  });

  test.each([3600_000, 30_000])('an older typed SMS cannot auto-apply over a proposal %i ms newer', async (gap) => {
    const newer = new Date(message.created_at.getTime() + gap).toISOString();
    await mockPg('data_hygiene_proposals').insert({ rule_id: 'extract.lockbox_code', rule_version: '1',
      resource_type: 'property_preferences', scope_type: 'customer', scope_id: message.customer_id, field: 'lockbox_code',
      source: 'message-extraction', proposed_value: JSON.stringify({ masked: '****', length: 4 }), confidence: 0.86,
      tier: 'medium', is_sensitive: true, status: 'pending', idempotency_key: randomUUID(),
      evidence: JSON.stringify({ evidence_source_type: 'message', evidence_source_id: randomUUID(), source_at: newer }) });
    message.message_body = 'Lockbox code is #0123';
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: message.message_body });
    result.facts = [{ field: 'lockbox_code', value: '#0123', quote: message.message_body, duration: 'durable', property_id: context.properties[0].id }];
    await recordMessageOperations(mockPg, message, result, context);
    expect(await mockPg('property_preferences')).toHaveLength(0);
    expect(await mockPg('data_hygiene_proposals').where({ field: 'lockbox_code', status: 'pending' })).toHaveLength(1);
    expect((await mockPg('sms_log').first()).operational_analysis.facts[0].outcome).toBe('superseded');
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test.each([3600_000, 30_000])('the extraction phase supersedes a pending sibling %i ms older', async (gap) => {
    const { runMessageExtractionPhase } = require('../services/data-hygiene/message-extractor');
    const older = new Date(Date.now() - gap).toISOString();
    process.env.GATE_SMS_OPERATIONAL_ACTIONS = 'false';
    await mockPg('data_hygiene_proposals').insert({ rule_id: 'extract.sms_profile', rule_version: 'sms-profile-v5',
      resource_type: 'property_preferences', scope_type: 'customer', scope_id: message.customer_id, field: 'pet_details',
      source: 'message-extraction', proposed_value: JSON.stringify({ masked: 'O***.', length: 12 }), confidence: 0.9,
      tier: 'medium', is_sensitive: true, status: 'pending', idempotency_key: randomUUID(),
      evidence: JSON.stringify({ evidence_source_type: 'message', evidence_source_id: randomUUID(), source_at: older }) });
    const [conversation] = await mockPg('conversations').insert({ customer_id: message.customer_id, channel: 'sms' }).returning('id');
    await mockPg('messages').insert({ conversation_id: conversation.id, channel: 'sms', direction: 'inbound',
      author_type: 'customer', body: 'Two friendly dogs in the yard.', twilio_sid: 'SM_newer' });
    const preview = await runMessageExtractionPhase({ dryRun: true, lookbackDays: 1, limit: 10 });
    expect(preview).toMatchObject({ would_create: 1, duplicates: 0, errors: 0 });
    const counts = await runMessageExtractionPhase({ lookbackDays: 1, limit: 10 });
    expect(counts).toMatchObject({ created: 1, duplicates: 0, errors: 0 });
    const rows = await mockPg('data_hygiene_proposals').where({ field: 'pet_details' }).select('rule_id', 'status').orderBy('rule_id');
    expect(rows).toEqual([{ rule_id: 'extract.pet_details', status: 'pending' }, { rule_id: 'extract.sms_profile', status: 'stale' }]);
  });

  test.each([3600_000, 30_000])('a retried SMS never displaces a pending proposal %i ms newer', async (gap) => {
    const newer = new Date(message.created_at.getTime() + gap).toISOString();
    await mockPg('data_hygiene_proposals').insert({ rule_id: 'extract.sms_profile', rule_version: 'sms-profile-v5',
      resource_type: 'property_preferences', scope_type: 'customer', scope_id: message.customer_id, field: 'pet_details',
      source: 'message-extraction', proposed_value: JSON.stringify({ masked: 'O***.', length: 12 }), confidence: 0.9,
      tier: 'medium', is_sensitive: true, status: 'pending', idempotency_key: randomUUID(),
      evidence: JSON.stringify({ evidence_source_type: 'message', evidence_source_id: randomUUID(), source_at: newer }) });
    const quote = 'Two friendly dogs in the yard.';
    message.message_body = quote;
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: quote });
    result.facts = [{ field: 'pet_details', quote, value: quote, property_id: context.properties[0].id, duration: 'durable' }];
    await recordMessageOperations(mockPg, message, result, context);
    const rows = await mockPg('data_hygiene_proposals').where({ field: 'pet_details' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending' });
    expect(rows[0].evidence.source_at).toBe(newer);
    expect((await mockPg('sms_log').first()).operational_analysis.facts[0].outcome).toBe('superseded');
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test.each([false, true])('the extraction phase recognizes the same SMS by identity (legacy evidence: %s)', async (legacy) => {
    const { runMessageExtractionPhase } = require('../services/data-hygiene/message-extractor');
    const quote = 'Two friendly dogs in the yard.';
    message.message_body = quote;
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: quote });
    result.facts = [{ field: 'pet_details', quote, value: quote, property_id: context.properties[0].id, duration: 'durable' }];
    await recordMessageOperations(mockPg, message, result, context);
    if (legacy) {
      const proposal = await mockPg('data_hygiene_proposals').first();
      delete proposal.evidence.twilio_sid;
      await mockPg('data_hygiene_proposals').where({ id: proposal.id }).update({ evidence: JSON.stringify(proposal.evidence) });
    }
    const [conversation] = await mockPg('conversations').insert({ customer_id: message.customer_id, channel: 'sms' }).returning('id');
    await mockPg('messages').insert({ conversation_id: conversation.id, channel: 'sms', direction: 'inbound',
      author_type: 'customer', body: quote, twilio_sid: message.twilio_sid,
      created_at: new Date(message.created_at.getTime() + 180_000) });
    const counts = await runMessageExtractionPhase({ lookbackDays: 1, limit: 10 });
    expect(counts).toMatchObject({ created: 0, duplicates: 1, errors: 0 });
    const pending = await mockPg('data_hygiene_proposals').where({ status: 'pending', field: 'pet_details' });
    expect(pending).toHaveLength(1);
    expect(pending[0].rule_id).toBe('extract.sms_profile');
  });

  test('the extraction phase checks for a sibling only under the customer preference lock', async () => {
    const { runMessageExtractionPhase } = require('../services/data-hygiene/message-extractor');
    const quote = 'Two friendly dogs in the yard.';
    const [conversation] = await mockPg('conversations').insert({ customer_id: message.customer_id, channel: 'sms' }).returning('id');
    await mockPg('messages').insert({ conversation_id: conversation.id, channel: 'sms', direction: 'inbound',
      author_type: 'customer', body: quote, twilio_sid: 'SM_race' });
    let lockTaken;
    const locked = new Promise((resolve) => { lockTaken = resolve; });
    const held = mockPg.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['property-preferences', String(message.customer_id)]);
      lockTaken();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await trx('data_hygiene_proposals').insert({ rule_id: 'extract.sms_profile', rule_version: 'sms-profile-v5',
        resource_type: 'property_preferences', scope_type: 'customer', scope_id: message.customer_id, field: 'pet_details',
        source: 'message-extraction', proposed_value: JSON.stringify({ masked: 'T***.', length: quote.length }),
        confidence: 0.9, tier: 'medium', is_sensitive: true, status: 'pending', idempotency_key: randomUUID(),
        evidence: JSON.stringify({ evidence_source_type: 'message', evidence_source_id: randomUUID(), source_at: new Date().toISOString() }) });
    });
    await locked;
    const [counts] = await Promise.all([runMessageExtractionPhase({ lookbackDays: 1, limit: 10 }), held]);
    expect(counts).toMatchObject({ created: 0, duplicates: 1, errors: 0 });
    expect(await mockPg('data_hygiene_proposals').where({ status: 'pending', field: 'pet_details' })).toHaveLength(1);
  });

  test.each(['pet_details', 'lockbox_code'])('the SMS lane reconciles the inbox twin for %s even when its write is delayed', async (field) => {
    const { runMessageExtractionPhase } = require('../services/data-hygiene/message-extractor');
    const quote = field === 'pet_details' ? 'Two friendly dogs in the yard.' : 'Lockbox code is #0123';
    const value = field === 'pet_details' ? quote : '#0123';
    message.message_body = quote;
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: quote });
    result.facts = [{ field, quote, value, property_id: context.properties[0].id, duration: 'durable' }];
    const [conversation] = await mockPg('conversations').insert({ customer_id: message.customer_id, channel: 'sms' }).returning('id');
    await mockPg('messages').insert({ conversation_id: conversation.id, channel: 'sms', direction: 'inbound',
      author_type: 'customer', body: quote, twilio_sid: message.twilio_sid,
      created_at: new Date(message.created_at.getTime() + 180_000) });
    expect(await runMessageExtractionPhase({ lookbackDays: 1, limit: 10 })).toMatchObject({ created: 1, errors: 0 });
    const proposal = await mockPg('data_hygiene_proposals').where({ field }).first();
    // Older proposals carry the inbox row id instead of a stamped Twilio id.
    delete proposal.evidence.twilio_sid;
    await mockPg('data_hygiene_proposals').where({ id: proposal.id }).update({ evidence: JSON.stringify(proposal.evidence) });
    await recordMessageOperations(mockPg, message, result, context);
    expect((await mockPg('data_hygiene_proposals').where({ id: proposal.id }).first()).status).toBe('stale');
    const outcome = (await mockPg('sms_log').where({ id: message.id }).first()).operational_analysis.facts[0].outcome;
    expect(outcome).toBe(field === 'pet_details' ? 'proposed' : 'applied');
    expect(await mockPg('data_hygiene_proposals').where({ status: 'pending', field })).toHaveLength(field === 'pet_details' ? 1 : 0);
  });

  test('a stated pet becomes a pending proposal instead of a direct write', async () => {
    const quote = 'Two friendly dogs in the yard.';
    message.message_body = quote;
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: quote });
    result.facts = [{ field: 'pet_details', quote, value: quote, property_id: context.properties[0].id, duration: 'durable' }];
    await recordMessageOperations(mockPg, message, result, context);
    expect(await mockPg('property_preferences')).toHaveLength(0);
    expect(await mockPg('data_hygiene_proposals').first()).toMatchObject({ field: 'pet_details', status: 'pending', is_sensitive: true });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
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
    expect(NotificationService.notifyAdmin).toHaveBeenCalled();
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

  test('profile-only processing does not call a provider for human outbound SMS', async () => {
    delete process.env.GATE_SMS_COMMITMENT_FOLLOWUP;
    await mockPg('sms_log').where({ id: message.id }).update({ direction: 'outbound',
      from_phone: numbers.locations.parrish.number, to_phone: '+12025550101',
      message_type: 'manual', status: 'delivered' });
    const extract = jest.fn();
    await runSmsOperationalActions({ conn: mockPg, extract });
    expect(extract).not.toHaveBeenCalled();
    expect(await mockPg('data_hygiene_source_extractions').first()).toMatchObject({ status: 'no_fields' });
  });

  test('media metadata never reaches the extraction prompt', async () => {
    await mockPg('sms_log').where({ id: message.id }).update({ metadata: JSON.stringify({
      media: [{ url: 'https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/MM0/Media/ME0', key: 'sms-media/abc.jpg' }],
    }) });
    const extract = jest.fn().mockResolvedValue({ facts: [], dropped: 0 });
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

  test('the irrigation companion flip is reported on apply and restored on revert only while it holds', async () => {
    const writer = require('../services/data-hygiene/property-preferences');
    // A legacy row can hold an irrigation input with the flag off; that
    // pre-existing evidence must not block the revert later.
    const [row] = await mockPg('property_preferences').insert({ customer_id: message.customer_id, irrigation_system: false,
      irrigation_zones: 6, irrigation_schedule_notes: 'Private watering instructions.' }).returning('*');
    const proposal = { scope_id: message.customer_id, field: 'irrigation_controller_location', resource_id: row.id };
    let recorded;
    await mockPg.transaction(async (trx) => {
      const target = await writer.resolvePropertyPreferencesTarget({ trx, proposal, currentRaw: null });
      const { companions } = await writer.applyPropertyPreferenceValue({ trx, proposal, target, proposedRaw: 'Beside the garage.' });
      expect(companions).toEqual({ irrigation_system: false, irrigation_baseline: { input_hashes: {
        irrigation_zones: expect.stringMatching(/^[a-f0-9]{64}$/),
        irrigation_schedule_notes: expect.stringMatching(/^[a-f0-9]{64}$/),
      }, confirmed: [], revision: '1' } });
      expect(JSON.stringify(companions)).not.toContain('Private watering instructions.');
      recorded = companions;
    });
    expect(await mockPg('property_preferences').first()).toMatchObject({ irrigation_system: true, irrigation_controller_location: 'Beside the garage.' });
    const revert = () => mockPg.transaction(async (trx) => {
      const target = await trx('property_preferences').where({ id: row.id }).forUpdate().first();
      return writer.revertPropertyPreferenceCompanions({ trx, proposal, target, companions: recorded });
    });
    // A deliberate change after approval is not clobbered by the revert.
    await mockPg('property_preferences').where({ id: row.id }).update({ irrigation_system: false });
    expect(await revert()).toEqual({ reverted: [] });
    // Later irrigation evidence (another input, or a portal confirmation) keeps the system on.
    await mockPg('property_preferences').where({ id: row.id }).update({ irrigation_system: true, irrigation_issues: 'Zone 3 head is broken.' });
    expect(await revert()).toEqual({ reverted: [], retained: { irrigation_system: 'later_irrigation_evidence' } });
    await mockPg('property_preferences').where({ id: row.id }).update({ irrigation_issues: null, irrigation_confirmed_fields: JSON.stringify(['watering_days']) });
    expect(await revert()).toEqual({ reverted: [], retained: { irrigation_system: 'later_irrigation_evidence' } });
    expect((await mockPg('property_preferences').first()).irrigation_system).toBe(true);
    // Clearing a pre-existing input is still a portal edit confirming irrigation.
    await mockPg('property_preferences').where({ id: row.id }).update({ irrigation_confirmed_fields: JSON.stringify([]),
      irrigation_schedule_notes: null });
    expect(await revert()).toEqual({ reverted: [], retained: { irrigation_system: 'later_irrigation_evidence' } });
    // An edit to a pre-existing input after approval is later evidence too.
    await mockPg('property_preferences').where({ id: row.id }).update({ irrigation_confirmed_fields: JSON.stringify([]),
      irrigation_schedule_notes: 'Changed private watering instructions.' });
    expect(await revert()).toEqual({ reverted: [], retained: { irrigation_system: 'later_irrigation_evidence' } });
    await mockPg('property_preferences').where({ id: row.id }).update({ irrigation_schedule_notes: 'Private watering instructions.' });
    await mockPg('property_preferences').where({ id: row.id }).update({ irrigation_confirmed_fields: JSON.stringify([]), irrigation_zones: 8 });
    expect(await revert()).toEqual({ reverted: [], retained: { irrigation_system: 'later_irrigation_evidence' } });
    await mockPg('property_preferences').where({ id: row.id }).update({ irrigation_zones: 6 });
    expect(await revert()).toEqual({ reverted: [], retained: { irrigation_system: 'later_irrigation_evidence' } });
    expect((await mockPg('property_preferences').first()).irrigation_system).toBe(true);
    // Revision-less approvals keep their original value-based semantics.
    recorded = { irrigation_system: false, irrigation_baseline: {
      inputs: { irrigation_zones: 6, irrigation_schedule_notes: 'Private watering instructions.' }, confirmed: [],
    } };
    await mockPg('property_preferences').where({ id: row.id }).update({ irrigation_system: true });
    expect(await revert()).toEqual({ reverted: ['irrigation_system'] });
  });

  test.each([
    ['unchanged irrigation', []],
    ['an unrelated preference edit', [{ parking_notes: 'Use the driveway.' }]],
    ['a same-value irrigation save', [{ irrigation_zones: 6 }]],
  ])('revert restores its companion after %s', async (_label, edits) => {
    const writer = require('../services/data-hygiene/property-preferences');
    const [row] = await mockPg('property_preferences').insert({ customer_id: message.customer_id,
      irrigation_system: false, irrigation_zones: 6 }).returning('*');
    const proposal = { scope_id: message.customer_id, field: 'irrigation_controller_location', resource_id: row.id };
    const { companions } = await mockPg.transaction(async (trx) => writer.applyPropertyPreferenceValue({
      trx, proposal, target: row, proposedRaw: 'Beside the garage.',
    }));
    for (const edit of edits) await mockPg('property_preferences').where({ id: row.id }).update(edit);
    await mockPg.transaction(async (trx) => {
      // Mirror the approve route: lock before restoring the proposed value,
      // and judge companion ownership against that locked snapshot.
      const target = await trx('property_preferences').where({ id: row.id }).forUpdate().first();
      await trx('property_preferences').where({ id: row.id }).update({ irrigation_controller_location: null });
      expect(await writer.revertPropertyPreferenceCompanions({ trx, proposal, target, companions }))
        .toEqual({ reverted: ['irrigation_system'] });
    });
    expect(await mockPg('property_preferences').first()).toMatchObject({
      irrigation_system: false, irrigation_controller_location: null,
    });
  });

  test.each([
    ['input', { irrigation_zones: 8 }, { irrigation_zones: 6 }],
    ['confirmation', { irrigation_confirmed_fields: JSON.stringify(['watering_days']) }, { irrigation_confirmed_fields: '[]' }],
    ['active-system choice', { irrigation_system: false }, { irrigation_system: true }],
  ])('edit-then-restore of an irrigation %s retains the companion', async (_label, edit, restore) => {
    const writer = require('../services/data-hygiene/property-preferences');
    const [row] = await mockPg('property_preferences').insert({ customer_id: message.customer_id,
      irrigation_system: false, irrigation_zones: 6 }).returning('*');
    const proposal = { scope_id: message.customer_id, field: 'irrigation_controller_location', resource_id: row.id };
    const { companions } = await mockPg.transaction(async (trx) => writer.applyPropertyPreferenceValue({
      trx, proposal, target: row, proposedRaw: 'Beside the garage.',
    }));
    await mockPg('property_preferences').where({ id: row.id }).update(edit);
    await mockPg('property_preferences').where({ id: row.id }).update(restore);
    await mockPg.transaction(async (trx) => {
      const target = await trx('property_preferences').where({ id: row.id }).forUpdate().first();
      await trx('property_preferences').where({ id: row.id }).update({ irrigation_controller_location: null });
      expect(await writer.revertPropertyPreferenceCompanions({ trx, proposal, target, companions }))
        .toEqual({ reverted: [], retained: { irrigation_system: 'later_irrigation_evidence' } });
    });
    expect((await mockPg('property_preferences').first()).irrigation_system).toBe(true);
  });

  test.each([false, true])('a legacy approval can restore its companion (approved during deployment: %s)', async (duringDeploy) => {
    const writer = require('../services/data-hygiene/property-preferences');
    const [row] = await mockPg('property_preferences').insert({ customer_id: message.customer_id,
      irrigation_system: !duringDeploy, irrigation_controller_location: duringDeploy ? null : 'Beside the garage.',
      irrigation_zones: 6 }).returning('*');
    if (duringDeploy) {
      // Pre-deploy migrations install the trigger while the old application
      // still writes approvals without recording a revision in the baseline.
      await mockPg('property_preferences').where({ id: row.id })
        .update({ irrigation_system: true, irrigation_controller_location: 'Beside the garage.' });
    }
    const target = await mockPg('property_preferences').where({ id: row.id }).first();
    expect(target.irrigation_revision).toBe(duringDeploy ? '1' : '0');
    const proposal = { scope_id: message.customer_id, field: 'irrigation_controller_location', resource_id: row.id };
    const companions = { irrigation_system: false, irrigation_baseline: { inputs: { irrigation_zones: 6 }, confirmed: [] } };
    await mockPg.transaction(async (trx) => {
      expect(await writer.revertPropertyPreferenceCompanions({ trx, proposal, target, companions }))
        .toEqual({ reverted: ['irrigation_system'] });
    });
  });

  test('irrigation revision migration is reversible and an aborted edit leaves no revision', async () => {
    await mockPg('property_preferences').insert({ customer_id: message.customer_id, irrigation_zones: 6 });
    const abort = new Error('synthetic rollback');
    await expect(mockPg.transaction(async (trx) => {
      await irrigationRevisionMigration.down(trx);
      await irrigationRevisionMigration.down(trx);
      expect(await trx.schema.hasColumn('property_preferences', 'irrigation_revision')).toBe(false);
      await irrigationRevisionMigration.up(trx);
      await irrigationRevisionMigration.up(trx);
      await trx('property_preferences').where({ customer_id: message.customer_id }).update({ irrigation_zones: 8 });
      expect((await trx('property_preferences').first()).irrigation_revision).toBe('1');
      throw abort;
    })).rejects.toBe(abort);
    expect(await mockPg('property_preferences').first()).toMatchObject({ irrigation_zones: 6, irrigation_revision: '0' });
  });

  test('a failed critical audit rolls back profile and processed marker together', async () => {
    message.message_body = 'Lockbox code is #0123';
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: message.message_body });
    result.facts = [{ field: 'lockbox_code', value: '#0123', quote: message.message_body,
      duration: 'durable', property_id: context.properties[0].id }];
    await mockPg.schema.renameTable('audit_log', 'audit_log_unavailable');
    try {
      await expect(recordMessageOperations(mockPg, message, result, context)).rejects.toThrow();
      expect(await mockPg('property_preferences')).toHaveLength(0);
      expect(await mockPg('call_commitments')).toHaveLength(0);
      expect((await mockPg('sms_log').first()).operational_analysis).toBeNull();
    } finally {
      await mockPg.schema.renameTable('audit_log_unavailable', 'audit_log');
    }
  });

  test('a source relink during extraction does not update the originally matched customer', async () => {
    await mockPg('sms_log').where({ id: message.id }).update({ customer_id: null });
    expect(await recordMessageOperations(mockPg, message, result, context)).toEqual({ skipped: 'source_changed' });
    expect(await mockPg('property_preferences')).toHaveLength(0);
    expect(await mockPg('call_commitments')).toHaveLength(0);
  });

  test.each([['call', true], ['call', false], ['email', true], ['email', false]])(
    'a new-row batch applies %s preference independently of its position (first=%s)', async (value, first) => {
      const preference = { field: 'contact_preference', value, quote: `I prefer ${value}`,
        duration: 'durable', property_id: context.properties[0].id };
      message.message_body += ` I prefer ${value}`;
      await mockPg('sms_log').where({ id: message.id }).update({ message_body: message.message_body });
      result.facts = first ? [preference, ...result.facts] : [...result.facts, preference];
      await recordMessageOperations(mockPg, message, result, context);
      const row = await mockPg('property_preferences').first();
      expect(row).toMatchObject({ contact_preference: value, irrigation_controller_location: null });
      const outcomes = (await mockPg('sms_log').first()).operational_analysis.facts.map((fact) => [fact.field, fact.outcome]);
      expect(outcomes).toEqual(expect.arrayContaining([['contact_preference', 'applied'], ['irrigation_controller_location', 'proposed']]));
      const [proposal] = await mockPg('data_hygiene_proposals');
      expect(proposal).toMatchObject({ field: 'irrigation_controller_location', status: 'pending', scope_id: message.customer_id });
      // A row created earlier in the same batch is the proposal's target; otherwise create-on-apply.
      expect(proposal.resource_id).toBe(first ? row.id : null);
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    },
  );

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
    const extract = jest.fn().mockResolvedValue({ facts: [], dropped: 0 });
    const outcome = await runSmsOperationalActions({ conn: mockPg, extract, now: new Date(active.created_at.getTime() + 1000) });
    expect(outcome).toEqual({ processed: 1, failed: 0, skipped: 0 });
    expect(extract).toHaveBeenCalledTimes(1);
    expect((await mockPg('sms_log').where({ id: active.id }).first()).operational_analysis).not.toBeNull();
  });

  test('rollback refuses to destroy recorded SMS analysis', async () => {
    await recordMessageOperations(mockPg, message, result, context);
    await expect(migration.down(mockPg)).rejects.toThrow('disable the gate');
    expect(await mockPg('call_commitments')).toHaveLength(0);
  });
});
