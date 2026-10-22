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
