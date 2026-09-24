/**
 * Audit repro r2-sched-update-details-financials-1 — Edit-appointment save on
 * a discounted NO-add-on visit strips the appointment discount and re-bills
 * at gross.
 *
 * Real Postgres (DATABASE_URL must point at a private clone of waves_audit_tpl).
 * Side-effect services (dispatch broadcast, tech notifications, geocoder,
 * visit-groups, reminders, address briefs) are isolated exactly as
 * tests/admin-arrival-window-save-db.test.js isolates them; the route, its
 * transaction and every scheduled_services read/write are real.
 *
 * Fixture: a pending visit with NO add-on rows whose stored economics are
 * primary_line_price=100 (gross), discount 10% (discount_type='percentage',
 * discount_amount=10), estimated_price=90 (net) — the shape POST create
 * (admin-schedule.js:7214 primary_line_price = pricing.primaryBase) and a prior
 * modal save (:10394 primary_line_price = primaryGross) both leave behind.
 *
 * The Schedule-page Edit modal seeds its Price field from the list DTO through
 * the SHARED deriveLegacyPrimarySubmission (SchedulePage.jsx:1708-1719): the
 * DTO always ships serviceAddons as an array (admin-schedule.js:4945/5207) and
 * primaryLinePrice (:5154), so the seed is the GROSS 100. The modal never seeds
 * the appointment discount (SchedulePage.jsx:2040 useState("")), and with no
 * add-on lines it posts no `addons` key (:2536 sendAddons=false), so an
 * unrelated notes-only save posts { estimatedPrice: 100, notes } and nothing
 * about the discount. This test posts exactly that payload.
 *
 * EXPECTED (asserted): an unrelated save leaves the stored economics alone —
 * estimated_price stays 90 and the discount stamp survives.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'audit-repro-secret';
jest.setTimeout(60000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  adminAuthenticate: (req, _res, next) => {
    req.technician = { id: '10000000-0000-4000-8000-000000000001', role: 'admin' };
    req.technicianId = '10000000-0000-4000-8000-000000000001';
    req.techRole = 'admin';
    next();
  },
}));
jest.mock('../services/dispatch-assignment', () => ({
  ...jest.requireActual('../services/dispatch-assignment'),
  emitDispatchJobUpdate: jest.fn(),
}));
jest.mock('../services/tech-visit-notifications', () => ({
  notifyAssignmentChange: jest.fn().mockResolvedValue(null),
  notifyVisitRescheduled: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/appointment-tagger', () => ({
  classifyAppointmentType: jest.fn(() => ({ tag: 'general' })),
}));
jest.mock('../services/geocoder', () => ({
  ...jest.requireActual('../services/geocoder'), geocodeAddress: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/visit-groups', () => ({
  ...jest.requireActual('../services/visit-groups'),
  maybeGroupRow: jest.fn().mockResolvedValue(null),
  handleChildStopChanged: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/appointment-reminders', () => ({
  releaseMoveHoldIfRepaired: jest.fn().mockResolvedValue(null),
  handleReschedule: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/appointment-address', () => ({
  ...jest.requireActual('../services/appointment-address'),
  refreshAppointmentAddressBriefs: jest.fn().mockResolvedValue(null),
}));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-schedule');
const { deriveLegacyPrimarySubmission } = require('../../shared/legacy-visit-money-submission.cjs');

const GROSS = 100;
const NET = 90;

let server;
let baseUrl;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule', router);
  app.use((error, _req, res, _next) => res.status(error.statusCode || error.status || 500)
    .json({ error: error.message, code: error.code }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.destroy();
});

async function insertDiscountedVisit() {
  const [customer] = await db('customers').insert({
    first_name: 'Audit', last_name: 'R2UpdDet', phone: '5550000042', email: `audit-r2-upddet-${Date.now()}@example.com`,
  }).returning('id');
  const customerId = customer.id || customer;
  const [row] = await db('scheduled_services').insert({
    customer_id: customerId,
    scheduled_date: '2099-01-15',
    service_type: 'Quarterly Pest Control',
    status: 'pending',
    is_recurring: false,
    estimated_price: NET,
    primary_line_price: GROSS,
    discount_type: 'percentage',
    discount_amount: 10,
    discount_dollars: 10,
  }).returning('id');
  return { customerId, serviceId: row.id || row };
}

async function readEconomics(serviceId) {
  return db('scheduled_services').where({ id: serviceId })
    .first('estimated_price', 'primary_line_price', 'discount_type', 'discount_amount', 'discount_dollars', 'notes');
}

describe('r2-sched-update-details-financials-1: unrelated edit on a discounted no-add-on visit', () => {
  test('notes-only save posted the way the Schedule modal posts it keeps estimated_price=90 and the discount stamp', async () => {
    const { serviceId } = await insertDiscountedVisit();
    const before = await readEconomics(serviceId);
    expect(Number(before.estimated_price)).toBe(NET);
    expect(before.discount_type).toBe('percentage');

    // What the Schedule-page modal seeds into its Price field from the list DTO
    // (serviceAddons is ALWAYS an array on the list DTO; primaryLinePrice is the
    // stored gross). This is the shared module the client imports.
    const seededPrice = deriveLegacyPrimarySubmission({
      primaryLinePrice: Number(before.primary_line_price),
      estimatedPrice: Number(before.estimated_price),
      addons: [], // list DTO: addonsByServiceId.get(s.id) || []
    });
    expect(seededPrice).toBe(GROSS); // the modal shows 100, not 90

    // The modal's payload for an unrelated (notes-only) save: no `addons` key
    // (no lines, none initially), estimatedPrice = form.price (the seed),
    // discountType/discountAmount/discountId undefined (never seeded).
    const res = await fetch(`${baseUrl}/api/admin/schedule/${serviceId}/update-details`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ estimatedPrice: seededPrice, notes: 'gate code 1234' }),
    });
    const body = await res.json().catch(() => ({}));
     
    console.log('PUT status', res.status, JSON.stringify(body).slice(0, 300));
    expect(res.status).toBe(200);

    const after = await readEconomics(serviceId);
     
    console.log('economics before', JSON.stringify(before), '\neconomics after ', JSON.stringify(after));

    expect(after.notes).toBe('gate code 1234');
    // EXPECTED: an unrelated save leaves the stored economics untouched.
    expect(Number(after.estimated_price)).toBe(NET);
    expect(after.discount_type).toBe('percentage');
    expect(Number(after.discount_amount)).toBe(10);
    expect(Number(after.discount_dollars)).toBe(10);
    expect(Number(after.primary_line_price)).toBe(GROSS);
  });
});
