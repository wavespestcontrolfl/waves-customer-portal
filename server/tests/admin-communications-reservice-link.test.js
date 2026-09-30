/**
 * POST /admin/communications/reservice-link — the SMS composer's "Re-service
 * Link" helper. Identity resolution mirrors /reschedule-link exactly (see
 * admin-communications-reschedule-link.test.js, which covers those rules in
 * depth); these tests instead pin the eligibility predicate this route now
 * shares with the SMS FREE RE-SERVICE fact and the send-time promise recheck
 * (reservice-scheduler.loadEligibleReserviceLanesStrict, Codex round-4 P1
 * structural fix): the link only resolves for the first candidate row that
 * loader reports eligible, operator-selected row first, and 404s when none
 * is — byte-identical to the route's pre-fix per-row behavior.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn(async (cb) => cb(fn));
  return fn;
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
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
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (req, res, next) => (
    req.techRole !== 'admin'
      ? res.status(403).json({ error: 'Admin access required' })
      : next()
  ),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/sms-media', () => ({
  mediaFromOutboundAttachments: jest.fn(() => []),
  signMediaForClient: jest.fn(async (media) => media),
}));
jest.mock('../services/twilio-failure-alerts', () => ({
  alertTwilioFailure: jest.fn(),
}));
jest.mock('../services/sms-suggest-mode', () => ({
  SUGGEST_WORKFLOW: 'sms_house_voice_suggest',
  HUMAN_REPLY_TYPES: ['manual', 'ai_approved', 'ai_revised'],
  revertDraftsToShadow: jest.fn(async () => 0),
  markSuggestionScheduled: jest.fn(async () => 1),
  parkThreadSuggestions: jest.fn(async () => []),
  reopenScheduledSuggestions: jest.fn(async () => 0),
  ignoreParkedSuggestions: jest.fn(async () => 0),
  lockSuggestThread: jest.fn(async () => {}),
}));
jest.mock('../services/sms-auto-send', () => ({
  hasActiveAutoSendClaim: jest.fn(async () => false),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: () => true,
  gates: {},
  logGateStatus: jest.fn(),
}));
jest.mock('@anthropic-ai/sdk', () => (
  jest.fn().mockImplementation(() => ({
    messages: { create: jest.fn() },
  }))
));
jest.mock('../services/reschedule-link', () => ({
  buildRescheduleLink: jest.fn(),
  smsLineFor: jest.fn(() => ''),
}));
jest.mock('../services/reservice-scheduler', () => ({
  reserviceSelfServeEnabled: jest.fn(() => true),
  loadEligibleReserviceLanesStrict: jest.fn(async () => []),
}));
jest.mock('../services/reservice-link', () => ({
  buildReserviceLink: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const communicationsRouter = require('../routes/admin-communications');
const { reserviceSelfServeEnabled, loadEligibleReserviceLanesStrict } = require('../services/reservice-scheduler');
const { buildReserviceLink } = require('../services/reservice-link');

const CUSTOMER_UUID = '3f2b8c4e-9d1a-4f6b-8e2c-5a7d9b1c3e5f';

// Customers: first() serves the customerId lookup; select() calls consume
// selectResults in order (phone-match rows, then account-expansion rows,
// then firstNameForPhone's name-agreement rows).
function makeCustomersBuilder({ firstRow = null, selectResults = [] } = {}) {
  const queue = [...selectResults];
  const inner = {
    where: jest.fn(() => inner),
    orWhere: jest.fn(() => inner),
  };
  const b = { inner, calls: { where: [], whereRaw: [], whereNull: [], whereIn: [] } };
  b.where = jest.fn((...a) => {
    if (typeof a[0] === 'function') a[0](inner);
    else b.calls.where.push(a);
    return b;
  });
  b.whereNull = jest.fn((...a) => { b.calls.whereNull.push(a); return b; });
  b.whereIn = jest.fn((...a) => { b.calls.whereIn.push(a); return b; });
  b.whereRaw = jest.fn((...a) => { b.calls.whereRaw.push(a); return b; });
  b.first = jest.fn(() => Promise.resolve(firstRow));
  b.select = jest.fn(() => Promise.resolve(queue.length ? queue.shift() : []));
  return b;
}

function wireDb(customers) {
  db.mockImplementation((table) => {
    if (table === 'customers') return customers;
    throw new Error(`unexpected table ${table}`);
  });
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/communications', communicationsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(baseUrl, body, token = 'admin') {
  return fetch(`${baseUrl}/admin/communications/reservice-link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

// A single-account, single-profile customer resolved via phone: exact-match
// row + account expansion resolving back to the same id.
function soloCustomer(id = CUSTOMER_UUID) {
  return makeCustomersBuilder({
    selectResults: [[{ id, account_id: id }], [{ id }]],
  });
}

const GOOD_LINK = {
  url: 'https://wvs.example/reservice/abc123',
  line: 'Book your free re-service here: https://wvs.example/reservice/abc123\n\n',
};

describe('POST /admin/communications/reservice-link', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    reserviceSelfServeEnabled.mockReturnValue(true);
  });

  test('404 while GATE_RESERVICE_SELF_SERVE is dark — belt and braces before any lookup', async () => {
    reserviceSelfServeEnabled.mockReturnValue(false);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { phone: '9415551234' });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/not enabled/);
      expect(db).not.toHaveBeenCalled();
      expect(loadEligibleReserviceLanesStrict).not.toHaveBeenCalled();
    });
  });

  test('400 when phone is missing or partial', async () => {
    await withServer(async (baseUrl) => {
      for (const body of [{}, { phone: '7' }, { phone: '555123' }]) {
        const res = await post(baseUrl, body);
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/full 10-digit/);
      }
    });
  });

  test('404 when no live customer matches the exact last-10 digits', async () => {
    wireDb(makeCustomersBuilder({ selectResults: [[]] }));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { phone: '9415551234' });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/No customer/);
      expect(loadEligibleReserviceLanesStrict).not.toHaveBeenCalled();
    });
  });

  test('404 with "no active recurring plan" when the ONE matched candidate is not eligible', async () => {
    wireDb(soloCustomer());
    loadEligibleReserviceLanesStrict.mockResolvedValue([]); // deleted/inactive/tokenless/lane-less — any of them collapse to []
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { phone: '9415551234' });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/No active recurring plan/);
      expect(loadEligibleReserviceLanesStrict).toHaveBeenCalledWith(CUSTOMER_UUID);
      expect(buildReserviceLink).not.toHaveBeenCalled();
    });
  });

  // Codex round-21 P2 (PR #5336): a FAILED eligibility lookup is not "no lanes" — it aborts the scan.
  test('a thrown eligibility lookup on the selected row aborts with 500 and never falls through to a sibling', async () => {
    const customers = makeCustomersBuilder({
      firstRow: { id: CUSTOMER_UUID, phone: '9415551234', account_id: 'acct-1' },
      selectResults: [[{ id: '00000000-0000-0000-0000-000000000001' }, { id: CUSTOMER_UUID }]],
    });
    wireDb(customers);
    loadEligibleReserviceLanesStrict.mockReset();
    loadEligibleReserviceLanesStrict.mockImplementation(async (id) => {
      if (id === CUSTOMER_UUID) throw new Error('db timeout');
      return ['lawn']; // the sibling WOULD be eligible — it must never be reached
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { phone: '9415551234', customerId: CUSTOMER_UUID });
      expect(res.status).toBe(500);
      expect((await res.json()).error).toMatch(/Could not verify re-service eligibility/);
      expect(loadEligibleReserviceLanesStrict).toHaveBeenCalledTimes(1);
      expect(loadEligibleReserviceLanesStrict).toHaveBeenCalledWith(CUSTOMER_UUID);
      expect(buildReserviceLink).not.toHaveBeenCalled();
    });
  });

  test('200 mints the link for the ONE eligible candidate and reports its lanes', async () => {
    wireDb(soloCustomer());
    loadEligibleReserviceLanesStrict.mockResolvedValue(['pest', 'lawn']);
    buildReserviceLink.mockResolvedValue(GOOD_LINK);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { phone: '9415551234' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        url: 'wvs.example/reservice/abc123',
        line: 'Book your free re-service here: wvs.example/reservice/abc123\n\n',
        customerId: CUSTOMER_UUID,
        lanes: ['pest', 'lawn'],
        firstName: null,
      });
      expect(buildReserviceLink).toHaveBeenCalledWith(CUSTOMER_UUID);
    });
  });

  // '0000…' sorts alphabetically BEFORE the UUID (customerIdsForAccount has
  // no ORDER BY, and the remaining-sibling scan sorts what's left) — proving
  // the selected row wins on more than accidental sort order.
  const SIB_ID = '00000000-0000-0000-0000-000000000001';

  test('the operator-selected row is checked FIRST, even when an alphabetically-earlier sibling is also eligible', async () => {
    const customers = makeCustomersBuilder({
      firstRow: { id: CUSTOMER_UUID, phone: '9415551234', account_id: 'acct-1' },
      selectResults: [[{ id: SIB_ID }, { id: CUSTOMER_UUID }]],
    });
    wireDb(customers);
    // Both rows would be eligible — the SELECTED one must win.
    loadEligibleReserviceLanesStrict.mockImplementation(async (id) => (id === CUSTOMER_UUID ? ['pest'] : ['lawn']));
    buildReserviceLink.mockResolvedValue(GOOD_LINK);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { phone: '9415551234', customerId: CUSTOMER_UUID });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.customerId).toBe(CUSTOMER_UUID);
      expect(body.lanes).toEqual(['pest']);
      expect(loadEligibleReserviceLanesStrict).toHaveBeenCalledWith(CUSTOMER_UUID);
    });
  });

  test('falls through to an eligible SIBLING when the operator-selected row is not eligible', async () => {
    const customers = makeCustomersBuilder({
      firstRow: { id: CUSTOMER_UUID, phone: '9415551234', account_id: 'acct-1' },
      selectResults: [[{ id: CUSTOMER_UUID }, { id: SIB_ID }]],
    });
    wireDb(customers);
    loadEligibleReserviceLanesStrict.mockImplementation(async (id) => (id === SIB_ID ? ['lawn'] : []));
    buildReserviceLink.mockResolvedValue(GOOD_LINK);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { phone: '9415551234', customerId: CUSTOMER_UUID });
      expect(res.status).toBe(200);
      expect((await res.json()).customerId).toBe(SIB_ID);
      expect(loadEligibleReserviceLanesStrict).toHaveBeenCalledWith(CUSTOMER_UUID);
      expect(loadEligibleReserviceLanesStrict).toHaveBeenCalledWith(SIB_ID);
    });
  });

  test('404 "no re-service link" when the eligible customer has no usable link (legacy tokenless mint failure)', async () => {
    wireDb(soloCustomer());
    loadEligibleReserviceLanesStrict.mockResolvedValue(['pest']);
    buildReserviceLink.mockResolvedValue({ url: null, line: '' });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { phone: '9415551234' });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/no re-service link/);
    });
  });

  test('401 without a token, 403 for a technician (admin-only mint)', async () => {
    wireDb(soloCustomer());
    await withServer(async (baseUrl) => {
      const anon = await post(baseUrl, { phone: '9415551234' }, null);
      expect(anon.status).toBe(401);
      const tech = await post(baseUrl, { phone: '9415551234' }, 'tech');
      expect(tech.status).toBe(403);
      expect(db).not.toHaveBeenCalled();
    });
  });
});
