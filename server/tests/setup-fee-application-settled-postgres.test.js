// GATE_SETUP_FEE_APPLICATION_SETTLED — the setup-fee alert reconcile counts a
// parked visit's application as billed when a live prepay year bought the
// visit, or when the visit's own invoices bill its frozen charge with its own
// add-on lines counted. The three false alerts of #6830 (prod, raised
// 2026-08-25, 09-11 and 09-25) are rebuilt below as synthetic records. Each
// read "the setup fee is covered, the application is still owed" although the
// application was billed: billing it by hand would have charged twice.
//
// GATE_SETUP_FEE_OPEN_INVOICE_NOTICE (owner 2026-10-31) closes what #6937 left:
// the 08-25 shape with the visit's invoice not paid yet still read "setup fee
// owed, bill it" although the fee rode that invoice as the add-on.
//
// The helper and the completion source contract run without a database; the
// reconcile runs on real migrated PostgreSQL, synthetic records, rolled back
// after every test.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  Object.defineProperty(db, 'client', { get: () => db.connection.client });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');
const { sumVisitChargeCents } = require('../services/estimate-first-application-invoice');

const GATE = 'GATE_SETUP_FEE_APPLICATION_SETTLED';
const NOTICE = 'GATE_SETUP_FEE_OPEN_INVOICE_NOTICE';

describe('sumVisitChargeCents: the visit\'s own charge, add-ons included', () => {
  const visitId = 'v-1';
  const base = { client_id: `scheduled_${visitId}_primary`, description: 'Pest Control Service', amount: 110, quantity: 1 };
  const feeAddon = { client_id: `scheduled_${visitId}_addon_a1`, description: 'WaveGuard Membership', amount: 99, quantity: 1 };

  test('the base line plus the visit\'s own add-on line, on one invoice or split across two', () => {
    expect(sumVisitChargeCents([{ line_items: [base, feeAddon] }], visitId)).toBe(20900);
    expect(sumVisitChargeCents([{ line_items: [base] }, { line_items: JSON.stringify([feeAddon]) }], visitId)).toBe(20900);
  });

  test('another visit\'s add-on and credited lines never count', () => {
    const foreignAddon = { ...feeAddon, client_id: 'scheduled_v-2_addon_a1' };
    const credited = { ...feeAddon, amount: -99 };
    expect(sumVisitChargeCents([{ line_items: [base, foreignAddon, credited] }], visitId)).toBe(11000);
  });

  test('add-on lines with no base line count nothing', () => {
    expect(sumVisitChargeCents([{ line_items: [feeAddon] }], visitId)).toBe(0);
    expect(sumVisitChargeCents([{ line_items: 'not json' }], visitId)).toBe(0);
    expect(sumVisitChargeCents([{ line_items: [base, feeAddon] }], null)).toBe(0);
  });
});

describe('the completion that parks an alert hands it to the shared reconcile', () => {
  const dispatch = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');

  test('with the gate on, the post-commit reconcile runs once the alert transaction committed', () => {
    const failedAt = dispatch.indexOf("code: 'unminted_setup_fee_alert_failed'");
    const handOffAt = dispatch.indexOf("if (require('../config/feature-gates').setupFeeApplicationSettledLive()) setupFeeReconcileAfterCommit = true;");
    const reconcileAt = dispatch.indexOf('if (setupFeeReconcileAfterCommit) {');
    expect(failedAt).toBeGreaterThan(0);
    expect(handOffAt).toBeGreaterThan(failedAt);
    expect(reconcileAt).toBeGreaterThan(handOffAt);
  });
});

jest.setTimeout(120000);

postgres('setup-fee alert reconcile: an application billed by a prepay year or the visit\'s own invoice', () => {
  let database;
  let trx;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    // As in prod since 10-24: the fee side reads the customer's own invoices.
    process.env.GATE_SETUP_FEE_SETTLED_ANYWHERE = 'true';
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    require('../models/db').connection = database;
  });

  beforeEach(async () => {
    delete process.env[GATE];
    delete process.env[NOTICE];
    trx = await database.transaction();
    require('../models/db').connection = trx;
    require('../services/annual-prepay-renewals')._private.resetCachesForTests();
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => {
    delete process.env[GATE];
    delete process.env[NOTICE];
    delete process.env.GATE_SETUP_FEE_SETTLED_ANYWHERE;
    await database?.destroy();
  });

  const { etDateString, addETDays } = require('../utils/datetime-et');
  const day = (offset) => etDateString(addETDays(new Date(), offset));
  const { reconcileSetupFeeAlert } = require('../services/setup-fee-alert-reconcile');
  const { prepayYearBillingVisit } = require('../services/annual-prepay-renewals');

  async function customerWithEstimate() {
    const customerId = randomUUID();
    const estimateId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'SetupFee', phone: '+12025550142',
      email: `${customerId}@example.invalid` });
    await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted', estimate_data: JSON.stringify({}) });
    return { customerId, estimateId };
  }

  async function visit(customerId, { date, status = 'pending', serviceType = 'Quarterly Pest Control Service', price,
    estimateId, parentId = null, termId = null, prepaidAmount = null }) {
    const id = randomUUID();
    await trx('scheduled_services').insert({ id, customer_id: customerId, service_type: serviceType, scheduled_date: date,
      window_start: '09:00', window_end: '10:00', status, estimated_price: price, source_estimate_id: estimateId,
      is_recurring: true, recurring_parent_id: parentId, annual_prepay_term_id: termId,
      ...(prepaidAmount ? { prepaid_amount: prepaidAmount, prepaid_method: 'annual_prepay_invoice' } : {}) });
    return id;
  }

  async function serviceRecord(customerId, visitId, date) {
    const id = randomUUID();
    await trx('service_records').insert({ id, customer_id: customerId, scheduled_service_id: visitId,
      service_type: 'Quarterly Pest Control Service', service_date: date, status: 'completed' });
    return id;
  }

  async function invoice(customerId, { status, total, lines, visitId = null, recordId = null, notes = null }) {
    const id = randomUUID();
    await trx('invoices').insert({ id, customer_id: customerId, invoice_number: `TEST-${id.slice(0, 8)}`,
      token: randomUUID().replace(/-/g, ''), status, total, subtotal: total, line_items: JSON.stringify(lines),
      scheduled_service_id: visitId, service_record_id: recordId, notes, paid_at: status === 'paid' ? new Date() : null });
    return id;
  }

  async function prepayTerm(customerId, { status, invoiceId, start, end, amount, coverage }) {
    const id = randomUUID();
    await trx('annual_prepay_terms').insert({ id, customer_id: customerId, status, prepay_invoice_id: invoiceId,
      term_start: start, term_end: end, prepay_amount: amount, plan_label: 'Synthetic Annual',
      coverage_service_type: coverage, coverage_visit_count: 4, coverage_cadence: 'quarterly' });
    return id;
  }

  // The alert as prod held it after the 10-26 sweep: a person marked it Done,
  // and its state says the fee is covered and this visit's application owed.
  async function standingAlert({ customerId, estimateId, visitId, recordId, expectedAppCents }) {
    const id = randomUUID();
    await trx('notifications').insert({ id, recipient_type: 'admin', category: 'billing',
      title: 'Completed first visit needs manual billing — setup fee was never invoiced', body: 'OLD COPY',
      metadata: JSON.stringify({ dedupeKey: `unminted_setup_fee_manual_billing:${estimateId}`, customerId,
        scheduledServiceId: visitId, serviceRecordId: recordId, sourceEstimateId: estimateId, expectedSetupFeeCents: 9900,
        expectedApplicationCentsByVisit: { [visitId]: expectedAppCents }, feeCovered: true, applicationCovered: false,
        coveredFeeCents: 0, uncoveredVisitIds: [visitId], resolvedCovered: false }),
      read_at: new Date(), done_at: new Date(), done_by: 'owner', resolution: 'Covered elsewhere. Nothing to bill.' });
    return id;
  }

  // 08-25: the office put the $99 fee on the first visit as a WaveGuard
  // Membership add-on, so the alert froze the visit charge at $209; the
  // visit's own invoice billed $110 + $99 and was paid.
  async function feeAddonOnTheVisit({ withBaseLine = true, invoiceStatus = 'paid' } = {}) {
    const { customerId, estimateId } = await customerWithEstimate();
    const visitId = await visit(customerId, { date: day(-64), status: 'completed', serviceType: 'Pest Control Service',
      price: 209, estimateId });
    const addonId = randomUUID();
    await trx('scheduled_service_addons').insert({ id: addonId, scheduled_service_id: visitId,
      service_name: 'WaveGuard Membership', base_price: 99, estimated_price: 99 });
    const recordId = await serviceRecord(customerId, visitId, day(-64));
    const addonLine = { client_id: `scheduled_${visitId}_addon_${addonId}`, description: 'WaveGuard Membership',
      category: 'WaveGuard Membership', amount: 99, quantity: 1, unit_price: 99 };
    const baseLine = { client_id: `scheduled_${visitId}_primary`, description: 'Pest Control Service',
      category: 'Pest Control Service', amount: 110, quantity: 1, unit_price: 110 };
    const invoiceId = await invoice(customerId, { status: invoiceStatus, total: withBaseLine ? 209 : 99, visitId,
      lines: withBaseLine ? [baseLine, addonLine] : [addonLine] });
    const alertId = await standingAlert({ customerId, estimateId, visitId, recordId, expectedAppCents: 20900 });
    return { customerId, estimateId, visitId, alertId, invoiceId, invoiceNumber: `TEST-${invoiceId.slice(0, 8)}` };
  }

  // 09-11: a same-day annual sale. The visit's own invoice is the year's
  // prepay invoice (4 x $108, setup fee waived), not yet paid; the year waits
  // in payment_pending and covers the four visits from 09-11 on.
  async function yearAwaitingItsInvoice({ invoiceStatus = 'viewed' } = {}) {
    const { customerId, estimateId } = await customerWithEstimate();
    const visitId = await visit(customerId, { date: day(-47), status: 'completed', price: 108, estimateId });
    for (const offset of [44, 135, 226]) await visit(customerId, { date: day(offset), price: 108, estimateId, parentId: visitId });
    const recordId = await serviceRecord(customerId, visitId, day(-47));
    const invoiceId = await invoice(customerId, { status: invoiceStatus, total: 432, visitId, recordId,
      notes: `Auto-generated from accepted estimate #${estimateId}.`,
      lines: [
        { description: 'Quarterly Pest Control Service — 4 prepaid applications', amount: 432, quantity: 4, unit_price: 108 },
        { description: 'WaveGuard setup fee — waived with annual prepay', amount: 0, quantity: 1, unit_price: 0 },
      ] });
    await prepayTerm(customerId, { status: 'payment_pending', invoiceId, start: day(-51), end: day(314), amount: 432,
      coverage: 'Quarterly Pest Control Service' });
    const alertId = await standingAlert({ customerId, estimateId, visitId, recordId, expectedAppCents: 10800 });
    return { customerId, estimateId, visitId, alertId };
  }

  // 09-25: the acceptance invoice was voided for an annual prepay the
  // customer paid days AFTER the first visit was completed. The year covers
  // that visit and three later ones; only the later ones were stamped prepaid.
  // `fifthVisit`: the year's four slots are taken by other visits instead.
  async function yearPaidAfterTheVisit({ fifthVisit = false } = {}) {
    const { customerId, estimateId } = await customerWithEstimate();
    const invoiceId = await invoice(customerId, { status: 'paid', total: 495.96,
      notes: 'Annual prepaid Quarterly Pest Control.',
      lines: [{ description: 'Quarterly Pest Control - 4 prepaid applications', category: 'Annual prepay',
        amount: 495.96, quantity: 1, unit_price: 495.96 }] });
    const termId = await prepayTerm(customerId, { status: 'active', invoiceId, start: day(-33), end: day(338),
      amount: 495.96, coverage: 'Quarterly Pest Control' });
    const visitId = await visit(customerId, { date: day(-33), status: 'completed', price: 124, estimateId,
      termId: fifthVisit ? null : termId });
    for (const offset of (fifthVisit ? [61, 152, 243, 300] : [61, 152, 243])) {
      await visit(customerId, { date: day(offset), price: 124, estimateId, parentId: visitId, termId, prepaidAmount: 123.99 });
    }
    const recordId = await serviceRecord(customerId, visitId, day(-33));
    await invoice(customerId, { status: 'void', total: 223, visitId, notes: `Auto-generated from accepted estimate #${estimateId}.`,
      lines: [
        { description: 'WaveGuard Membership — one-time setup fee', amount: 99, quantity: 1, unit_price: 99 },
        { description: 'First service application', amount: 124, quantity: 1, unit_price: 124 },
      ] });
    const alertId = await standingAlert({ customerId, estimateId, visitId, recordId, expectedAppCents: 12400 });
    return { customerId, estimateId, visitId, alertId, termId };
  }

  async function reconciled(shape) {
    await reconcileSetupFeeAlert({ customerId: shape.customerId, sourceEstimateId: shape.estimateId });
    const row = await trx('notifications').where({ id: shape.alertId }).first();
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    return { text: row.detail || row.body, meta, row };
  }

  const SHAPES = [
    ['08-25: the setup fee rode the visit as an add-on', feeAddonOnTheVisit],
    ['09-11: the visit is on the year\'s unpaid prepay invoice', yearAwaitingItsInvoice],
    ['09-25: the year was paid after the visit was completed', yearPaidAfterTheVisit],
  ];

  describe.each(SHAPES)('%s', (_name, build) => {
    test('gate off: the alert still names the application as owed (the bug)', async () => {
      const shape = await build();
      const { text, meta } = await reconciled(shape);
      expect(text).toContain(`Still owed: the application charge for visit ${shape.visitId}`);
      expect(meta.resolvedCovered).toBe(false);
    });

    test('gate on: the alert resolves and stays done, the person\'s note kept', async () => {
      process.env[GATE] = 'true';
      const shape = await build();
      const { text, meta, row } = await reconciled(shape);
      expect(text).toMatch(/^RESOLVED — no action needed/);
      expect(meta.resolvedCovered).toBe(true);
      expect(row.done_at).not.toBeNull();
      expect(row.resolution).toBe('Covered elsewhere. Nothing to bill.');
    });
  });

  describe('gate on, the application is still owed when nothing bills it', () => {
    beforeEach(() => { process.env[GATE] = 'true'; });

    test('the year\'s prepay invoice was voided', async () => {
      const shape = await yearAwaitingItsInvoice({ invoiceStatus: 'void' });
      expect(await prepayYearBillingVisit(await trx('scheduled_services').where({ id: shape.visitId }).first(), trx)).toBeNull();
      const { text, meta } = await reconciled(shape);
      expect(text).toContain(`the application charge for visit ${shape.visitId}`);
      expect(meta.resolvedCovered).toBe(false);
    });

    test('the year bought four other visits', async () => {
      const shape = await yearPaidAfterTheVisit({ fifthVisit: true });
      expect(await prepayYearBillingVisit(await trx('scheduled_services').where({ id: shape.visitId }).first(), trx)).toBeNull();
      const { text } = await reconciled(shape);
      expect(text).toContain(`Still owed: the application charge for visit ${shape.visitId}`);
    });

    test('the visit\'s invoice bills only its add-on', async () => {
      const shape = await feeAddonOnTheVisit({ withBaseLine: false });
      const { text } = await reconciled(shape);
      expect(text).toContain(`Still owed: the application charge for visit ${shape.visitId}`);
    });
  });

  // The 08-25 shape with the visit's invoice not paid yet: the plain "WaveGuard
  // Membership" add-on is fee money only once paid, so the alert said to bill a fee
  // the customer was already invoiced for.
  describe('the fee add-on on a visit invoice not paid yet (application gate on, as in prod)', () => {
    beforeEach(() => { process.env[GATE] = 'true'; });
    const owedFee = 'Still owed: the one-time WaveGuard setup fee';
    const owedBoth = 'UPDATE: still owed for this estimate: the one-time WaveGuard setup fee';

    test('notice off: the alert says to bill the fee again (the gap)', async () => {
      const shape = await feeAddonOnTheVisit({ invoiceStatus: 'sent' });
      const { text, meta } = await reconciled(shape);
      expect(text).toContain(owedFee);
      expect(meta.feeOnOpenInvoice).toBe(false);
    });

    test('notice on: the alert names the open invoice and stays open, a Done sticks, and off restores the fee instruction', async () => {
      process.env[NOTICE] = 'true';
      const shape = await feeAddonOnTheVisit({ invoiceStatus: 'sent' });
      const { text, meta, row } = await reconciled(shape);
      expect(text).toBe(`UPDATE: nothing to bill — the one-time setup fee is already on open invoice ${shape.invoiceNumber} (not paid yet) and every parked visit's application charge for this estimate is COVERED. Do NOT bill the setup fee or an application again; this alert clears by itself after the customer pays.`);
      expect(meta).toMatchObject({ feeOnOpenInvoice: true, feeCovered: false, applicationCovered: true, resolvedCovered: false });
      expect(row.done_at).toBeNull();
      await trx('notifications').where({ id: shape.alertId }).update({ read_at: new Date(), done_at: new Date(), done_by: 'owner' });
      expect((await reconciled(shape)).row.done_by).toBe('owner');
      delete process.env[NOTICE];
      const off = await reconciled(shape);
      expect(off.text).toContain(owedFee);
      expect(off.meta.feeOnOpenInvoice).toBe(false);
      expect(off.row.done_at).toBeNull();
    });

    test('notice on: once the customer pays, the alert resolves', async () => {
      process.env[NOTICE] = 'true';
      const shape = await feeAddonOnTheVisit({ invoiceStatus: 'viewed' });
      expect((await reconciled(shape)).meta.feeOnOpenInvoice).toBe(true);
      await trx('invoices').where({ id: shape.invoiceId }).update({ status: 'paid', paid_at: new Date() });
      const { text, meta, row } = await reconciled(shape);
      expect(text).toMatch(/^RESOLVED — no action needed/);
      expect(meta.resolvedCovered).toBe(true);
      expect(row.done_at).not.toBeNull();
    });

    test('notice on: voiding the invoice brings both charges back', async () => {
      process.env[NOTICE] = 'true';
      const shape = await feeAddonOnTheVisit({ invoiceStatus: 'overdue' });
      expect((await reconciled(shape)).meta.feeOnOpenInvoice).toBe(true);
      await trx('invoices').where({ id: shape.invoiceId }).update({ status: 'void' });
      const { text, meta } = await reconciled(shape);
      expect(text).toContain(owedBoth);
      expect(text).toContain(`plus the application charge for visit ${shape.visitId}`);
      expect(meta.feeOnOpenInvoice).toBe(false);
    });

    test('notice on: open fee lines short of the fee change nothing', async () => {
      process.env[NOTICE] = 'true';
      const shape = await feeAddonOnTheVisit({ invoiceStatus: 'sent' });
      const { line_items: stored } = await trx('invoices').where({ id: shape.invoiceId }).first('line_items');
      const lines = (typeof stored === 'string' ? JSON.parse(stored) : stored).map((li) => (li.description === 'WaveGuard Membership'
        ? { ...li, amount: 50, unit_price: 50 } : { ...li, amount: 159, unit_price: 159 }));
      await trx('invoices').where({ id: shape.invoiceId }).update({ line_items: JSON.stringify(lines) });
      const { text, meta } = await reconciled(shape);
      expect(text).toContain(owedFee);
      expect(meta.feeOnOpenInvoice).toBe(false);
    });

    test('notice on, the application owed too: the notice keeps the application instruction, and off restores the fee', async () => {
      process.env[NOTICE] = 'true';
      const shape = await feeAddonOnTheVisit({ withBaseLine: false, invoiceStatus: 'sent' });
      // As raised at completion: no coverage state recorded yet.
      await trx('notifications').where({ id: shape.alertId }).update({ done_at: null, done_by: null, resolution: null,
        metadata: trx.raw("metadata - 'feeCovered' - 'applicationCovered' - 'coveredFeeCents' - 'uncoveredVisitIds' - 'resolvedCovered'") });
      const on = await reconciled(shape);
      expect(on.text).toContain(`UPDATE: the one-time setup fee is already on open invoice ${shape.invoiceNumber} (not paid yet) — do NOT bill it again. Still owed: the application charge for visit ${shape.visitId}`);
      expect(on.meta.feeOnOpenInvoice).toBe(true);
      delete process.env[NOTICE];
      const off = await reconciled(shape);
      expect(off.text).toContain(owedBoth);
      expect(off.meta.feeOnOpenInvoice).toBe(false);
    });
  });

  test('prepayYearBillingVisit names the year that bought the visit', async () => {
    const shape = await yearPaidAfterTheVisit();
    const term = await prepayYearBillingVisit(await trx('scheduled_services').where({ id: shape.visitId }).first(), trx);
    expect(term?.id).toBe(shape.termId);
  });
});
