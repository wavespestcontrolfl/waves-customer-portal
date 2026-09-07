// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// Runs in the existing DB-gated CI step or the owning worktree's private QA DB.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
const { randomUUID, randomBytes } = require('node:crypto');
const { stampSeriesPrepaid, clearSeriesPrepaid } = require('../services/prepaid-series');
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'synthetic-notification' })) }));
jest.mock('../services/irrigation-weekly-email', () => ({
  findLawnEmailAudienceGaps: jest.fn(async () => []), findUnstampedRecurringLawnMembers: jest.fn(async () => []),
}));

postgres('prepaid series integrity against migrated PostgreSQL', () => {
  let database;
  let trx;
  let customerId;
  const now = new Date('2040-01-10T16:00:00Z');

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function visit(overrides = {}) {
    const [row] = await trx('scheduled_services').insert({ id: randomUUID(), customer_id: customerId,
      service_type: 'Monthly Pest Control Service', service_key_snapshot: 'pest_general_monthly',
      status: 'pending', scheduled_date: '2040-01-15', source_estimate_id: null,
      is_recurring: true, recurring_pattern: 'monthly', ...overrides }).returning('*');
    return row;
  }

  test('the watchdog distinguishes single-visit payments from incomplete manual series coverage', async () => {
    const { runInner } = require('../services/schedule-integrity-watchdog');
    const paidAt = new Date('2040-01-05T16:00:00Z');
    const root = await visit({ prepaid_method: 'check', prepaid_amount: 100, prepaid_at: paidAt });
    const child = await visit({ recurring_parent_id: root.id, created_at: new Date('2040-01-04T16:00:00Z'), estimated_price: 100 });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(0);
    const sibling = await visit({ recurring_parent_id: root.id, scheduled_date: '2040-02-15', prepaid_method: 'check',
      prepaid_amount: 100, prepaid_at: paidAt });
    await visit({ recurring_parent_id: root.id, created_at: new Date('2040-01-06T16:00:00Z'), estimated_price: 100 });
    const result = await runInner({ now });
    expect(result).toMatchObject({ prepayCoverageGaps: 1 });
    const notifications = require('../services/notification-service');
    expect(notifications.notifyAdmin).toHaveBeenCalledWith('alert', expect.any(String), expect.any(String),
      expect.objectContaining({ metadata: expect.objectContaining({ scheduled_service_id: child.id, issue: 'manual_series_stamp_missing' }) }));
    const key = () => notifications.notifyAdmin.mock.calls.filter((call) => call[3].metadata?.scheduled_service_id === child.id
      && call[3].metadata?.issue === 'manual_series_stamp_missing').at(-1)[3].metadata.dedupeKey;
    const originalKey = key();
    await trx.transaction((sp) => sp('scheduled_services').where({ id: child.id }).update({
      prepaid_amount: 100, prepaid_method: 'check', prepaid_at: paidAt,
    }));
    expect((await runInner({ now })).prepayCoverageGaps).toBe(0);
    await trx.transaction((sp) => sp('scheduled_services').where({ id: child.id }).update({
      prepaid_amount: null, prepaid_method: null, prepaid_at: null,
    }));
    expect((await runInner({ now })).prepayCoverageGaps).toBe(1);
    expect(key()).not.toBe(originalKey);
    expect((await trx('scheduled_services').where({ id: child.id }).first()).updated_at).toEqual(child.updated_at);
    const childRegressionKey = key();
    await trx.transaction((sp) => sp('scheduled_services').where({ id: sibling.id }).update({ prepaid_amount: null, prepaid_at: null }));
    expect((await runInner({ now })).prepayCoverageGaps).toBe(0);
    await trx.transaction((sp) => sp('scheduled_services').where({ id: sibling.id }).update({ prepaid_amount: 100, prepaid_at: paidAt }));
    expect((await runInner({ now })).prepayCoverageGaps).toBe(1);
    expect(key()).not.toBe(childRegressionKey);
  });

  test('two children with a shared manual payment reveal a cleared parent stamp', async () => {
    const { runInner } = require('../services/schedule-integrity-watchdog');
    const root = await visit({ estimated_price: 100, is_recurring: false });
    const paidAt = new Date('2040-01-05T16:00:00Z');
    await visit({ recurring_parent_id: root.id, scheduled_date: '2040-02-15', prepaid_method: 'check', prepaid_amount: 100, prepaid_at: paidAt });
    const second = await visit({ recurring_parent_id: root.id, scheduled_date: '2040-03-15', prepaid_method: 'check', prepaid_amount: 100,
      prepaid_at: new Date('2040-01-06T16:00:00Z') });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(0);
    await trx('scheduled_services').where({ id: second.id }).update({ prepaid_at: paidAt });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(1);
    expect(require('../services/notification-service').notifyAdmin).toHaveBeenCalledWith('alert', expect.any(String), expect.any(String),
      expect.objectContaining({ metadata: expect.objectContaining({ scheduled_service_id: root.id, issue: 'manual_series_stamp_missing' }) }));
  });

  test.each([
    ['2040-01-09', 'pending'],
    ['2040-01-09', null],
    ['2040-01-15', null],
  ])('coverage includes live visits on %s with status %s while pricing keeps its existing window', async (scheduled_date, status) => {
    const manual = await visit({ scheduled_date, status, estimated_price: 100 });
    const paidAt = new Date('2040-01-05T16:00:00Z');
    for (const date of ['2040-02-15', '2040-03-15']) {
      await visit({ recurring_parent_id: manual.id, scheduled_date: date, prepaid_method: 'check', prepaid_amount: 100, prepaid_at: paidAt });
    }
    const termId = randomUUID();
    await trx('annual_prepay_terms').insert({ id: termId, customer_id: customerId,
      status: 'active', term_start: '2040-01-01', term_end: '2041-01-01', prepay_amount: 400,
      coverage_service_type: 'Monthly Pest Control Service' });
    const annual = await visit({ scheduled_date, status, annual_prepay_term_id: termId, estimated_price: 100 });
    await visit({ scheduled_date: '2040-01-09' });
    await visit({ scheduled_date: '2040-01-15', status: null });
    await visit({ scheduled_date: '2040-01-25' });
    const { runInner } = require('../services/schedule-integrity-watchdog');
    expect(await runInner({ now })).toMatchObject({ prepayCoverageGaps: 2, unpricedSeries: 0 });
    const notifications = require('../services/notification-service');
    for (const [id, issue] of [[manual.id, 'manual_series_stamp_missing'], [annual.id, 'annual_coverage_unverified']]) {
      expect(notifications.notifyAdmin).toHaveBeenCalledWith('alert', expect.any(String), expect.any(String),
        expect.objectContaining({ metadata: expect.objectContaining({ scheduled_service_id: id, issue }) }));
    }
    for (const terminalStatus of ['completed', 'cancelled', 'rescheduled', 'skipped']) {
      await trx('scheduled_services').whereIn('id', [manual.id, annual.id]).update({ status: terminalStatus });
      expect(await runInner({ now })).toMatchObject({ prepayCoverageGaps: 0, unpricedSeries: 0 });
    }
  });

  test('a valid annual replacement still exposes the original manual allocation conflict', async () => {
    const paidAt = new Date('2040-01-05T16:00:00Z');
    const root = await visit({ prepaid_method: 'check', prepaid_amount: 100, prepaid_at: paidAt });
    for (const date of ['2040-02-15', '2040-03-15']) {
      await visit({ recurring_parent_id: root.id, scheduled_date: date, prepaid_method: 'check', prepaid_amount: 100, prepaid_at: paidAt });
    }
    const { runInner } = require('../services/schedule-integrity-watchdog');
    expect((await runInner({ now })).prepayCoverageGaps).toBe(0);
    const termId = randomUUID();
    const invoiceId = randomUUID();
    await trx('invoices').insert({ id: invoiceId, customer_id: customerId, invoice_number: `fixture-${invoiceId.slice(0, 20)}`,
      token: randomBytes(32).toString('hex'), total: 400, subtotal: 400, status: 'paid' });
    await trx('annual_prepay_terms').insert({ id: termId, customer_id: customerId, prepay_invoice_id: invoiceId,
      status: 'active', term_start: '2040-01-01', term_end: '2041-01-01', prepay_amount: 400 });
    await trx('scheduled_services').where({ id: root.id }).update({ annual_prepay_term_id: termId,
      prepaid_method: 'annual_prepay_invoice', prepaid_at: new Date('2040-01-06T16:00:00Z') });
    const notifications = require('../services/notification-service');
    notifications.notifyAdmin.mockClear();
    expect(await runInner({ now })).toMatchObject({ prepayCoverageGaps: 1, unpricedSeries: 0 });
    expect(notifications.notifyAdmin).toHaveBeenCalledWith('alert', expect.any(String), expect.any(String),
      expect.objectContaining({ metadata: expect.objectContaining({ scheduled_service_id: root.id, issue: 'manual_series_stamp_conflict' }) }));
    await trx('scheduled_services').where({ id: root.id }).update({ annual_prepay_term_id: null, prepaid_method: 'check' });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(1);
    const laterRows = [];
    for (const date of ['2040-04-15', '2040-05-15']) {
      laterRows.push(await visit({ recurring_parent_id: root.id, scheduled_date: date,
        created_at: new Date('2040-01-06T16:00:00Z'), prepaid_method: 'check', prepaid_amount: 100,
        prepaid_at: new Date('2040-01-06T16:00:00Z') }));
    }
    // Matching the newer payment does not account for the older allocation.
    expect((await runInner({ now })).prepayCoverageGaps).toBe(1);
    await trx('scheduled_services').whereIn('id', laterRows.map((row) => row.id))
      .update({ prepaid_amount: null, prepaid_method: null, prepaid_at: null });
    await trx('scheduled_services').where({ id: root.id }).update({ prepaid_at: paidAt });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(0);
  });

  test('upcoming coverage gaps retain priority when overdue coverage exceeds the alert cap', async () => {
    const { runInner, MAX_ALERTS_PER_RUN } = require('../services/schedule-integrity-watchdog');
    for (let i = 0; i <= MAX_ALERTS_PER_RUN; i++) {
      await visit({ scheduled_date: '2040-01-09', estimated_price: 100, prepaid_method: 'annual_prepay_invoice', prepaid_amount: 100 });
    }
    const upcoming = await visit({ estimated_price: 100, prepaid_method: 'annual_prepay_invoice', prepaid_amount: 100 });
    const notifications = require('../services/notification-service');
    notifications.notifyAdmin.mockClear();
    expect(await runInner({ now })).toMatchObject({ prepayCoverageGaps: MAX_ALERTS_PER_RUN + 2, alerted: MAX_ALERTS_PER_RUN });
    expect(notifications.notifyAdmin.mock.calls[0][3].metadata.scheduled_service_id).toBe(upcoming.id);
  });

  test('linked unstamped priced visits alert only while their matching term has paid coverage', async () => {
    const invoiceId = randomUUID();
    const termId = randomUUID();
    await trx('invoices').insert({ id: invoiceId, customer_id: customerId, invoice_number: `fixture-${invoiceId.slice(0, 20)}`,
      token: randomBytes(32).toString('hex'), total: 400, subtotal: 400, status: 'paid' });
    await trx('annual_prepay_terms').insert({ id: termId, customer_id: customerId, prepay_invoice_id: invoiceId,
      status: 'active', term_start: '2040-01-01', term_end: '2041-01-01', prepay_amount: 400,
      coverage_service_type: 'Monthly Pest Control Service', coverage_visit_count: 12 });
    const root = await visit({ annual_prepay_term_id: termId, estimated_price: 100, is_recurring: false });
    const { runInner } = require('../services/schedule-integrity-watchdog');
    expect((await runInner({ now })).prepayCoverageGaps).toBe(1);
    expect(require('../services/notification-service').notifyAdmin).toHaveBeenCalledWith('alert', expect.any(String), expect.any(String),
      expect.objectContaining({ metadata: expect.objectContaining({ scheduled_service_id: root.id, issue: 'annual_coverage_unverified' }) }));
    await trx('scheduled_services').where({ id: root.id }).update({ prepaid_method: 'cash', prepaid_amount: 10 });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(1);
    await trx('scheduled_services').where({ id: root.id }).update({ prepaid_amount: 100 });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(1);
    await trx('scheduled_services').where({ id: root.id }).update({ prepaid_method: 'annual_prepay_invoice' });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(0);
    await trx('scheduled_services').where({ id: root.id }).update({ prepaid_method: null, prepaid_amount: null });
    await trx('annual_prepay_terms').where({ id: termId }).update({ coverage_service_type: 'Lawn Care' });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(0);
    await trx('annual_prepay_terms').where({ id: termId }).update({ coverage_service_type: 'Monthly Pest Control Service', status: 'cancelled' });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(0);
    await trx('annual_prepay_terms').where({ id: termId }).update({ status: 'payment_pending' });
    await trx('invoices').where({ id: invoiceId }).update({ status: 'sent' });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(0);
    await trx('invoices').where({ id: invoiceId }).update({ status: 'paid' });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(1);
  });

  test('payment-only refund changes refresh the same annual visit\'s alert evidence', async () => {
    const invoiceId = randomUUID();
    const paymentId = randomUUID();
    const termId = randomUUID();
    const intentId = `pi_fixture_${randomUUID()}`;
    await trx('invoices').insert({ id: invoiceId, customer_id: customerId, invoice_number: `fixture-${invoiceId.slice(0, 20)}`,
      token: randomBytes(32).toString('hex'), total: 400, subtotal: 400, status: 'paid', stripe_payment_intent_id: intentId });
    await trx('payments').insert({ id: paymentId, customer_id: customerId, payment_date: '2040-01-01', amount: 400, status: 'refunded',
      refund_status: 'full', stripe_payment_intent_id: intentId, updated_at: new Date('2040-01-01T12:00:00Z') });
    await trx('annual_prepay_terms').insert({ id: termId, customer_id: customerId, prepay_invoice_id: invoiceId,
      status: 'active', term_start: '2040-01-01', term_end: '2041-01-01', prepay_amount: 400 });
    const root = await visit({ annual_prepay_term_id: termId, prepaid_method: 'annual_prepay_invoice',
      prepaid_amount: 100, estimated_price: 100 });
    const { runInner } = require('../services/schedule-integrity-watchdog');
    const notifications = require('../services/notification-service');
    const key = () => notifications.notifyAdmin.mock.calls.filter((call) => call[3].metadata?.scheduled_service_id === root.id
      && call[3].metadata?.issue === 'annual_coverage_unverified').at(-1)[3].metadata.dedupeKey;
    expect((await runInner({ now })).prepayCoverageGaps).toBe(1);
    const originalKey = key();
    await trx.transaction((sp) => sp('payments').where({ id: paymentId }).update({ status: 'paid', refund_status: null }));
    expect((await runInner({ now })).prepayCoverageGaps).toBe(0);
    await trx.transaction((sp) => sp('payments').where({ id: paymentId }).update({ status: 'refunded', refund_status: 'full' }));
    expect((await runInner({ now })).prepayCoverageGaps).toBe(1);
    expect(key()).not.toBe(originalKey);
  });

  test('manual allocation preserves exact cents across the locked series', async () => {
    const root = await visit();
    await visit({ recurring_parent_id: root.id, scheduled_date: '2040-02-15' });
    await visit({ recurring_parent_id: root.id, scheduled_date: '2040-03-15' });
    const result = await stampSeriesPrepaid(trx, { anchorServiceId: root.id, totalAmount: 100, method: 'check', useExistingTransaction: true });
    expect(result.updatedRows.map((row) => Number(row.prepaid_amount))).toEqual([33.33, 33.33, 33.34]);
    const audits = await trx('audit_log').where({ action: 'prepaid_series.allocated' })
      .whereRaw("metadata->>'customer_id' = ?", [customerId]);
    expect(audits).toHaveLength(3);
    expect(audits.map((audit) => audit.metadata.prepaid_amount).sort()).toEqual([33.33, 33.33, 33.34]);
  });

  test.each([1, 2])('an audited %i-visit series detects erased slices and explicit whole-series clearing retires evidence', async (count) => {
    const root = await visit({ estimated_price: 100, recurring_pattern: count === 1 ? 'annual' : 'semiannual', is_recurring: false });
    if (count === 2) await visit({ recurring_parent_id: root.id, estimated_price: 100, scheduled_date: '2040-07-15' });
    const stamp = await stampSeriesPrepaid(trx, { anchorServiceId: root.id, totalAmount: 100 * count, method: 'cash', useExistingTransaction: true });
    const { runInner } = require('../services/schedule-integrity-watchdog');
    expect((await runInner({ now })).prepayCoverageGaps).toBe(0);
    // Single-visit clear leaves the series payment unreconciled, even with
    // no surviving positive stamps and no current recurrence flag.
    await trx('scheduled_services').where({ id: root.id }).update({ prepaid_amount: null, prepaid_method: null, prepaid_at: null });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(1);
    await trx('scheduled_services').where({ id: root.id }).update({ prepaid_amount: 10, prepaid_method: 'cash', prepaid_at: stamp.updatedRows[0].prepaid_at });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(1);
    await trx('scheduled_services').where({ id: root.id }).update({ prepaid_amount: 100 });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(0);
    await trx('scheduled_services').whereIn('id', stamp.updatedRows.map((row) => row.id))
      .update({ prepaid_amount: null, prepaid_method: null, prepaid_at: null });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(1);
    expect(await clearSeriesPrepaid(trx, root)).toMatchObject({ success: true, clearedCount: 0 });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(0);
    // Retiring old audit ids must never retire a subsequent series payment.
    await stampSeriesPrepaid(trx, { anchorServiceId: root.id, totalAmount: 120 * count, method: 'check', useExistingTransaction: true });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(0);
    await trx('scheduled_services').where({ id: root.id }).update({ prepaid_amount: null, prepaid_method: null, prepaid_at: null });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(1);
    expect(await clearSeriesPrepaid(trx, root)).toMatchObject({ success: true, clearedCount: count - 1 });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(0);
    expect(await trx('audit_log').where({ action: 'prepaid_series.allocated' })
      .whereRaw("metadata->>'customer_id' = ?", [customerId])).toHaveLength(count * 2);
  });

  test('allocation audit failure rolls back both the series stamps and its clear', async () => {
    const root = await visit({ estimated_price: 100 });
    const failAudit = async (sp) => {
      await sp.raw(`CREATE FUNCTION pg_temp.reject_prepaid_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$`);
      await sp.raw('CREATE TRIGGER fixture_reject_prepaid_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_prepaid_audit()');
    };
    await expect(trx.transaction(async (sp) => {
      await failAudit(sp);
      await stampSeriesPrepaid(sp, { anchorServiceId: root.id, totalAmount: 100, method: 'cash', useExistingTransaction: true });
    })).rejects.toThrow('synthetic audit failure');
    expect((await trx('scheduled_services').where({ id: root.id }).first()).prepaid_amount).toBeNull();
    await stampSeriesPrepaid(trx, { anchorServiceId: root.id, totalAmount: 100, method: 'cash', useExistingTransaction: true });
    await expect(trx.transaction(async (sp) => {
      await failAudit(sp);
      await clearSeriesPrepaid(sp, root);
    })).rejects.toThrow('synthetic audit failure');
    expect(Number((await trx('scheduled_services').where({ id: root.id }).first()).prepaid_amount)).toBe(100);
  });

  test('an annual stamp on a later sibling prevents every manual write', async () => {
    const root = await visit();
    const child = await visit({ recurring_parent_id: root.id, scheduled_date: '2040-02-15',
      prepaid_method: 'annual_prepay_invoice', prepaid_amount: 100 });
    await expect(stampSeriesPrepaid(trx, { anchorServiceId: root.id, totalAmount: 200, method: 'cash', useExistingTransaction: true }))
      .rejects.toMatchObject({ status: 409 });
    const rows = await trx('scheduled_services').whereIn('id', [root.id, child.id]).orderBy('scheduled_date');
    expect(rows[0].prepaid_amount).toBeNull();
    expect(rows[1].prepaid_method).toBe('annual_prepay_invoice');
    expect(Number(rows[1].prepaid_amount)).toBe(100);
  });

  test('a foreign-customer sibling prevents allocation to the entire locked family', async () => {
    const root = await visit();
    const otherCustomer = randomUUID();
    await trx('customers').insert({ id: otherCustomer, first_name: 'Synthetic', last_name: 'Other',
      phone: `fixture-${otherCustomer.slice(0, 8)}`, address_line1: '200 Test Lane', city: 'Test City', zip: '00000' });
    const child = await visit({ customer_id: otherCustomer, recurring_parent_id: root.id, scheduled_date: '2040-02-15' });
    await expect(stampSeriesPrepaid(trx, { anchorServiceId: root.id, totalAmount: 200, method: 'cash', useExistingTransaction: true }))
      .rejects.toMatchObject({ status: 409 });
    const rows = await trx('scheduled_services').whereIn('id', [root.id, child.id]);
    expect(rows.every((row) => row.prepaid_amount === null)).toBe(true);
  });
});
