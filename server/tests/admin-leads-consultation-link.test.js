/**
 * GET /api/admin/leads/:id/consultation-link (lead-inspection-link-scope.md
 * §4) — Virginia's "Send consultation link" action. Same admin-only router
 * gate as every other /admin/leads route; returns { url, line, reason },
 * rendered via buildLeadConsultationSmsLine (mocked here — its own render/
 * fallback contract is lead-consultation-link.test.js's).
 */

jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(async () => ({})); return db; });
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const role = token === 'admin' ? 'admin' : token === 'tech' ? 'technician' : null;
    if (!role) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = { id: `${role}-1`, role };
    req.technicianId = `${role}-1`;
    req.techRole = role;
    return next();
  },
  requireAdmin: (req, res, next) => (
    req.techRole !== 'admin'
      ? res.status(403).json({ error: 'Admin access required' })
      : next()
  ),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/lead-consultation-link', () => ({
  buildLeadConsultationSmsLine: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const { buildLeadConsultationSmsLine } = require('../services/lead-consultation-link');
const router = require('../routes/admin-leads');

let lead;

beforeEach(() => {
  jest.clearAllMocks();
  lead = { id: 'lead-qa', first_name: 'Pat', deleted_at: null };
  db.mockImplementation((table) => {
    const builder = {
      where: jest.fn(() => builder),
      whereNull: jest.fn(() => builder),
      first: jest.fn(async () => (table === 'leads' ? (lead ? { id: lead.id, first_name: lead.first_name } : undefined) : undefined)),
    };
    return builder;
  });
});

async function get(leadId = 'lead-qa', token = 'admin') {
  const app = express();
  app.use(express.json());
  app.use('/admin/leads', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/leads/${leadId}/consultation-link`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('403 for technicians — same router-wide admin gate as every other /admin/leads route', async () => {
  const { status, body } = await get('lead-qa', 'tech');
  expect(status).toBe(403);
  expect(body.error).toMatch(/Admin access required/);
  expect(buildLeadConsultationSmsLine).not.toHaveBeenCalled();
});

test('404 for a missing or deleted lead', async () => {
  lead = null;
  const { status, body } = await get('lead-gone');
  expect(status).toBe(404);
  expect(body.error).toBe('Lead not found');
  expect(buildLeadConsultationSmsLine).not.toHaveBeenCalled();
});

test('gate off (or otherwise unavailable): passes the builder\'s reason straight through, 200 not 404', async () => {
  buildLeadConsultationSmsLine.mockResolvedValue({
    url: null,
    line: '',
    reason: 'Consultation links are switched off (GATE_LEAD_INSPECTION_LINK)',
  });
  const { status, body } = await get();
  expect(status).toBe(200);
  expect(buildLeadConsultationSmsLine).toHaveBeenCalledWith('lead-qa', 'Pat');
  expect(body).toEqual({
    url: null,
    line: '',
    reason: 'Consultation links are switched off (GATE_LEAD_INSPECTION_LINK)',
  });
});

test('gate on: returns the rendered url/line for the Leads-page composer to insert', async () => {
  buildLeadConsultationSmsLine.mockResolvedValue({
    url: 'https://waves.link/l/abc123',
    line: "Hi Pat, it's Waves. Pick a time for us to stop by for a free consultation: https://waves.link/l/abc123\n\nOr reply here and we'll set it up.\n\nReply STOP to opt out.\n\n",
    standalone: true,
  });
  const { status, body } = await get();
  expect(status).toBe(200);
  expect(body.url).toBe('https://waves.link/l/abc123');
  expect(body.line).toContain("Hi Pat, it's Waves.");
  expect(body.standalone).toBe(true);
});
