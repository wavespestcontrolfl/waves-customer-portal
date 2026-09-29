/**
 * Real PUT /api/estimates/:token/accept on Postgres, synthetic data only.
 *
 * A slot-reserved accept of a multi-service estimate books one row per service
 * on the first day (same window + technician) and mints ONE first-application
 * draft invoice on the anchor. Those rows must form ONE open service_visits
 * stop (behavior_version 2) so the technician closes once through combined
 * closeout. The hold row carries no property_id, so grouping only becomes
 * possible once the accept links the property — and that has to happen BEFORE
 * the invoice attaches, because createOrJoinVisit refuses any row that already
 * carries an invoice or service record (child_artifact, codex #3590 r13).
 * That refusal stays: the last cases pin it for real completion artifacts.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATA_HYGIENE_VAULT_KEY = process.env.DATA_HYGIENE_VAULT_KEY
  || 'test-vault-key-0123456789abcdef0123456789abcdef';
for (const gate of ['GATE_VISIT_COMBINED_CAPACITY', 'GATE_SEPARATE_COMBO_VISITS', 'GATE_SCHEDULING_CAPACITY',
  'GATE_BOOK_CAPACITY_COMMIT', 'GATE_VISIT_GROUPS', 'GATE_VISIT_CLOSEOUT', 'GATE_CUSTOMER_PROPERTIES',
  'GATE_BOOKING_PAY_AT_VISIT']) process.env[gate] = 'true';

jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../models/db', () => new Proxy((...args) => mockPg(...args), {
  get: (_, key) => (typeof mockPg[key] === 'function' ? mockPg[key].bind(mockPg) : mockPg[key]),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/twilio', () => new Proxy({}, { get: () => jest.fn(async () => ({ sid: 'SMstub' })) }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: false, blocked: true, code: 'test_stub' })),
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
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ suppressed: true })) }));
jest.mock('../services/admin-unread', () => ({ getUnreadCountForAdmin: jest.fn(async () => ({ count: 0, at: Date.now() })) }));
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
const SHRUB = { service: 'tree_shrub', name: 'Tree & Shrub', visitsPerYear: 9, frequency: 'every_6_weeks',
  annual: 900, mo: 75, perTreatment: 100 };

async function http(method, url, body) {
  const response = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, json };
}

async function wipe() {
  // Route-driven cases commit on pooled connections, so they cannot roll
  // back. Only ever runs against the private waves_qa_<hex> dev database.
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

/** Existing customer with a primary property row; the estimate carries an
 * address but NO property_id (the reserved hold row gets none either). */
async function seedEstimate(services, { withCustomer = true } = {}) {
  const customerId = withCustomer ? randomUUID() : null;
  const phone = `+1941555${String(1000 + Math.floor(Math.random() * 8999))}`;
  if (customerId) {
    await mockPg('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Grouping',
      email: `${customerId}@example.invalid`, phone, active: true, property_type: 'residential',
      address_line1: '100 Example Court', city: 'Parrish', state: 'FL', zip: '34219',
      pipeline_stage: 'active_customer', autopay_enabled: false });
    await mockPg('customer_properties').insert({ id: randomUUID(), customer_id: customerId, is_primary: true,
      active: true, address_line1: '100 Example Court', city: 'Parrish', state: 'FL', zip: '34219', source: 'backfill' });
  }
  const estimateId = randomUUID();
  const token = hex() + hex();
  const monthly = services.reduce((sum, s) => sum + s.mo, 0);
  await mockPg('estimates').insert({ id: estimateId, customer_id: customerId, status: 'sent',
    token, sent_at: new Date(), expires_at: new Date(Date.now() + 5 * 86400000), category: 'RESIDENTIAL',
    address: '100 Example Court, Parrish, FL 34219', customer_name: 'Synthetic Grouping',
    customer_phone: phone, customer_email: `est-${estimateId}@example.invalid`,
    monthly_total: monthly, annual_total: monthly * 12, source: 'admin', bill_by_invoice: false,
    estimate_data: JSON.stringify({ result: { recurring: { services } } }) });
  return { estimateId, token, customerId };
}

async function reserveAndAccept(token, services) {
  const selectedFrequency = 'quarterly';
  const serviceCadences = Object.fromEntries(services.filter((s) => s.service !== 'pest_control')
    .map((s) => [s.service, s.frequency]));
  const qs = new URLSearchParams({ selectedFrequency,
    ...(Object.keys(serviceCadences).length ? { serviceCadences: JSON.stringify(serviceCadences) } : {}) });
  const slots = await http('GET', `/api/public/estimates/${token}/available-slots?${qs}`);
  const list = slots.json?.primary || slots.json?.availableSlots || [];
  expect(list.length).toBeGreaterThan(0);
  const extra = Object.keys(serviceCadences).length ? { serviceCadences } : {};
  const reserve = await http('POST', `/api/public/estimates/${token}/reserve`,
    { slotId: list[0].slotId, selectedFrequency, ...extra });
  expect(reserve.status).toBe(201);
  const accept = await http('PUT', `/api/estimates/${token}/accept`, { paymentMethodPreference: 'pay_at_visit',
    serviceMode: 'recurring', slotId: list[0].slotId, selectedFrequency, ...extra });
  if (accept.status !== 200) throw new Error(`accept failed: ${JSON.stringify(accept)}`);
  return { holdId: reserve.json.scheduledServiceId };
}

async function firstDayRows(estimateId) {
  const parents = await mockPg('scheduled_services').where({ source_estimate_id: estimateId })
    .whereNull('recurring_parent_id').orderBy('id');
  const firstDate = parents.map((row) => ymd(row.scheduled_date)).sort()[0];
  return parents.filter((row) => ymd(row.scheduled_date) === firstDate);
}

postgres('first-day rows of a combined booking form one stop at accept (real accept route)', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname) || !['localhost', '127.0.0.1'].includes(url.hostname)) {
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
    await seedTechnician();
  });

  test.each([
    ['2-service pest + lawn', [PEST, LAWN]],
    ['3-service pest + lawn + tree & shrub', [PEST, LAWN, SHRUB]],
  ])('%s: every first-day row lands in one open behavior-v2 visit and the invoice is unchanged', async (_name, services) => {
    const { estimateId, token, customerId } = await seedEstimate(services);
    const { holdId } = await reserveAndAccept(token, services);
    // The reserved hold carries no property until the accept links one.
    const rows = await firstDayRows(estimateId);
    expect(rows).toHaveLength(services.length);
    expect(rows.some((row) => row.id === holdId)).toBe(true);

    const visitIds = [...new Set(rows.map((row) => row.visit_id))];
    expect(visitIds).toHaveLength(1);
    expect(visitIds[0]).toBeTruthy();
    const visit = await mockPg('service_visits').where({ id: visitIds[0] }).first();
    expect(visit).toMatchObject({ status: 'open', behavior_version: 2, customer_id: customerId });
    expect(await mockPg('scheduled_services').where({ visit_id: visit.id }).count('id as n').first())
      .toMatchObject({ n: String(services.length) });
    expect(rows.every((row) => row.property_id && row.property_id === visit.property_id)).toBe(true);
    expect(new Set(rows.map((row) => `${row.window_start}-${row.window_end}`)).size).toBe(1);
    expect(new Set(rows.map((row) => row.technician_id)).size).toBe(1);

    // One first-application draft invoice, still attached to the anchor, still
    // covering every first-day row, with its amount untouched by grouping.
    const invoices = await mockPg('invoices').where({ customer_id: customerId });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ status: 'draft', scheduled_service_id: holdId });
    expect(Number(invoices[0].total)).toBe(services.reduce((sum, s) => sum + s.perTreatment, 0));
    expect(rows.every((row) => row.first_application_invoice_id === invoices[0].id)).toBe(true);
    expect(await mockPg('service_records').where({ customer_id: customerId })).toHaveLength(0);

    // Later-quarter children still group through the unchanged post-commit pass.
    const children = await mockPg('scheduled_services').where({ source_estimate_id: estimateId })
      .whereNotNull('recurring_parent_id');
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((row) => row.property_id === rows[0].property_id)).toBe(true);
  });

  test('a new lead is created and linked in the accept, and its first-day rows still form one stop', async () => {
    const services = [PEST, LAWN];
    const { estimateId, token } = await seedEstimate(services, { withCustomer: false });
    await reserveAndAccept(token, services);
    const rows = await firstDayRows(estimateId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.visit_id)).size).toBe(1);
    expect(rows[0].visit_id).toBeTruthy();
    expect(await mockPg('service_visits').where({ id: rows[0].visit_id }).first())
      .toMatchObject({ status: 'open', behavior_version: 2 });
  });

  test('with the customer-properties gate off the accept behaves as before (no early link, rows ungrouped)', async () => {
    const services = [PEST, LAWN];
    const { estimateId, token } = await seedEstimate(services);
    process.env.GATE_CUSTOMER_PROPERTIES = 'false';
    try {
      await reserveAndAccept(token, services);
    } finally {
      process.env.GATE_CUSTOMER_PROPERTIES = 'true';
    }
    const rows = await firstDayRows(estimateId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.visit_id == null && row.property_id == null)).toBe(true);
    expect(await mockPg('service_visits')).toHaveLength(0);
  });
});

postgres('createOrJoinVisit still refuses rows carrying a real completion artifact (codex #3590 r13)', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname) || !['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('Use the verified private waves_qa dev database');
    }
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  });
  afterAll(async () => {
    if (mockPg) {
      await wipe();
      await mockPg.destroy();
    }
  });
  beforeEach(wipe);

  async function pair() {
    const customerId = randomUUID();
    const technicianId = await seedTechnician();
    const propertyId = randomUUID();
    await mockPg('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Artifact',
      email: `${customerId}@example.invalid`, phone: '+19415550188', active: true, property_type: 'residential',
      address_line1: '300 Example Court', city: 'Parrish', state: 'FL', zip: '34219', pipeline_stage: 'active_customer' });
    await mockPg('customer_properties').insert({ id: propertyId, customer_id: customerId, is_primary: true,
      active: true, address_line1: '300 Example Court', city: 'Parrish', state: 'FL', zip: '34219', source: 'backfill' });
    const catalogs = await mockPg('services').whereIn('service_key', ['pest_general_quarterly', 'lawn_care_recurring']);
    expect(catalogs).toHaveLength(2);
    const date = ymd(new Date(Date.now() + 20 * 86400000));
    const rows = [];
    for (const catalog of catalogs) {
      const [row] = await mockPg('scheduled_services').insert({ customer_id: customerId, property_id: propertyId,
        technician_id: technicianId, service_id: catalog.id, service_type: catalog.name, scheduled_date: date,
        window_start: '09:00', window_end: '11:00', status: 'pending', estimated_duration_minutes: 60 }).returning('*');
      rows.push(row);
    }
    return { customerId, propertyId, rows };
  }

  test('control: two clean rows group', async () => {
    const { rows } = await pair();
    const visit = await require('../services/visit-groups').createOrJoinVisit({ rows, createdBy: 'test' });
    expect(visit).toMatchObject({ status: 'open' });
    expect(await mockPg('scheduled_services').whereIn('id', rows.map((r) => r.id)).whereNotNull('visit_id')).toHaveLength(2);
  });

  test('a row with an invoice is refused', async () => {
    const { customerId, rows } = await pair();
    await mockPg('invoices').insert({ id: randomUUID(), customer_id: customerId, scheduled_service_id: rows[0].id,
      status: 'draft', title: 'First Service Application', total: 120, subtotal: 120, line_items: JSON.stringify([]),
      token: hex(), invoice_number: `SYN-${Date.now()}` });
    await expect(require('../services/visit-groups').createOrJoinVisit({ rows, createdBy: 'test' }))
      .rejects.toThrow(/child_artifact/);
    expect(await mockPg('service_visits')).toHaveLength(0);
  });

  test('a row with a service record is refused', async () => {
    const { customerId, rows } = await pair();
    await mockPg('service_records').insert({ id: randomUUID(), customer_id: customerId, scheduled_service_id: rows[1].id,
      service_date: ymd(new Date()), service_type: 'Quarterly Pest Control', status: 'completed' });
    await expect(require('../services/visit-groups').createOrJoinVisit({ rows, createdBy: 'test' }))
      .rejects.toThrow(/child_artifact/);
    expect(await mockPg('service_visits')).toHaveLength(0);
  });
});
