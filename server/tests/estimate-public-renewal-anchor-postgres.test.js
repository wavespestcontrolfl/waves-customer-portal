// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// Public annual prepay and conversion share one paid-visit identity, then
// recheck the exact normalized start immediately before the term write.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

const { paidEstimateVisitsQuery } = require('../services/assessment-booking');
const { createTermForAnnualPrepay } = require('../services/annual-prepay-renewals');
const { lockAndAssertNoAnnualPrepayOverlap } = require('../routes/admin-customers')._private;

function dateOnly(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

postgres('public annual-prepay renewal anchor (real PostgreSQL)', () => {
  let database;
  let trx;
  let customerId;
  let estimateId;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
  });

  beforeEach(async () => {
    trx = await database.transaction();
    customerId = randomUUID();
    estimateId = randomUUID();
    await trx('customers').insert({
      id: customerId,
      first_name: 'Synthetic',
      last_name: 'Renewal',
      email: `${customerId}@example.invalid`,
      phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '1 Synthetic Lane',
      city: 'Test City',
      zip: '00000',
      active: true,
      pipeline_stage: 'active_customer',
    });
    await trx('estimates').insert({
      id: estimateId,
      customer_id: customerId,
      status: 'sent',
      service_interest: 'Quarterly Pest Control',
    });
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function visit(overrides = {}) {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id,
      customer_id: customerId,
      source_estimate_id: estimateId,
      scheduled_date: '2098-02-10',
      service_type: 'Quarterly Pest Control Service',
      status: 'confirmed',
      window_start: '09:00',
      window_end: '10:00',
      ...overrides,
    });
    return id;
  }

  test('anchors on the earliest qualifying paid visit, including a stale former hold stamp', async () => {
    await visit({ scheduled_date: '2098-01-05', service_type: 'Waves Assessment' });
    await visit({ scheduled_date: '2098-01-10', customer_id: null,
      reservation_expires_at: trx.raw("NOW() + INTERVAL '15 minutes'") });
    await visit({ scheduled_date: '2098-01-15', is_callback: true });
    await visit({ scheduled_date: '2098-01-20', status: 'cancelled' });
    const legacyReService = await trx('services').where({ service_key: 'pest_re_service' }).first('id');
    expect(legacyReService).toBeTruthy();
    await visit({ scheduled_date: '2098-01-25', status: 'completed', is_callback: false,
      service_id: legacyReService.id, service_type: 'Pest Control Re-Service' });
    const paid = await visit({ reservation_expires_at: trx.raw("NOW() - INTERVAL '1 day'") });

    const rows = await paidEstimateVisitsQuery(trx, { estimateId, customerId });

    expect(rows.map((row) => row.id)).toEqual([paid]);
    expect(dateOnly(rows[0].scheduled_date)).toBe('2098-02-10');
  });

  test('never anchors another customer or a catalog-identified assessment', async () => {
    const assessment = await trx('services').where({ service_key: 'lawn_inspection' }).first('id');
    const paidService = await trx('services').whereNot({ service_key: 'lawn_inspection' })
      .whereNotNull('service_key').first('id');
    const otherCustomerId = randomUUID();
    await trx('customers').insert({
      id: otherCustomerId,
      first_name: 'Other',
      last_name: 'Customer',
      email: `${otherCustomerId}@example.invalid`,
      phone: `fixture-${otherCustomerId.slice(0, 8)}`,
      address_line1: '2 Synthetic Lane',
      city: 'Test City',
      zip: '00000',
      active: true,
      pipeline_stage: 'active_customer',
    });
    await visit({ scheduled_date: '2098-01-05', service_type: 'Paid-looking label', service_id: assessment.id });
    await visit({ scheduled_date: '2098-01-10', customer_id: otherCustomerId, service_id: paidService.id });
    const paid = await visit({ scheduled_date: '2098-02-10', service_id: paidService.id });

    expect((await paidEstimateVisitsQuery(trx, { estimateId, customerId })).map((row) => row.id)).toEqual([paid]);
  });

  test.each([
    ['cancelled', { status: 'cancelled' }, null],
    ['moved behind current coverage', { scheduled_date: '2097-12-15' }, '2097-12-15'],
  ])('an anchor %s after preflight cannot write overlapping coverage', async (_label, change, expectedFinalStart) => {
    const paid = await visit();
    await trx('annual_prepay_terms').insert({
      id: randomUUID(),
      customer_id: customerId,
      status: 'active',
      term_start: '2097-02-01',
      term_end: '2098-01-31',
      prepay_amount: 600,
      plan_label: 'Synthetic Existing Coverage',
    });
    const verifiedStart = dateOnly((await paidEstimateVisitsQuery(trx, { estimateId, customerId }).first()).scheduled_date);
    await expect(lockAndAssertNoAnnualPrepayOverlap(
      trx, customerId, verifiedStart, false, 'Customer already has an annual prepay term through', estimateId,
    )).resolves.toBeUndefined();

    await trx('scheduled_services').where({ id: paid }).update(change);
    const finalPaid = await paidEstimateVisitsQuery(trx, { estimateId, customerId })
      .first('scheduled_services.scheduled_date');
    const converterTermStart = dateOnly(finalPaid?.scheduled_date || '') || null;
    let finalStart = null;
    await expect(createTermForAnnualPrepay({
      customerId,
      sourceEstimateId: estimateId,
      termStart: converterTermStart,
      conn: trx,
      verifyNormalizedStart: async (normalizedStart) => {
        finalStart = normalizedStart;
        if (normalizedStart === verifiedStart) return;
        await lockAndAssertNoAnnualPrepayOverlap(
          trx, customerId, normalizedStart, false, 'Customer already has an annual prepay term through', estimateId,
        );
      },
    })).rejects.toMatchObject({
      annualPrepayOverlap: expect.objectContaining({ activeTermEnd: '2098-01-31' }),
    });
    expect(finalStart).toMatch(/^20\d\d-\d\d-\d\d$/);
    if (expectedFinalStart) expect(finalStart).toBe(expectedFinalStart);
    expect(finalStart < '2098-01-31').toBe(true);
    expect(await trx('annual_prepay_terms').where({ source_estimate_id: estimateId }).count('id as count').first())
      .toMatchObject({ count: '0' });
  });
});
