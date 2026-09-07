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
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { recordMessageOperations, loadMessageContext, runSmsOperationalActions } = require('../services/sms-operational-actions');
const numbers = require('../config/twilio-numbers');
const NotificationService = require('../services/notification-service');
const migration = require('../models/migrations/20260906000001_sms_operational_actions');
const { listOpenCommitments } = require('../services/call-commitments');
const connection = process.env.SMS_OPERATIONS_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `sms_operations_${randomUUID().replaceAll('-', '')}`;
const TABLES = ['customers', 'customer_properties', 'property_preferences', 'sms_log', 'call_log',
  'call_commitments', 'data_hygiene_source_extractions', 'data_hygiene_proposals', 'notifications', 'audit_log',
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
    admin = knex({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 5 } });
    // Clone the MIGRATED schema, never application records. This catches real
    // column/type/CHECK drift; no simplified hand-written table definitions.
    for (const table of TABLES) {
      await admin.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    }
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    NotificationService.notifyAdmin.mockResolvedValue({ id: randomUUID() });
    for (const table of TABLES) await mockPg(table).delete();
    process.env.GATE_SMS_OPERATIONAL_ACTIONS = 'true';
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
    };
    context = await loadMessageContext(mockPg, message);
  });
  afterAll(async () => {
    delete process.env.GATE_SMS_OPERATIONAL_ACTIONS;
    delete process.env.GATE_SMS_OPERATIONAL_ACTIONS_SINCE;
    if (mockPg) await mockPg.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  test('concurrent retries commit one profile update and extraction receipt', async () => {
    await Promise.all([
      recordMessageOperations(mockPg, message, result, context),
      recordMessageOperations(mockPg, message, result, context),
    ]);
    expect(await mockPg('call_commitments')).toHaveLength(0);
    expect(await mockPg('data_hygiene_source_extractions')).toHaveLength(1);
    expect(await mockPg('audit_log')).toHaveLength(1);
    expect((await mockPg('property_preferences').first()).irrigation_controller_location).toBe('The controller is beside the garage');
    expect((await mockPg('sms_log').first()).operational_analysis.facts[0].outcome).toBe('applied');
    // Existing Owed/call readers remain call-scoped. No new portal queue.
    expect(await listOpenCommitments(mockPg)).toEqual([]);
  });

  test('an irrigation fact turns on a legacy false irrigation flag atomically', async () => {
    await mockPg('property_preferences').insert({ customer_id: message.customer_id, irrigation_system: false });
    context = await loadMessageContext(mockPg, message);
    await recordMessageOperations(mockPg, message, result, context);
    expect(await mockPg('property_preferences').first()).toMatchObject({
      irrigation_system: true, irrigation_controller_location: result.facts[0].value,
    });
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
    const proposal = (scope_id, field) => ({ rule_id: 'extract.access_notes', rule_version: '1',
      resource_type: 'property_preferences', scope_type: 'customer', scope_id, field, source: 'message-extraction',
      proposed_value: JSON.stringify('Use the side gate'), confidence: 0.8, tier: 'medium', is_sensitive: true,
      status: 'pending', idempotency_key: randomUUID() });
    const otherCustomer = randomUUID();
    await mockPg('customers').insert({ id: otherCustomer, first_name: 'Other', last_name: 'Fixture',
      phone: '+12025550199', address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236' });
    await mockPg('data_hygiene_proposals').insert([
      proposal(message.customer_id, 'access_notes'), proposal(message.customer_id, 'pet_details'),
      proposal(otherCustomer, 'access_notes'),
    ]);
    message.message_body = 'Use the side gate.';
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: message.message_body });
    result.facts = [{ field: 'access_notes', value: message.message_body, quote: message.message_body,
      duration: 'durable', property_id: context.properties[0].id }];
    await recordMessageOperations(mockPg, message, result, context);
    expect((await mockPg('property_preferences').first()).access_notes).toBe('Use the side gate.');
    const stale = await mockPg('data_hygiene_proposals').where({ status: 'stale' }).select('scope_id', 'field');
    expect(stale).toEqual([{ scope_id: message.customer_id, field: 'access_notes' }]);
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

  test('a stated pet fills an empty pet field', async () => {
    const quote = 'Two friendly dogs in the yard.';
    message.message_body = quote;
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: quote });
    result.facts = [{ field: 'pet_details', quote, value: quote, property_id: context.properties[0].id, duration: 'durable' }];
    await recordMessageOperations(mockPg, message, result, context);
    expect((await mockPg('property_preferences').first()).pet_details).toBe(quote);
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

  test('a failed critical audit rolls back profile and processed marker together', async () => {
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
      expect(await mockPg('property_preferences').first()).toMatchObject({
        contact_preference: value, irrigation_controller_location: 'The controller is beside the garage',
      });
      expect((await mockPg('sms_log').first()).operational_analysis.facts.every((fact) => fact.outcome === 'applied')).toBe(true);
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
