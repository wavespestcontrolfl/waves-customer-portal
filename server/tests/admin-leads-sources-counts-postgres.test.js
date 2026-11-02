/**
 * GET /api/admin/leads/sources: each source's month and all-time lead and
 * win counts over the prospect scope (scopeToProspects), now taken from one
 * grouped pass instead of four correlated COUNTs per source.
 *
 * Real migrated PostgreSQL, real router, real adminAuthenticate with a signed
 * staff token. Synthetic records only; deleted in afterAll.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(60000);

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');

describeOrSkip('lead source counts on GET /api/admin/leads/sources', () => {
  let db; let server; let baseUrl; let admin; let token;
  const sources = { busy: randomUUID(), empty: randomUUID() };
  const leadIds = [];

  beforeAll(async () => {
    db = require('../models/db');
    const app = express();
    app.use(express.json());
    app.use('/api/admin/leads', require('../routes/admin-leads'));
    app.use((err, req, res, next) => res.status(500).json({ error: String(err && err.message) }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    [admin] = await db('technicians')
      .insert({ name: 'Lead Sources Admin', role: 'admin', employment_status: 'active', auth_token_version: 1 }).returning('*');
    token = jwt.sign({ technicianId: admin.id, type: 'access', tokenVersion: 1 }, process.env.JWT_SECRET);
    await db('lead_sources').insert([
      { id: sources.busy, name: 'Synthetic Counts Busy', source_type: 'website_organic' },
      { id: sources.empty, name: 'Synthetic Counts Empty', source_type: 'website_organic' },
    ]);
    const thisMonth = new Date();
    const lastYear = new Date(Date.now() - 400 * 24 * 3600 * 1000);
    const lead = (status, firstContactAt, extra = {}) => {
      const id = randomUUID();
      leadIds.push(id);
      return {
        id, lead_source_id: sources.busy, status, lead_type: 'inbound_call', first_contact_at: firstContactAt,
        phone: `+1555${id.slice(0, 7)}`, email: `${id.slice(0, 8)}@example.com`, ...extra,
      };
    };
    await db('leads').insert([
      lead('won', thisMonth),
      lead('lost', thisMonth),
      lead('won', lastYear),
      lead('contacted', lastYear),
      lead('spam', thisMonth), // not a prospect
      lead('duplicate', thisMonth), // not a prospect
      lead('won', thisMonth, { deleted_at: thisMonth }), // deleted
    ]);
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (db) {
      if (leadIds.length) await db('leads').whereIn('id', leadIds).del();
      await db('lead_sources').whereIn('id', Object.values(sources)).del();
      if (admin) await db('technicians').where({ id: admin.id }).del();
      await db.destroy();
    }
  });

  test('counts prospects per source: this month, all time, and wins; a source with no leads reads zero', async () => {
    const res = await fetch(`${baseUrl}/api/admin/leads/sources`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const byId = Object.fromEntries((await res.json()).sources.map((s) => [s.id, s]));
    const counts = (s) => ['month_leads', 'month_conversions', 'total_leads', 'total_conversions'].map((k) => Number(s[k]));
    expect(byId[sources.busy]).toMatchObject({ name: 'Synthetic Counts Busy' });
    expect(counts(byId[sources.busy])).toEqual([2, 1, 4, 2]);
    expect(counts(byId[sources.empty])).toEqual([0, 0, 0, 0]);
  });
});
