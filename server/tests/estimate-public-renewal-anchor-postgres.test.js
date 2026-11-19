// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// The public annual-prepay overlap guard must anchor on the first qualifying
// paid visit, never an earlier free Waves Assessment linked to the estimate.
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

  afterEach(async () => {
    if (trx) await trx.rollback();
    jest.resetModules();
    jest.clearAllMocks();
    jest.dontMock('../models/db');
    jest.dontMock('../services/logger');
    jest.dontMock('../services/notification-service');
    jest.dontMock('../services/estimate-converter');
    jest.dontMock('../routes/admin-customers');
  });
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

  test('skips a Jan 5 assessment and anchors the renewal on the paid Feb 10 service', async () => {
    await visit({
      scheduled_date: '2098-01-05',
      service_type: 'Waves Assessment',
      window_start: '08:00',
      window_end: '09:00',
    });
    await visit({ scheduled_date: '2098-01-15', is_callback: true });
    const paid = await visit({ reservation_expires_at: trx.raw("NOW() - INTERVAL '1 day'") });

    const rows = await paidEstimateVisitsQuery(trx, { estimateId, customerId });

    expect(rows.map((row) => row.id)).toEqual([paid]);
    expect(dateOnly(rows[0].scheduled_date)).toBe('2098-02-10');
    expect(dateOnly(rows[0].scheduled_date) > '2098-01-31').toBe(true);
  });

  test('excludes another customer, unclaimed holds, assessment, and retained history', async () => {
    const assessment = await trx('services').where({ service_key: 'lawn_inspection' }).first('id');
    const paid = await trx('services').whereNot({ service_key: 'lawn_inspection' }).whereNotNull('service_key').first('id');
    expect(assessment).toBeTruthy();
    expect(paid).toBeTruthy();

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

    // Catalog assessment despite the paid-looking snapshot: excluded.
    await visit({ scheduled_date: '2098-01-05', service_type: 'Lawn Care Visit', service_id: assessment.id });
    // An unclaimed estimate hold is not a booked visit.
    await visit({ scheduled_date: '2098-01-10', customer_id: null, service_id: paid.id, reservation_expires_at: trx.raw("NOW() + INTERVAL '15 minutes'") });
    // A source stamp cannot transfer another customer's booking into this plan.
    await visit({ scheduled_date: '2098-01-15', customer_id: otherCustomerId, service_id: paid.id });
    // Retained history never starts a new plan.
    await visit({ scheduled_date: '2098-01-20', service_id: paid.id, status: 'cancelled' });
    await visit({ scheduled_date: '2098-01-21', service_id: paid.id, status: 'rescheduled' });
    // A staff-booked visit remains valid despite its stale former hold stamp.
    const firstPaid = await visit({ scheduled_date: '2098-02-10', service_type: 'Waves Assessment', service_id: paid.id, reservation_expires_at: trx.raw("NOW() - INTERVAL '1 day'") });
    const secondPaid = await visit({ scheduled_date: '2098-03-10', service_id: paid.id });

    const rows = await paidEstimateVisitsQuery(trx, { estimateId, customerId });

    expect(rows.map((row) => row.id)).toEqual([firstPaid, secondPaid]);
    expect(rows.map((row) => dateOnly(row.scheduled_date))).toEqual(['2098-02-10', '2098-03-10']);
  });

  test.each([
    ['cancelled', { status: 'cancelled' }, null],
    ['moved behind the current term', { scheduled_date: '2097-12-15' }, '2097-12-15'],
  ])('an anchor %s after preflight cannot move the final term start behind existing coverage', async (_label, change, expectedFinalStart) => {
    const paid = await visit({ scheduled_date: '2098-02-10' });
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
    expect(verifiedStart).toBe('2098-02-10');
    await expect(lockAndAssertNoAnnualPrepayOverlap(
      trx, customerId, verifiedStart, false, 'Customer already has an annual prepay term through', estimateId,
    )).resolves.toBeUndefined();

    // Dispatch changes the source after preflight. Re-run the converter's
    // canonical paid-visit query and pass the same final start it would.
    await trx('scheduled_services').where({ id: paid }).update(change);
    const finalPaid = await paidEstimateVisitsQuery(trx, { estimateId, customerId }).first('scheduled_services.scheduled_date');
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

  test('a signed termite activation rejects a linked visit moved inside locked existing coverage', async () => {
    const initialStart = '2098-02-10';
    const movedStart = '2098-01-15';
    await trx('estimates').where({ id: estimateId }).update({
      annual_plan_activation_status: 'awaiting_signature',
      annual_plan_deferred_invoice: JSON.stringify({
        version: 1,
        parkedAt: '2097-12-01T12:00:00.000Z',
        annualPrepayTermStart: initialStart,
      }),
    });
    const contractId = randomUUID();
    await trx('customer_contracts').insert({
      id: contractId,
      customer_id: customerId,
      title: 'Synthetic Termite Annual Agreement',
      document_template_key: 'service_agreement.termite_annual_protection',
      status: 'signed',
      signed_at: new Date('2097-12-02T12:00:00.000Z'),
      annual_plan_version: 'v3',
      document_variables_snapshot: JSON.stringify({ estimate: { id: estimateId } }),
    });
    await trx('annual_prepay_terms').insert({
      id: randomUUID(),
      customer_id: customerId,
      status: 'active',
      term_start: '2097-02-01',
      term_end: '2098-01-31',
      prepay_amount: 600,
      plan_label: 'Synthetic Existing Coverage',
    });

    const convertEstimate = jest.fn(async (_id, opts) => {
      expect(opts.database.isTransaction).toBe(true);
      await opts.verifyAnnualPrepayTermStart(movedStart);
      throw new Error('conversion should stop at the final-start verifier');
    });
    const notifyAdmin = jest.fn(async () => ({ id: randomUUID(), deduped: false }));
    jest.resetModules();
    jest.doMock('../models/db', () => trx);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
    jest.doMock('../services/estimate-converter', () => ({ convertEstimate }));
    jest.doMock('../routes/admin-customers', () => ({
      _private: { lockAndAssertNoAnnualPrepayOverlap },
    }));
    const { activateTermiteAnnualPlanForSignedContract } = require('../services/termite-annual-activation');

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId, conn: trx, trigger: 'test' });

    expect(result).toMatchObject({ skipped: 'error' });
    expect(result.error).toMatch(/overlapping annual coverage/);
    expect(convertEstimate).toHaveBeenCalledTimes(1);
    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate', expect.stringContaining('needs manual follow-up'), expect.any(String), expect.any(Object),
    );
    expect(await trx('estimates').where({ id: estimateId }).first('annual_plan_activation_status'))
      .toMatchObject({ annual_plan_activation_status: 'awaiting_signature' });
    expect(await trx('annual_prepay_terms').where({ source_estimate_id: estimateId }).count('id as count').first())
      .toMatchObject({ count: '0' });
  });
});
