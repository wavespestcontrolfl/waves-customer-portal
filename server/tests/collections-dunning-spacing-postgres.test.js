/**
 * Seven-day overdue-message spacing against real Postgres (codex #5108 r1):
 * the policy read and the ledger reservation are separate steps, so the
 * reservation re-checks under a per-customer advisory lock. Two rails that
 * both passed the read can no longer both reserve; a rail's own sibling legs
 * still can; re-arming a failed reservation takes the same lock; and a late
 * acceptance moves the row's time forward, never back.
 */

let mockPg;
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('node:crypto');
const knex = require('knex');
const Ledger = require('../services/collections/contact-ledger');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `dunning_spacing_${randomUUID().replaceAll('-', '')}`;
const DAY = 24 * 60 * 60 * 1000;
let admin;

const reserve = (customerId, source, channel = 'sms', extra = {}) => Ledger.recordContact({
  customerId, channel, purpose: 'late_payment', invoiceIds: ['inv-1'], source, ...extra,
});

postgres('seven-day spacing at reservation time', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 4 } });
    await mockPg.schema.createTable('collections_contact_ledger', (table) => {
      table.increments('id'); table.uuid('customer_id'); table.jsonb('invoice_ids'); table.jsonb('metadata');
      table.timestamp('occurred_at', { useTz: true }); table.text('idempotency_key').unique();
      for (const key of ['channel', 'purpose', 'source']) table.text(key);
    });
  }, 30000);
  afterAll(async () => {
    await mockPg?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });
  beforeEach(async () => {
    await mockPg('collections_contact_ledger').del();
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    process.env.GATE_DUNNING_SPACING = 'true';
  });
  afterEach(() => {
    delete process.env.GATE_COLLECTIONS_POLICY;
    delete process.env.GATE_DUNNING_SPACING;
  });

  test('two rails reserving at once: exactly one message lands, the other is held', async () => {
    const customerId = randomUUID();
    // Hold the customer's lock so both reservations are waiting at once,
    // each past its own policy read.
    const blocker = await mockPg.transaction();
    await blocker.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['dunning-spacing', customerId]);
    const racing = Promise.allSettled([
      reserve(customerId, 'late_payment_checker', 'sms'),
      reserve(customerId, 'invoice_followups', 'email'),
    ]);
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    await blocker.commit();
    const outcomes = await racing;
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const held = outcomes.find((o) => o.status === 'rejected');
    expect(held.reason.code).toBe('DUNNING_SPACING_HELD');
    expect(await mockPg('collections_contact_ledger').where({ customer_id: customerId })).toHaveLength(1);
  });

  test('a rail\'s own sibling legs both land; another customer is unaffected', async () => {
    const customerId = randomUUID();
    await reserve(customerId, 'invoice_followups', 'sms');
    await reserve(customerId, 'invoice_followups', 'email');
    await reserve(randomUUID(), 'late_payment_checker', 'sms');
    expect(await mockPg('collections_contact_ledger').where({ customer_id: customerId })).toHaveLength(2);
  });

  test('another rail\'s failed or settled message does not hold; delivery evidence does', async () => {
    const customerId = randomUUID();
    const occurred = new Date(Date.now() - 2 * DAY);
    const row = (metadata) => ({
      customer_id: customerId, channel: 'sms', purpose: 'late_payment', source: 'late_payment_checker',
      invoice_ids: '[]', occurred_at: occurred, metadata: JSON.stringify(metadata),
    });
    await mockPg('collections_contact_ledger').insert([row({ send_failed: true }), row({ resolved: true })]);
    await expect(reserve(customerId, 'invoice_followups')).resolves.toMatchObject({ id: expect.any(Number) });

    const other = randomUUID();
    await mockPg('collections_contact_ledger').insert({ ...row({ send_failed: true, delivered: true }), customer_id: other });
    await expect(reserve(other, 'invoice_followups')).rejects.toMatchObject({ code: 'DUNNING_SPACING_HELD' });
  });

  test('a pay link asked for on a call neither waits nor holds', async () => {
    const customerId = randomUUID();
    await reserve(customerId, 'late_payment_checker');
    await expect(reserve(customerId, 'collections_voice_paylink')).resolves.toMatchObject({ id: expect.any(Number) });
    const renewal = randomUUID();
    await reserve(renewal, 'annual_prepay_payment_reminder');
    await expect(reserve(renewal, 'invoice_followups')).resolves.toMatchObject({ id: expect.any(Number) });
  });

  test('re-arming a failed reservation is held when another rail sent in the meantime', async () => {
    const customerId = randomUUID();
    const entry = await reserve(customerId, 'late_payment_checker', 'sms', { idempotencyKey: `lpc:${customerId}:sms` });
    await Ledger.markSendFailed(entry, { code: 'provider_refused' });
    // The retry refreshes its reservation (nothing else holds yet)...
    const retry = await reserve(customerId, 'late_payment_checker', 'sms', { idempotencyKey: `lpc:${customerId}:sms` });
    expect(retry.reused).toBe(true);
    // ...and another rail reserves before the retry claims its attempt.
    await reserve(customerId, 'invoice_followups', 'email');
    await expect(Ledger.claimAttempt(retry)).resolves.toEqual({ allowed: false, held: true });
    const stored = await mockPg('collections_contact_ledger').where({ id: entry.id }).first('metadata');
    expect(stored.metadata.send_failed).toBe(true);
  });

  test('re-arming proceeds when nothing else holds', async () => {
    const customerId = randomUUID();
    const entry = await reserve(customerId, 'late_payment_checker', 'sms', { idempotencyKey: `lpc:${customerId}:sms` });
    await Ledger.markSendFailed(entry, { code: 'provider_refused' });
    const retry = await reserve(customerId, 'late_payment_checker', 'sms', { idempotencyKey: `lpc:${customerId}:sms` });
    await expect(Ledger.claimAttempt(retry)).resolves.toEqual({ allowed: true });
  });

  test('a late acceptance moves the row\'s time forward, never back', async () => {
    const customerId = randomUUID();
    const reservedAt = new Date('2026-09-29T14:16:00Z');
    const entry = await reserve(customerId, 'invoice_followups', 'email', { occurredAt: reservedAt });
    const acceptedAt = new Date('2026-09-29T19:40:00Z');
    await expect(Ledger.markDelivered({ id: entry.id }, { deliveredAt: acceptedAt })).resolves.toBe(true);
    await expect(Ledger.markDelivered({ id: entry.id }, { deliveredAt: reservedAt })).resolves.toBe(true);
    const stored = await mockPg('collections_contact_ledger').where({ id: entry.id }).first('occurred_at', 'metadata');
    expect(new Date(stored.occurred_at).toISOString()).toBe(acceptedAt.toISOString());
    expect(stored.metadata.delivered).toBe(true);
  });

  test('gates off: a second rail still reserves (unchanged)', async () => {
    delete process.env.GATE_DUNNING_SPACING;
    const customerId = randomUUID();
    await reserve(customerId, 'late_payment_checker');
    await expect(reserve(customerId, 'invoice_followups')).resolves.toMatchObject({ id: expect.any(Number) });
  });
});
