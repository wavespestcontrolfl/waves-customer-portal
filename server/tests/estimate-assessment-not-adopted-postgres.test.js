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
  classifyAppointmentType: jest.fn(() => ({ tag: 'service', label: 'Service' })),
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
  const COMMERCIAL_RODENT_DATA = {
    commercialEstimatedPricing: true,
    engineRequest: { profile: { commercialRiskType: 'warehouse_distribution' } },
    customerSelection: { frequency: 'quarterly' },
    setupFeeQuote: { kind: 'rodent_bait_setup', amount: 55 },
    result: {
      totals: { year2mo: 55, year2: 660 },
      lineItems: [
        {
          name: 'Commercial Rodent Bait Stations', service: 'commercial_rodent_bait',
          frequency: 'quarterly', visitsPerYear: 4, monthly: 55, annual: 660,
          monthlyAfterDiscount: 55, annualAfterDiscount: 660,
          taxable: true, discountable: false, excludeFromPctDiscount: true, isCommercial: true,
        },
        { name: 'Bait Station Setup', service: 'rodent_bait_setup', price: 55, taxable: true },
      ],
      recurring: {
        discount: 0,
        monthlyTotal: 55,
        grandTotal: 55,
        services: [{
          name: 'Commercial Rodent Bait Stations', service: 'commercial_rodent_bait',
          frequency: 'quarterly', visitsPerYear: 4, mo: 55, annual: 660,
          perTreatment: 165, taxable: true, discountable: false,
          excludeFromPctDiscount: true, isCommercial: true,
        }],
      },
      oneTime: {
        items: [{ name: 'Bait Station Setup', service: 'rodent_bait_setup', price: 55 }],
        membershipFee: 0,
      },
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

    test('an invoice-only commercial sale keeps its setup off an older $73 job', async () => {
      const { customerId, estimateId } = await fixture(mockTransaction, {
        data: COMMERCIAL_RODENT_DATA, monthly: 55, annual: 660,
      });
      await mockTransaction('customers').where({ id: customerId }).update({ property_type: 'commercial' });
      await mockTransaction('estimates').where({ id: estimateId }).update({
        category: 'COMMERCIAL', status: 'accepted', accepted_at: new Date(),
      });
      const olderId = await visit(mockTransaction, {
        customerId, key: 'rodent_bait_quarterly', type: 'Commercial Rodent Bait Stations', date: CHOSEN_DATE,
        extra: {
          source_estimate_id: estimateId,
          estimated_price: 73,
          pending_setup_fee: 73,
          is_recurring: true,
          recurring_pattern: 'quarterly',
          service_address_line1: '73 Older Visit Lane',
        },
      });
      const olderBefore = await mockTransaction('scheduled_services').where({ id: olderId }).first();

      const result = await EstimateConverter().convertEstimate(estimateId, {
        database: mockTransaction,
        billingTerm: 'prepay_annual',
        prepayInvoiceAmount: 660,
        allowFirstApplicationFallback: false,
        skipAutoSchedule: true,
        requestedFirstVisit: { date: CHOSEN_DATE, windowStart: '13:00', windowEnd: '15:00' },
        autoSendInvoice: false,
        skipMembershipEmail: true,
      });

      expect(result.firstScheduledServiceId).toBeNull();
      expect(await mockTransaction('setup_fee_claims').where({ invoice_id: result.draftInvoiceId }).first())
        .toMatchObject({
          scheduled_service_id: null,
          amount: '55.00',
          estimate_id: estimateId,
          unbooked_commercial_setup: true,
        });
      expect(await mockTransaction('scheduled_services').where({ customer_id: customerId }).select('*'))
        .toEqual([olderBefore]);
    });

    test('the locked overlap check and converted term use the sold occurrence, including an invoice-only sale', async () => {
      const { customerId, estimateId } = await fixture(mockTransaction, { data: COMMERCIAL_RODENT_DATA });
      await mockTransaction('customers').where({ id: customerId }).update({ property_type: 'commercial' });
      await mockTransaction('estimates').where({ id: estimateId }).update({ category: 'COMMERCIAL', status: 'accepted' });
      const today = etDateString();
      await mockTransaction('annual_prepay_terms').insert({
        customer_id: customerId, term_start: today, term_end: ASSESSMENT_DATE, status: 'active', prepay_amount: 660,
      });
      const chosen = await visit(mockTransaction, {
        customerId, key: 'rodent_bait_quarterly', type: 'Commercial Rodent Bait Stations', date: CHOSEN_DATE,
        extra: { source_estimate_id: estimateId, pending_setup_fee: 55, is_recurring: true, recurring_pattern: 'quarterly' },
      });
      const { resolveCommercialPrepaySale } = require('../services/commercial-prepay-sale-visits');
      const { lockAndAssertNoAnnualPrepayOverlap } = require('../routes/admin-customers')._private;
      const unbooked = await resolveCommercialPrepaySale(mockTransaction, customerId, COMMERCIAL_RODENT_DATA);
      expect(unbooked.termStart).toBe(today);
      await expect(lockAndAssertNoAnnualPrepayOverlap(mockTransaction, customerId, unbooked.termStart, false, 'Overlap', estimateId))
        .rejects.toMatchObject({ annualPrepayOverlap: expect.any(Object) });
      await visit(mockTransaction, {
        customerId, key: 'lawn_care_monthly', type: 'Lawn Care', date: today, extra: { source_estimate_id: estimateId },
      });
      const opts = { adoptedExistingAppointmentId: chosen, skipAutoSchedule: true };
      const sale = await resolveCommercialPrepaySale(mockTransaction, customerId, COMMERCIAL_RODENT_DATA, opts);
      expect(sale.termStart).toBe(CHOSEN_DATE);
      await lockAndAssertNoAnnualPrepayOverlap(mockTransaction, customerId, sale.termStart, false, 'Overlap', estimateId);
      const result = await EstimateConverter().convertEstimate(estimateId, {
        ...opts, database: mockTransaction, commercialPrepaySale: sale, billingTerm: 'prepay_annual',
        prepayInvoiceAmount: 660, allowFirstApplicationFallback: false, autoSendInvoice: false, skipMembershipEmail: true,
      });
      const term = await mockTransaction('annual_prepay_terms').where({ id: result.annualPrepayTermId }).first();
      expect(dateOnly(term.term_start)).toBe(sale.termStart);
      expect(term.commercial_setup_series_root_id).toBe(chosen);
    });

    test.each([['completed', 3], ['cancelled', 0]])('collection after the sole booked root is %s creates %i remaining visits', async (status, remaining) => {
      const { customerId, estimateId } = await fixture(mockTransaction, { data: COMMERCIAL_RODENT_DATA });
      await mockTransaction('customers').where({ id: customerId }).update({ property_type: 'commercial' });
      await mockTransaction('estimates').where({ id: estimateId }).update({ category: 'COMMERCIAL', status: 'accepted' });
      const rootId = await visit(mockTransaction, {
        customerId, key: 'rodent_bait_quarterly', type: 'Commercial Rodent Bait Stations', date: etDateString(),
        extra: { pending_setup_fee: 55, is_recurring: true, recurring_pattern: 'quarterly', estimated_price: 165 },
      });
      const result = await EstimateConverter().convertEstimate(estimateId, {
        database: mockTransaction, billingTerm: 'prepay_annual', prepayInvoiceAmount: 660,
        allowFirstApplicationFallback: false, skipAutoSchedule: true, adoptedExistingAppointmentId: rootId,
        autoSendInvoice: false, skipMembershipEmail: true,
      });
      const children = () => mockTransaction('scheduled_services').where({ recurring_parent_id: rootId });
      expect(await children()).toHaveLength(0);
      await mockTransaction('scheduled_services').where({ id: rootId }).update({ status });
      await mockTransaction('invoices').where({ id: result.draftInvoiceId }).update({ status: 'paid', paid_at: new Date() });
      const renewals = require('../services/annual-prepay-renewals');
      await renewals.syncTermForInvoicePayment(result.draftInvoiceId, mockTransaction);
      await renewals.syncTermForInvoicePayment(result.draftInvoiceId, mockTransaction);
      const visits = await children();
      expect(visits).toHaveLength(remaining);
      for (const row of visits) {
        expect(row).toMatchObject({ customer_id: customerId, annual_prepay_term_id: result.annualPrepayTermId, prepaid_method: 'annual_prepay_invoice' });
      }
    });

    test('a freshly committed commercial root is promoted and seeds its recurring successors', async () => {
      const { customerId, estimateId } = await fixture(mockTransaction, {
        data: COMMERCIAL_RODENT_DATA, monthly: 55, annual: 660,
      });
      await mockTransaction('customers').where({ id: customerId }).update({ property_type: 'commercial' });
      await mockTransaction('estimates').where({ id: estimateId }).update({
        category: 'COMMERCIAL', status: 'accepted', accepted_at: new Date(),
      });
      const rootId = await visit(mockTransaction, {
        customerId, key: 'rodent_bait_quarterly', type: 'Commercial Rodent Bait Stations', date: CHOSEN_DATE,
        extra: {
          source_estimate_id: estimateId,
          estimated_price: 165,
          pending_setup_fee: 55,
          is_recurring: true,
          recurring_pattern: 'quarterly',
        },
      });

      const result = await EstimateConverter().convertEstimate(estimateId, {
        database: mockTransaction,
        billingTerm: 'prepay_annual',
        prepayInvoiceAmount: 660,
        allowFirstApplicationFallback: false,
        skipAutoSchedule: true,
        bookedAppointmentIds: [rootId],
        autoSendInvoice: false,
        skipMembershipEmail: true,
      });

      expect(result.firstScheduledServiceId).toBe(rootId);
      expect(dateOnly((await mockTransaction('annual_prepay_terms')
        .where({ id: result.annualPrepayTermId }).first()).term_start)).toBe(CHOSEN_DATE);
      expect(await mockTransaction('setup_fee_claims').where({ invoice_id: result.draftInvoiceId }).first())
        .toMatchObject({
          scheduled_service_id: rootId,
          estimate_id: estimateId,
          amount: '55.00',
          unbooked_commercial_setup: false,
        });
      expect((await mockTransaction('scheduled_services').where({ id: rootId }).first()).pending_setup_fee).toBeNull();
      const successors = await mockTransaction('scheduled_services')
        .where({ recurring_parent_id: rootId }).orderBy('scheduled_date', 'asc');
      expect(successors).toHaveLength(3);
      expect(successors.every((row) => dateOnly(row.scheduled_date) > CHOSEN_DATE)).toBe(true);
    });

    test('an explicitly adopted commercial root keeps its date and existing series unchanged', async () => {
      const { customerId, estimateId } = await fixture(mockTransaction, {
        data: COMMERCIAL_RODENT_DATA, monthly: 55, annual: 660,
      });
      await mockTransaction('customers').where({ id: customerId }).update({ property_type: 'commercial' });
      await mockTransaction('estimates').where({ id: estimateId }).update({
        category: 'COMMERCIAL', status: 'accepted', accepted_at: new Date(),
      });
      const rootId = await visit(mockTransaction, {
        customerId, key: 'rodent_bait_quarterly', type: 'Commercial Rodent Bait Stations', date: CHOSEN_DATE,
        extra: {
          estimated_price: 165, pending_setup_fee: 55,
          is_recurring: true, recurring_pattern: 'quarterly',
          service_address_line1: '55 Selected Series Lane',
        },
      });
      const existingChildId = await visit(mockTransaction, {
        customerId, key: 'rodent_bait_quarterly', type: 'Commercial Rodent Bait Stations',
        date: etDateString(addETDays(new Date(), 100)),
        extra: { recurring_parent_id: rootId, estimated_price: 165, is_recurring: true, recurring_pattern: 'quarterly' },
      });
      const competingRootId = await visit(mockTransaction, {
        customerId, key: 'rodent_bait_quarterly', type: 'Commercial Rodent Bait Stations', date: ASSESSMENT_DATE,
        extra: {
          source_estimate_id: estimateId,
          estimated_price: 73, pending_setup_fee: 73,
          is_recurring: true, recurring_pattern: 'quarterly',
          service_address_line1: '73 Unrelated Property Way',
        },
      });
      const before = await mockTransaction('scheduled_services')
        .where(function selectedAndCompeting() {
          this.whereIn('id', [rootId, competingRootId]).orWhere({ recurring_parent_id: rootId });
        })
        .orderBy('id');

      const result = await EstimateConverter().convertEstimate(estimateId, {
        database: mockTransaction,
        billingTerm: 'prepay_annual',
        prepayInvoiceAmount: 660,
        allowFirstApplicationFallback: false,
        skipAutoSchedule: true,
        adoptedExistingAppointmentId: rootId,
        bookedAppointmentIds: [competingRootId],
        autoSendInvoice: false,
        skipMembershipEmail: true,
      });

      expect(result.firstScheduledServiceId).toBe(rootId);
      expect(dateOnly((await mockTransaction('annual_prepay_terms')
        .where({ id: result.annualPrepayTermId }).first()).term_start)).toBe(CHOSEN_DATE);
      expect(await mockTransaction('setup_fee_claims').where({ invoice_id: result.draftInvoiceId }).first())
        .toMatchObject({
          scheduled_service_id: rootId,
          estimate_id: estimateId,
          amount: '55.00',
          unbooked_commercial_setup: false,
        });
      const after = await mockTransaction('scheduled_services')
        .where(function selectedAndCompeting() {
          this.whereIn('id', [rootId, competingRootId]).orWhere({ recurring_parent_id: rootId });
        })
        .orderBy('id');
      const rootBefore = before.find((row) => row.id === rootId);
      const rootAfter = after.find((row) => row.id === rootId);
      expect(Number(rootBefore.pending_setup_fee)).toBe(55);
      expect(rootAfter).toEqual({ ...rootBefore, pending_setup_fee: null, updated_at: rootAfter.updated_at });
      expect(after.find((row) => row.id === existingChildId)).toEqual(before.find((row) => row.id === existingChildId));
      expect(after.find((row) => row.id === competingRootId)).toEqual(before.find((row) => row.id === competingRootId));
      expect(before.some((row) => row.id === existingChildId)).toBe(true);

      const term = await mockTransaction('annual_prepay_terms').where({ id: result.annualPrepayTermId }).first();
      expect(term.commercial_setup_series_root_id).toBe(rootId);
      // Four other-property jobs land earlier than this series' children. Even
      // after refund recovery consumes the setup claim, the term keeps its sale scope.
      await mockTransaction('setup_fee_claims').where({ invoice_id: result.draftInvoiceId }).del();
      const unrelatedIds = [competingRootId];
      for (const days of [12, 14, 16, 18]) {
        unrelatedIds.push(await visit(mockTransaction, {
          customerId, key: 'rodent_bait_quarterly', type: 'Commercial Rodent Bait Stations',
          date: etDateString(addETDays(new Date(), days)),
          extra: { recurring_parent_id: competingRootId, estimated_price: 73, service_address_line1: '73 Unrelated Property Way' },
        }));
      }
      const unrelated = () => mockTransaction('scheduled_services').whereIn('id', unrelatedIds).orderBy('id');
      const otherBeforePayment = await unrelated();
      await mockTransaction('invoices').where({ id: result.draftInvoiceId }).update({ status: 'paid', paid_at: new Date() });
      const renewals = require('../services/annual-prepay-renewals');
      await renewals.syncTermForInvoicePayment(result.draftInvoiceId, mockTransaction);
      const coveredVisits = () => mockTransaction('scheduled_services')
        .where({ annual_prepay_term_id: term.id }).orderBy('id');
      const covered = await coveredVisits();
      expect(covered).toHaveLength(4);
      for (const row of covered) {
        expect(row.recurring_parent_id || row.id).toBe(rootId);
        expect(row.prepaid_method).toBe('annual_prepay_invoice');
        if (![rootId, existingChildId].includes(row.id)) expect(row.service_address_line1).toBe('55 Selected Series Lane');
      }
      expect(covered.map((row) => row.id)).toEqual(expect.arrayContaining([rootId, existingChildId]));
      expect(await unrelated()).toEqual(otherBeforePayment);
      await renewals.syncTermForInvoicePayment(result.draftInvoiceId, mockTransaction);
      expect((await coveredVisits()).map((row) => row.id)).toEqual(covered.map((row) => row.id));
      expect(await unrelated()).toEqual(otherBeforePayment);
    });

    test.each([
      ['catalog', 'rodent_bait_quarterly', 'Commercial Rodent Bait Stations'],
      ['catalog with stale label', 'rodent_bait_quarterly', 'Pest Control'],
      ['legacy', null, 'Rodent Bait Stations'],
    ])('a selected %s bait child keeps its cancelled parent as setup owner and its own promised date', async (_kind, serviceKey, serviceType) => {
      const { customerId, estimateId } = await fixture(mockTransaction, {
        data: COMMERCIAL_RODENT_DATA, monthly: 55, annual: 660,
      });
      await mockTransaction('customers').where({ id: customerId }).update({ property_type: 'commercial' });
      await mockTransaction('estimates').where({ id: estimateId }).update({
        category: 'COMMERCIAL', status: 'accepted', accepted_at: new Date(),
      });
      const parentId = await visit(mockTransaction, {
        customerId, key: serviceKey, type: serviceType, date: CHOSEN_DATE,
        extra: {
          status: 'cancelled', estimated_price: 165, pending_setup_fee: 55,
          is_recurring: true, recurring_pattern: 'quarterly',
        },
      });
      const childDate = etDateString(addETDays(new Date(), 42));
      const childId = await visit(mockTransaction, {
        customerId, key: serviceKey, type: serviceType, date: childDate,
        extra: { recurring_parent_id: parentId, estimated_price: 165 },
      });
      const parentBefore = await mockTransaction('scheduled_services').where({ id: parentId }).first();
      const childBefore = await mockTransaction('scheduled_services').where({ id: childId }).first();

      const result = await EstimateConverter().convertEstimate(estimateId, {
        database: mockTransaction,
        billingTerm: 'prepay_annual',
        prepayInvoiceAmount: 660,
        allowFirstApplicationFallback: false,
        skipAutoSchedule: true,
        adoptedExistingAppointmentId: childId,
        autoSendInvoice: false,
        skipMembershipEmail: true,
      });

      expect(result.firstScheduledServiceId).toBe(childId);
      const term = await mockTransaction('annual_prepay_terms').where({ id: result.annualPrepayTermId }).first();
      expect(dateOnly(term.term_start)).toBe(childDate);
      expect(term.commercial_setup_series_root_id).toBe(parentId);
      expect(await mockTransaction('setup_fee_claims').where({ invoice_id: result.draftInvoiceId }).first())
        .toMatchObject({
          scheduled_service_id: parentId,
          estimate_id: estimateId,
          amount: '55.00',
          unbooked_commercial_setup: false,
        });
      const parentAfter = await mockTransaction('scheduled_services').where({ id: parentId }).first();
      expect(Number(parentBefore.pending_setup_fee)).toBe(55);
      expect(parentAfter).toEqual({ ...parentBefore, pending_setup_fee: null, updated_at: parentAfter.updated_at });
      expect(await mockTransaction('scheduled_services').where({ id: childId }).first()).toEqual(childBefore);
      expect(await mockTransaction('scheduled_services').where({ customer_id: customerId }).count('id as count').first())
        .toMatchObject({ count: '2' });
      const otherServiceId = await visit(mockTransaction, {
        customerId, key: 'lawn_care_monthly', type: 'Commercial Rodent Bait Stations', date: childDate,
        extra: { recurring_parent_id: parentId, estimated_price: 73 },
      });
      await mockTransaction('invoices').where({ id: result.draftInvoiceId }).update({ status: 'paid', paid_at: new Date() });
      const renewals = require('../services/annual-prepay-renewals');
      await renewals.syncTermForInvoicePayment(result.draftInvoiceId, mockTransaction);
      const paidChild = await mockTransaction('scheduled_services').where({ id: childId }).first();
      expect(paidChild).toMatchObject({ annual_prepay_term_id: term.id, prepaid_method: 'annual_prepay_invoice' });
      expect(await renewals.annualPrepayCoversVisit(paidChild, mockTransaction, { throwOnError: true })).toBe(true);
      const partialStamp = {
        id: childId, service_type: serviceType, scheduled_date: paidChild.scheduled_date,
        annual_prepay_term_id: term.id, prepaid_method: paidChild.prepaid_method, prepaid_amount: paidChild.prepaid_amount,
      };
      expect(await renewals.annualPrepayCoversVisit(partialStamp, mockTransaction, { throwOnError: true })).toBe(true);
      const otherService = await mockTransaction('scheduled_services').where({ id: otherServiceId }).first();
      expect(otherService).toMatchObject({ annual_prepay_term_id: null, prepaid_method: null });
      expect(Number(otherService.estimated_price)).toBe(73);
      expect(await renewals.annualPrepayCoversVisit({
        ...partialStamp, id: otherServiceId, service_type: otherService.service_type,
      }, mockTransaction, { throwOnError: true })).toBe(false);
    });

    test('an in-flight completion claim on the selected root rejects the prepay and rolls its claim back', async () => {
      const { customerId, estimateId } = await fixture(mockTransaction, {
        data: COMMERCIAL_RODENT_DATA, monthly: 55, annual: 660,
      });
      await mockTransaction('customers').where({ id: customerId }).update({ property_type: 'commercial' });
      await mockTransaction('estimates').where({ id: estimateId }).update({
        category: 'COMMERCIAL', status: 'accepted', accepted_at: new Date(),
      });
      const rootId = await visit(mockTransaction, {
        customerId, key: 'rodent_bait_quarterly', type: 'Commercial Rodent Bait Stations', date: CHOSEN_DATE,
        extra: {
          estimated_price: 165, pending_setup_fee: -55,
          is_recurring: true, recurring_pattern: 'quarterly',
        },
      });

      await expect(mockTransaction.transaction((conversionTrx) => EstimateConverter().convertEstimate(estimateId, {
        database: conversionTrx,
        billingTerm: 'prepay_annual',
        prepayInvoiceAmount: 660,
        allowFirstApplicationFallback: false,
        skipAutoSchedule: true,
        adoptedExistingAppointmentId: rootId,
        autoSendInvoice: false,
        skipMembershipEmail: true,
      }))).rejects.toMatchObject({
        switchConflict: true, status: 409, statusCode: 409,
        message: expect.stringMatching(/completion in progress/),
      });

      expect(Number((await mockTransaction('scheduled_services').where({ id: rootId }).first()).pending_setup_fee)).toBe(-55);
      expect(await mockTransaction('setup_fee_claims').where({ estimate_id: estimateId })).toHaveLength(0);
      expect(await mockTransaction('annual_prepay_terms').where({ source_estimate_id: estimateId })).toHaveLength(0);
    });

    test('a completed selected series with a billed setup cannot become an invoice-only sale', async () => {
      const { customerId, estimateId } = await fixture(mockTransaction, {
        data: COMMERCIAL_RODENT_DATA, monthly: 55, annual: 660,
      });
      await mockTransaction('customers').where({ id: customerId }).update({ property_type: 'commercial' });
      await mockTransaction('estimates').where({ id: estimateId }).update({
        category: 'COMMERCIAL', status: 'accepted', accepted_at: new Date(),
      });
      const rootId = await visit(mockTransaction, {
        customerId, key: 'rodent_bait_quarterly', type: 'Commercial Rodent Bait Stations', date: CHOSEN_DATE,
        extra: { status: 'completed', is_recurring: true, pending_setup_fee: null, estimated_price: 165 },
      });
      const completionId = randomUUID();
      await mockTransaction('invoices').insert({
        id: completionId, customer_id: customerId, scheduled_service_id: rootId, token: randomUUID(),
        invoice_number: 'SETUP-' + completionId.slice(0, 8), title: 'Bait station setup', status: 'paid',
        paid_at: new Date(), subtotal: 55, total: 55, due_date: CHOSEN_DATE, line_items: '[]',
      });
      await mockTransaction('setup_fee_claims').insert({
        invoice_id: completionId, scheduled_service_id: rootId, amount: 55,
      });
      await expect(EstimateConverter().convertEstimate(estimateId, {
        billingTerm: 'prepay_annual', prepayInvoiceAmount: 660, skipAutoSchedule: true,
        adoptedExistingAppointmentId: rootId, autoSendInvoice: false, skipMembershipEmail: true,
      })).rejects.toMatchObject({ statusCode: 409, switchConflict: true });
      expect(await mockTransaction('invoices').where({ customer_id: customerId }).select('id', 'status'))
        .toEqual([{ id: completionId, status: 'paid' }]);
      expect(await mockTransaction('setup_fee_claims').where({ scheduled_service_id: rootId }).select('invoice_id'))
        .toEqual([{ invoice_id: completionId }]);
      expect(await mockTransaction('annual_prepay_terms').where({ source_estimate_id: estimateId })).toHaveLength(0);
    });

    test('the standalone converter rejects an in-flight selected-root claim before its invoice commits', async () => {
      const { customerId, estimateId } = await fixture(mockTransaction, {
        data: COMMERCIAL_RODENT_DATA, monthly: 55, annual: 660,
      });
      await mockTransaction('customers').where({ id: customerId }).update({ property_type: 'commercial' });
      await mockTransaction('estimates').where({ id: estimateId }).update({
        category: 'COMMERCIAL', status: 'accepted', accepted_at: new Date(),
      });
      const rootId = await visit(mockTransaction, {
        customerId, key: 'rodent_bait_quarterly', type: 'Commercial Rodent Bait Stations', date: CHOSEN_DATE,
        extra: {
          estimated_price: 165, pending_setup_fee: -55,
          is_recurring: true, recurring_pattern: 'quarterly',
        },
      });

      // No opts.database: exercise the normal standalone/global converter.
      // The module's db mock delegates to this test's real PG transaction,
      // while the converter's invoice transaction is a real savepoint.
      await expect(EstimateConverter().convertEstimate(estimateId, {
        billingTerm: 'prepay_annual',
        prepayInvoiceAmount: 660,
        allowFirstApplicationFallback: false,
        skipAutoSchedule: true,
        adoptedExistingAppointmentId: rootId,
        autoSendInvoice: false,
        skipMembershipEmail: true,
      })).rejects.toMatchObject({
        switchConflict: true, status: 409, statusCode: 409,
        message: expect.stringMatching(/completion in progress/),
      });

      expect(Number((await mockTransaction('scheduled_services').where({ id: rootId }).first()).pending_setup_fee)).toBe(-55);
      expect(await mockTransaction('invoices').where({ customer_id: customerId })).toHaveLength(0);
      expect(await mockTransaction('setup_fee_claims').where({ estimate_id: estimateId })).toHaveLength(0);
      expect(await mockTransaction('annual_prepay_terms').where({ source_estimate_id: estimateId })).toHaveLength(0);
    });

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
