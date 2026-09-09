const { randomUUID } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice', () => ({ CANCELLED_SERVICE_RESOLVED_STATUSES: ['void', 'refunded', 'canceled', 'cancelled'] }));
const { plan, evaluate } = require('../../ops/agents/link-unlinked-visit-invoices');
const { createRepairDatabase, seedPair } = require('./helpers/invoice-repair-db');

jest.setTimeout(30000);
(process.env.REPAIR_TEST_DATABASE_URL ? describe : describe.skip)('read-only invoice planner on PostgreSQL', () => {
  let fixture; let db;
  beforeEach(async () => { fixture = await createRepairDatabase(); db = fixture.db; });
  afterEach(async () => { await fixture.destroy(); });
  const readPlan = () => db.transaction((trx) => plan(trx), { isolationLevel: 'repeatable read', readOnly: true });

  test('builds a canonical pairing inside a database-enforced read-only transaction', async () => {
    const ids = await seedPair(db, { invoice: { tech_name: 'Former Technician' } });
    const before = await db('invoices').first();
    const result = await readPlan();
    expect(result).toMatchObject({ version: 2, scanned: 1, pairings: [{ invoiceId: ids.invoiceId,
      visitId: ids.visitId, serviceRecordId: ids.recordId, technicianId: ids.techId, techName: null }] });
    expect(await db('invoices').first()).toEqual(before);
  });
  test.each(['void', 'refunded', 'canceled', 'cancelled'])('excludes a terminal invoice: %s', async (status) => {
    await seedPair(db, { invoice: { status } });
    expect((await readPlan()).pairings).toEqual([]);
  });
  test.each(['visit', 'record'])('refuses callback evidence from the %s', async (source) => {
    const ids = await seedPair(db, { [source]: { is_callback: true } });
    expect(await evaluate(db, ids.invoiceId)).toEqual({ skip: 'callback' });
  });
  test('refuses a combined label and a distinct invoice on the same day', async () => {
    const ids = await seedPair(db, { visit: { service_type: 'Quarterly Pest + Termite Bait Station Service' } });
    expect((await readPlan()).skipped).toEqual({ compositeVisit: 1 });
    await db('scheduled_services').where({ id: ids.visitId }).update({ service_type: 'Pest Control' });
    const inv = await db('invoices').first();
    await db('invoices').insert({ ...inv, id: randomUUID(), line_items: JSON.stringify(inv.line_items) });
    expect((await readPlan()).skipped).toEqual({ ambiguous: 2 });
  });
  test('refuses a second visit even if only the first has completion evidence', async () => {
    const ids = await seedPair(db);
    await db('scheduled_services').insert({ id: randomUUID(), customer_id: ids.customerId, scheduled_date: '2020-01-01', status: 'confirmed' });
    expect((await readPlan()).skipped).toEqual({ ambiguous: 1 });
  });
  test('treats a NULL-status invoice as live for uniqueness and existing-bill checks', async () => {
    const ids = await seedPair(db);
    const sibling = randomUUID();
    await db('invoices').insert({ id: sibling, customer_id: ids.customerId, service_date: '2020-01-01', status: null });
    expect(await evaluate(db, ids.invoiceId)).toEqual({ skip: 'ambiguous' });
    await db('invoices').where({ id: sibling }).update({ service_date: '2020-01-02', scheduled_service_id: ids.visitId });
    expect(await evaluate(db, ids.invoiceId)).toEqual({ skip: 'visitAlreadyInvoiced' });
  });
  test.each([
    { service_type: 'Waves Pest Control Appointment Service' }, { followup_included: true },
  ])('refuses designated no-cost work: %j', async (visit) => {
    const ids = await seedPair(db, { visit });
    expect(await evaluate(db, ids.invoiceId)).toEqual({ skip: 'noCostVisit' });
  });
  test.each([
    { prepaid_method: 'annual_prepay_invoice', prepaid_amount: 40, annual_prepay_term_id: randomUUID() },
    { prepaid_method: 'annual_prepay_invoice' }, { annual_prepay_term_id: randomUUID() }, { prepaid_method: 'cash', prepaid_amount: 100 },
  ])('refuses prepaid visits: %j', async (visit) => {
    const ids = await seedPair(db, { visit });
    expect(await evaluate(db, ids.invoiceId)).toEqual({ skip: 'prepaid' });
  });
  test('refuses conflicting visit identities and accepts agreeing ones', async () => {
    const ids = await seedPair(db, { visit: { service_key_snapshot: 'termite_bait' } });
    expect(await evaluate(db, ids.invoiceId)).toEqual({ skip: 'identityConflict' });
    const serviceId = randomUUID();
    await db('services').insert({ id: serviceId, name: 'Termite Bait Station Service', service_key: 'termite_bait' });
    await db('scheduled_services').where({ id: ids.visitId }).update({ service_key_snapshot: null, service_id: serviceId });
    expect(await evaluate(db, ids.invoiceId)).toEqual({ skip: 'identityConflict' });
    await db('services').where({ id: serviceId }).update({ name: 'Pest Control', service_key: 'pest_general_quarterly' });
    await db('scheduled_services').where({ id: ids.visitId }).update({ service_key_snapshot: 'pest_general_quarterly' });
    expect((await evaluate(db, ids.invoiceId)).pairing).toMatchObject({ visitId: ids.visitId });
  });
  test('counts a legacy record-linked invoice as a competing bill', async () => {
    const ids = await seedPair(db); const legacyRecordId = randomUUID();
    await db('service_records').insert({ id: legacyRecordId, customer_id: ids.customerId });
    await db('invoices').insert({ id: randomUUID(), customer_id: ids.customerId, service_date: '2020-01-01',
      status: 'paid', service_record_id: legacyRecordId });
    expect(await readPlan()).toMatchObject({ scanned: 1, pairings: [], skipped: { ambiguous: 1 } });
  });
  test('excludes prepay invoices owned only by the term and ignores null term links', async () => {
    const ids = await seedPair(db);
    await db('annual_prepay_terms').insert({ id: randomUUID() });
    expect((await readPlan()).pairings).toHaveLength(1);
    await db('annual_prepay_terms').insert({ id: randomUUID(), prepay_invoice_id: ids.invoiceId });
    expect(await readPlan()).toMatchObject({ scanned: 0, pairings: [] });
    expect(await evaluate(db, ids.invoiceId)).toEqual({ skip: 'invoiceChanged' });
  });
  test('catalog membership cannot turn inspection charges into treatment evidence', async () => {
    await seedPair(db, { visit: { service_type: 'Quarterly Pest Control Service' },
      invoice: { line_items: JSON.stringify([{ description: 'Pest Inspection Service', amount: 100 }]) } });
    await db('services').insert({ id: randomUUID(), name: 'Pest Inspection Service' });
    expect((await readPlan()).skipped).toEqual({ noEvidence: 1 });
  });
  test.each(['scheduled_service_addons', 'visit_billing_dispositions'])('refuses existing %s rows', async (table) => {
    const ids = await seedPair(db);
    await db(table).insert({ id: randomUUID(), scheduled_service_id: ids.visitId });
    expect((await readPlan()).pairings).toEqual([]);
  });
  test('requires effective payer and PO agreement through the real payer reader', async () => {
    const ids = await seedPair(db);
    await db('payers').insert({ id: 1, tax_exempt: true });
    await db('scheduled_services').where({ id: ids.visitId }).update({ payer_id: 1, po_number: 'FIXTURE-PO' });
    expect((await readPlan()).skipped).toEqual({ billToMismatch: 1 });
    await db('invoices').where({ id: ids.invoiceId }).update({ payer_id: 1, po_number: 'FIXTURE-PO' });
    expect((await readPlan()).pairings).toHaveLength(1);
  });
  test('the CLI replaces an existing plan with an empty result', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-plan-postgres-'));
    const file = path.join(dir, 'plan.json');
    fs.writeFileSync(file, '{"pairings":["stale"]}');
    const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${fixture.schema}`);
    try {
      await promisify(execFile)(process.execPath, ['ops/agents/link-unlinked-visit-invoices.js', `--plan-out=${file}`], {
        cwd: path.join(__dirname, '../..'), env: { PATH: process.env.PATH, NODE_ENV: 'test', REPAIR_DATABASE_URL: url.toString() },
      });
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ version: 2, pairings: [] });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
