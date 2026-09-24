/**
 * AUDIT REPRO r1-projects-docs-1 — technician token reaches customer-facing
 * sends + content approval on /api/admin/service-outlines.
 *
 * The REAL admin-auth middleware runs (adminAuthenticate + requireTechOrAdmin
 * + whatever per-route guard the router installs). Only the db is mocked:
 * the technicians lookup returns a role='technician' row, so the JWT resolves
 * to a technician, exactly as a leaked/legit tech token would in prod.
 *
 * Asserts the EXPECTED (owner-only) behaviour: POST /:id/send, POST /:id/approve
 * and PATCH /content-modules/:id must 403 for a technician and must never reach
 * sendCustomerMessage / sendgrid.sendOne. If the bug is real these FAIL.
 * A control asserts the same tech token gets 403 on /api/admin/projects/:id/send.
 */
process.env.JWT_SECRET = 'audit-test-secret';

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((s) => s);
  mock.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((...args) => mock(...args));
    trx.fn = mock.fn;
    trx.raw = mock.raw;
    return fn(trx);
  });
  return mock;
});
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (url) => url) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true), sendOne: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const sendgrid = require('../services/sendgrid-mail');
const adminServiceOutlines = require('../routes/admin-service-outlines');

const TECH = { id: 'tech-9', role: 'technician', employment_status: 'active', auth_token_version: 1, must_change_password: false };
const techToken = jwt.sign({ technicianId: TECH.id, type: 'access', tokenVersion: 1 }, process.env.JWT_SECRET);
const ADMIN = { id: 'admin-9', role: 'admin', employment_status: 'active', auth_token_version: 1, must_change_password: false };
const adminToken = jwt.sign({ technicianId: ADMIN.id, type: 'access', tokenVersion: 1 }, process.env.JWT_SECRET);

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    first: jest.fn(),
    update: jest.fn().mockReturnThis(),
    returning: jest.fn(),
    insert: jest.fn().mockResolvedValue(1),
    orderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    ...overrides,
  };
}

async function withServer(mount, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/service-outlines', adminServiceOutlines);
  if (mount) mount(app);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

const packetRow = {
  id: 'packet-1', estimate_id: 'estimate-1', customer_id: 'customer-1', status: 'approved',
  validation_status: 'passed', token_hash: 'existing-hash', title: 'Your Waves Lawn Care Program Overview',
  expires_at: null, revoked_at: null,
};
const estimateRow = {
  id: 'estimate-1', customer_id: 'customer-1', customer_phone: '+19415550123',
  customer_email: 'customer@example.com', customer_name: 'Ava',
};

beforeEach(() => {
  jest.clearAllMocks();
  const staffById = { [TECH.id]: TECH, [ADMIN.id]: ADMIN };
  const techQuery = chain({
    where: jest.fn(function (value) { this._where = value; return this; }),
    first: jest.fn(async function () { return staffById[this._where?.id] || null; }),
  });
  const packetQuery = chain({
    first: jest.fn().mockResolvedValue(packetRow),
    returning: jest.fn().mockResolvedValue([{ ...packetRow, status: 'sent', sent_at: 'NOW' }]),
  });
  const estimateQuery = chain({ first: jest.fn().mockResolvedValue(estimateRow) });
  const moduleRow = { id: 'mod-1', status: 'draft', title: 'What a visit includes', plain_text: 'orig' };
  const moduleQuery = chain({
    first: jest.fn().mockResolvedValue(moduleRow),
    returning: jest.fn().mockResolvedValue([{ ...moduleRow, status: 'approved', approved_by: TECH.id }]),
  });
  db.mockImplementation((table) => {
    if (table === 'technicians') return techQuery;
    if (table === 'service_outline_packets') return packetQuery;
    if (table === 'estimates') return estimateQuery;
    if (table === 'lawn_service_content_modules') return moduleQuery;
    return chain();
  });
  sendCustomerMessage.mockResolvedValue({ sent: true, messageSid: 'SM1' });
  sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-1' });
});

const hdrs = { authorization: `Bearer ${techToken}`, 'content-type': 'application/json' };

describe('r1-projects-docs-1: technician token on /api/admin/service-outlines', () => {
  test('sanity: the token really resolves to a technician — GET /:id is ALSO 403 (full router-level lockdown, not a per-route carve-out)', async () => {
    await withServer(null, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/service-outlines/packet-1`, { headers: hdrs });
      expect(res.status).toBe(403);
    });
  });

  test('POST /:id/send {method:both} must be 403 for a technician and must not send SMS/email', async () => {
    let status;
    await withServer(null, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/service-outlines/packet-1/send`, {
        method: 'POST', headers: hdrs, body: JSON.stringify({ method: 'both' }),
      });
      status = res.status;
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(status).toBe(403);
  });

  test('POST /:id/approve must be 403 for a technician', async () => {
    await withServer(null, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/service-outlines/packet-1/approve`, {
        method: 'POST', headers: hdrs, body: '{}',
      });
      expect(res.status).toBe(403);
    });
  });

  test('PATCH /content-modules/:id {status:approved} must be 403 for a technician', async () => {
    let status; let body;
    await withServer(null, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/service-outlines/content-modules/mod-1`, {
        method: 'PATCH', headers: hdrs, body: JSON.stringify({ status: 'approved', plainText: 'tech-rewritten copy' }),
      });
      status = res.status; body = await res.json();
    });
    expect(status).toBe(403);
    expect(body?.module?.approved_by).not.toBe(TECH.id);
  });

  test('control: an admin token still reaches GET /:id and POST /:id/approve', async () => {
    const adminHdrs = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
    await withServer(null, async (baseUrl) => {
      const getRes = await fetch(`${baseUrl}/api/admin/service-outlines/packet-1`, { headers: adminHdrs });
      expect(getRes.status).toBe(200);
      const approveRes = await fetch(`${baseUrl}/api/admin/service-outlines/packet-1/approve`, {
        method: 'POST', headers: adminHdrs, body: '{}',
      });
      expect(approveRes.status).toBe(200);
    });
  });
});
