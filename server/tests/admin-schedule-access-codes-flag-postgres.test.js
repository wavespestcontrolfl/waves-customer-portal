/**
 * GET /api/admin/schedule: GATE_SCHEDULE_ACCESS_CODES (owner ruling
 * 2026-10-26) marks each day row `scheduleAccessEnabled` so the office
 * schedule draws the row's gate lines; off, the row is what it was. The gate
 * lines themselves (propertyAlerts) never change with it.
 *
 * Real migrated PostgreSQL, real router, real adminAuthenticate with a signed
 * staff token (the admin-schedule-neighborhood-gate-actions.pg.test.js
 * pattern). Fixtures are deleted in afterAll; synthetic names, addresses and
 * codes only.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(60000);

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');

const DATE = '2099-04-17';

postgres('scheduleAccessEnabled on GET /api/admin/schedule', () => {
  let db, server, baseUrl, admin, token, customerId, propertyId, visitId;
  const OLD = process.env.GATE_SCHEDULE_ACCESS_CODES;

  beforeAll(async () => {
    db = require('../models/db');
    const app = express();
    app.use(express.json());
    app.use('/api/admin/schedule', require('../routes/admin-schedule'));
    app.use((err, req, res, next) => res.status(500).json({ error: String(err && err.message) }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    [admin] = await db('technicians')
      .insert({ name: 'Access Flag Admin', role: 'admin', employment_status: 'active', auth_token_version: 1 }).returning('*');
    token = jwt.sign({ technicianId: admin.id, type: 'access', tokenVersion: 1 }, process.env.JWT_SECRET);
    customerId = randomUUID();
    await db('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'AccessFlag', phone: `+1555${customerId.slice(0, 7)}`,
      address_line1: '200 Synthetic Way', city: 'Bradenton', zip: '34201', active: true,
    });
    await db('property_preferences').insert({ customer_id: customerId, neighborhood_gate_code: '#1234', lockbox_code: '5678' });
    propertyId = randomUUID();
    await db('customer_properties').insert({
      id: propertyId, customer_id: customerId, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: true,
      address_line1: '200 Synthetic Way', city: 'Bradenton', zip: '34201', active: true, address_key: randomUUID(),
    });
    visitId = randomUUID();
    await db('scheduled_services').insert({
      id: visitId, customer_id: customerId, property_id: propertyId, scheduled_date: DATE,
      service_type: 'pest_control', status: 'confirmed',
    });
  });

  afterEach(() => {
    if (OLD === undefined) delete process.env.GATE_SCHEDULE_ACCESS_CODES;
    else process.env.GATE_SCHEDULE_ACCESS_CODES = OLD;
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (db) {
      if (visitId) await db('scheduled_services').where({ id: visitId }).del();
      if (propertyId) await db('customer_properties').where({ id: propertyId }).del();
      if (customerId) {
        await db('property_preferences').where({ customer_id: customerId }).del();
        await db('customers').where({ id: customerId }).del();
      }
      if (admin) await db('technicians').where({ id: admin.id }).del();
      await db.destroy();
    }
  });

  const feedRow = async () => {
    const res = await fetch(`${baseUrl}/api/admin/schedule?date=${DATE}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    return (await res.json()).services.find((s) => s.id === visitId);
  };
  const gateAlerts = (row) => row.propertyAlerts.filter((a) => a.type === 'gate');
  const LINES = [{ type: 'gate', text: 'Gate: #1234' }, { type: 'gate', text: 'Lockbox: 5678' }];

  test('on: the row is marked and carries its gate lines', async () => {
    process.env.GATE_SCHEDULE_ACCESS_CODES = 'true';
    const row = await feedRow();
    expect(row.scheduleAccessEnabled).toBe(true);
    expect(gateAlerts(row)).toEqual(LINES);
  });

  test('off, or any value but exactly "true": the row is what it was', async () => {
    for (const value of [undefined, 'TRUE', '1', 'yes']) {
      if (value === undefined) delete process.env.GATE_SCHEDULE_ACCESS_CODES;
      else process.env.GATE_SCHEDULE_ACCESS_CODES = value;
      const row = await feedRow();
      expect(row).not.toHaveProperty('scheduleAccessEnabled');
      expect(gateAlerts(row)).toEqual(LINES);
    }
  });
});
