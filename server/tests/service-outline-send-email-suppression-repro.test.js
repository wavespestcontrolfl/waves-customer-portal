// Audit repro r1-comms-side-effects-1: POST /api/admin/service-outlines/:id/send
// {method:'email'} calls sendgrid.sendOne directly, bypassing the
// email_suppressions list and the customer's portal email opt-out, and is
// reachable by a technician-role token.
//
// Each test asserts the EXPECTED behaviour, so it FAILS on current code if the
// bug is real. Mock pattern copied from ../admin-service-outlines-send-token.test.js.

let mockRole = 'admin';

jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    adminAuthenticate: (req, _res, next) => {
      req.techRole = mockRole;
      req.technicianId = 'staff-1';
      next();
    },
    requireTechOrAdmin: actual.requireTechOrAdmin,
    requireAdmin: actual.requireAdmin,
  };
});

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

jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
}));

jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));

jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({ messageId: 'sg-1' })),
}));

jest.mock('../services/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const sendgrid = require('../services/sendgrid-mail');
const EmailTemplateLibrary = require('../services/email-template-library');
const adminServiceOutlines = require('../routes/admin-service-outlines');

const CUSTOMER_EMAIL = 'optedout@example.com';

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    first: jest.fn(),
    update: jest.fn().mockReturnThis(),
    returning: jest.fn(),
    insert: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
}

// An awaitable chain: `await db('email_suppressions').whereRaw(...).where(...)`
function rowsChain(rows) {
  const c = chain();
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

function packetRow() {
  return {
    id: 'packet-1',
    estimate_id: 'estimate-1',
    customer_id: 'customer-1',
    status: 'approved',
    validation_status: 'passed',
    token_hash: 'existing-token-hash',
    token_last_four: 'old1',
    title: 'Your Waves Lawn Care Program Overview',
    expires_at: null,
    revoked_at: null,
  };
}

function installDb({ suppressions = [], prefs = null } = {}) {
  const row = packetRow();
  const packetQuery = chain({
    first: jest.fn().mockResolvedValue(row),
    returning: jest.fn().mockResolvedValue([{ ...row, status: 'sent', sent_at: 'NOW' }]),
  });
  const estimateQuery = chain({
    first: jest.fn().mockResolvedValue({
      id: 'estimate-1',
      customer_id: 'customer-1',
      customer_phone: '',
      customer_email: CUSTOMER_EMAIL,
      customer_name: 'Ava',
    }),
  });
  const prefsQuery = chain({ first: jest.fn().mockResolvedValue(prefs) });
  const suppressionQuery = rowsChain(suppressions);
  const tokenQuery = chain();

  db.mockImplementation((table) => {
    if (table === 'service_outline_packets') return packetQuery;
    if (table === 'estimates') return estimateQuery;
    if (table === 'service_outline_public_tokens') return tokenQuery;
    if (table === 'email_suppressions') return suppressionQuery;
    if (table === 'notification_prefs') return prefsQuery;
    return rowsChain([]);
  });
  return { packetQuery, suppressionQuery, prefsQuery };
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/service-outlines', adminServiceOutlines);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function postSend(body) {
  const { server, baseUrl } = appServer();
  try {
    const res = await fetch(`${baseUrl}/admin/service-outlines/packet-1/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('r1-comms-side-effects-1: service-outline email send honours opt-outs and is admin-only', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRole = 'admin';
  });

  test('email leg is refused when the address has an active do_not_email suppression', async () => {
    const { packetQuery, suppressionQuery } = installDb({
      suppressions: [{ email: CUSTOMER_EMAIL, status: 'active', suppression_type: 'do_not_email', group_key: null }],
    });
    const spy = jest.spyOn(EmailTemplateLibrary, 'activeSuppressionFor');

    const { status, body } = await postSend({ method: 'email' });

    // Expected: the send is blocked and the packet is NOT stamped 'sent'.
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(packetQuery.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'sent' }));
    // Some suppression lookup must have happened (library helper or a direct query).
    const looked = spy.mock.calls.length > 0 || suppressionQuery.whereRaw.mock.calls.length > 0 || suppressionQuery.where.mock.calls.length > 0;
    expect({ status, outcomes: body.outcomes, suppressionLookedUp: looked }).toEqual(expect.objectContaining({ suppressionLookedUp: true }));
  });

  test('email leg is refused when the customer turned portal email off (notification_prefs.email_enabled=false)', async () => {
    const { packetQuery, prefsQuery } = installDb({
      prefs: { customer_id: 'customer-1', email_enabled: false },
    });

    await postSend({ method: 'email' });

    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(packetQuery.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'sent' }));
    expect(prefsQuery.first).toHaveBeenCalled();
  });

  // A technician-role token reaching this route at all (no requireAdmin) is
  // a separate, already-tracked finding (r1-projects-docs-1 in the audit
  // register) — out of scope for this comms-suppression fix, so it is not
  // asserted here.
});
