/**
 * clearAtRiskForSettledLongOverdue on real PostgreSQL: the reverse of the Day 60/90 at-risk stamp
 * (markAtRiskForLongOverdue). Before it, nothing returned a customer from at_risk after the debt was
 * paid (2026-11-11: 3 of the 4 at-risk customers had paid in full weeks before, and the daily
 * lead-to-cash sweep listed them as drift). The rule is one UPDATE, so it is tested where its SQL runs:
 * the ET calendar-day count from the reminder anchor, "paid after the stamp", and "nothing 60+ days
 * old still owed". Disposable schema on a private QA / isolated CI database; skipped without
 * APP_TEST_DATABASE_URL, run for real in CI.
 */
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  Object.defineProperty(db, 'fn', { get: () => mockPg.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('node:crypto');
const knex = require('knex');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `at_risk_clear_${randomUUID().replaceAll('-', '')}`;
let admin;
let mockPg;

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);

postgres('clearAtRiskForSettledLongOverdue on PostgreSQL', () => {
  let sweep;

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    await mockPg.raw(`CREATE TABLE customers (
      id uuid PRIMARY KEY, active boolean DEFAULT true, deleted_at timestamptz,
      pipeline_stage text, pipeline_stage_changed_at timestamptz)`);
    await mockPg.raw(`CREATE TABLE invoices (
      id uuid PRIMARY KEY, customer_id uuid NOT NULL, status text, payer_id uuid,
      sent_at timestamptz, sms_sent_at timestamptz, paid_at timestamptz, created_at timestamptz DEFAULT now())`);
    await mockPg.raw(`CREATE TABLE invoice_followup_sequences (
      id uuid PRIMARY KEY, invoice_id uuid NOT NULL UNIQUE, customer_id uuid NOT NULL, status text,
      step_index integer DEFAULT 0, anchor_at timestamptz)`);
    ({ clearAtRiskForSettledLongOverdue: sweep } = require('../services/invoice-followups'));
  });

  afterAll(async () => {
    if (mockPg) await mockPg.destroy();
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (admin) await admin.destroy();
  });

  beforeEach(async () => {
    await mockPg.raw('TRUNCATE customers, invoices, invoice_followup_sequences');
  });

  // A customer the Day 60 step stamped `stampedDaysAgo` days back.
  async function customer({ stage = 'at_risk', stampedDaysAgo = 5, active = true, deleted = false } = {}) {
    const id = randomUUID();
    await mockPg('customers').insert({
      id, active, deleted_at: deleted ? new Date() : null, pipeline_stage: stage, pipeline_stage_changed_at: daysAgo(stampedDaysAgo),
    });
    return id;
  }

  // One invoice. sentDaysAgo dates the reminder anchor; paidDaysAgo (a number) marks it paid then.
  async function invoice(customerId, {
    status = 'paid', sentDaysAgo = 70, paidDaysAgo = null, payerId = null, sequence = true, anchorDaysAgo = null,
  } = {}) {
    const id = randomUUID();
    await mockPg('invoices').insert({
      id, customer_id: customerId, status, payer_id: payerId, sent_at: daysAgo(sentDaysAgo),
      paid_at: paidDaysAgo === null ? null : daysAgo(paidDaysAgo), created_at: daysAgo(sentDaysAgo + 1),
    });
    if (sequence) {
      await mockPg('invoice_followup_sequences').insert({
        id: randomUUID(), invoice_id: id, customer_id: customerId, status: 'completed', step_index: 5,
        anchor_at: anchorDaysAgo === null ? null : daysAgo(anchorDaysAgo),
      });
    }
    return id;
  }

  const stageOf = async (id) => (await mockPg('customers').where({ id }).first()).pipeline_stage;

  test('a debt paid 60+ days late, after the stamp, returns the customer to active_customer', async () => {
    const id = await customer({ stampedDaysAgo: 5 });
    await invoice(id, { sentDaysAgo: 70, paidDaysAgo: 2 });
    const before = (await mockPg('customers').where({ id }).first()).pipeline_stage_changed_at;
    await expect(sweep()).resolves.toEqual([id]);
    const after = await mockPg('customers').where({ id }).first();
    expect(after.pipeline_stage).toBe('active_customer');
    expect(after.pipeline_stage_changed_at.getTime()).toBeGreaterThan(before.getTime());
    // A second run finds nothing.
    await expect(sweep()).resolves.toEqual([]);
  });

  test('a prepaid status counts as paid, and an invoice with no sequence row is dated from its send time', async () => {
    const id = await customer();
    await invoice(id, { status: 'prepaid', sentDaysAgo: 70, paidDaysAgo: 2, sequence: false });
    await expect(sweep()).resolves.toEqual([id]);
  });

  test('another invoice 60+ days old and still owed keeps the stage', async () => {
    for (const status of ['sent', 'viewed', 'overdue', 'processing']) {
      const id = await customer();
      await invoice(id, { sentDaysAgo: 95, paidDaysAgo: 2 });
      await invoice(id, { status, sentDaysAgo: 65 });
      await expect(sweep()).resolves.toEqual([]);
      expect(await stageOf(id)).toBe('at_risk');
    }
  });

  test('an old invoice that is not owed does not keep the stage: void, refunded, draft, payer-billed, or younger than 60 days', async () => {
    const id = await customer();
    await invoice(id, { sentDaysAgo: 95, paidDaysAgo: 2 });
    await invoice(id, { status: 'void', sentDaysAgo: 80 });
    await invoice(id, { status: 'refunded', sentDaysAgo: 80 });
    await invoice(id, { status: 'draft', sentDaysAgo: 80 });
    await invoice(id, { status: 'sent', sentDaysAgo: 80, payerId: randomUUID() });
    await invoice(id, { status: 'sent', sentDaysAgo: 20 });
    await expect(sweep()).resolves.toEqual([id]);
  });

  test('a stage set after the payment stays (a person marked the customer at risk)', async () => {
    const id = await customer({ stampedDaysAgo: 1 });
    await invoice(id, { sentDaysAgo: 80, paidDaysAgo: 3 });
    await expect(sweep()).resolves.toEqual([]);
    expect(await stageOf(id)).toBe('at_risk');
  });

  test('a payment that was not long overdue is no evidence: paid inside 60 days, or only a void', async () => {
    const paidOnTime = await customer({ stampedDaysAgo: 5 });
    await invoice(paidOnTime, { sentDaysAgo: 30, paidDaysAgo: 2 });
    const onlyVoid = await customer({ stampedDaysAgo: 5 });
    await invoice(onlyVoid, { status: 'void', sentDaysAgo: 90 });
    const noInvoice = await customer({ stampedDaysAgo: 5 });
    await expect(sweep()).resolves.toEqual([]);
    for (const id of [paidOnTime, onlyVoid, noInvoice]) expect(await stageOf(id)).toBe('at_risk');
  });

  test('the sequence anchor, when set, dates the invoice in place of its send time', async () => {
    // Sent 70 days ago but re-anchored 20 days ago: the paid invoice was 18 days old, not long overdue.
    const reAnchored = await customer({ stampedDaysAgo: 5 });
    await invoice(reAnchored, { sentDaysAgo: 70, anchorDaysAgo: 20, paidDaysAgo: 2 });
    // An open invoice sent 70 days ago but re-anchored 20 days ago is not long overdue either.
    const openReAnchored = await customer({ stampedDaysAgo: 5 });
    await invoice(openReAnchored, { sentDaysAgo: 95, paidDaysAgo: 2 });
    await invoice(openReAnchored, { status: 'sent', sentDaysAgo: 70, anchorDaysAgo: 20 });
    await expect(sweep()).resolves.toEqual([openReAnchored]);
    expect(await stageOf(reAnchored)).toBe('at_risk');
  });

  test('days are ET calendar days from the anchor, the way the Day 60 touch is dated', async () => {
    // Sent at 3 PM ET, paid at 11 AM ET on calendar day 60: 59 days 20 hours later. The Day 60 touch
    // (10 AM ET that day) had already stamped the customer, so the payment settles the stamped debt.
    const id = randomUUID();
    const invoiceId = randomUUID();
    await mockPg('customers').insert({ id, active: true, pipeline_stage: 'at_risk', pipeline_stage_changed_at: '2026-03-03T15:16:00Z' });
    await mockPg('invoices').insert({
      id: invoiceId, customer_id: id, status: 'paid', sent_at: '2026-01-02T20:00:00Z', paid_at: '2026-03-03T16:00:00Z', created_at: '2026-01-02T20:00:00Z',
    });
    // One calendar day earlier is day 59: not long overdue.
    const early = randomUUID();
    await mockPg('customers').insert({ id: early, active: true, pipeline_stage: 'at_risk', pipeline_stage_changed_at: '2026-03-01T15:16:00Z' });
    await mockPg('invoices').insert({
      id: randomUUID(), customer_id: early, status: 'paid', sent_at: '2026-01-02T20:00:00Z', paid_at: '2026-03-02T16:00:00Z', created_at: '2026-01-02T20:00:00Z',
    });
    await expect(sweep()).resolves.toEqual([id]);
    expect(await stageOf(early)).toBe('at_risk');
  });

  test('only an active, not deleted, at_risk customer moves', async () => {
    const inactive = await customer({ active: false });
    const deleted = await customer({ deleted: true });
    const churned = await customer({ stage: 'churned' });
    const won = await customer({ stage: 'won' });
    for (const id of [inactive, deleted, churned, won]) await invoice(id, { sentDaysAgo: 70, paidDaysAgo: 2 });
    await expect(sweep()).resolves.toEqual([]);
    expect(await stageOf(inactive)).toBe('at_risk');
    expect(await stageOf(deleted)).toBe('at_risk');
    expect(await stageOf(churned)).toBe('churned');
    expect(await stageOf(won)).toBe('won');
  });
});
