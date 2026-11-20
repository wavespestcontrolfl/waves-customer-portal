let mockPg;

jest.mock('../models/db', () => {
  const db = (table, ...args) => mockPg(table, ...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref', 'destroy']) {
    db[name] = (...args) => mockPg[name](...args);
  }
  for (const name of ['schema', 'fn', 'client']) {
    Object.defineProperty(db, name, { get: () => mockPg[name] });
  }
  return db;
});
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));

const knex = require('knex');
const { randomUUID } = require('crypto');
const { etDateString } = require('../utils/datetime-et');

const connection = process.env.DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;
let trx;

jest.setTimeout(120000);

async function seedOriginal({ withEstimate = true } = {}) {
  const ids = {
    customerId: randomUUID(),
    invoiceId: randomUUID(),
    termId: randomUUID(),
    estimateId: withEstimate ? randomUUID() : null,
  };
  await trx('customers').insert({
    id: ids.customerId,
    first_name: 'Synthetic',
    last_name: 'Dispatch Review',
    phone: `+1202555${String(parseInt(ids.customerId.slice(0, 8), 16) % 10000).padStart(4, '0')}`,
    property_type: 'commercial',
  });
  if (ids.estimateId) {
    await trx('estimates').insert({
      id: ids.estimateId,
      customer_id: ids.customerId,
      status: 'accepted',
      estimate_data: { propertyType: 'commercial' },
    });
  }
  await trx('invoices').insert({
    id: ids.invoiceId,
    token: randomUUID(),
    invoice_number: `OBS-${ids.invoiceId.slice(0, 8)}`,
    customer_id: ids.customerId,
    title: 'Commercial Rodent Bait Stations — Annual Prepay',
    status: 'paid',
    paid_at: new Date(),
    payment_recorded_at: new Date(),
    subtotal: 55,
    total: 55,
    due_date: etDateString(),
    line_items: JSON.stringify([{
      description: 'Bait Station Setup — one-time setup fee',
      quantity: 1,
      unit_price: 55,
      amount: 55,
      category: 'Setup fee',
    }]),
  });
  await trx('annual_prepay_terms').insert({
    id: ids.termId,
    customer_id: ids.customerId,
    prepay_invoice_id: ids.invoiceId,
    source_estimate_id: ids.estimateId,
    plan_label: 'Commercial Rodent Bait Stations',
    monthly_rate: 55,
    prepay_amount: 55,
    term_start: etDateString(),
    term_end: '2099-12-31',
    status: 'active',
    coverage_service_type: 'Commercial Rodent Bait Stations',
    coverage_visit_count: 4,
  });
  await require('../services/commercial-prepay-sale-record').recordUnbookedSale(trx, {
    invoiceId: ids.invoiceId,
    estimateId: ids.estimateId,
    customerId: ids.customerId,
    setupAmount: 55,
  });
  const sale = await require('../services/commercial-prepay-sale-record')
    .findUnbookedSale(trx, ids.invoiceId);
  return { ...ids, sale };
}

function reviews(invoiceId) {
  return trx('dispatch_alerts')
    .where({ type: 'commercial_prepay_setup_review' })
    .whereRaw("payload->>'sourceInvoiceId' = ?", [String(invoiceId)])
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc');
}

postgres('commercial prepay Dispatch review accepts only a verified sale context', () => {
  beforeAll(() => {
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)
      || !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) {
      throw new Error('Dispatch review tests require a private local waves_qa_<32 hex> database.');
    }
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    mockPg = database;
  });

  beforeEach(async () => {
    trx = await database.transaction();
    mockPg = trx;
  });

  afterEach(async () => {
    await trx?.rollback();
    trx = null;
    mockPg = database;
  });

  afterAll(async () => database?.destroy());

  test('forged, stale and unsupported observations cannot open a card', async () => {
    const { invoiceId, sale } = await seedOriginal();
    const review = require('../services/commercial-prepay-dispatch-review');
    const context = sale.reviewContext;

    await expect(review.updateReview(trx, context, 'active')).resolves.toBeNull();
    await expect(review.updateReview(trx, context, 'unknown')).resolves.toBeNull();
    await expect(review.updateReview(trx, null, 'cancelled')).resolves.toBeNull();
    for (const [key, value] of [
      ['saleId', randomUUID()],
      ['sourceInvoiceId', randomUUID()],
      ['customerId', randomUUID()],
      ['estimateId', randomUUID()],
      ['setupAmountCents', 5501],
    ]) {
      await expect(review.updateReview(trx, { ...context, [key]: value }, 'cancelled'))
        .resolves.toBeNull();
    }

    expect(await reviews(invoiceId)).toHaveLength(0);
  });

  test('acknowledgement survives replay and each opposite observation opens one new episode', async () => {
    const { invoiceId, customerId, estimateId, sale } = await seedOriginal();
    const review = require('../services/commercial-prepay-dispatch-review');
    const dispatchAlerts = require('../services/dispatch-alerts');

    await review.updateReview(trx, sale.reviewContext, 'cancelled');
    await review.updateReview(trx, sale.reviewContext, 'cancelled');
    let alerts = await reviews(invoiceId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toEqual(expect.objectContaining({
      resolved_at: null,
      payload: expect.objectContaining({
        sourceInvoiceId: invoiceId,
        customerId,
        estimateId,
        amount: 55,
      }),
    }));
    expect(alerts[0].payload.paymentRestored).toBeUndefined();

    await dispatchAlerts.resolveAlert({ trx, id: alerts[0].id, resolvedBy: null });
    await review.updateReview(trx, sale.reviewContext, 'cancelled');
    alerts = await reviews(invoiceId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].resolved_at).not.toBeNull();
    expect(alerts[0].payload.superseded_at).toBeUndefined();

    await review.updateReview(trx, sale.reviewContext, 'active');
    await review.updateReview(trx, sale.reviewContext, 'active');
    alerts = await reviews(invoiceId);
    expect(alerts).toHaveLength(2);
    const returned = alerts.find((row) => row.payload.paymentRestored !== true);
    const restored = alerts.find((row) => row.payload.paymentRestored === true);
    expect(returned.resolved_at).not.toBeNull();
    expect(returned.payload.superseded_at).toBeTruthy();
    expect(restored).toEqual(expect.objectContaining({ resolved_at: null }));

    // A late Resolve click for the previous card cannot clear the marker that
    // keeps it historical beside the replacement episode.
    await dispatchAlerts.resolveAlert({ trx, id: returned.id, resolvedBy: null });
    const stale = await trx('dispatch_alerts').where({ id: returned.id }).first();
    expect(stale.payload.superseded_at).toBeTruthy();

    await review.updateReview(trx, sale.reviewContext, 'cancelled');
    alerts = await reviews(invoiceId);
    expect(alerts).toHaveLength(3);
    expect(alerts.filter((row) => row.payload.superseded_at == null)).toHaveLength(1);
    const current = alerts.find((row) => row.payload.superseded_at == null);
    expect(current).toEqual(expect.objectContaining({ resolved_at: null }));
    expect(current.payload.paymentRestored).toBeUndefined();
  });

  test('an owner mismatch is accepted only through an active merge row naming the invoice', async () => {
    const ids = await seedOriginal();
    const winnerId = randomUUID();
    await trx('customers').insert({
      id: winnerId,
      first_name: 'Synthetic',
      last_name: 'Merge Winner',
      phone: `+1202555${String(parseInt(winnerId.slice(0, 8), 16) % 10000).padStart(4, '0')}`,
      property_type: 'commercial',
    });
    await trx('invoices').where({ id: ids.invoiceId }).update({ customer_id: winnerId });
    await trx('annual_prepay_terms').where({ id: ids.termId }).update({ customer_id: winnerId });
    await trx('estimates').where({ id: ids.estimateId }).update({ customer_id: winnerId });

    const sales = require('../services/commercial-prepay-sale-record');
    await expect(sales.findUnbookedSale(trx, ids.invoiceId)).resolves.toBeNull();

    const loser = await trx('customers').where({ id: ids.customerId }).first();
    const [journal] = await trx('customer_merge_journal').insert({
      winner_customer_id: winnerId,
      loser_customer_id: ids.customerId,
      loser_snapshot: loser,
      repointed: {},
      repointed_ids: {
        version: 1,
        tables: { 'annual_prepay_terms.customer_id': [ids.termId] },
      },
      winner_backfills: {},
      tier: 'manual',
      evidence: { synthetic: true },
      performed_by: 'test:commercial-prepay-merge',
      created_at: trx.raw('clock_timestamp()'),
    }).returning('*');
    await expect(sales.findUnbookedSale(trx, ids.invoiceId)).resolves.toBeNull();

    await trx('customer_merge_journal').where({ id: journal.id }).update({
      repointed_ids: {
        version: 1,
        tables: {
          'invoices.customer_id': [ids.invoiceId],
          'annual_prepay_terms.customer_id': [ids.termId],
        },
      },
    });
    const merged = await sales.findUnbookedSale(trx, ids.invoiceId);
    expect(merged).toMatchObject({
      invoice: { id: ids.invoiceId, customer_id: winnerId },
      reviewContext: { sourceInvoiceId: ids.invoiceId, customerId: winnerId },
    });
    await require('../services/commercial-prepay-dispatch-review')
      .updateReview(trx, merged.reviewContext, 'cancelled');
    expect(await reviews(ids.invoiceId)).toEqual([
      expect.objectContaining({
        resolved_at: null,
        payload: expect.objectContaining({ customerId: winnerId }),
      }),
    ]);

    await trx('customer_merge_journal').where({ id: journal.id }).update({ undone_at: trx.fn.now() });
    await expect(sales.findUnbookedSale(trx, ids.invoiceId)).resolves.toBeNull();
  });

  test('bulk clear leaves the invoice review open while resolving ordinary cards', async () => {
    const { invoiceId, sale } = await seedOriginal({ withEstimate: false });
    const review = require('../services/commercial-prepay-dispatch-review');
    const dispatchAlerts = require('../services/dispatch-alerts');
    await review.updateReview(trx, sale.reviewContext, 'cancelled');
    const ordinary = await dispatchAlerts.createAlert({
      trx,
      type: 'synthetic_bulk_clear',
      severity: 'info',
      payload: { synthetic: true },
    });

    const result = await dispatchAlerts.resolveAllOpenAlerts({ trx, resolvedBy: null });
    expect(result.alerts.map((row) => row.id)).toContain(ordinary.id);
    expect((await trx('dispatch_alerts').where({ id: ordinary.id }).first()).resolved_at).not.toBeNull();
    expect((await reviews(invoiceId))[0].resolved_at).toBeNull();
  });
});
