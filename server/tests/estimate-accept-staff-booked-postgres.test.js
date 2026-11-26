/**
 * A visit staff booked from the estimate's own hold — ROUTE-LEVEL, real
 * migrated Postgres (real router and accept transaction).
 *
 * Staff can attach the customer to a hold without clearing its timestamp. The
 * accept must then treat the row as a booking: offer it, and never commit it as a
 * hold or rewrite it for a page that showed a hold.
 *
 * Needs DATABASE_URL pointing at a local, migrated, disposable database.
 * Every fixture rolls back; all data is synthetic.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.GATE_ESTIMATE_EXISTING_APPT_CUSTOMER_WIDE = 'true';
jest.setTimeout(90000);

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
if (!SKIP && !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname)) {
  throw new Error('estimate-accept-staff-booked-postgres requires a local database.');
}

let mockTransaction;
jest.mock('../models/db', () => {
  const database = (...args) => mockTransaction(...args);
  database.transaction = (...args) => mockTransaction.transaction(...args);
  database.raw = (...args) => mockTransaction.raw(...args);
  database.fn = { now: () => new Date() };
  Object.defineProperty(database, 'schema', { get: () => mockTransaction.schema });
  return database;
});

// Side-effect modules only — the router, converter and resolver run for real.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  existingShortUrlFor: jest.fn(async () => null),
  createShortCode: jest.fn(async (url) => ({ code: 'abc12', shortUrl: url })),
  createTrackedShortLink: jest.fn(async (url) => ({ code: 'abc12', shortUrl: url })),
  resolveShortCode: jest.fn(async () => null),
  invoiceShortCodePrefix: jest.fn(() => 'inv'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({})),
  notifyCustomer: jest.fn(async () => ({})),
}));
jest.mock('../services/account-membership-email', () => ({
  sendMembershipStarted: jest.fn(async () => ({})),
}));
jest.mock('../services/estimate-accepted-email', () => ({
  sendEstimateAcceptedOnboarding: jest.fn(async () => ({})),
}));
jest.mock('../services/appointment-tagger', () => {
  // The tagger is a class instance: keep its real classifier, stub only the send.
  const tagger = jest.requireActual('../services/appointment-tagger');
  tagger.onServiceScheduled = jest.fn(async () => ({}));
  return tagger;
});
jest.mock('../services/lead-estimate-link', () => ({
  markLinkedLeadEstimateAccepted: jest.fn(async () => ({})),
  markLinkedLeadEstimateViewed: jest.fn(async () => ({})),
}));
jest.mock('../services/estimate-card-holds', () => ({
  resolveCardHoldPolicy: jest.fn(() => ({ required: false, enforced: false })),
  verifyCardHoldIntent: jest.fn(async () => ({ ok: false })),
  recordCardHoldHeld: jest.fn(async () => ({})),
  attachCardHoldPaymentMethod: jest.fn(async () => ({})),
  cardHoldNoShowFee: jest.fn(() => 49),
  cardHoldCancelWindowHours: jest.fn(() => 24),
}));

const express = require('express');
const knex = require('knex');
const { randomUUID } = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');

const dateOnly = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

postgres('estimate accept — a visit staff booked from the hold', () => {
  let db;
  let server;
  let baseUrl;

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    if (!await db.schema.hasTable('knex_migrations')) throw new Error('Run development migrations first');
    const router = require('../routes/estimate-public');
    const app = express();
    app.use(express.json());
    app.use('/api/estimates', router);
    app.use((err, req, res, next) => {
      res.status(err.status || err.statusCode || 500).json({ error: err.message });
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    mockTransaction = await db.transaction();
    const { isBlackoutDate } = require('../services/scheduling/blackout-dates');
    let day = addETDays(new Date(), 10);
    while (await isBlackoutDate(etDateString(day), mockTransaction)) day = addETDays(day, 1);
    BOOKED_DATE = etDateString(day);
    SLOT_ID = `${BOOKED_DATE}_09-00_unassigned`;
  });
  afterEach(async () => { await mockTransaction?.rollback(); mockTransaction = null; });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db?.destroy();
    await require('../models/db').destroy?.();
  });

  const LAWN_DATA = {
    customerSelection: { frequency: 'monthly' },
    setupFeeQuote: { amount: 0, waived: true },
    result: {
      totals: { year2mo: 55, year2: 660 },
      recurring: {
        discount: 0,
        monthlyTotal: 55,
        grandTotal: 55,
        services: [{
          name: 'Lawn Care', service: 'lawn_care', frequency: 'monthly', mo: 55,
          visitsPerYear: 12, perTreatment: 55, selected: true, isSelected: true,
        }],
      },
      oneTime: { items: [], membershipFee: 0 },
    },
  };
  // A date the calendar allows (no blackout day), found per test.
  let BOOKED_DATE;
  let SLOT_ID;
  const STAFF_PRICE = 73;

  async function newCustomer(trx, last) {
    const customerId = randomUUID();
    const tag = customerId.slice(0, 8);
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: last,
      phone: `+1941555${String(parseInt(tag, 16)).slice(-4).padStart(4, '0')}`,
      email: `qa-${tag}@example.test`, active: true,
      address_line1: '123 Synthetic Ave', city: 'Bradenton', state: 'FL', zip: '34205',
    });
    return customerId;
  }

  async function fixture(trx) {
    const customerId = await newCustomer(trx, 'Booked');
    const estimateId = randomUUID();
    const token = randomUUID().replace(/-/g, '');
    await trx('estimates').insert({
      id: estimateId, customer_id: customerId, status: 'sent', token,
      customer_name: 'Synthetic Booked', customer_phone: '+19415550100', customer_email: 'qa-booked@example.test',
      address: '123 Synthetic Ave, Bradenton, FL 34205', monthly_total: 55, annual_total: 660, onetime_total: 0,
      waveguard_tier: 'Bronze', show_one_time_option: false, bill_by_invoice: false, category: 'RESIDENTIAL',
      estimate_data: JSON.stringify(LAWN_DATA), sent_at: new Date(),
    });
    return { customerId, estimateId, token };
  }

  // The estimate's own hold that staff booked: customer attached, old hold
  // timestamp left behind (an hour past, well beyond the commit grace).
  async function staffBookedHold(trx, { customerId, estimateId, stamp = 'lapsed' }) {
    const id = randomUUID();
    const serviceRow = await trx('services').where({ service_key: 'lawn_care_monthly' }).first('id');
    await trx('scheduled_services').insert({
      id, customer_id: customerId, source_estimate_id: estimateId, service_id: serviceRow.id,
      service_type: 'Monthly Lawn Care Service', scheduled_date: BOOKED_DATE,
      window_start: '09:00', window_end: '11:00', status: 'confirmed', estimated_price: STAFF_PRICE,
      reservation_expires_at: stamp === 'cleared' ? null
        : trx.raw({ live: "NOW() + INTERVAL '10 minutes'", justlapsed: "NOW() - INTERVAL '30 seconds'" }[stamp] || "NOW() - INTERVAL '1 hour'"),
    });
    return id;
  }

  const visitRow = (id) => mockTransaction('scheduled_services').where({ id }).first();
  const estimateStatus = async (id) => (await mockTransaction('estimates').where({ id }).first()).status;
  const putAccept = (token, body = {}) => fetch(`${baseUrl}/api/estimates/${token}/accept`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentMethodPreference: 'pay_at_visit', ...body }),
  });

  test('/data offers the staff-booked visit as a booked appointment, not a hold, after its timestamp lapsed', async () => {
    const { customerId, estimateId, token } = await fixture(mockTransaction);
    const id = await staffBookedHold(mockTransaction, { customerId, estimateId });
    const res = await fetch(`${baseUrl}/api/estimates/${token}/data`);
    expect(res.status).toBe(200);
    const { acceptance } = (await res.json()).estimate;
    expect(acceptance.mode).toBe('existing_appointment');
    expect(acceptance.appointment.id).toBe(id);
    expect(acceptance.appointment.isHold).toBeUndefined();
  });

  test.each([
    ['a page that showed a hold', { existingAppointmentWasHold: true }, false],
    ['a tab that predates the field', {}, true],
  ])('accept by appointment id from %s is refused and the booked visit is untouched', async (_label, extra, reloadRequired) => {
    const { customerId, estimateId, token } = await fixture(mockTransaction);
    const id = await staffBookedHold(mockTransaction, { customerId, estimateId });
    const before = await visitRow(id);
    const res = await putAccept(token, { existingAppointmentId: id, ...extra });
    expect(res.status).toBe(409);
    const body = await res.json();
    // A tab that predates the field gets the stale-page code both deployed
    // clients answer, with a reload message; a current page gets the slot code.
    if (reloadRequired) {
      expect(body.code).toBe('LAWN_LIMITS_STALE');
      expect(body.reloadRequired).toBe(true);
      expect(body.error).toMatch(/reload/i);
    } else {
      expect(body.code).toBe('SLOT_UNAVAILABLE');
    }
    expect(await visitRow(id)).toEqual(before);
    expect(await estimateStatus(estimateId)).toBe('sent');
  });

  test('accept by appointment id from a page that showed a booked visit is refused when the row is now an unclaimed hold', async () => {
    const { estimateId, token } = await fixture(mockTransaction);
    const holdId = randomUUID();
    await mockTransaction('scheduled_services').insert({
      id: holdId, source_estimate_id: estimateId, scheduled_date: BOOKED_DATE, window_start: '09:00', window_end: '11:00',
      service_type: 'Lawn Care', status: 'pending', estimated_duration_minutes: 60,
      reservation_expires_at: mockTransaction.raw("NOW() + INTERVAL '10 minutes'"),
    });
    const before = await visitRow(holdId);
    const res = await putAccept(token, { existingAppointmentId: holdId, existingAppointmentWasHold: false });
    expect(res.status).toBe(409);
    // The stale-page code: the server-rendered page cannot clear an adopted visit
    // with its slot-conflict handler, so it reloads to re-read the row.
    expect((await res.json()).code).toBe('LAWN_LIMITS_STALE');
    expect(await visitRow(holdId)).toEqual(before);
    expect(await estimateStatus(estimateId)).toBe('sent');
  });

  test.each([
    ['lapsed', 'RESERVATION_EXPIRED'],
    ['cleared', 'RESERVATION_EXPIRED'],
    // Inside the commit grace an unclaimed hold still graduates, but a booked
    // visit's timestamp is judged on the database clock with no grace.
    ['justlapsed', 'RESERVATION_EXPIRED'],
    ['live', 'SLOT_UNAVAILABLE'],
  ])('accept by slot of a staff-booked visit (%s timestamp) is refused and the visit untouched', async (stamp, code) => {
    const { customerId, estimateId, token } = await fixture(mockTransaction);
    const id = await staffBookedHold(mockTransaction, { customerId, estimateId, stamp });
    const before = await visitRow(id);
    const res = await putAccept(token, { slotId: SLOT_ID });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(code);
    expect(await visitRow(id)).toEqual(before);
    expect(await estimateStatus(estimateId)).toBe('sent');
  });

  test('accept by slot of another customer\'s booked visit is refused and the visit untouched', async () => {
    const { estimateId, token } = await fixture(mockTransaction);
    const other = await newCustomer(mockTransaction, 'Other');
    const id = await staffBookedHold(mockTransaction, { customerId: other, estimateId, stamp: 'live' });
    const before = await visitRow(id);
    const res = await putAccept(token, { slotId: SLOT_ID });
    expect(res.status).toBe(409);
    expect(await visitRow(id)).toEqual(before);
    expect(await estimateStatus(estimateId)).toBe('sent');
  });

  test('control: adopting a stamped booking by appointment id, from a page that showed it booked, succeeds', async () => {
    const { customerId, estimateId, token } = await fixture(mockTransaction);
    const id = await staffBookedHold(mockTransaction, { customerId, estimateId });
    const res = await putAccept(token, { existingAppointmentId: id, existingAppointmentWasHold: false });
    expect(res.status).toBe(200);
    expect((await visitRow(id)).reservation_expires_at).toBeNull();
  });

  // Termite annual sign-before-pay books nothing; the persisted park stamp routes
  // the accept into that lane. It records the pick only from an unclaimed live hold.
  describe('sign-before-pay lane', () => {
    const parked = (estimateId) => mockTransaction('estimates').where({ id: estimateId }).update({ annual_plan_activation_status: 'awaiting_signature' });
    const acceptPrepay = (token, body) => putAccept(token, { paymentMethodPreference: 'prepay_annual', ...body });

    test.each([['slot', (id) => ({ slotId: SLOT_ID })], ['appointment id', (id) => ({ existingAppointmentId: id, existingAppointmentWasHold: true })]])(
      'a visit staff booked after the preflight is refused by %s and never recorded as the requested first visit', async (_label, body) => {
        const { customerId, estimateId, token } = await fixture(mockTransaction);
        const id = await staffBookedHold(mockTransaction, { customerId, estimateId, stamp: 'live' });
        await parked(estimateId);
        const before = await visitRow(id);
        const res = await acceptPrepay(token, body(id));
        expect(res.status).toBe(409);
        expect(await visitRow(id)).toEqual(before);
        const stored = await mockTransaction('estimates').where({ id: estimateId }).first();
        expect(JSON.stringify(stored.estimate_data || {})).not.toContain(id);
      },
    );
  });

  test('control: an unclaimed hold still graduates for its own estimate', async () => {
    const { customerId, estimateId, token } = await fixture(mockTransaction);
    const holdId = randomUUID();
    await mockTransaction('scheduled_services').insert({
      id: holdId, source_estimate_id: estimateId, scheduled_date: BOOKED_DATE, window_start: '09:00', window_end: '11:00',
      service_type: 'Lawn Care', status: 'pending', estimated_duration_minutes: 60,
      reservation_expires_at: mockTransaction.raw("NOW() + INTERVAL '10 minutes'"),
    });
    const res = await putAccept(token, { slotId: SLOT_ID });
    expect(res.status).toBe(200);
    const row = await visitRow(holdId);
    expect(row.customer_id).toBe(customerId);
    expect(row.reservation_expires_at).toBeNull();
  });
});
