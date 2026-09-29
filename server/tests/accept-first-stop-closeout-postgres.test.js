/**
 * Real PUT /api/estimates/:token/accept on Postgres, synthetic data only:
 *  - the grouped first stop, moved as a whole, is CLOSED OUT through combined
 *    closeout, which adopts the accept invoice unchanged (one charge equal to
 *    its total, no second invoice);
 *  - an invoice-mode multi-service accept keeps today's shape (separate rows —
 *    its invoice is delivered right after commit, so it is never pristine and
 *    grouping it would only produce an unmovable frozen stop);
 *  - a SQL error inside the accept-time linkage is contained by its savepoint:
 *    the accept still commits (ungrouped), it does not abort.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATA_HYGIENE_VAULT_KEY = process.env.DATA_HYGIENE_VAULT_KEY
  || 'test-vault-key-0123456789abcdef0123456789abcdef';
for (const gate of ['GATE_VISIT_COMBINED_CAPACITY', 'GATE_SEPARATE_COMBO_VISITS', 'GATE_SCHEDULING_CAPACITY',
  'GATE_BOOK_CAPACITY_COMMIT', 'GATE_VISIT_GROUPS', 'GATE_VISIT_CLOSEOUT', 'GATE_CUSTOMER_PROPERTIES',
  'GATE_BOOKING_PAY_AT_VISIT', 'GATE_AUTOINVOICE_PRICED_VISITS']) process.env[gate] = 'true';
// The production lane: card on file (draft accept invoice attached, never delivered).
process.env.RECURRING_CARD_ON_FILE = 'true';

jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../models/db', () => new Proxy((...args) => mockPg(...args), {
  get: (_, key) => (typeof mockPg[key] === 'function' ? mockPg[key].bind(mockPg) : mockPg[key]),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/twilio', () => new Proxy({}, { get: () => jest.fn(async () => ({ sid: 'SMstub' })) }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async ({ withSmsHandoff }) => {
    const verdict = withSmsHandoff ? await withSmsHandoff(async () => ({ ok: true })) : { ok: true };
    return verdict.ok === true ? { sent: true } : { sent: false, blocked: true, code: verdict.code };
  }),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({})), notifyCustomer: jest.fn(async () => ({})),
}));
jest.mock('../services/estimate-accepted-email', () => ({ sendEstimateAcceptedOnboarding: jest.fn(async () => ({})) }));
jest.mock('../services/new-recurring-welcome-sms', () => ({
  isNewRecurringSignupCandidate: jest.fn(async () => false), sendNewRecurringWelcome: jest.fn(async () => ({})),
}));
jest.mock('../services/account-membership-email', () => ({ sendMembershipStarted: jest.fn(async () => ({})) }));
jest.mock('../services/tech-visit-notifications', () => ({
  notifyTechVisitChange: jest.fn(async () => {}), notifyAssignmentChange: jest.fn(async () => {}),
}));
jest.mock('../services/push-notifications', () => ({ sendToAdminUsers: jest.fn(async () => ({ sent: 0 })) }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true })),
  loadTemplateByKey: jest.fn(async () => ({ template: { template_key: 'stub' } })),
  activeSuppressionFor: jest.fn(async () => null),
}));
jest.mock('../services/stripe', () => ({
  chargeInvoiceWithSavedCard: jest.fn(),
  retrieveSetupIntent: jest.fn(async () => ({ id: 'seti_stub', status: 'succeeded', payment_method: 'pm_stub', metadata: {} })),
  retrievePaymentMethod: jest.fn(async () => ({ id: 'pm_stub', type: 'card' })),
  savedCardChargeSuppressesAlternateCollection: jest.fn(() => false),
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => {}),
}));
jest.mock('../services/recurring-card-on-file', () => {
  const actual = jest.requireActual('../services/recurring-card-on-file');
  return {
    ...actual,
    verifyRecurringCardIntent: jest.fn(async () => ({ ok: true, paymentMethodId: 'pm_lane_stub', setupIntentId: 'seti_lane_stub', methodType: 'card' })),
    completeRecurringCardEnrollment: jest.fn(async ({ customerId }) => {
      const id = require('node:crypto').randomUUID();
      await mockPg('payment_methods').insert({ id, customer_id: customerId, processor: 'stripe', method_type: 'card',
        stripe_payment_method_id: `pm_lane_${id}`, is_default: true, autopay_enabled: true, exp_month: 12, exp_year: new Date().getUTCFullYear() + 1 });
      await mockPg('customers').where({ id: customerId }).update({ autopay_enabled: true, autopay_payment_method_id: id });
      return { enrolled: true };
    }),
  };
});
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ suppressed: true })) }));
jest.mock('../services/admin-unread', () => ({ getUnreadCountForAdmin: jest.fn(async () => ({ count: 0, at: Date.now() })) }));
jest.mock('../services/customer-card', () => ({ ensureCardForCompletion: jest.fn(async () => {}) }));
jest.mock('../services/referral-engine', () => ({ creditReferralOnFirstService: jest.fn(async () => {}) }));
jest.mock('../services/review-request', () => ({
  enrollPostService: jest.fn(async () => ({ started: true })), completionReviewDelay: jest.fn(() => undefined),
}));
jest.mock('../services/weather-forecast', () => ({
  ...jest.requireActual('../services/weather-forecast'), getDailyRainOutlookBounded: jest.fn(async () => null),
}));
jest.mock('../services/service-report/application-conditions', () => ({ fetchApplicationConditions: jest.fn(async () => null) }));
jest.mock('../services/recap-visit-context', () => ({ buildRecapVisitContext: jest.fn(async () => '') }));
jest.mock('../services/tree-shrub-assessment', () => ({
  ...jest.requireActual('../services/tree-shrub-assessment'), scoreAndStoreTreeShrubAssessment: jest.fn(async () => null),
}));
jest.mock('../services/slot-zone', () => ({ resolveEstimateZone: async () => null, zoneSlugOf: () => null }));
jest.mock('../services/estimate-slot-availability', () => ({
  ...jest.requireActual('../services/estimate-slot-availability'),
  resolveEstimateCoords: jest.fn(async () => require('../services/route-optimizer').HQ),
}));

const knex = require('knex');
const express = require('express');
const { randomUUID } = require('node:crypto');

const connection = process.env.COMBINED_VISIT_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let mockPg;
let server;
let base;
jest.setTimeout(180000);

const hex = () => randomUUID().replaceAll('-', '');
const ymd = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
const PEST = { service: 'pest_control', name: 'Quarterly Pest Control', visitsPerYear: 4, frequency: 'quarterly',
  annual: 480, mo: 40, perTreatment: 120 };
// Bi-monthly (6x) lawn is a retired cadence at accept; every-6-weeks (9x) is sold.
const LAWN = { service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 9, frequency: 'every_6_weeks',
  annual: 1080, mo: 90, perTreatment: 120 };

async function http(method, url, body, headers = {}) {
  const response = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, json };
}

async function wipe() {
  await mockPg.raw('TRUNCATE customers, estimates RESTART IDENTITY CASCADE');
  await mockPg('technicians').where('email', 'like', '%@example.invalid').del();
}

async function seedTechnician() {
  const id = randomUUID();
  await mockPg('technicians').insert({ id, name: 'Synthetic Technician', email: `${id}@example.invalid`,
    password_hash: 'synthetic-not-a-login-hash', role: 'technician', active: true,
    employment_status: 'active', field_dispatchable: true, auth_token_version: 1, must_change_password: false });
  return id;
}

async function seedEstimate(services, { billByInvoice = false } = {}) {
  const customerId = randomUUID();
  const phone = `+1941555${String(1000 + Math.floor(Math.random() * 8999))}`;
  await mockPg('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Closeout',
    email: `${customerId}@example.invalid`, phone, active: true, property_type: 'residential',
    address_line1: '100 Example Court', city: 'Parrish', state: 'FL', zip: '34219',
    pipeline_stage: 'active_customer', autopay_enabled: false });
  await mockPg('customer_properties').insert({ id: randomUUID(), customer_id: customerId, is_primary: true,
    active: true, address_line1: '100 Example Court', city: 'Parrish', state: 'FL', zip: '34219', source: 'backfill' });
  const estimateId = randomUUID();
  const token = hex() + hex();
  const monthly = services.reduce((sum, s) => sum + s.mo, 0);
  await mockPg('estimates').insert({ id: estimateId, customer_id: customerId, status: 'sent',
    token, sent_at: new Date(), expires_at: new Date(Date.now() + 5 * 86400000), category: 'RESIDENTIAL',
    address: '100 Example Court, Parrish, FL 34219', customer_name: 'Synthetic Closeout',
    customer_phone: phone, customer_email: `est-${estimateId}@example.invalid`,
    monthly_total: monthly, annual_total: monthly * 12, source: 'admin', bill_by_invoice: billByInvoice,
    estimate_data: JSON.stringify({ result: { recurring: { services } } }) });
  return { estimateId, token, customerId };
}

async function reserveAndAccept(token, services) {
  const selectedFrequency = 'quarterly';
  const serviceCadences = Object.fromEntries(services.filter((s) => s.service !== 'pest_control')
    .map((s) => [s.service, s.frequency]));
  const extra = Object.keys(serviceCadences).length ? { serviceCadences } : {};
  const qs = new URLSearchParams({ selectedFrequency,
    ...(extra.serviceCadences ? { serviceCadences: JSON.stringify(serviceCadences) } : {}) });
  const slots = await http('GET', `/api/public/estimates/${token}/available-slots?${qs}`);
  const list = slots.json?.primary || slots.json?.availableSlots || [];
  expect(list.length).toBeGreaterThan(0);
  const reserve = await http('POST', `/api/public/estimates/${token}/reserve`,
    { slotId: list[0].slotId, selectedFrequency, ...extra });
  expect(reserve.status).toBe(201);
  const accept = await http('PUT', `/api/estimates/${token}/accept`, { paymentMethodPreference: 'pay_at_visit',
    serviceMode: 'recurring', slotId: list[0].slotId, selectedFrequency, ...extra,
    recurringCardSetupIntentId: 'seti_lane_stub' });
  if (accept.status !== 200) throw new Error(`accept failed: ${JSON.stringify(accept)}`);
  return { holdId: reserve.json.scheduledServiceId };
}

async function firstDayRows(estimateId) {
  const parents = await mockPg('scheduled_services').where({ source_estimate_id: estimateId })
    .whereNull('recurring_parent_id').orderBy('id');
  const firstDate = parents.map((row) => ymd(row.scheduled_date)).sort()[0];
  return parents.filter((row) => ymd(row.scheduled_date) === firstDate);
}

postgres('accept-time stop formation: closeout adoption, invoice mode, savepoint recovery', () => {
  let techId;
  beforeAll(async () => {
    const url = new URL(connection);
    if (!(/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname) || url.pathname === '/waves_test') || !['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('Use the verified private waves_qa dev database');
    }
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
    const realFetch = global.fetch;
    global.fetch = (target, ...rest) => {
      if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(String(target))) return realFetch(target, ...rest);
      return Promise.reject(new Error(`blocked outbound fetch ${target}`));
    };
    const app = express();
    app.use(express.json());
    app.use('/api/estimates', require('../routes/estimate-public'));
    app.use('/api/public/estimates', require('../routes/estimate-slots-public'));
    app.use('/api/tech/services', require('../routes/tech-track'));
    app.use('/api/admin/visit-closeouts', require('../routes/admin-visit-closeouts'));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
    server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mockPg) {
      await wipe();
      await mockPg.destroy();
    }
  });
  beforeEach(async () => {
    await wipe();
    const { HQ } = require('../services/route-optimizer');
    await mockPg('service_zones').where('zone_name', 'Bradenton / Parrish').update({ center_lat: HQ.lat, center_lng: HQ.lng });
    techId = await seedTechnician();
  });

  test('a grouped stop moved as a whole is closed out by combined closeout, which adopts the accept invoice: one charge, no second invoice', async () => {
    const services = [PEST, LAWN];
    const { estimateId, token, customerId } = await seedEstimate(services);
    const { holdId } = await reserveAndAccept(token, services);
    const rows = await firstDayRows(estimateId);
    const visitId = rows[0].visit_id;
    expect(visitId).toBeTruthy();
    // Synthetic estimates carry no per-service pricing rows, so the accept mints
    // one generic line; real priced estimates itemize one member-owned line per
    // service (what closeout adoption matches). Re-itemize the SAME draft the
    // way the accept does for those, total unchanged.
    const { itemizeFirstApplication } = require('../services/estimate-first-application-invoice');
    const lines = await itemizeFirstApplication({ estimateId, customerId, scheduledServiceId: holdId,
      rowAmounts: services.map((service) => ({ service: service.service, name: service.name, amount: service.perTreatment })),
      line: { description: 'First service application', quantity: 1, unit_price: PEST.perTreatment + LAWN.perTreatment },
    }, mockPg);
    const pending = await mockPg('invoices').where({ customer_id: customerId }).first();
    await mockPg('invoices').where({ id: pending.id }).update({ line_items: JSON.stringify(lines) });
    const accepted = await mockPg('invoices').where({ customer_id: customerId }).first();

    // Whole-stop move (started from the NON-anchor member): the invoice date follows.
    const lawn = rows.find((row) => row.id !== holdId);
    const moved = new Date(`${ymd(lawn.scheduled_date)}T12:00:00Z`);
    moved.setUTCDate(moved.getUTCDate() + 7);
    const target = moved.toISOString().slice(0, 10);
    await require('../services/rebooker').reschedule(lawn.id, target,
      `${String(lawn.window_start).slice(0, 5)}-${String(lawn.window_end).slice(0, 5)}`, 'test move', 'admin',
      { overlapAdvisory: true, seriesPolicy: 'single' });
    expect(ymd((await mockPg('invoices').where({ id: accepted.id }).first()).service_date)).toBe(target);
    expect((await mockPg('scheduled_services').whereIn('id', rows.map((r) => r.id))).every((r) => ymd(r.scheduled_date) === target)).toBe(true);

    // The visit day arrives (test-only time travel: rows, stop and the
    // invoice's service date, which the move above proved travel together).
    const { etDateString, addETDays } = require('../utils/datetime-et');
    const { stopBaseKey } = require('../services/visit-groups');
    const arrival = etDateString(addETDays(new Date(), -1));
    await mockPg('scheduled_services').whereIn('id', rows.map((r) => r.id)).update({ scheduled_date: arrival });
    await mockPg('service_visits').where({ id: visitId }).update({ scheduled_date: arrival,
      stop_base_key: stopBaseKey({ propertyId: rows[0].property_id || (await mockPg('scheduled_services').where({ id: holdId }).first()).property_id, scheduledDate: arrival }) });
    await mockPg('invoices').where({ id: accepted.id }).update({ service_date: arrival, due_date: arrival });

    // Card on file was enrolled by the accept's card lane; charge provider stubbed.
    expect((await mockPg('customers').where({ id: customerId }).first()).autopay_enabled).toBe(true);
    const charges = [];
    require('../services/stripe').chargeInvoiceWithSavedCard.mockImplementation(async (invoiceId) => {
      const invoice = await mockPg('invoices').where({ id: invoiceId }).first();
      charges.push({ invoiceId, total: Number(invoice.total) });
      await mockPg('invoices').where({ id: invoiceId }).update({ status: 'paid', paid_at: mockPg.fn.now(), stripe_payment_intent_id: 'pi_stub' });
      return { success: true, status: 'succeeded' };
    });

    const bearer = require('jsonwebtoken').sign({ technicianId: techId, type: 'access', tokenVersion: 1 }, require('../config').jwt.secret);
    const authed = (method, url, body, key) => http(method, url, body, { Authorization: `Bearer ${bearer}`, ...(key ? { 'Idempotency-Key': key } : {}) });
    const onSite = await authed('POST', `/api/tech/services/${holdId}/on-site`);
    if (onSite.status !== 200) throw new Error(`on-site failed: ${JSON.stringify(onSite)}`);
    await mockPg('service_visits').where({ id: visitId }).update({ arrived_at: mockPg.raw("NOW() - INTERVAL '60 minutes'") });
    const item = (serviceId) => ({ serviceId, body: { customerRecap: 'The scheduled service was completed.', visitOutcome: 'completed',
      products: [], areasTreated: [], sendCompletionSms: true, requestReview: true } });
    const done = await authed('POST', `/api/admin/visit-closeouts/${visitId}`, { items: rows.map((r) => item(r.id)) }, randomUUID());
    if (![200, 201, 202].includes(done.status)) throw new Error(`closeout failed: ${JSON.stringify(done)}`);
    if (done.json?.state === 'office_required') throw new Error(`closeout parked for the office: ${JSON.stringify(done.json)}`);

    const invoices = await mockPg('invoices').where({ customer_id: customerId });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ id: accepted.id, status: 'paid', total: accepted.total, line_items: accepted.line_items });
    expect(invoices[0].visit_completion_packet_id).toBeTruthy();
    expect(charges).toEqual([{ invoiceId: accepted.id, total: Number(accepted.total) }]);
    expect(Number(accepted.total)).toBe(PEST.perTreatment + LAWN.perTreatment);
    expect(await mockPg('service_records').where({ customer_id: customerId })).toHaveLength(2);
  });

  test('an invoice-mode multi-service accept keeps separate, individually movable rows (its invoice is delivered right after commit)', async () => {
    const services = [PEST, LAWN];
    const { estimateId, token, customerId } = await seedEstimate(services, { billByInvoice: true });
    const { holdId } = await reserveAndAccept(token, services);
    const rows = await firstDayRows(estimateId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.visit_id == null)).toBe(true);
    expect(await mockPg('service_visits').where({ customer_id: customerId })).toHaveLength(0);
    const invoices = await mockPg('invoices').where({ customer_id: customerId });
    expect(invoices).toHaveLength(1);
    // Delivered at accept (not pristine): grouping it would freeze the stop.
    expect(invoices[0].sent_at || invoices[0].sms_sent_at || invoices[0].email_sent_at || invoices[0].scheduled_send_at
      || invoices[0].status !== 'draft').toBeTruthy();
    // Each row still moves on its own.
    const lawn = rows.find((row) => row.id !== holdId);
    const d = new Date(`${ymd(lawn.scheduled_date)}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    await require('../services/rebooker').reschedule(lawn.id, d.toISOString().slice(0, 10),
      `${String(lawn.window_start).slice(0, 5)}-${String(lawn.window_end).slice(0, 5)}`, 'test move', 'admin',
      { overlapAdvisory: true, seriesPolicy: 'single' });
    expect(ymd((await mockPg('scheduled_services').where({ id: lawn.id }).first()).scheduled_date)).toBe(d.toISOString().slice(0, 10));
  });

  test('a SQL error inside the accept-time linkage is contained by its savepoint: the accept commits, ungrouped', async () => {
    await mockPg.raw(`CREATE OR REPLACE FUNCTION synthetic_fail_first_day_link() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'synthetic linkage failure'; END; $$ LANGUAGE plpgsql`);
    await mockPg.raw(`CREATE TRIGGER synthetic_fail_first_day_link BEFORE UPDATE OF property_id ON scheduled_services
      FOR EACH ROW WHEN (OLD.property_id IS NULL AND NEW.property_id IS NOT NULL)
      EXECUTE FUNCTION synthetic_fail_first_day_link()`);
    try {
      const services = [PEST, LAWN];
      const { estimateId, token, customerId } = await seedEstimate(services);
      await reserveAndAccept(token, services);
      const rows = await firstDayRows(estimateId);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.visit_id == null)).toBe(true);
      // The accept itself committed intact: estimate accepted, one invoice covering both rows.
      expect((await mockPg('estimates').where({ id: estimateId }).first()).status).toBe('accepted');
      const invoices = await mockPg('invoices').where({ customer_id: customerId });
      expect(invoices).toHaveLength(1);
      expect(rows.every((row) => row.first_application_invoice_id === invoices[0].id)).toBe(true);
    } finally {
      await mockPg.raw('DROP TRIGGER IF EXISTS synthetic_fail_first_day_link ON scheduled_services');
      await mockPg.raw('DROP FUNCTION IF EXISTS synthetic_fail_first_day_link()');
    }
  });
});
