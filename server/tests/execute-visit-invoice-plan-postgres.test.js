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
  const review = async (ids) => (await evaluate(db, ids.invoiceId)).pairing;
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
  async function holdInvoiceUpdates() {
    // Pause the final UPDATE after eligibility reads, using a test-only trigger.
    await db.raw(`CREATE FUNCTION pause_invoice_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(4121, 1); RETURN NEW; END $$;
      CREATE TRIGGER pause_invoice_update BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION pause_invoice_update();`);
    const barrier = await db.transaction();
    const { rows: [{ pid }] } = await barrier.raw('SELECT pg_backend_pid() AS pid');
    await barrier.raw('SELECT pg_advisory_xact_lock(4121, 1)');
    return { barrier, pid };
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
  test.each(['visitCallback', 'recordCallback', 'composite', 'amount', 'techName', 'newRecord', 'disposition', 'prepay', 'legacyInvoice', 'catalogEdit'])('refuses post-review drift: %s', async (change) => {
    const ids = await seedPair(db);
    const serviceId = randomUUID();
    await db('services').insert({ id: serviceId, name: 'Pest Control', service_key: 'pest_general_quarterly' });
    await db('scheduled_services').where({ id: ids.visitId }).update({ service_id: serviceId });
    const reviewed = await review(ids);
    if (change === 'catalogEdit') await db('services').where({ id: serviceId }).update({ service_key: 'pest_termite_bait_quarterly' });
    if (change === 'visitCallback') await db('scheduled_services').where({ id: ids.visitId }).update({ is_callback: true });
    if (change === 'recordCallback') await db('service_records').where({ id: ids.recordId }).update({ is_callback: true });
    if (change === 'composite') await db('scheduled_services').where({ id: ids.visitId }).update({ service_type: 'Quarterly Pest + Termite Bait Station Service' });
    if (change === 'amount') await db('invoices').where({ id: ids.invoiceId }).update({ total: 150 });
    if (change === 'techName') await db('invoices').where({ id: ids.invoiceId }).update({ tech_name: 'Changed Technician' });
    if (change === 'newRecord') await db('service_records').insert({ id: randomUUID(), scheduled_service_id: ids.visitId });
    if (change === 'disposition') await db('visit_billing_dispositions').insert({ id: randomUUID(), scheduled_service_id: ids.visitId });
    if (change === 'prepay') await db('annual_prepay_terms').insert({ id: randomUUID(), prepay_invoice_id: ids.invoiceId });
    if (change === 'legacyInvoice') {
      const recordId = randomUUID();
      await db('service_records').insert({ id: recordId, customer_id: ids.customerId });
      await db('invoices').insert({ id: randomUUID(), customer_id: ids.customerId, status: 'paid',
        service_date: '2020-01-01', service_record_id: recordId });
    }
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
  test('refuses a pending callback edit and still rejects the reviewed plan after it commits', async () => {
    const ids = await seedPair(db); const reviewed = await review(ids);
    const edit = await db.transaction();
    try {
      await edit('service_records').where({ id: ids.recordId }).update({ is_callback: true });
      await expect(executePlan(db, [reviewed])).rejects.toMatchObject({ code: '55P03',
        message: expect.stringContaining('could not obtain lock on row in relation "service_records"') });
    } finally { await edit.commit(); }
    await expect(executePlan(db, [reviewed])).rejects.toThrow('callback');
    expect((await invoice(ids)).scheduled_service_id).toBeNull();
  });
  test.each(['reviewed', 'sibling'])('refuses a %s visit editor before it waits for an invoice', async (target) => {
    const ids = await seedPair(db); const reviewed = await review(ids);
    const edited = target === 'reviewed' ? ids : await seedPair(db, { customerId: ids.customerId,
      invoice: { service_date: '2020-01-02', status: 'sent' }, visit: { scheduled_date: '2020-01-02' } });
    const edit = await db.transaction();
    try {
      // admin-schedule re-service conversion holds the visit before locking
      // its invoice to void it. Cover both the reviewed visit and another date.
      await edit('scheduled_services').where({ id: edited.visitId }).forUpdate();
      await expect(executePlan(db, [reviewed])).rejects.toMatchObject({ code: '55P03',
        message: expect.stringContaining('could not obtain lock on row in relation "scheduled_services"') });
      await edit.raw("SET LOCAL lock_timeout = '100ms'");
      expect(await edit('invoices').where({ id: edited.invoiceId }).update({ status: 'void' })).toBe(1);
    } finally { await edit.rollback(); }
    expect((await invoice(ids)).scheduled_service_id).toBeNull();
  });
  test('refuses a busy customer so a customer-first merge can finish its invoice sweep', async () => {
    const ids = await seedPair(db); const reviewed = await review(ids); const winnerId = randomUUID();
    await db('customers').insert({ id: winnerId });
    const merge = await db.transaction();
    try {
      // customer-dedupe.executeMerge locks both customers before its FK sweep.
      await merge('customers').whereIn('id', [winnerId, ids.customerId]).forUpdate();
      await expect(executePlan(db, [reviewed])).rejects.toMatchObject({ code: '55P03' });
      await merge.raw("SET LOCAL lock_timeout = '100ms'");
      expect(await merge('invoices').where({ customer_id: ids.customerId }).update({ customer_id: winnerId })).toBe(1);
      await merge.commit();
    } finally { if (!merge.isCompleted()) await merge.rollback(); }
    expect(await invoice(ids)).toMatchObject({ customer_id: winnerId, scheduled_service_id: null });
  });
  test('refuses a customer FK lock without blocking a concurrent invoice insert', async () => {
    const ids = await seedPair(db); const reviewed = await review(ids);
    const insert = await db.transaction();
    try {
      await insert('customers').where({ id: ids.customerId }).forKeyShare().first();
      await expect(executePlan(db, [reviewed])).rejects.toMatchObject({ code: '55P03' });
      await insert('invoices').insert({ id: randomUUID(), customer_id: ids.customerId, status: 'void', service_date: '2020-01-01' });
    } finally { await insert.commit(); }
    expect((await invoice(ids)).scheduled_service_id).toBeNull();
  });
  test('fails fast during a partial invoice sweep and releases earlier invoice locks', async () => {
    const ids = await seedPair(db); const reviewed = await review(ids);
    const siblingId = randomUUID(); const winnerId = randomUUID();
    await db('customers').insert({ id: winnerId });
    await db('invoices').insert({ id: siblingId, customer_id: ids.customerId, status: 'void' });
    const [firstId, lastId] = [ids.invoiceId, siblingId].sort();
    const merge = await db.transaction();
    try {
      await merge('customers').whereIn('id', [winnerId, ids.customerId]).forUpdate();
      // Model a bulk merge UPDATE reaching the higher UUID first. The repair
      // takes the lower UUID first, so blocking on this row would form a cycle.
      await merge('invoices').where({ id: lastId }).update({ customer_id: winnerId });
      await expect(executePlan(db, [reviewed])).rejects.toMatchObject({ code: '55P03',
        message: expect.stringContaining('could not obtain lock on row in relation "invoices"') });
      await merge.raw("SET LOCAL lock_timeout = '100ms'");
      expect(await merge('invoices').where({ id: firstId }).update({ customer_id: winnerId })).toBe(1);
      await merge.commit();
    } finally { if (!merge.isCompleted()) await merge.rollback(); }
    expect(await invoice(ids)).toMatchObject({ customer_id: winnerId, scheduled_service_id: null });
  });
  test.each(['recordEdit', 'newRecord', 'newInvoice', 'siblingInvoice', 'siblingVisit', 'payerEdit', 'attemptEdit', 'newVisit', 'newAddon', 'newPrepay', 'catalogEdit'])('holds %s against changes after revalidation until commit', async (change) => {
    const ids = await seedPair(db);
    const siblingInvoiceId = randomUUID(); const siblingVisitId = randomUUID(); const attemptId = randomUUID(); const serviceId = randomUUID();
    await db('services').insert({ id: serviceId, name: 'Pest Control', service_key: 'pest_general_quarterly' });
    await db('scheduled_services').where({ id: ids.visitId }).update({ service_id: serviceId });
    await db('payers').insert({ id: 1 });
    await db('scheduled_services').where({ id: ids.visitId }).update({ payer_id: 1 });
    await db('invoices').where({ id: ids.invoiceId }).update({ payer_id: 1 });
    await db('invoices').insert({ id: siblingInvoiceId, customer_id: ids.customerId, status: 'void', service_date: '2020-01-01' });
    await db('scheduled_services').insert({ id: siblingVisitId, customer_id: ids.customerId, status: 'rescheduled', scheduled_date: '2020-01-01' });
    await db('service_records').insert({ id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.visitId });
    await db('service_completion_attempts').insert({ id: attemptId, service_id: ids.visitId, service_record_id: ids.recordId, status: 'succeeded' });
    const reviewed = await review(ids);
    const { barrier, pid } = await holdInvoiceUpdates();
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
        if (change === 'newPrepay') query = edit('annual_prepay_terms').insert({ id: randomUUID(), prepay_invoice_id: ids.invoiceId });
        if (change === 'catalogEdit') query = edit('services').where({ id: serviceId }).update({ service_key: 'pest_termite_bait_quarterly' });
        await expect(query).rejects.toMatchObject({ code: '55P03' });
      } finally { await edit.rollback(); }
    } finally { await barrier.commit(); }
    await completed;
    expect((await invoice(ids)).scheduled_service_id).toBe(ids.visitId);
  });
  test('catalog insertions cannot change an in-flight exact-label repair', async () => {
    const ids = await seedPair(db); const reviewed = await review(ids);
    const { barrier, pid } = await holdInvoiceUpdates();
    const completed = expect(executePlan(db, [reviewed])).resolves.toBe(1);
    try {
      await waitForBlocker(pid);
      await db('services').insert({ id: randomUUID(), name: 'Pest Control + Mosquito Control' });
      expect(await review(ids)).toEqual(reviewed);
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
