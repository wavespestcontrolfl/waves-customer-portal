// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// The public annual-prepay overlap guard must anchor on the first qualifying
// paid visit, never an earlier free Waves Assessment linked to the estimate.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

const { paidEstimateVisitsQuery } = require('../services/assessment-booking');

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

  test('skips a Jan 5 assessment and anchors the renewal on the paid Feb 10 service', async () => {
    await visit({
      scheduled_date: '2098-01-05',
      service_type: 'Waves Assessment',
      window_start: '08:00',
      window_end: '09:00',
    });
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
});
