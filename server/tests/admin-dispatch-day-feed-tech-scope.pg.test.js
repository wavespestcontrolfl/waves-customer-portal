/**
 * AUDIT REPRO r1-dispatch-1 — GET /api/admin/dispatch/:date returns every
 * visit on the date (all customers' phones, gate codes, rates, invoice
 * totals) to a technician-role token, unscoped to the tech's assignments.
 *
 * Asserts the EXPECTED behaviour (technician sees only own current
 * assignments, as admin-schedule's scopeToAssignedTech does). FAILS on
 * current code if the bug is real.
 *
 * Real Postgres (DATABASE_URL = private clone of waves_audit_tpl), real
 * router, real adminAuthenticate with a signed staff access token.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'audit-repro-jwt-secret';

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('r1-dispatch-1: technician token scoping on GET /api/admin/dispatch/:date', () => {
  let db, server, baseUrl;
  let techA, techB, custA, custB, svcA, svcB, svcOldB;
  const DATE = '2026-09-22';          // inside the 7-day tech window
  const OLD_DATE = '2024-01-15';      // far outside any tech window

  beforeAll(async () => {
    db = require('../models/db');
    const router = require('../routes/admin-dispatch');
    const app = express();
    app.use(express.json());
    app.use('/api/admin/dispatch', router);
     
    app.use((err, req, res, next) => res.status(500).json({ error: String(err && err.message) }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    [techA] = await db('technicians').insert({ name: 'Audit Tech A', role: 'technician', employment_status: 'active', auth_token_version: 1 }).returning('*');
    [techB] = await db('technicians').insert({ name: 'Audit Tech B', role: 'technician', employment_status: 'active', auth_token_version: 1 }).returning('*');
    [custA] = await db('customers').insert({ first_name: 'CustA', last_name: 'Alpha', phone: '9415550001', email: `audit-a-${Date.now()}@local.test`, address_line1: '1 A St', city: 'Sarasota', state: 'FL', zip: '34231', monthly_rate: 99 }).returning('*');
    [custB] = await db('customers').insert({ first_name: 'CustB', last_name: 'Bravo', phone: '9415550002', email: `audit-b-${Date.now()}@local.test`, address_line1: '2 B St', city: 'Sarasota', state: 'FL', zip: '34231', monthly_rate: 149 }).returning('*');
    await db('property_preferences').insert({ customer_id: custB.id, neighborhood_gate_code: 'GATE-B-7777', garage_code: 'GAR-B-1234', lockbox_code: 'LB-B-9999' });
    [svcA] = await db('scheduled_services').insert({ customer_id: custA.id, technician_id: techA.id, scheduled_date: DATE, service_type: 'Quarterly Pest Control', status: 'confirmed', window_start: '09:00', window_end: '11:00' }).returning('*');
    [svcB] = await db('scheduled_services').insert({ customer_id: custB.id, technician_id: techB.id, scheduled_date: DATE, service_type: 'Quarterly Pest Control', status: 'confirmed', window_start: '13:00', window_end: '15:00', prepaid_amount: 412.5 }).returning('*');
    [svcOldB] = await db('scheduled_services').insert({ customer_id: custB.id, technician_id: techB.id, scheduled_date: OLD_DATE, service_type: 'Quarterly Pest Control', status: 'completed' }).returning('*');
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (db) await db.destroy();
  });

  const tokenFor = (tech) => jwt.sign({ technicianId: tech.id, type: 'access', tokenVersion: 1 }, process.env.JWT_SECRET);
  const get = async (path, tech) => {
    const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${tokenFor(tech)}` } });
    return { status: res.status, body: await res.json() };
  };

  test('technician A on the day feed sees ONLY their own visit — never tech B\'s customer phone / gate codes / rate / prepaid', async () => {
    const { status, body } = await get(`/api/admin/dispatch/${DATE}`, techA);
    expect(status).toBe(200);
    const ids = body.services.map((s) => s.id);
    expect(ids).toContain(svcA.id);                 // sanity: own visit present

    const leaked = body.services.find((s) => s.id === svcB.id);
    // Diagnostic dump of what a tech-A token can read about tech-B's customer:
    if (leaked) {
       
      console.log('[r1-dispatch-1] LEAK tech-A sees tech-B row:', JSON.stringify({
        customerName: leaked.customerName, customerPhone: leaked.customerPhone,
        propertyAlerts: leaked.propertyAlerts, monthlyRate: leaked.monthlyRate,
        prepaidAmount: leaked.prepaidAmount, technicianId: leaked.technicianId,
        address: leaked.address,
      }));
    }
    expect(leaked).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('9415550002');
    expect(JSON.stringify(body)).not.toContain('GATE-B-7777');
    expect(body.techSummary.map((t) => t.technicianId)).not.toContain(techB.id);
  });

  test('technician A on an ancient date sees nothing (no historical enumeration)', async () => {
    const { status, body } = await get(`/api/admin/dispatch/${OLD_DATE}`, techA);
    expect(status).toBe(200);
    expect(body.services.map((s) => s.id)).not.toContain(svcOldB.id);
    expect(JSON.stringify(body)).not.toContain('9415550002');
  });

  test('control: an admin token sees both visits on the day (route stays useful for the office)', async () => {
    const [admin] = await db('technicians').insert({ name: 'Audit Admin', role: 'admin', employment_status: 'active', auth_token_version: 1 }).returning('*');
    const { status, body } = await get(`/api/admin/dispatch/${DATE}`, admin);
    expect(status).toBe(200);
    const ids = body.services.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([svcA.id, svcB.id]));
  });
});
