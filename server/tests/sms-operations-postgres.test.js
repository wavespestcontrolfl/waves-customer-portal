/** Transaction proof against an explicitly selected synthetic QA database. */
jest.mock('../models/db', () => {
  const conn = (...args) => mockPg(...args);
  conn.transaction = (...args) => mockPg.transaction(...args);
  conn.raw = (...args) => mockPg.raw(...args);
  return conn;
});
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatch: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((name, work) => work()) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { recordMessageOperations, loadMessageContext, runSmsOperationalActions, refreshSmsCommitments } = require('../services/sms-operational-actions');
const numbers = require('../config/twilio-numbers');
const { dispatch } = require('../services/llm/call');
const { loadSmsFulfillmentEvidence, admissibleWitness } = require('../services/sms-commitment-fulfillment');
const NotificationService = require('../services/notification-service');
const { etDateString } = require('../utils/datetime-et');
const migration = require('../models/migrations/20260906000001_sms_operational_actions');
const { listOpenCommitments } = require('../services/call-commitments');
const connection = process.env.SMS_OPERATIONS_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `sms_operations_${randomUUID().replaceAll('-', '')}`;
const TABLES = ['customers', 'customer_properties', 'property_preferences', 'sms_log', 'call_log',
  'call_commitments', 'data_hygiene_source_extractions', 'notifications', 'audit_log',
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
    result = { dropped: 0, facts: [{ field: 'irrigation_controller_location', value: 'beside the garage',
      quote: 'The controller is beside the garage', duration: 'durable', property_id: propertyId }],
    obligations: [{ party: 'waves', kind: 'send_estimate', description: 'send the estimate',
      quote: 'Please send the estimate', basis: 'request', property_id: propertyId, due_text: null, due_at: null }] };
    context = await loadMessageContext(mockPg, message);
  });
  afterAll(async () => {
    delete process.env.GATE_SMS_OPERATIONAL_ACTIONS;
    delete process.env.GATE_SMS_OPERATIONAL_ACTIONS_SINCE;
    if (mockPg) await mockPg.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  test('concurrent retries commit one profile update, obligation and extraction receipt', async () => {
    await Promise.all([
      recordMessageOperations(mockPg, message, result, context),
      recordMessageOperations(mockPg, message, result, context),
    ]);
    expect(await mockPg('call_commitments')).toHaveLength(1);
    expect(await mockPg('data_hygiene_source_extractions')).toHaveLength(1);
    expect(await mockPg('audit_log')).toHaveLength(1);
    expect((await mockPg('property_preferences').first()).irrigation_controller_location).toBe('beside the garage');
    expect((await mockPg('sms_log').first()).operational_analysis.facts[0].outcome).toBe('applied');
    // Existing Owed/call readers remain call-scoped. No new portal queue.
    expect(await listOpenCommitments(mockPg)).toEqual([]);
  });

  test('a failed critical audit rolls back profile, commitment and processed marker together', async () => {
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

  test('the same sentence can request estimates for two properties without dropping either', async () => {
    const secondProperty = randomUUID();
    await mockPg('customer_properties').insert({ id: secondProperty, customer_id: message.customer_id,
      address_line1: '200 Example Lane', city: 'Sarasota', zip: '34236', active: true });
    message.message_body = 'Please send an estimate for both properties';
    await mockPg('sms_log').where({ id: message.id }).update({ message_body: message.message_body });
    const first = { ...result.obligations[0], quote: message.message_body };
    result = { dropped: 0, facts: [], obligations: [first, { ...first, property_id: secondProperty }] };
    await recordMessageOperations(mockPg, message, result, context);
    const rows = await mockPg('call_commitments');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.sms_context.property_id))).toEqual(new Set([first.property_id, secondProperty]));
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

  test.each([['call', true], ['call', false], ['email', true], ['email', false]])(
    'a new-row batch applies %s preference independently of its position (first=%s)', async (value, first) => {
      const preference = { field: 'contact_preference', value, quote: `I prefer ${value}`,
        duration: 'durable', property_id: context.properties[0].id };
      message.message_body += ` I prefer ${value}`;
      await mockPg('sms_log').where({ id: message.id }).update({ message_body: message.message_body });
      result.facts = first ? [preference, ...result.facts] : [...result.facts, preference];
      await recordMessageOperations(mockPg, message, result, context);
      expect(await mockPg('property_preferences').first()).toMatchObject({
        contact_preference: value, irrigation_controller_location: 'beside the garage',
      });
      expect((await mockPg('sms_log').first()).operational_analysis.facts.every((fact) => fact.outcome === 'applied')).toBe(true);
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    },
  );

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
    expect(admissibleWitness(evidence.records[0], { kind: 'send_appointment_confirmation' })).toBe(true);
  });

  test('persisted evidence checks avoid repeated LLM calls and rerun after a delivery changes', async () => {
    result.obligations[0] = { ...result.obligations[0], kind: 'other',
      due_at: new Date(message.created_at.getTime() + 1000).toISOString() };
    await recordMessageOperations(mockPg, message, result, context);
    const [reply] = await mockPg('sms_log').insert({ ...message, id: randomUUID(), direction: 'outbound',
      from_phone: message.to_phone, to_phone: message.from_phone, message_body: 'Still checking',
      message_type: 'manual', status: 'sent', created_at: new Date(message.created_at.getTime() + 1000) }).returning('id');
    dispatch.mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    const now = new Date(message.created_at.getTime() + 2000);
    await refreshSmsCommitments({ conn: mockPg, now });
    await refreshSmsCommitments({ conn: mockPg, now: new Date(now.getTime() + 300000) });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await mockPg('call_commitments').first()).sms_context.fulfillment_check.evidence_hash).toBeTruthy();
    await mockPg('sms_log').where({ id: reply.id }).update({ status: 'delivered', message_body: 'The issue is resolved' });
    dispatch.mockResolvedValue({ ok: true, json: { verdict: 'fulfilled', record_ref: `sms:${reply.id}`, quote: 'The issue is resolved' } });
    await refreshSmsCommitments({ conn: mockPg, now: new Date(now.getTime() + 600000) });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((await mockPg('call_commitments').first()).status).toBe('fulfilled');
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
    const sms_context = { property_id: base.property_id, source_at: message.created_at.toISOString() };
    const allowed = (kind) => evidence.records.filter((r) => admissibleWitness(r, { kind, sms_context })).map((r) => r.id).sort();
    expect(allowed('schedule_visit')).toEqual([rows[1].id, rows[4].id].sort());
    expect(allowed('technician_follow_up')).toEqual([rows[3].id]);
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
    expect(NotificationService.notifyAdmin.mock.calls[0][3].link).toBe(`/admin/customers?customerId=${winner}`);
    await mockPg.transaction(async (trx) => {
      await trx('sms_log').where({ id: message.id }).update({ customer_id: message.customer_id });
      await trx('customer_properties').where({ customer_id: winner }).update({ customer_id: message.customer_id });
      await trx('customers').where({ id: message.customer_id }).update({ deleted_at: null });
    });
    await refreshSmsCommitments({ conn: mockPg, verify, now });
    expect((await mockPg('call_commitments').first()).sms_context.customer_id).toBe(message.customer_id);
    expect(NotificationService.notifyAdmin.mock.calls[1][3].link).toBe(`/admin/customers?customerId=${message.customer_id}`);
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
});
