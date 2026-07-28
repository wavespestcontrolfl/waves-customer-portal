/**
 * GET /admin/communications/reschedule-link — the SMS composer's
 * "Reschedule Link" helper. The reschedule token is a bearer credential, so
 * these tests pin the fail-closed resolution rules (full 10-digit phone,
 * exact last-10 match, customerId↔phone cross-check, account-scoped
 * multi-property expansion, cross-account rejection), the candidate gates
 * (status set, ET day frame, dispatch-owned pending exclusion, elapsed
 * same-day placeholder skip, stable ordering), and the response shape. Link
 * building itself is covered by reschedule-public.test.js —
 * buildRescheduleLink is mocked here.
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
    if (token !== 'admin') return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = { id: 'admin-1', role: 'admin' };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
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
  smsLineFor: jest.fn((url) => (url ? `Need a different time? Reschedule online: ${url}\n\n` : '')),
}));

const express = require('express');
const db = require('../models/db');
const communicationsRouter = require('../routes/admin-communications');
const { buildRescheduleLink } = require('../services/reschedule-link');
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('../services/call-booking-source-actions');

const CUSTOMER_UUID = '3f2b8c4e-9d1a-4f6b-8e2c-5a7d9b1c3e5f';

// The phone path issues up to two customers queries (exact-match rows, then
// the account expansion) — selectResults is consumed in call order.
function makeCustomersBuilder({ firstRow = null, selectResults = [] } = {}) {
  const queue = [...selectResults];
  const inner = {
    where: jest.fn(() => inner),
    orWhere: jest.fn(() => inner),
  };
  const b = { inner, calls: { where: [], whereRaw: [], whereNull: [] } };
  b.where = jest.fn((...a) => {
    if (typeof a[0] === 'function') a[0](inner);
    else b.calls.where.push(a);
    return b;
  });
  b.whereNull = jest.fn((...a) => { b.calls.whereNull.push(a); return b; });
  b.whereRaw = jest.fn((...a) => { b.calls.whereRaw.push(a); return b; });
  b.first = jest.fn(() => Promise.resolve(firstRow));
  b.select = jest.fn(() => Promise.resolve(queue.length ? queue.shift() : []));
  return b;
}

function makeServicesBuilder(rows = []) {
  const inner = {
    whereNull: jest.fn(() => inner),
    orWhereNotIn: jest.fn(() => inner),
    orWhereNot: jest.fn(() => inner),
    orWhere: jest.fn(() => inner),
  };
  const b = { inner, calls: { where: [], whereIn: [], orderBy: [] } };
  b.whereIn = jest.fn((...a) => { b.calls.whereIn.push(a); return b; });
  b.where = jest.fn((...a) => {
    if (typeof a[0] === 'function') a[0](inner);
    else b.calls.where.push(a);
    return b;
  });
  b.orderBy = jest.fn((...a) => { b.calls.orderBy.push(a); return b; });
  b.limit = jest.fn(() => b);
  b.select = jest.fn(() => Promise.resolve(rows));
  return b;
}

function wireDb({ customers, services }) {
  db.mockImplementation((table) => (table === 'customers' ? customers : services));
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

function get(baseUrl, qs) {
  return fetch(`${baseUrl}/admin/communications/reschedule-link${qs}`, {
    headers: { Authorization: 'Bearer admin' },
  });
}

const GOOD_LINK = {
  url: 'https://wvs.example/r/abc123',
  line: 'Need a different time? Reschedule online: https://wvs.example/r/abc123\n\n',
};

// A single-account, single-profile customer: exact-match row + account
// expansion resolving back to the same id (self-adopted account_id = id).
function soloCustomer(id = CUSTOMER_UUID) {
  return makeCustomersBuilder({
    selectResults: [[{ id, account_id: id }], [{ id }]],
  });
}

describe('GET /admin/communications/reschedule-link', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
  });

  test('400 when phone is missing or partial (no LIKE over-match on fragments)', async () => {
    await withServer(async (baseUrl) => {
      for (const qs of ['', '?phone=7', '?phone=555123', `?customerId=${CUSTOMER_UUID}`]) {
        const res = await get(baseUrl, qs);
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/full 10-digit/);
      }
      expect(db).not.toHaveBeenCalled();
    });
  });

  test('404 when no live customer matches the exact last-10 digits', async () => {
    const customers = makeCustomersBuilder({ selectResults: [[]] });
    wireDb({ customers, services: makeServicesBuilder([]) });
    await withServer(async (baseUrl) => {
      const res = await get(baseUrl, '?phone=%2B15551234567');
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/No customer/);
      // Exact last-10 match on non-deleted rows — same idiom as /rewrite-sms,
      // never a bare LIKE '%...'.
      expect(customers.whereNull).toHaveBeenCalledWith('deleted_at');
      expect(customers.whereRaw).toHaveBeenCalledWith(
        "right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?",
        ['5551234567'],
      );
      expect(db).not.toHaveBeenCalledWith('scheduled_services');
    });
  });

  test('11-digit numbers with a leading 1 normalize to the last 10', async () => {
    const customers = makeCustomersBuilder({ selectResults: [[]] });
    wireDb({ customers, services: makeServicesBuilder([]) });
    await withServer(async (baseUrl) => {
      await get(baseUrl, '?phone=19415551234');
      expect(customers.whereRaw).toHaveBeenCalledWith(
        expect.stringContaining('right(regexp_replace'),
        ['9415551234'],
      );
    });
  });

  test('a valid customerId wins over phone lookup but must cross-match the phone', async () => {
    const customers = makeCustomersBuilder({ firstRow: { id: CUSTOMER_UUID, phone: '+1 (941) 555-1234' } });
    const services = makeServicesBuilder([]);
    wireDb({ customers, services });
    await withServer(async (baseUrl) => {
      const res = await get(baseUrl, `?phone=9415551234&customerId=${CUSTOMER_UUID}`);
      expect(res.status).toBe(404); // no visit — resolution path is what's under test
      expect(customers.calls.where).toContainEqual([{ id: CUSTOMER_UUID }]);
      expect(customers.whereNull).toHaveBeenCalledWith('deleted_at');
      expect(customers.whereRaw).not.toHaveBeenCalled();
      expect(services.calls.whereIn).toContainEqual(['customer_id', [CUSTOMER_UUID]]);
    });
  });

  test('400 when customerId and phone disagree (stale selection fails closed)', async () => {
    const customers = makeCustomersBuilder({ firstRow: { id: CUSTOMER_UUID, phone: '+19410000000' } });
    const services = makeServicesBuilder([]);
    wireDb({ customers, services });
    await withServer(async (baseUrl) => {
      const res = await get(baseUrl, `?phone=9415551234&customerId=${CUSTOMER_UUID}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/must match/);
      expect(db).not.toHaveBeenCalledWith('scheduled_services');
    });
  });

  test('a malformed customerId falls back to the exact phone match instead of reaching the uuid column', async () => {
    const customers = soloCustomer();
    const services = makeServicesBuilder([]);
    wireDb({ customers, services });
    await withServer(async (baseUrl) => {
      await get(baseUrl, '?phone=9415551234&customerId=not-a-uuid');
      expect(customers.calls.where).not.toContainEqual([{ id: 'not-a-uuid' }]);
      expect(customers.whereRaw).toHaveBeenCalled();
    });
  });

  test('multi-property rows under ONE account expand to the whole account', async () => {
    const customers = makeCustomersBuilder({
      selectResults: [
        [{ id: 'cust-a', account_id: 'acct-1' }, { id: 'cust-b', account_id: 'acct-1' }],
        [{ id: 'cust-a' }, { id: 'cust-b' }, { id: 'cust-c' }],
      ],
    });
    const services = makeServicesBuilder([{
      id: 'svc-c1',
      customer_id: 'cust-c',
      scheduled_date: '2099-01-05',
      window_start: '08:00:00',
      window_end: '10:00:00',
      service_type: 'pest control',
      status: 'confirmed',
    }]);
    wireDb({ customers, services });
    buildRescheduleLink.mockResolvedValue(GOOD_LINK);
    await withServer(async (baseUrl) => {
      const res = await get(baseUrl, '?phone=9415551234');
      expect(res.status).toBe(200);
      // Expansion is by account membership, not just the phone-matched rows —
      // a property profile with a different contact number still counts.
      expect(customers.inner.where).toHaveBeenCalledWith({ account_id: 'acct-1' });
      expect(customers.inner.orWhere).toHaveBeenCalledWith({ id: 'acct-1' });
      expect(services.calls.whereIn).toContainEqual(['customer_id', ['cust-a', 'cust-b', 'cust-c']]);
      // The link is minted for the row that owns the picked visit.
      expect(buildRescheduleLink).toHaveBeenCalledWith('svc-c1', { customerId: 'cust-c' });
    });
  });

  test('409 when the phone matches rows under DIFFERENT accounts (number reuse fails closed)', async () => {
    const customers = makeCustomersBuilder({
      selectResults: [
        [{ id: 'cust-a', account_id: 'acct-1' }, { id: 'cust-x', account_id: 'acct-2' }],
      ],
    });
    const services = makeServicesBuilder([]);
    wireDb({ customers, services });
    await withServer(async (baseUrl) => {
      const res = await get(baseUrl, '?phone=9415551234');
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/more than one customer account/);
      expect(db).not.toHaveBeenCalledWith('scheduled_services');
      expect(buildRescheduleLink).not.toHaveBeenCalled();
    });
  });

  test('rows with NULL account_id are their own account: one is fine, two fail closed', async () => {
    // Two account-less rows can't be assumed to be the same person.
    const ambiguous = makeCustomersBuilder({
      selectResults: [[{ id: 'cust-a', account_id: null }, { id: 'cust-b', account_id: null }]],
    });
    wireDb({ customers: ambiguous, services: makeServicesBuilder([]) });
    await withServer(async (baseUrl) => {
      const res = await get(baseUrl, '?phone=9415551234');
      expect(res.status).toBe(409);
    });

    // A single account-less row self-anchors on its own id.
    const solo = makeCustomersBuilder({
      selectResults: [[{ id: 'cust-a', account_id: null }], [{ id: 'cust-a' }]],
    });
    wireDb({ customers: solo, services: makeServicesBuilder([]) });
    await withServer(async (baseUrl) => {
      const res = await get(baseUrl, '?phone=9415551234');
      expect(res.status).toBe(404); // proceeds to the (empty) visit lookup
      expect(solo.inner.where).toHaveBeenCalledWith({ account_id: 'cust-a' });
      expect(solo.inner.orWhere).toHaveBeenCalledWith({ id: 'cust-a' });
    });
  });

  test('candidate query applies the status gate, ET day frame, dispatch-owned exclusion, and stable ordering', async () => {
    const customers = soloCustomer();
    const services = makeServicesBuilder([]);
    wireDb({ customers, services });
    await withServer(async (baseUrl) => {
      const res = await get(baseUrl, '?phone=9415551234');
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/No upcoming appointment/);
      expect(services.calls.whereIn).toContainEqual(['status', ['pending', 'confirmed', 'rescheduled']]);
      // DATE column compared against the ET 'YYYY-MM-DD' day string.
      const dateWhere = services.calls.where.find((c) => c[0] === 'scheduled_date');
      expect(dateWhere).toBeDefined();
      expect(dateWhere[1]).toBe('>=');
      expect(dateWhere[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Null-safe dispatch-owned predicate — same shape as /api/schedule:
      // a tentative call-pipeline pending row must not get a bearer link.
      expect(services.inner.whereNull).toHaveBeenCalledWith('source_action');
      expect(services.inner.orWhereNotIn).toHaveBeenCalledWith('source_action', DISPATCH_OWNED_PENDING_SOURCE_ACTIONS);
      expect(services.inner.orWhereNot).toHaveBeenCalledWith('status', 'pending');
      expect(services.inner.orWhere).toHaveBeenCalledWith('customer_confirmed', true);
      // Deterministic pick: unique id tie-breaker after date + window.
      expect(services.calls.orderBy).toContainEqual([[
        { column: 'scheduled_date', order: 'asc' },
        { column: 'window_start', order: 'asc' },
        { column: 'id', order: 'asc' },
      ]]);
      expect(buildRescheduleLink).not.toHaveBeenCalled();
    });
  });

  test('200 returns the link, the SMS clause, and the visit the link points to', async () => {
    const customers = soloCustomer();
    const services = makeServicesBuilder([{
      id: 'svc-1',
      customer_id: CUSTOMER_UUID,
      // pg can hand DATE columns back as a JS Date — the route must
      // normalize to 'YYYY-MM-DD'.
      scheduled_date: new Date('2099-08-04T00:00:00Z'),
      window_start: '08:00:00',
      window_end: '10:00:00',
      service_type: 'lawn care',
      status: 'confirmed',
    }]);
    wireDb({ customers, services });
    buildRescheduleLink.mockResolvedValue(GOOD_LINK);
    await withServer(async (baseUrl) => {
      const res = await get(baseUrl, '?phone=9415551234');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        url: GOOD_LINK.url,
        line: GOOD_LINK.line,
        appointment: {
          id: 'svc-1',
          scheduledDate: '2099-08-04',
          windowStart: '08:00',
          serviceType: 'lawn care',
          status: 'confirmed',
        },
      });
      expect(buildRescheduleLink).toHaveBeenCalledWith('svc-1', { customerId: CUSTOMER_UUID });
    });
  });

  test('an elapsed same-day rescheduled placeholder is skipped in favor of the next usable visit', async () => {
    // Fake only Date: 2026-07-28 16:00 ET (20:00 UTC, EDT). Timers, sockets,
    // and fetch stay real.
    jest.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-28T20:00:00Z') });
    try {
      const customers = soloCustomer();
      const services = makeServicesBuilder([
        {
          id: 'svc-placeholder',
          customer_id: CUSTOMER_UUID,
          scheduled_date: '2026-07-28', // today, 8–10 AM quoted window long past by 4 PM
          window_start: '08:00:00',
          window_end: '10:00:00',
          service_type: 'pest control',
          status: 'rescheduled',
        },
        {
          id: 'svc-next',
          customer_id: CUSTOMER_UUID,
          scheduled_date: '2026-07-30',
          window_start: '09:00:00',
          window_end: '11:00:00',
          service_type: 'pest control',
          status: 'confirmed',
        },
      ]);
      wireDb({ customers, services });
      buildRescheduleLink.mockResolvedValue(GOOD_LINK);
      await withServer(async (baseUrl) => {
        const res = await get(baseUrl, '?phone=9415551234');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.appointment.id).toBe('svc-next');
        expect(buildRescheduleLink).toHaveBeenCalledWith('svc-next', { customerId: CUSTOMER_UUID });
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('404 when the visit has no usable link (legacy tokenless row)', async () => {
    const customers = soloCustomer();
    const services = makeServicesBuilder([{
      id: 'svc-legacy',
      customer_id: CUSTOMER_UUID,
      scheduled_date: '2099-08-04',
      window_start: null,
      window_end: null,
      service_type: 'pest control',
      status: 'pending',
    }]);
    wireDb({ customers, services });
    buildRescheduleLink.mockResolvedValue({ url: null, line: '' });
    await withServer(async (baseUrl) => {
      const res = await get(baseUrl, '?phone=9415551234');
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/no reschedule link/);
    });
  });

  test('401 without an admin token', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/reschedule-link?phone=9415551234`);
      expect(res.status).toBe(401);
    });
  });
});

describe('isElapsedSameDayReschedulePlaceholder', () => {
  const { isElapsedSameDayReschedulePlaceholder } = communicationsRouter._internals;
  // Fixed "now": 2026-07-28 16:00 ET (20:00 UTC, EDT).
  const NOW = new Date('2026-07-28T20:00:00.000Z');

  test('true for a same-day rescheduled row whose quoted window elapsed', () => {
    expect(isElapsedSameDayReschedulePlaceholder({
      status: 'rescheduled',
      scheduled_date: '2026-07-28',
      window_start: '08:00:00',
      window_end: '10:00:00',
    }, NOW)).toBe(true);
  });

  test('false while the quoted arrival window (start + 120m) is still open, even past window_end', () => {
    // 15:00 start, job block to 15:30 — at 16:00 the quoted 15:00–17:00
    // arrival window is still open, so the placeholder is still actionable.
    expect(isElapsedSameDayReschedulePlaceholder({
      status: 'rescheduled',
      scheduled_date: '2026-07-28',
      window_start: '15:00:00',
      window_end: '15:30:00',
    }, NOW)).toBe(false);
  });

  test('false for pending/confirmed rows (missed visits stay rebookable) and future rescheduled rows', () => {
    expect(isElapsedSameDayReschedulePlaceholder({
      status: 'confirmed',
      scheduled_date: '2026-07-28',
      window_start: '08:00:00',
      window_end: '10:00:00',
    }, NOW)).toBe(false);
    expect(isElapsedSameDayReschedulePlaceholder({
      status: 'pending',
      scheduled_date: '2026-07-28',
      window_start: '08:00:00',
      window_end: '10:00:00',
    }, NOW)).toBe(false);
    expect(isElapsedSameDayReschedulePlaceholder({
      status: 'rescheduled',
      scheduled_date: '2026-07-29',
      window_start: '08:00:00',
      window_end: '10:00:00',
    }, NOW)).toBe(false);
  });

  test('false when the row has no window to judge by', () => {
    expect(isElapsedSameDayReschedulePlaceholder({
      status: 'rescheduled',
      scheduled_date: '2026-07-28',
      window_start: null,
      window_end: null,
    }, NOW)).toBe(false);
  });
});
