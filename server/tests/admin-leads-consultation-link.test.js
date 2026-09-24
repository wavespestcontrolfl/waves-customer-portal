/**
 * GET /api/admin/leads/:id/consultation-link and POST of the same path
 * (lead-inspection-link-scope.md §4) — Virginia's "Send consultation link"
 * action. Same admin-only router gate as every other /admin/leads route.
 *
 * Split (pre-push Codex P2): GET is a read-only AVAILABILITY probe —
 * { available, reason } — that never mints a short code (delegates to
 * consultationLinkAvailable, mocked here — its own eligibility contract is
 * lead-consultation-link.test.js's). POST is the actual mint — { url, line,
 * reason }, via buildLeadConsultationSmsLine (also mocked here — its own
 * render/fallback contract is lead-consultation-link.test.js's too).
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
  consultationLinkAvailable: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const { buildLeadConsultationSmsLine, consultationLinkAvailable } = require('../services/lead-consultation-link');
const router = require('../routes/admin-leads');

let lead;

beforeEach(() => {
  jest.clearAllMocks();
  lead = { id: 'lead-qa', first_name: 'Pat', deleted_at: null, status: 'new', converted_at: null };
  db.mockImplementation((table) => {
    const builder = {
      where: jest.fn(() => builder),
      whereNull: jest.fn(() => builder),
      first: jest.fn(async () => (table === 'leads' ? (lead ? { id: lead.id, first_name: lead.first_name, status: lead.status, converted_at: lead.converted_at } : undefined) : undefined)),
    };
    return builder;
  });
});

async function request(method, leadId = 'lead-qa', token = 'admin') {
  const app = express();
  app.use(express.json());
  app.use('/admin/leads', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/leads/${leadId}/consultation-link`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const get = (leadId, token) => request('GET', leadId, token);
const post = (leadId, token) => request('POST', leadId, token);

describe('GET /:id/consultation-link — availability probe, never mints', () => {
  test('403 for technicians — same router-wide admin gate as every other /admin/leads route', async () => {
    const { status, body } = await get('lead-qa', 'tech');
    expect(status).toBe(403);
    expect(body.error).toMatch(/Admin access required/);
    expect(consultationLinkAvailable).not.toHaveBeenCalled();
  });

  test('delegates to consultationLinkAvailable and returns its result verbatim', async () => {
    consultationLinkAvailable.mockResolvedValue({ available: true });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(consultationLinkAvailable).toHaveBeenCalledWith('lead-qa');
    expect(body).toEqual({ available: true });
    // The read-only probe never touches the builder — no short code minted.
    expect(buildLeadConsultationSmsLine).not.toHaveBeenCalled();
  });

  test('gate off (or otherwise unavailable): passes the reason straight through, 200 not 404', async () => {
    consultationLinkAvailable.mockResolvedValue({
      available: false,
      reason: 'Consultation links are switched off (GATE_LEAD_INSPECTION_LINK)',
    });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual({
      available: false,
      reason: 'Consultation links are switched off (GATE_LEAD_INSPECTION_LINK)',
    });
  });

  test('a closed/converted lead: available:false with the specific reason, straight from the service', async () => {
    consultationLinkAvailable.mockResolvedValue({ available: false, reason: 'That lead has already converted or closed' });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual({ available: false, reason: 'That lead has already converted or closed' });
    expect(buildLeadConsultationSmsLine).not.toHaveBeenCalled();
  });
});

describe('POST /:id/consultation-link — the actual mint, fired only on Send', () => {
  test('403 for technicians — same router-wide admin gate as every other /admin/leads route', async () => {
    const { status, body } = await post('lead-qa', 'tech');
    expect(status).toBe(403);
    expect(body.error).toMatch(/Admin access required/);
    expect(buildLeadConsultationSmsLine).not.toHaveBeenCalled();
  });

  test('404 for a missing or deleted lead', async () => {
    lead = null;
    const { status, body } = await post('lead-gone');
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
    const { status, body } = await post();
    expect(status).toBe(200);
    expect(buildLeadConsultationSmsLine).toHaveBeenCalledWith('lead-qa', 'Pat');
    expect(body).toEqual({
      url: null,
      line: '',
      reason: 'Consultation links are switched off (GATE_LEAD_INSPECTION_LINK)',
    });
  });

  // Pre-push Codex P1 (an earlier round): the same early filter this route
  // already had before the GET/POST split — a closed or converted lead is
  // unavailable up front, with no short code minted for a doomed link.
  test('a CLOSED lead (e.g. disqualified) is unavailable up front — no link minted, builder never called', async () => {
    lead.status = 'disqualified';
    const { status, body } = await post();
    expect(status).toBe(200);
    expect(body).toEqual({ url: null, line: '', reason: 'That lead has already converted or closed' });
    expect(buildLeadConsultationSmsLine).not.toHaveBeenCalled();
  });

  test('a CONVERTED lead (converted_at set) is unavailable up front — no link minted, builder never called', async () => {
    lead.status = 'won';
    lead.converted_at = new Date('2026-01-01');
    const { status, body } = await post();
    expect(status).toBe(200);
    expect(body).toEqual({ url: null, line: '', reason: 'That lead has already converted or closed' });
    expect(buildLeadConsultationSmsLine).not.toHaveBeenCalled();
  });

  test('gate on: returns the rendered url/line for the Leads-page composer to insert', async () => {
    buildLeadConsultationSmsLine.mockResolvedValue({
      url: 'https://waves.link/l/abc123',
      line: "Hi Pat, it's Waves. Pick a time for us to stop by for a free consultation: https://waves.link/l/abc123\n\nOr reply here and we'll set it up.\n\nReply STOP to opt out.\n\n",
      standalone: true,
    });
    const { status, body } = await post();
    expect(status).toBe(200);
    expect(body.url).toBe('https://waves.link/l/abc123');
    expect(body.line).toContain("Hi Pat, it's Waves.");
    expect(body.standalone).toBe(true);
  });
});
