/**
 * The "check <name>'s plan price" bell (series-price-guards.js, cancelled root)
 * closes only when the guard would no longer refuse the extension: real rows,
 * real SQL. Skips without DATABASE_URL (the CI `server` job runs it migrated).
 * Fixtures are synthetic.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

postgres('plan-price bell closes when the guard stops refusing', () => {
  let db; let guards; let customerId; let rootId; const bellIds = [];

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local/CI database');
    db = require('../models/db');
    guards = require('../services/series-price-guards');
  });
  afterAll(async () => { await db.destroy(); });

  beforeEach(async () => {
    customerId = randomUUID();
    await db('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Fixture', email: `${customerId}@example.invalid`,
      phone: '+19415550145', address_line1: '102 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer',
    });
    rootId = await visit({ status: 'cancelled', scheduled_date: '2040-01-15' });
  });
  afterEach(async () => {
    await db('notifications').whereIn('id', bellIds.splice(0)).del();
    await db('invoices').where({ customer_id: customerId }).del();
    await db('scheduled_services').where({ customer_id: customerId }).del();
    await db('customers').where({ id: customerId }).del();
  });

  async function visit(overrides = {}) {
    const id = randomUUID();
    await db('scheduled_services').insert({
      id, customer_id: customerId, service_type: 'Monthly Pest Control Service', status: 'pending', scheduled_date: '2040-02-15',
      is_recurring: true, recurring_pattern: 'monthly', estimated_price: 100, ...overrides,
    });
    return id;
  }
  async function paidInvoiceFor(visitId, total) {
    await db('invoices').insert({
      id: randomUUID(), customer_id: customerId, scheduled_service_id: visitId, invoice_number: `TST-${visitId.slice(0, 8)}`,
      token: randomUUID().replace(/-/g, ''), status: 'paid', total, subtotal: total, paid_at: new Date(),
      line_items: JSON.stringify([{ description: 'Pest Control', amount: total, quantity: 1, unit_price: total, client_id: `scheduled_${visitId}_primary` }]),
    });
  }
  async function bell({ price = 100, root = rootId, doneWhen = 'plan_price_checked', prefix = 'series-price-guard:cancelled-root:' } = {}) {
    const dedupeKey = `${prefix}${root}`;
    const [row] = await db('notifications').insert({
      recipient_type: 'admin', category: 'billing', title: "Schedule - check Synthetic's plan price", body: 'Not added',
      metadata: JSON.stringify({ dedupeKey, doneWhen, kind: 'cancelled_root', seriesRootId: root, customerId, price, lastPaid: null }),
    }).returning('id');
    const id = row.id ?? row;
    bellIds.push(id);
    return id;
  }
  const state = (id) => db('notifications').where({ id }).first('done_at', 'done_by', 'resolution');
  const sweep = () => guards.sweepSettledCancelledRootAlerts({ conn: db });

  test('stays open while the root is cancelled and no paid visit backs the price', async () => {
    const id = await bell();
    await visit({ recurring_parent_id: rootId, scheduled_date: '2040-03-15' }); // a later visit is not evidence
    await sweep();
    expect((await state(id)).done_at).toBeNull();
  });

  test('stays open when the paid visit does not back the price (over 25%)', async () => {
    const id = await bell({ price: 200 });
    const paid = await visit({ recurring_parent_id: rootId, status: 'completed', scheduled_date: '2039-12-15' });
    await paidInvoiceFor(paid, 100);
    await sweep();
    expect((await state(id)).done_at).toBeNull();
  });

  test('closes once a paid completed visit backs the price', async () => {
    const id = await bell({ price: 110 });
    const paid = await visit({ recurring_parent_id: rootId, status: 'completed', scheduled_date: '2039-12-15' });
    await paidInvoiceFor(paid, 100);
    expect(await sweep()).toBeGreaterThanOrEqual(1);
    expect(await state(id)).toMatchObject({ done_by: 'series-price-guard', resolution: guards.CANCELLED_ROOT_RESOLUTION });
    expect((await state(id)).done_at).not.toBeNull();
  });

  test('closes when the root is no longer cancelled', async () => {
    const id = await bell();
    await db('scheduled_services').where({ id: rootId }).update({ status: 'pending' });
    await sweep();
    expect(await state(id)).toMatchObject({ done_by: 'series-price-guard' });
  });

  test('leaves a bell with no stored price, a missing root, another doneWhen or another key prefix alone', async () => {
    const noPrice = await bell({ price: null });
    const noRoot = await bell({ root: randomUUID() });
    const otherDone = await bell({ doneWhen: 'visit_price_checked' });
    await db('scheduled_services').where({ id: rootId }).update({ status: 'pending' });
    const otherKey = await bell({ prefix: 'series-price-guard:over-last-paid:' });
    await sweep();
    for (const id of [noPrice, noRoot, otherDone, otherKey]) expect((await state(id)).done_at).toBeNull();
  });

  test('a row a person marked Done keeps their close', async () => {
    const id = await bell();
    await db('scheduled_services').where({ id: rootId }).update({ status: 'pending' });
    const personDone = new Date('2026-11-20T14:00:00Z');
    await db('notifications').where({ id }).update({ done_at: personDone, done_by: randomUUID(), resolution: 'Checked' });
    await sweep();
    expect((await state(id)).resolution).toBe('Checked');
  });
});
