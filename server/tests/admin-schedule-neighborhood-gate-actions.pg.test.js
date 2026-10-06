/**
 * GET /api/admin/schedule: what the day feed gives the field screen so a
 * technician can add a neighborhood gate code or mark one wrong
 * (GATE_NEIGHBORHOOD_TECH_ACTIONS, owner ruling 2026-10-03).
 *
 * Real migrated PostgreSQL, real router, real adminAuthenticate with a signed
 * staff token (the admin-schedule-customer-sent-photos.pg.test.js pattern).
 * Skipped without DATABASE_URL. Fixtures are deleted in afterAll; synthetic
 * names, addresses and codes only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(60000);

const describeOrSkip = process.env.DATABASE_URL ? describe : describe.skip;
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');

const DATE = '2099-04-16';

describeOrSkip('neighborhood gate actions on GET /api/admin/schedule', () => {
  let db, server, baseUrl, admin, token, customerId, propertyId, neighborhoodId, entryId, visitId;
  const OLD = { access: process.env.GATE_NEIGHBORHOOD_ACCESS, actions: process.env.GATE_NEIGHBORHOOD_TECH_ACTIONS };

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
      .insert({ name: 'Gate Feed Admin', role: 'admin', employment_status: 'active', auth_token_version: 1 }).returning('*');
    token = jwt.sign({ technicianId: admin.id, type: 'access', tokenVersion: 1 }, process.env.JWT_SECRET);
    customerId = randomUUID();
    await db('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'GateFeed', phone: `+1555${customerId.slice(0, 7)}`,
      address_line1: '100 Synthetic Way', city: 'Bradenton', zip: '34201', active: true,
    });
    [{ id: neighborhoodId }] = await db('neighborhoods').insert({
      name: 'Synthetic Gate Feed', county: 'Manatee', match_key: `manatee|synthetic gate feed ${randomUUID()}`,
      source: 'office', subdivision_names: JSON.stringify([]),
    }).returning('id');
    [{ id: entryId }] = await db('neighborhood_access').insert({
      neighborhood_id: neighborhoodId, access_type: 'keypad', code: '4242', status: 'active', source: 'office',
    }).returning('id');
    propertyId = randomUUID();
    await db('customer_properties').insert({
      id: propertyId, customer_id: customerId, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: true,
      address_line1: '100 Synthetic Way', city: 'Bradenton', zip: '34201', active: true, address_key: randomUUID(),
      neighborhood_id: neighborhoodId, neighborhood_source: 'office',
    });
    visitId = randomUUID();
    await db('scheduled_services').insert({
      id: visitId, customer_id: customerId, property_id: propertyId, scheduled_date: DATE,
      service_type: 'pest_control', status: 'confirmed',
    });
  });

  afterEach(() => {
    for (const [key, value] of [['GATE_NEIGHBORHOOD_ACCESS', OLD.access], ['GATE_NEIGHBORHOOD_TECH_ACTIONS', OLD.actions]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (db) {
      if (visitId) await db('scheduled_services').where({ id: visitId }).del();
      if (propertyId) await db('customer_properties').where({ id: propertyId }).del();
      if (neighborhoodId) await db('neighborhoods').where({ id: neighborhoodId }).del();
      if (customerId) await db('customers').where({ id: customerId }).del();
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

  test('actions gate on: the stop is marked and its neighborhood code carries its entry', async () => {
    process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
    process.env.GATE_NEIGHBORHOOD_TECH_ACTIONS = 'true';
    const row = await feedRow();
    expect(row.neighborhoodGateActions).toBe(true);
    expect(gateAlerts(row)).toEqual([
      { type: 'gate', text: 'Gate: 4242 (neighborhood)', neighborhoodEntryId: entryId, neighborhoodEntryCode: '4242', reportedWrong: false },
    ]);
  });

  test('actions gate off: the feed is what it was (the code line only, no action data)', async () => {
    process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
    delete process.env.GATE_NEIGHBORHOOD_TECH_ACTIONS;
    const row = await feedRow();
    expect(row).not.toHaveProperty('neighborhoodGateActions');
    expect(gateAlerts(row)).toEqual([{ type: 'gate', text: 'Gate: 4242 (neighborhood)' }]);
  });

  test('the actions gate alone does nothing while the directory is off', async () => {
    delete process.env.GATE_NEIGHBORHOOD_ACCESS;
    process.env.GATE_NEIGHBORHOOD_TECH_ACTIONS = 'true';
    const row = await feedRow();
    expect(row).not.toHaveProperty('neighborhoodGateActions');
    expect(gateAlerts(row)).toEqual([]);
  });
});
