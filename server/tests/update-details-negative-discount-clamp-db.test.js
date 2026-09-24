/**
 * Audit repro r2-sched-update-details-financials-2 — PUT /:id/update-details
 * no-add-on price branch (admin-schedule.js ~10297-10404) accepts a NEGATIVE
 * custom discount amount / a NEGATIVE price and persists estimated_price
 * above gross / below zero.
 *
 * Real Postgres (DATABASE_URL must point at a private clone of waves_audit_tpl).
 * Side-effect services are isolated the same way
 * r2-sched-update-details-financials-1.test.js isolates them.
 *
 * EXPECTED (asserted): the save is refused (4xx) OR the stored estimated_price
 * never exceeds the gross / never goes below zero — the clamp the create path
 * (calculateDiscountDollars, :1790-1815) and the add-on branch (toMoney,
 * :10003-10007) already enforce.
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

const GROSS = 100;

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

async function insertVisit() {
  const [customer] = await db('customers').insert({
    first_name: 'Audit', last_name: 'R2UpdDet2', phone: '5550000043', email: `audit-r2-upddet2-${Date.now()}-${Math.random()}@example.com`,
  }).returning('id');
  const customerId = customer.id || customer;
  const [row] = await db('scheduled_services').insert({
    customer_id: customerId,
    scheduled_date: '2099-01-15',
    service_type: 'Quarterly Pest Control',
    status: 'pending',
    is_recurring: false,
    estimated_price: GROSS,
    primary_line_price: GROSS,
  }).returning('id');
  return { customerId, serviceId: row.id || row };
}

async function readEconomics(serviceId) {
  return db('scheduled_services').where({ id: serviceId })
    .first('estimated_price', 'primary_line_price', 'discount_type', 'discount_amount', 'discount_dollars');
}

async function put(serviceId, body) {
  const res = await fetch(`${baseUrl}/api/admin/schedule/${serviceId}/update-details`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

describe('r2-sched-update-details-financials-2: negative discount / negative price on the no-add-on branch', () => {
  test('custom percentage -50 on a $100 visit must not persist estimated_price above gross', async () => {
    const { serviceId } = await insertVisit();
    const { status, json } = await put(serviceId, { estimatedPrice: GROSS, discountType: 'percentage', discountAmount: -50 });
    const after = await readEconomics(serviceId);
     
    console.log('CASE 1 PUT status', status, JSON.stringify(json).slice(0, 200), '\nafter', JSON.stringify(after));
    if (status === 200) {
      expect(Number(after.estimated_price)).toBeLessThanOrEqual(GROSS);
      expect(Number(after.discount_amount ?? 0)).toBeGreaterThanOrEqual(0);
    } else {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    }
  });

  test('custom fixed_amount -25 on a $100 visit must not persist estimated_price above gross', async () => {
    const { serviceId } = await insertVisit();
    const { status, json } = await put(serviceId, { estimatedPrice: GROSS, discountType: 'fixed_amount', discountAmount: -25 });
    const after = await readEconomics(serviceId);
     
    console.log('CASE 2 PUT status', status, JSON.stringify(json).slice(0, 200), '\nafter', JSON.stringify(after));
    if (status === 200) {
      expect(Number(after.estimated_price)).toBeLessThanOrEqual(GROSS);
    } else {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    }
  });

  test('negative estimatedPrice -40 must be refused or never stored', async () => {
    const { serviceId } = await insertVisit();
    const { status, json } = await put(serviceId, { estimatedPrice: -40 });
    const after = await readEconomics(serviceId);
     
    console.log('CASE 3 PUT status', status, JSON.stringify(json).slice(0, 200), '\nafter', JSON.stringify(after));
    if (status === 200) {
      expect(Number(after.estimated_price)).toBeGreaterThanOrEqual(0);
    } else {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    }
  });

  // Shape 3 from the brief (r1-money-3): an add-on line with a negative
  // per-line discount, via the multi-line `addons` branch of the same
  // handler (no UI editor for this — direct API call only).
  test('add-on line with fixed_amount -25 discount must not persist an inflated add-on price', async () => {
    const { serviceId } = await insertVisit();
    const { status, json } = await put(serviceId, {
      estimatedPrice: GROSS,
      addons: [{ serviceName: 'Fire Ant Treatment', basePrice: 100, discountType: 'fixed_amount', discountAmount: -25 }],
    });
    const addonRows = await db('scheduled_service_addons').where({ scheduled_service_id: serviceId })
      .select('estimated_price', 'discount_amount');
     
    console.log('CASE 4 PUT status', status, JSON.stringify(json).slice(0, 200), '\naddons', JSON.stringify(addonRows));
    if (status === 200) {
      for (const row of addonRows) {
        expect(Number(row.estimated_price)).toBeLessThanOrEqual(100);
      }
    } else {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    }
  });
});
