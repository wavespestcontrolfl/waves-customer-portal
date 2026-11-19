/**
 * A free Waves Assessment is never a lawn plan's first paid application —
 * ROUTE-LEVEL, real migrated Postgres (real router, real converter, real
 * composer confirmation resolver). Owner case 2026-10-21.
 *
 * The assessment's catalog key (lawn_inspection) classifies into the lawn
 * family, so the accept page used to adopt it: acceptance.mode came back
 * 'existing_appointment' (no slot picker), the accept restamped the
 * assessment with the plan's source/price, and the converter dated the lawn
 * series on the assessment day. The call-booking confirmation text also
 * offered "accept your estimate" against it.
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
  throw new Error('estimate-assessment-not-adopted-postgres requires a local database.');
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
jest.mock('../services/appointment-tagger', () => ({
  onServiceScheduled: jest.fn(async () => ({})),
  classifyAppointmentType: jest.fn(() => ({ tag: 'lawn', label: 'Lawn Care' })),
}));
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
const { acquireOccupancyLock } = require('../services/scheduling/occupancy');

const dateOnly = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

postgres('estimate adoption — a Waves Assessment is never the plan\'s first visit', () => {
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

  beforeEach(async () => { mockTransaction = await db.transaction(); });
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
  const PEST_DATA = {
    customerSelection: { frequency: 'quarterly' },
    setupFeeQuote: { amount: 0, waived: true },
    result: {
      totals: { year2mo: 15, year2: 180 },
      results: { pestTiers: [{ label: 'Quarterly', mo: 15, ann: 180, apps: 4, pa: 45 }] },
      recurring: {
        discount: 0,
        monthlyTotal: 15,
        grandTotal: 15,
        services: [{
          name: 'Pest Control', service: 'pest_control', mo: 15, visitsPerYear: 4, perTreatment: 45,
        }],
      },
      oneTime: { items: [], membershipFee: 0 },
    },
  };

  // Booked in-window dates: the assessment first, the customer's chosen lawn
  // slot later — so "the earliest linked row" and "the chosen slot" differ.
  const ASSESSMENT_DATE = etDateString(addETDays(new Date(), 3));
  const CHOSEN_DATE = etDateString(addETDays(new Date(), 10));

  async function serviceId(trx, key) {
    const row = await trx('services').where({ service_key: key }).first('id');
    if (!row) throw new Error(`catalog row ${key} missing — run migrations`);
    return row.id;
  }

  async function fixture(trx, { data = LAWN_DATA, monthly = 55, annual = 660 } = {}) {
    const customerId = randomUUID();
    const tag = customerId.slice(0, 8);
    const phone = `+1941555${String(parseInt(tag, 16)).slice(-4).padStart(4, '0')}`;
    await trx('customers').insert({
      id: customerId,
      first_name: 'Synthetic',
      last_name: 'Assesslane',
      phone,
      email: `qa-${tag}@example.test`,
      active: true,
      address_line1: '123 Synthetic Ave',
      city: 'Bradenton',
      state: 'FL',
      zip: '34205',
    });
    const estimateId = randomUUID();
    const token = randomUUID().replace(/-/g, '');
    await trx('estimates').insert({
      id: estimateId,
      customer_id: customerId,
      status: 'sent',
      token,
      customer_name: 'Synthetic Assesslane',
      customer_phone: phone,
      customer_email: `qa-${tag}@example.test`,
      address: '123 Synthetic Ave, Bradenton, FL 34205',
      monthly_total: monthly,
      annual_total: annual,
      onetime_total: 0,
      waveguard_tier: 'Bronze',
      show_one_time_option: false,
      bill_by_invoice: false,
      category: 'RESIDENTIAL',
      estimate_data: JSON.stringify(data),
      sent_at: new Date(),
    });
    return { customerId, estimateId, token };
  }

  async function visit(trx, { customerId, key, type, date, extra = {} }) {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id,
      customer_id: customerId,
      service_id: key ? await serviceId(trx, key) : null,
      service_type: type,
      scheduled_date: date,
      window_start: '09:00',
      window_end: '11:00',
      status: 'confirmed',
      ...extra,
    });
    return id;
  }

  const assessmentVisit = (trx, customerId, extra = {}) => visit(trx, {
    customerId, key: 'lawn_inspection', type: 'Waves Assessment', date: ASSESSMENT_DATE, extra,
  });
  const getAcceptance = async (token) => {
    const res = await fetch(`${baseUrl}/api/estimates/${token}/data`);
    expect(res.status).toBe(200);
    return (await res.json()).estimate.acceptance;
  };
  const putAccept = (token, body = {}) => fetch(`${baseUrl}/api/estimates/${token}/accept`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  test('control: a genuine upcoming lawn visit IS offered as the existing appointment', async () => {
    const { customerId, token } = await fixture(mockTransaction);
    const lawnId = await visit(mockTransaction, {
      customerId, key: 'lawn_care_monthly', type: 'Monthly Lawn Care Service', date: CHOSEN_DATE,
    });
    const acceptance = await getAcceptance(token);
    expect(acceptance.mode).toBe('existing_appointment');
    expect(acceptance.appointment.id).toBe(lawnId);
  });

  test.each([false, true])('a booked visit with an old hold expiry is offered once (already linked: %s)', async (linked) => {
    const { customerId, estimateId, token } = await fixture(mockTransaction);
    const id = await visit(mockTransaction, {
      customerId, key: 'lawn_care_monthly', type: 'Monthly Lawn Care Service', date: CHOSEN_DATE,
      extra: {
        source_estimate_id: linked ? estimateId : null,
        reservation_expires_at: mockTransaction.raw("NOW() - INTERVAL '1 day'"),
      },
    });
    const acceptance = await getAcceptance(token);
    expect(acceptance.mode).toBe('existing_appointment');
    expect(acceptance.appointment.id).toBe(id);
    expect(acceptance.appointment).not.toHaveProperty('reservationExpiresAt');
  });

  test('an open picker and its retry reuse the exact visit staff already booked', async () => {
    const { customerId, estimateId, token } = await fixture(mockTransaction);
    // A separate legacy hold can still coexist briefly when staff created a
    // booking instead of linking the hold. The booked row wins; the hold can
    // never become a second first visit.
    await visit(mockTransaction, {
      customerId: null, key: 'lawn_care_monthly', type: 'Monthly Lawn Care Service', date: CHOSEN_DATE,
      extra: {
        source_estimate_id: estimateId,
        status: 'pending',
        reservation_expires_at: mockTransaction.raw("NOW() + INTERVAL '10 minutes'"),
      },
    });
    const id = await visit(mockTransaction, {
      customerId, key: 'lawn_care_monthly', type: 'Monthly Lawn Care Service', date: CHOSEN_DATE,
      extra: {
        source_estimate_id: estimateId,
        reservation_expires_at: mockTransaction.raw("NOW() - INTERVAL '1 day'"),
      },
    });
    const reloaded = await getAcceptance(token);
    expect(reloaded.appointment.id).toBe(id);
    expect(reloaded.appointment).not.toHaveProperty('reservationExpiresAt');
    const body = { slotId: `${CHOSEN_DATE}_09-00_unassigned`, paymentMethodPreference: 'pay_at_visit' };
    const response = await putAccept(token, body);
    expect({ status: response.status, error: (await response.json()).error }).toEqual({ status: 200, error: undefined });
    expect((await mockTransaction('estimates').where({ id: estimateId }).first()).status).toBe('accepted');
    const firstVisits = await mockTransaction('scheduled_services')
      .where({ customer_id: customerId, source_estimate_id: estimateId, scheduled_date: CHOSEN_DATE }).pluck('id');
    expect(firstVisits).toEqual([id]);

    const beforeRetry = await mockTransaction('scheduled_services').where({ source_estimate_id: estimateId }).pluck('id');
    const retry = await putAccept(token, body);
    expect(retry.status).toBe(200);
    expect(await mockTransaction('scheduled_services').where({ source_estimate_id: estimateId }).pluck('id'))
      .toEqual(beforeRetry);
  });

  test('cancelled history at the submitted coordinates does not hide the estimate\'s new live hold', async () => {
    const { customerId, estimateId, token } = await fixture(mockTransaction);
    let bookingDate = CHOSEN_DATE;
    for (let i = 0; i < 30 && await require('../services/scheduling/blackout-dates').isBlackoutDate(bookingDate, mockTransaction); i += 1) {
      bookingDate = etDateString(addETDays(new Date(`${bookingDate}T12:00:00Z`), 1));
    }
    expect(await require('../services/scheduling/blackout-dates').isBlackoutDate(bookingDate, mockTransaction)).toBe(false);
    const cancelledId = await visit(mockTransaction, {
      customerId, key: 'lawn_care_monthly', type: 'Monthly Lawn Care Service', date: bookingDate,
      extra: { source_estimate_id: estimateId, status: 'cancelled' },
    });
    const holdId = await visit(mockTransaction, {
      customerId: null, key: 'lawn_care_monthly', type: 'Monthly Lawn Care Service', date: bookingDate,
      extra: {
        source_estimate_id: estimateId,
        status: 'pending',
        reservation_expires_at: mockTransaction.raw("NOW() + INTERVAL '10 minutes'"),
      },
    });
    expect(await mockTransaction('scheduled_services')
      .where({ source_estimate_id: estimateId, scheduled_date: bookingDate, window_start: '09:00', technician_id: null })
      .whereIn('status', ['pending', 'confirmed', 'en_route', 'on_site'])
      .whereNotNull('customer_id'))
      .toHaveLength(0);
    expect(await mockTransaction('scheduled_services').where({ id: holdId }).first('reservation_expires_at'))
      .toEqual(expect.objectContaining({ reservation_expires_at: expect.any(Date) }));

    const response = await putAccept(token, {
      slotId: `${bookingDate}_09-00_unassigned`,
      paymentMethodPreference: 'pay_at_visit',
    });

    const payload = await response.json();
    expect({ status: response.status, payload }).toEqual({
      status: 200,
      payload: expect.objectContaining({ success: true }),
    });
    expect((await mockTransaction('estimates').where({ id: estimateId }).first()).status).toBe('accepted');
    expect(await mockTransaction('scheduled_services').where({ id: cancelledId }).first('status', 'customer_id'))
      .toMatchObject({ status: 'cancelled', customer_id: customerId });
    expect(await mockTransaction('scheduled_services').where({ id: holdId }).first('status', 'customer_id', 'reservation_expires_at'))
      .toMatchObject({ status: 'pending', customer_id: customerId, reservation_expires_at: null });
  });

  test('a second eligible booking committed while acceptance waits for the date lock makes recovery fail closed', async () => {
    // This case needs two independently committed transactions. Replace the
    // per-test rollback fixture with committed synthetic rows, then clean them
    // explicitly after the request's own outer transaction is rolled back.
    await mockTransaction.rollback();
    mockTransaction = null;
    let seeded;
    let firstId;
    let secondId;
    await db.transaction(async (seedTrx) => {
      seeded = await fixture(seedTrx);
      firstId = await visit(seedTrx, {
        customerId: seeded.customerId,
        key: 'lawn_care_monthly',
        type: 'Monthly Lawn Care Service',
        date: CHOSEN_DATE,
        extra: { source_estimate_id: seeded.estimateId },
      });
    });
    mockTransaction = await db.transaction();
    const blocker = await db.transaction();
    const observer = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    let blockerOpen = true;
    let request;
    try {
      await acquireOccupancyLock(blocker, CHOSEN_DATE);
      request = putAccept(seeded.token, {
        slotId: `${CHOSEN_DATE}_09-00_unassigned`,
        paymentMethodPreference: 'pay_at_visit',
      });

      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i += 1) {
        const rows = await observer('pg_stat_activity')
          .whereRaw('datname = current_database()')
          .where({ wait_event_type: 'Lock' })
          .where('query', 'like', '%pg_advisory_xact_lock%')
          .select('pid');
        waiting = rows.length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);

      secondId = await visit(blocker, {
        customerId: seeded.customerId,
        key: 'lawn_care_monthly',
        type: 'Monthly Lawn Care Service',
        date: CHOSEN_DATE,
        extra: { source_estimate_id: seeded.estimateId },
      });
      await blocker.commit();
      blockerOpen = false;

      const response = await request;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'RESERVATION_EXPIRED' });
      expect((await mockTransaction('estimates').where({ id: seeded.estimateId }).first()).status).toBe('sent');
      const owners = await mockTransaction('scheduled_services').whereIn('id', [firstId, secondId]).pluck('customer_id');
      expect(owners).toHaveLength(2);
      expect(new Set(owners)).toEqual(new Set([seeded.customerId]));
    } finally {
      if (blockerOpen) await blocker.rollback().catch(() => {});
      if (request) await request.catch(() => {});
      await observer.destroy();
      await mockTransaction?.rollback().catch(() => {});
      mockTransaction = null;
      if (seeded) {
        await db('scheduled_services').where({ source_estimate_id: seeded.estimateId }).del();
        await db('estimates').where({ id: seeded.estimateId }).del();
        await db('customers').where({ id: seeded.customerId }).del();
      }
    }
  });

  test('an open picker cannot adopt a moved hour or assigned technician', async () => {
    const { customerId, estimateId, token } = await fixture(mockTransaction);
    await visit(mockTransaction, {
      customerId, key: 'lawn_care_monthly', type: 'Monthly Lawn Care Service', date: CHOSEN_DATE,
      extra: { source_estimate_id: estimateId, window_start: '11:00', window_end: '13:00' },
    });
    const movedHour = await putAccept(token, { slotId: `${CHOSEN_DATE}_09-00_unassigned` });
    expect(movedHour.status).toBe(409);
    expect(await movedHour.json()).toMatchObject({ code: 'RESERVATION_EXPIRED' });

    const technicianId = randomUUID();
    await mockTransaction('technicians').insert({
      id: technicianId, name: 'Assigned fixture', role: 'technician', active: true,
      employment_status: 'active', field_dispatchable: true,
    });
    await mockTransaction('scheduled_services').where({ source_estimate_id: estimateId })
      .update({ window_start: '09:00', window_end: '11:00', technician_id: technicianId });
    const movedTech = await putAccept(token, { slotId: `${CHOSEN_DATE}_09-00_unassigned` });
    expect(movedTech.status).toBe(409);
    expect(await movedTech.json()).toMatchObject({ code: 'RESERVATION_EXPIRED' });
    expect((await mockTransaction('estimates').where({ id: estimateId }).first()).status).toBe('sent');
  });

  test('an open picker refuses an ambiguous duplicate or a free assessment at the submitted coordinates', async () => {
    const ambiguous = await fixture(mockTransaction);
    for (let i = 0; i < 2; i += 1) {
      await visit(mockTransaction, {
        customerId: ambiguous.customerId, key: 'lawn_care_monthly', type: 'Monthly Lawn Care Service', date: CHOSEN_DATE,
        extra: { source_estimate_id: ambiguous.estimateId },
      });
    }
    expect((await putAccept(ambiguous.token, { slotId: `${CHOSEN_DATE}_09-00_unassigned` })).status).toBe(409);
    expect((await mockTransaction('estimates').where({ id: ambiguous.estimateId }).first()).status).toBe('sent');

    const free = await fixture(mockTransaction);
    await assessmentVisit(mockTransaction, free.customerId, {
      source_estimate_id: free.estimateId, scheduled_date: CHOSEN_DATE,
    });
    expect((await putAccept(free.token, { slotId: `${CHOSEN_DATE}_09-00_unassigned` })).status).toBe(409);
    expect((await mockTransaction('estimates').where({ id: free.estimateId }).first()).status).toBe('sent');
  });

  test('an open picker never adopts another customer\'s visit even when the estimate and hour stamps match', async () => {
    const owner = await fixture(mockTransaction);
    const other = await fixture(mockTransaction);
    const id = await visit(mockTransaction, {
      customerId: other.customerId, key: 'lawn_care_monthly', type: 'Monthly Lawn Care Service', date: CHOSEN_DATE,
      extra: { source_estimate_id: owner.estimateId },
    });
    expect((await putAccept(owner.token, { slotId: `${CHOSEN_DATE}_09-00_unassigned` })).status).toBe(409);
    expect((await mockTransaction('estimates').where({ id: owner.estimateId }).first()).status).toBe('sent');
    expect((await mockTransaction('scheduled_services').where({ id }).first()).customer_id).toBe(other.customerId);
  });

  test('/data: a booked assessment is not offered — the normal slot-picker flow renders', async () => {
    const { customerId, token } = await fixture(mockTransaction);
    await assessmentVisit(mockTransaction, customerId);
    const acceptance = await getAcceptance(token);
    expect(acceptance.mode).not.toBe('existing_appointment');
    expect(acceptance.appointment).toBeUndefined();
  });

  test('/data: with an assessment AND a real lawn visit, only the lawn visit is offered', async () => {
    const { customerId, token } = await fixture(mockTransaction);
    await assessmentVisit(mockTransaction, customerId);
    const lawnId = await visit(mockTransaction, {
      customerId, key: 'lawn_care_monthly', type: 'Monthly Lawn Care Service', date: CHOSEN_DATE,
    });
    const acceptance = await getAcceptance(token);
    expect(acceptance.mode).toBe('existing_appointment');
    expect(acceptance.appointment.id).toBe(lawnId);
  });

  test('/data: an unlinked legacy assessment row (name only) is not offered either', async () => {
    const { customerId, token } = await fixture(mockTransaction);
    await visit(mockTransaction, { customerId, key: null, type: 'Waves Assessment', date: ASSESSMENT_DATE });
    expect((await getAcceptance(token)).mode).not.toBe('existing_appointment');
  });

  test('/data: the estimate\'s own link to the assessment (estimate_data.scheduled_service_id) does not adopt it', async () => {
    const { customerId, estimateId, token } = await fixture(mockTransaction);
    const assessmentId = await assessmentVisit(mockTransaction, customerId);
    await mockTransaction('estimates').where({ id: estimateId }).update({
      estimate_data: JSON.stringify({ ...LAWN_DATA, scheduled_service_id: assessmentId }),
    });
    expect((await getAcceptance(token)).mode).not.toBe('existing_appointment');
  });

  test('/data: a row repointed to a paid lawn service keeps adopting despite a stale Waves Assessment label', async () => {
    const { customerId, token } = await fixture(mockTransaction);
    const repointedId = await visit(mockTransaction, {
      customerId, key: 'lawn_care_monthly', type: 'Waves Assessment', date: CHOSEN_DATE,
    });
    const acceptance = await getAcceptance(token);
    expect(acceptance.mode).toBe('existing_appointment');
    expect(acceptance.appointment.id).toBe(repointedId);
  });

  test('/data: an EARLIER estimate-linked assessment does not hide a LATER estimate-linked paid visit', async () => {
    const { customerId, estimateId, token } = await fixture(mockTransaction);
    await assessmentVisit(mockTransaction, customerId, { source_estimate_id: estimateId });
    const lawnId = await visit(mockTransaction, {
      customerId, key: 'lawn_care_monthly', type: 'Monthly Lawn Care Service', date: CHOSEN_DATE,
      extra: { source_estimate_id: estimateId },
    });
    const acceptance = await getAcceptance(token);
    expect(acceptance.mode).toBe('existing_appointment');
    expect(acceptance.appointment.id).toBe(lawnId);
  });

  test('/data: an estimate-linked assessment alone still falls through to the slot picker', async () => {
    const { customerId, estimateId, token } = await fixture(mockTransaction);
    await assessmentVisit(mockTransaction, customerId, { source_estimate_id: estimateId });
    expect((await getAcceptance(token)).mode).not.toBe('existing_appointment');
  });

  test('accept: a stale page posting the assessment id is refused and the assessment is not restamped', async () => {
    const { customerId, estimateId, token } = await fixture(mockTransaction);
    const assessmentId = await assessmentVisit(mockTransaction, customerId, { estimated_price: 0 });
    const before = await mockTransaction('scheduled_services').where({ id: assessmentId }).first();

    const res = await putAccept(token, { existingAppointmentId: assessmentId });
    expect(res.status).toBe(409);

    const after = await mockTransaction('scheduled_services').where({ id: assessmentId }).first();
    expect(after.source_estimate_id).toBeNull();
    expect(Number(after.estimated_price)).toBe(Number(before.estimated_price));
    expect(after.payment_method_preference).toBe(before.payment_method_preference);
    expect((await mockTransaction('estimates').where({ id: estimateId }).first()).status).toBe('sent');
  });

  test('accept: pest estimate with an assessment on the books — assessment still untouched', async () => {
    const { customerId, token } = await fixture(mockTransaction, { data: PEST_DATA, monthly: 15, annual: 180 });
    const assessmentId = await assessmentVisit(mockTransaction, customerId);
    expect((await getAcceptance(token)).mode).not.toBe('existing_appointment');
    const res = await putAccept(token, { existingAppointmentId: assessmentId });
    expect(res.status).toBe(409);
    expect((await mockTransaction('scheduled_services').where({ id: assessmentId }).first()).source_estimate_id).toBeNull();
  });

  describe('converter: seeds the series from the chosen slot, never from a linked assessment', () => {
    const EstimateConverter = () => require('../services/estimate-converter');
    const convertOpts = { skipSetupInvoice: true, autoSendInvoice: false, skipMembershipEmail: true };

    test('an assessment stamped to the estimate (older build) does not become the plan start', async () => {
      const { customerId, estimateId } = await fixture(mockTransaction);
      // The earlier-dated assessment carries the estimate's stamp, as the
      // old adoption left it; the customer's chosen lawn slot is the
      // committed reservation row, dated later.
      const assessmentId = await assessmentVisit(mockTransaction, customerId, { source_estimate_id: estimateId });
      const chosenId = await visit(mockTransaction, {
        customerId, key: 'lawn_care_monthly', type: 'Monthly Lawn Care Service', date: CHOSEN_DATE,
        extra: { source_estimate_id: estimateId, estimated_price: 55 },
      });
      await mockTransaction('estimates').where({ id: estimateId }).update({ status: 'accepted', accepted_at: new Date() });

      const result = await EstimateConverter().convertEstimate(estimateId, { database: mockTransaction, ...convertOpts });

      expect(result.firstScheduledServiceId).toBe(chosenId);
      // The plan's start (what the welcome email and term are dated on) is the chosen slot.
      expect(dateOnly(result.membershipEmail.effectiveDate)).toBe(CHOSEN_DATE);
      // Nothing the plan seeded lands before the chosen slot, and the
      // assessment day carries no plan visit.
      const planRows = await mockTransaction('scheduled_services')
        .where({ customer_id: customerId, source_estimate_id: estimateId })
        .whereNot({ id: assessmentId });
      expect(planRows.length).toBeGreaterThan(0);
      for (const row of planRows) {
        expect(dateOnly(row.scheduled_date) >= CHOSEN_DATE).toBe(true);
      }
      // The assessment was not priced as a plan visit nor made a series parent.
      const assessment = await mockTransaction('scheduled_services').where({ id: assessmentId }).first();
      expect(assessment.estimated_price == null || Number(assessment.estimated_price) === 0).toBe(true);
      expect(assessment.recurring_parent_id).toBeNull();
      const childrenOfAssessment = await mockTransaction('scheduled_services').where({ recurring_parent_id: assessmentId });
      expect(childrenOfAssessment).toHaveLength(0);
    });

    test('a stamped row repointed to a paid service (stale Waves Assessment label) IS the plan start', async () => {
      const { customerId, estimateId } = await fixture(mockTransaction);
      const repointedId = await visit(mockTransaction, {
        customerId, key: 'lawn_care_monthly', type: 'Waves Assessment', date: CHOSEN_DATE,
        extra: { source_estimate_id: estimateId, estimated_price: 55 },
      });
      await mockTransaction('estimates').where({ id: estimateId }).update({ status: 'accepted', accepted_at: new Date() });

      const result = await EstimateConverter().convertEstimate(estimateId, { database: mockTransaction, ...convertOpts });

      expect(result.firstScheduledServiceId).toBe(repointedId);
      expect(dateOnly(result.membershipEmail.effectiveDate)).toBe(CHOSEN_DATE);
    });

    test('an assessment stamped to the estimate is not "a reservation": the normal auto-schedule path runs', async () => {
      const { customerId, estimateId } = await fixture(mockTransaction);
      const assessmentId = await assessmentVisit(mockTransaction, customerId, { source_estimate_id: estimateId });
      await mockTransaction('estimates').where({ id: estimateId }).update({ status: 'accepted', accepted_at: new Date() });

      const result = await EstimateConverter().convertEstimate(estimateId, { database: mockTransaction, ...convertOpts });

      expect(result.firstScheduledServiceId).not.toBe(assessmentId);
      const lawnRows = await mockTransaction('scheduled_services')
        .where({ customer_id: customerId, source_estimate_id: estimateId })
        .whereNot({ id: assessmentId });
      expect(lawnRows.length).toBeGreaterThan(0);
    });
  });

  describe('call-booking confirmation text (resolveConfirmationEstimate)', () => {
    const resolver = () => require('../services/composer-customer-links').resolveConfirmationEstimate;

    test('control: a real lawn visit still earns the accept line', async () => {
      const { customerId, estimateId } = await fixture(mockTransaction);
      const lawnId = await visit(mockTransaction, {
        customerId, key: 'lawn_care_monthly', type: 'Monthly Lawn Care Service', date: CHOSEN_DATE,
      });
      const hit = await resolver()({ customerId, scheduledServiceId: lawnId });
      expect(hit && hit.id).toBe(estimateId);
    });

    test('an assessment booking never offers "accept your estimate"', async () => {
      const { customerId } = await fixture(mockTransaction);
      const assessmentId = await assessmentVisit(mockTransaction, customerId);
      expect(await resolver()({ customerId, scheduledServiceId: assessmentId })).toBeNull();
    });
  });
});
