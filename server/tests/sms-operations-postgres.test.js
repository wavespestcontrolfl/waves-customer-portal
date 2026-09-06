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
const { recordMessageOperations, loadMessageContext, runSmsOperationalActions, refreshSmsCommitments, listSmsCommitments, applySmsCommitmentUpdate } = require('../services/sms-operational-actions');
const numbers = require('../config/twilio-numbers');
const { dispatchWithFallback } = require('../services/llm/call');
const { loadSmsFulfillmentEvidence, admissibleWitness, verifySmsFulfillment } = require('../services/sms-commitment-fulfillment');
const NotificationService = require('../services/notification-service');
const { etDateString } = require('../utils/datetime-et');
const migration = require('../models/migrations/20260906000001_sms_operational_actions');
const { listOpenCommitments } = require('../services/call-commitments');
const connection = process.env.SMS_OPERATIONS_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `sms_operations_${randomUUID().replaceAll('-', '')}`;
const TABLES = ['customers', 'customer_properties', 'property_preferences', 'sms_log', 'call_log',
  'call_commitments', 'data_hygiene_source_extractions', 'notifications', 'audit_log',
  'emails', 'email_messages', 'estimates', 'invoices', 'scheduled_services', 'job_status_history', 'system_settings', 'leads'];
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
    delete process.env.GATE_SMS_COMMITMENT_FOLLOWUP;
    delete process.env.GATE_SMS_OPERATIONAL_ACTIONS_SINCE;
    if (mockPg) await mockPg.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
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

  test('concurrent retries commit one profile update, obligation and extraction receipt', async () => {
    await Promise.all([
      recordMessageOperations(mockPg, message, result, context),
      recordMessageOperations(mockPg, message, result, context),
    ]);
    expect(await mockPg('call_commitments')).toHaveLength(1);
    expect(await mockPg('data_hygiene_source_extractions')).toHaveLength(1);
    expect(await mockPg('audit_log')).toHaveLength(1);
    expect((await mockPg('property_preferences').first()).irrigation_controller_location).toBe('The controller is beside the garage');
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
        contact_preference: value, irrigation_controller_location: 'The controller is beside the garage',
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
    expect(evidence.records[0].recipient_email_snapshot).toBe(base.recipient_email_snapshot);
    expect(admissibleWitness(evidence.records[0], { kind: 'send_appointment_confirmation',
      evidence: [{ quote: 'Send the confirmation to synthetic@example.invalid' }] })).toBe(true);
    expect(admissibleWitness(evidence.records[0], { kind: 'send_appointment_confirmation',
      evidence: [{ quote: 'Send the confirmation to another@example.invalid' }] })).toBe(false);
  });

  test('persisted evidence checks avoid repeated LLM calls and rerun after a delivery changes', async () => {
    result.obligations[0] = { ...result.obligations[0], kind: 'other',
      due_at: new Date(message.created_at.getTime() + 1000).toISOString() };
    await recordMessageOperations(mockPg, message, result, context);
    const [reply] = await mockPg('sms_log').insert({ ...message, id: randomUUID(), direction: 'outbound',
      from_phone: message.to_phone, to_phone: message.from_phone, message_body: 'Still checking',
      message_type: 'manual', status: 'sent', created_at: new Date(message.created_at.getTime() + 1000) }).returning('id');
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
      address: '100 Example Lane', estimate_data: data }).returning('id');
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
    expect(await mockPg('audit_log').where({ action: 'sms.commitment.fulfill' })).toHaveLength(1);
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
    expect(await mockPg('property_preferences')).toHaveLength(1);
    expect(await mockPg('call_commitments')).toHaveLength(0);
  });

});
