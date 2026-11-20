'use strict';

let mockPg;
let mockOccupancyHook = null;

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
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/scheduling/staff-save-route-check', () => ({
  placeAutoSavedVisit: jest.fn(async () => null),
}));
jest.mock('../services/appointment-reminders', () => ({
  registerVisitReminderInTx: jest.fn(async () => null),
}));
jest.mock('../services/scheduling/occupancy', () => {
  const actual = jest.requireActual('../services/scheduling/occupancy');
  return {
    ...actual,
    tryAcquireOccupancyLock: jest.fn(async (trx, scheduledDate) => (
      mockOccupancyHook ? mockOccupancyHook(trx, scheduledDate) : true
    )),
  };
});

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');

const connection = process.env.DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const day = (offset) => etDateString(addETDays(new Date(), offset));

jest.setTimeout(120000);

postgres('annual-prepay sold-visit ownership refreshes', () => {
  let database;
  let trx;
  let renewals;

  beforeAll(() => {
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)
      || !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) {
      throw new Error('Sold-visit ownership tests require a private local waves_qa_<32 hex> PostgreSQL database.');
    }
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    renewals = require('../services/annual-prepay-renewals');
  });

  beforeEach(async () => {
    trx = await database.transaction();
    mockPg = trx;
    mockOccupancyHook = null;
    renewals._private.resetCachesForTests();
  });

  afterEach(async () => {
    mockOccupancyHook = null;
    await trx.rollback();
    trx = null;
  });

  afterAll(async () => database?.destroy());

  async function insertCustomer() {
    const id = randomUUID();
    await trx('customers').insert({
      id,
      first_name: 'Synthetic',
      last_name: 'Sold Visit',
      phone: `+1202555${String(parseInt(id.slice(0, 8), 16) % 10000).padStart(4, '0')}`,
      email: `${id}@example.invalid`,
      property_type: 'commercial',
    });
    return id;
  }

  async function insertPaidInvoice(customerId, amount = 100) {
    const id = randomUUID();
    await trx('invoices').insert({
      id,
      token: randomUUID(),
      invoice_number: `OWN-${id.slice(0, 8)}`,
      customer_id: customerId,
      title: 'Synthetic annual prepay',
      status: 'paid',
      paid_at: new Date(),
      subtotal: amount,
      total: amount,
      due_date: day(0),
      line_items: JSON.stringify([{ description: 'Annual service coverage', quantity: 1, unit_price: amount, amount }]),
    });
    return id;
  }

  test('a catalog-verified bait root gives every Pest Control child its identity; two refreshes neither duplicate nor restamp', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertPaidInvoice(customerId);
    const termId = randomUUID();
    const rootId = randomUUID();
    const firstDate = day(14);
    const bait = await trx('services').where({ service_key: 'rodent_bait_quarterly' })
      .first('id', 'service_key');
    expect(bait).toBeTruthy();

    await trx('annual_prepay_terms').insert({
      id: termId,
      customer_id: customerId,
      prepay_invoice_id: invoiceId,
      status: 'active',
      plan_label: 'Commercial rodent annual prepay',
      coverage_service_type: 'Pest Control',
      coverage_visit_count: 4,
      coverage_cadence: 'quarterly',
      prepay_amount: 100,
      term_start: firstDate,
      term_end: day(379),
      first_visit_date: firstDate,
      commercial_setup_series_root_id: rootId,
    });
    await trx('scheduled_services').insert({
      id: rootId,
      customer_id: customerId,
      annual_prepay_term_id: termId,
      scheduled_date: firstDate,
      service_type: 'Pest Control',
      service_id: bait.id,
      status: 'confirmed',
      is_recurring: true,
      recurring_pattern: 'quarterly',
      estimated_price: 25,
    });

    await renewals.refreshTermSnapshot(termId, trx);
    const first = await trx('scheduled_services')
      .where({ annual_prepay_term_id: termId })
      .orderBy(['scheduled_date', 'id']);
    expect(first).toHaveLength(4);
    expect(first.map((row) => row.service_id)).toEqual(Array(4).fill(bait.id));
    expect(first.slice(1).map((row) => row.service_key_snapshot)).toEqual(Array(3).fill(bait.service_key));
    expect(first.map((row) => row.prepaid_method)).toEqual(Array(4).fill('annual_prepay_invoice'));
    expect(first.map((row) => row.prepaid_amount)).toEqual(Array(4).fill('25.00'));
    const firstStamp = new Map(first.map((row) => [row.id, row.prepaid_at?.toISOString()]));

    await renewals.refreshTermSnapshot(termId, trx);
    const second = await trx('scheduled_services')
      .where({ annual_prepay_term_id: termId })
      .orderBy(['scheduled_date', 'id']);
    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
    expect(second.map((row) => row.service_id)).toEqual(Array(4).fill(bait.id));
    expect(second.map((row) => row.prepaid_amount)).toEqual(Array(4).fill('25.00'));
    expect(new Map(second.map((row) => [row.id, row.prepaid_at?.toISOString()]))).toEqual(firstStamp);
  });

  test('an invoice-owned promised visit that loses term membership under the occupancy lock is not retimed', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertPaidInvoice(customerId, 235);
    const termId = randomUUID();
    const visitId = randomUUID();
    const promisedDate = day(21);

    await trx('annual_prepay_terms').insert({
      id: termId,
      customer_id: customerId,
      prepay_invoice_id: invoiceId,
      status: 'active',
      plan_label: 'Invoice-owned commercial setup',
      coverage_service_type: 'Pest Control',
      coverage_visit_count: 4,
      coverage_cadence: 'quarterly',
      prepay_amount: 180,
      term_start: promisedDate,
      term_end: day(386),
      first_visit_date: promisedDate,
      first_visit_window_start: '08:00',
      commercial_setup_series_root_id: null,
    });
    await trx('setup_fee_claims').insert({
      invoice_id: invoiceId,
      amount: 55,
      scheduled_service_id: null,
      unbooked_commercial_setup: true,
    });
    await trx('scheduled_services').insert({
      id: visitId,
      customer_id: customerId,
      annual_prepay_term_id: termId,
      scheduled_date: promisedDate,
      service_type: 'Pest Control',
      status: 'confirmed',
      window_start: '10:00',
      window_end: '11:00',
      estimated_duration_minutes: 60,
      estimated_price: 45,
    });

    mockOccupancyHook = jest.fn(async (sp) => {
      await sp('scheduled_services').where({ id: visitId }).update({ annual_prepay_term_id: null });
      return true;
    });

    await renewals.refreshTermSnapshot(termId, trx);

    expect(mockOccupancyHook).toHaveBeenCalledTimes(1);
    // The later attach phase may safely restore this visit's term link after
    // the retime abort; the stale snapshot must never move its window.
    expect(await trx('scheduled_services').where({ id: visitId })
      .first('window_start', 'window_end'))
      .toEqual({ window_start: '10:00:00', window_end: '11:00:00' });
    expect(await trx('notifications')
      .whereRaw("metadata->>'dedupeKey' = ?", [`annual-prepay-first-visit:${termId}:adopted_visit_moved`]))
      .toHaveLength(1);
  });
});
