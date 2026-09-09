const { randomUUID } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice', () => ({ CANCELLED_SERVICE_RESOLVED_STATUSES: ['void', 'refunded', 'canceled', 'cancelled'] }));
const { executePlan } = require('../../ops/agents/execute-visit-invoice-plan');
const { evaluate } = require('../../ops/agents/link-unlinked-visit-invoices');
const { createRepairDatabase, seedPair } = require('./helpers/invoice-repair-db');

jest.setTimeout(30000);
(process.env.REPAIR_TEST_DATABASE_URL ? describe : describe.skip)('reviewed invoice executor on PostgreSQL', () => {
  let fixture; let db;
  beforeEach(async () => { fixture = await createRepairDatabase(); db = fixture.db; });
  afterEach(async () => { await fixture.destroy(); });
  const review = async (ids) => (await evaluate(db, ids.invoiceId, new Set())).pairing;
  const invoice = (ids) => db('invoices').where({ id: ids.invoiceId }).first();
  async function waitForBlocker(pid) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const { rows } = await db.raw('SELECT pid FROM pg_stat_activity WHERE ?::int = ANY(pg_blocking_pids(pid))', [pid]);
      if (rows.length) return rows[0].pid;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Expected executor to reach the held database lock');
  }

  test('applies reviewed links and clears the stale technician name without changing money fields', async () => {
    const ids = await seedPair(db, { invoice: { tech_name: 'Former Technician' } });
    const before = await invoice(ids);
    expect(await executePlan(db, [await review(ids)])).toBe(1);
    const after = await invoice(ids);
    expect(after).toMatchObject({ scheduled_service_id: ids.visitId, service_record_id: ids.recordId,
      technician_id: ids.techId, tech_name: null, total: before.total, status: before.status, line_items: before.line_items });
  });
  test('preserves an existing technician and name when the visit has no technician', async () => {
    const ids = await seedPair(db, { visit: { technician_id: null } });
    await db('invoices').where({ id: ids.invoiceId }).update({ technician_id: ids.techId, tech_name: 'Fixture Technician' });
    await executePlan(db, [await review(ids)]);
    expect(await invoice(ids)).toMatchObject({ technician_id: ids.techId, tech_name: 'Fixture Technician' });
  });
  test.each(['visitCallback', 'recordCallback', 'composite', 'amount', 'techName', 'newRecord', 'disposition'])('refuses post-review drift: %s', async (change) => {
    const ids = await seedPair(db); const reviewed = await review(ids);
    if (change === 'visitCallback') await db('scheduled_services').where({ id: ids.visitId }).update({ is_callback: true });
    if (change === 'recordCallback') await db('service_records').where({ id: ids.recordId }).update({ is_callback: true });
    if (change === 'composite') await db('scheduled_services').where({ id: ids.visitId }).update({ service_type: 'Quarterly Pest + Termite Bait Station Service' });
    if (change === 'amount') await db('invoices').where({ id: ids.invoiceId }).update({ total: 150 });
    if (change === 'techName') await db('invoices').where({ id: ids.invoiceId }).update({ tech_name: 'Changed Technician' });
    if (change === 'newRecord') await db('service_records').insert({ id: randomUUID(), scheduled_service_id: ids.visitId });
    if (change === 'disposition') await db('visit_billing_dispositions').insert({ id: randomUUID(), scheduled_service_id: ids.visitId });
    await expect(executePlan(db, [reviewed])).rejects.toThrow('reviewed pairing changed');
    expect((await invoice(ids)).scheduled_service_id).toBeNull();
  });
  test('rolls back an earlier pairing when a later pairing changed', async () => {
    const first = await seedPair(db); const second = await seedPair(db);
    const reviewed = [await review(first), await review(second)];
    await db('invoices').where({ id: second.invoiceId }).update({ total: 200 });
    await expect(executePlan(db, reviewed)).rejects.toThrow('reviewed pairing changed');
    expect((await invoice(first)).scheduled_service_id).toBeNull();
    expect((await invoice(second)).scheduled_service_id).toBeNull();
  });
  test('handles multiple reviewed visits belonging to one customer', async () => {
    const first = await seedPair(db);
    const second = await seedPair(db, { customerId: first.customerId,
      invoice: { service_date: '2020-01-02' }, visit: { scheduled_date: '2020-01-02' } });
    expect(await executePlan(db, [await review(first), await review(second)])).toBe(2);
  });
  test('sees a callback edit that commits while waiting for the record lock', async () => {
    const ids = await seedPair(db); const reviewed = await review(ids);
    const edit = await db.transaction();
    const { rows: [{ pid }] } = await edit.raw('SELECT pg_backend_pid() AS pid');
    await edit('service_records').where({ id: ids.recordId }).update({ is_callback: true });
    const executing = executePlan(db, [reviewed]);
    // Attach rejection handling immediately while another transaction holds it.
    const rejected = expect(executing).rejects.toThrow('callback');
    try { await waitForBlocker(pid); } finally { await edit.commit(); }
    await rejected;
    expect((await invoice(ids)).scheduled_service_id).toBeNull();
  });
  test('aborts if an invoice was inserted between the invoice and customer locks', async () => {
    const ids = await seedPair(db); const reviewed = await review(ids);
    const insert = await db.transaction();
    const { rows: [{ pid }] } = await insert.raw('SELECT pg_backend_pid() AS pid');
    await insert('customers').where({ id: ids.customerId }).forKeyShare().first();
    const executing = executePlan(db, [reviewed]);
    const rejected = expect(executing).rejects.toThrow('Customer invoice set changed');
    try {
      await waitForBlocker(pid);
      await insert('invoices').insert({ id: randomUUID(), customer_id: ids.customerId, status: 'void', service_date: '2020-01-01' });
    } finally { await insert.commit(); }
    await rejected;
    expect((await invoice(ids)).scheduled_service_id).toBeNull();
  });
  test.each(['recordEdit', 'newRecord', 'newInvoice', 'siblingInvoice', 'siblingVisit', 'payerEdit', 'attemptEdit', 'newVisit', 'newAddon'])('holds %s against changes after revalidation until commit', async (change) => {
    const ids = await seedPair(db);
    const siblingInvoiceId = randomUUID(); const siblingVisitId = randomUUID(); const attemptId = randomUUID();
    await db('payers').insert({ id: 1 });
    await db('scheduled_services').where({ id: ids.visitId }).update({ payer_id: 1 });
    await db('invoices').where({ id: ids.invoiceId }).update({ payer_id: 1 });
    await db('invoices').insert({ id: siblingInvoiceId, customer_id: ids.customerId, status: 'void', service_date: '2020-01-01' });
    await db('scheduled_services').insert({ id: siblingVisitId, customer_id: ids.customerId, status: 'rescheduled', scheduled_date: '2020-01-01' });
    await db('service_records').insert({ id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.visitId });
    await db('service_completion_attempts').insert({ id: attemptId, service_id: ids.visitId, service_record_id: ids.recordId, status: 'succeeded' });
    const reviewed = await review(ids);
    // This test-only trigger pauses the final UPDATE after all eligibility
    // reads. It gives a deterministic window to probe each held row/FK lock.
    await db.raw(`CREATE FUNCTION pause_invoice_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(4121, 1); RETURN NEW; END $$;
      CREATE TRIGGER pause_invoice_update BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION pause_invoice_update();`);
    const barrier = await db.transaction();
    const { rows: [{ pid }] } = await barrier.raw('SELECT pg_backend_pid() AS pid');
    await barrier.raw('SELECT pg_advisory_xact_lock(4121, 1)');
    const executing = executePlan(db, [reviewed]);
    const completed = expect(executing).resolves.toBe(1);
    try {
      await waitForBlocker(pid);
      const edit = await db.transaction();
      try {
        await edit.raw("SET LOCAL lock_timeout = '100ms'");
        let query;
        if (change === 'recordEdit') query = edit('service_records').where({ id: ids.recordId }).update({ is_callback: true });
        if (change === 'newRecord') query = edit('service_records').insert({ id: randomUUID(), scheduled_service_id: ids.visitId, is_callback: true });
        if (change === 'newInvoice') query = edit('invoices').insert({ id: randomUUID(), customer_id: ids.customerId, status: 'paid', service_date: '2020-01-01' });
        if (change === 'siblingInvoice') query = edit('invoices').where({ id: siblingInvoiceId }).update({ status: 'paid' });
        if (change === 'siblingVisit') query = edit('scheduled_services').where({ id: siblingVisitId }).update({ status: 'confirmed' });
        if (change === 'attemptEdit') query = edit('service_completion_attempts').where({ id: attemptId }).update({ status: 'failed' });
        if (change === 'newVisit') query = edit('scheduled_services').insert({ id: randomUUID(), customer_id: ids.customerId, scheduled_date: '2020-01-01', status: 'confirmed' });
        if (change === 'newAddon') query = edit('scheduled_service_addons').insert({ id: randomUUID(), scheduled_service_id: ids.visitId });
        if (change === 'payerEdit') query = edit('payers').where({ id: 1 }).update({ tax_exempt: true });
        await expect(query).rejects.toMatchObject({ code: '55P03' });
      } finally { await edit.rollback(); }
    } finally { await barrier.commit(); }
    await completed;
    expect((await invoice(ids)).scheduled_service_id).toBe(ids.visitId);
  });
  test('refuses a second execution of the same reviewed plan', async () => {
    const ids = await seedPair(db); const reviewed = [await review(ids)];
    await executePlan(db, reviewed);
    await expect(executePlan(db, reviewed)).rejects.toThrow('invoiceChanged');
  });
});

describe('executor CLI dry-run default', () => {
  test('shows a saved plan without connecting or requiring database credentials', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-executor-cli-'));
    const file = path.join(dir, 'plan.json');
    fs.writeFileSync(file, JSON.stringify({ version: 2, pairings: [{ invoiceId: randomUUID(), visitId: randomUUID(), digest: 'a'.repeat(64) }] }));
    try {
      const result = spawnSync(process.execPath, ['ops/agents/execute-visit-invoice-plan.js', `--plan=${file}`],
        { cwd: path.join(__dirname, '../..'), env: { PATH: process.env.PATH, NODE_ENV: 'test' }, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('not revalidated; no database connection or writes');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
