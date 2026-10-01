/**
 * /book "Can't find a time?" preferred-time request (GATE_BOOK_PREFERRED_TIME,
 * owner 2026-09-29).
 *
 * Pins: the dark gate (generic 404 + config flag), the proof-of-funnel token,
 * request validation, the stored lead shape the office reads, one row per
 * phone per day, and — the standing rule — NOTHING is sent to the customer:
 * no SMS, no email, and the abandoned-booking recovery worker cannot text them
 * either (open intents retired, capture-intent skips the phone).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

const mockOps = [];            // { table, op, arg }
let mockExistingLead = null;   // what a phone lookup on leads returns
let mockCustomer = null;       // what customers .first() returns
let mockOpenLeads = [];        // what an awaited leads select() resolves to
let mockLeadUpdateRows = 1;    // rows a conditional leads UPDATE matches (0 = staff closed it since the lookup)
let mockRetireError = null;    // makes the booking_intents suppression UPDATE throw
let mockBookedList = null;     // when set, the reconcile's multi-booking lookup resolves this list
let mockDeadVisit = false;      // the booking's only visit is cancelled/skipped/rescheduled (the live-status lookup finds nothing)
let mockScheduledService = null; // what the reconcile's scheduled_services lookup returns (null = derived from mockBookedSince)
const mockRaws = [];            // whereRaw calls (query-shape asserts)
let mockOpenLeadsNewerOnly = false; // every open preferred lead was requested AFTER the booking (the <= cutoff excludes them)
let mockBookedSince = null;    // what the post-commit "booked since the request began" lookup returns
const mockOrder = [];          // op order inside/after the transaction
let mockLockedLead = null;     // what the note transaction's leads ... FOR UPDATE re-read returns

function builder(table) {
  const b = {
    where: (a, op, val) => {
      if (typeof a === 'function') a(b);
      return b;
    },
    orWhere: () => b,
    orWhereNotIn: () => b,
    whereNull: () => b,
    whereNotNull: () => b,
    whereNot: () => b,
    whereIn: () => b,
    forUpdate: () => { b._forUpdate = true; return b; },
    whereNotIn: () => { b._liveOnly = true; return b; },
    whereRaw: (sql, vals) => { mockRaws.push({ table, op: 'whereRaw', arg: sql, vals }); if (/<= \?/.test(String(sql))) b._requestedBy = vals && vals[0]; return b; },
    orWhereRaw: () => b,
    leftJoin: () => b,
    orderBy: () => b,
    limit: () => b,
    select: () => b,
    then: (resolve, reject) => Promise.resolve(
      table === 'leads' ? (b._requestedBy && mockOpenLeadsNewerOnly ? [] : mockOpenLeads)
        : table === 'self_booked_appointments as sba' ? (mockBookedList || (mockBookedSince ? [mockBookedSince] : []))
          : [],
    ).then(resolve, reject),
    first: (...cols) => Promise.resolve(
      table === 'leads' ? (b._forUpdate ? mockLockedLead : mockExistingLead)
        : table === 'customers' ? mockCustomer
          : table === 'self_booked_appointments as sba' ? mockBookedSince
            : table === 'scheduled_services' && mockDeadVisit ? (b._liveOnly ? null : { id: 'ss-dead' })
            : table === 'scheduled_services' && mockScheduledService ? mockScheduledService
            : table === 'scheduled_services' && mockBookedSince ? { id: 'ss-1', self_booking_id: mockBookedSince.id, service_type: 'Pest Control', scheduled_date: '2026-10-08' }
              : null,
    ),
    insert: (row) => {
      mockOps.push({ table, op: 'insert', arg: row });
      mockOrder.push(`insert:${table}`);
      return { returning: () => Promise.resolve([{ id: 'lead-1', ...row }]) };
    },
    del: () => {
      mockOps.push({ table, op: 'del' });
      mockOrder.push(`del:${table}`);
      return Promise.resolve(1);
    },
    update: (patch) => {
      mockOps.push({ table, op: 'update', arg: patch });
      mockOrder.push(`update:${table}`);
      if (table === 'booking_intents' && mockRetireError) return Promise.reject(mockRetireError);
      return Promise.resolve(table === 'leads' ? mockLeadUpdateRows : 1);
    },
  };
  return b;
}
const mockDb = jest.fn((table) => builder(table));
mockDb.fn = { now: () => 'NOW' };
mockDb.raw = jest.fn((s) => s);
const mockLocks = [];
mockDb.transaction = jest.fn(async (cb) => {
  const trx = (table) => builder(table);
  trx.isTrx = true;
  trx.fn = mockDb.fn;
  trx.raw = jest.fn((sql, bindings) => {
    // An expression fragment (the jsonb merge) is returned as-is, like knex's
    // Raw; the advisory lock is awaited.
    if (!/pg_advisory/.test(sql)) return { __raw: sql, bindings };
    mockLocks.push({ sql, bindings });
    return Promise.resolve({ rows: [] });
  });
  return cb(trx);
});

const mockTriggerNotification = jest.fn(async () => ({ bellWritten: 1 }));
const mockSendCustomerMessage = jest.fn();
const mockSendSMS = jest.fn();
const mockSendEmail = jest.fn();
const mockNotifyAdmin = jest.fn(async () => ({ id: 'notif-1' }));

jest.mock('../models/db', () => mockDb);
// The admin FYI goes through the real raiseAdminAlert/composeAdminAlert (so the
// notification rule is enforced here); only the row write is stubbed.
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotifyAdmin(...a) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: (...a) => mockTriggerNotification(...a),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: (...a) => mockSendCustomerMessage(...a),
}));
jest.mock('../services/twilio', () => ({ sendSMS: (...a) => mockSendSMS(...a) }));
jest.mock('../services/sendgrid-mail', () => ({
  sendOne: (...a) => mockSendEmail(...a),
  sendBatch: (...a) => mockSendEmail(...a),
  sendTemplated: (...a) => mockSendEmail(...a),
  sendBroadcast: (...a) => mockSendEmail(...a),
}));
const mockMarkConverted = jest.fn(async () => true);
jest.mock('../services/lead-attribution', () => ({ markConverted: (...a) => mockMarkConverted(...a) }));
const mockStampFunnel = jest.fn(async () => { mockOrder.push('stamp'); return 'funnel-1'; });
jest.mock('../services/lead-funnel-bridge', () => {
  const actual = jest.requireActual('../services/lead-funnel-bridge');
  return { ...actual, stampLeadFunnelRow: (...a) => mockStampFunnel(...a) };
});
jest.mock('../services/lead-source-resolver', () => ({
  resolveLeadSource: jest.fn(async () => ({ leadSourceId: 'src-main' })),
}));

const express = require('express');
const bookingRouter = require('../routes/booking');
const { mintCaptureToken, captureIpKey } = bookingRouter._internals;
const {
  validatePreferredTimeRequest,
  recordPreferredTimeRequest,
  hasRecentPreferredTimeRequest,
} = require('../services/booking-preferred-time');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));

function validBody(extra = {}) {
  return {
    name: 'Pat Sample',
    phone: '(941) 555-0100',
    preferred_date: dayOffset(5),
    time_of_day: 'morning',
    ...extra,
  };
}

function appServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/booking', bookingRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
// Each test gets its own client IP (X-Forwarded-For, trust proxy on) so the
// per-IP limiter only trips in the test that means to trip it.
let ipCounter = 0;
let currentIp = '10.0.0.1';
const nextIp = () => { ipCounter += 1; currentIp = `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`; return currentIp; };
async function post(baseUrl, body) {
  const res = await fetch(`${baseUrl}/api/booking/preferred-time`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': currentIp },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
// The token is bound to the requesting IP (see captureIpKey).
const loopbackToken = () => mintCaptureToken(captureIpKey({ ip: currentIp, headers: {} }));

let server; let baseUrl;
beforeAll(() => { ({ server, baseUrl } = appServer()); });
afterAll((done) => { server.close(done); });
beforeEach(() => {
  nextIp();
  mockOps.length = 0;
  mockLocks.length = 0;
  mockExistingLead = null;
  mockCustomer = null;
  mockOpenLeads = [];
  mockLockedLead = { lead_type: 'book_preferred_time', status: 'new', converted_at: null, deleted_at: null, phone: '+19415550100', customer_id: null, requested_in_time: true };
  mockLeadUpdateRows = 1;
  mockRetireError = null;
  mockBookedSince = null;
  mockOpenLeadsNewerOnly = false;
  mockRaws.length = 0;
  mockBookedList = null;
  mockScheduledService = null;
  mockDeadVisit = false;
  mockOrder.length = 0;
  mockMarkConverted.mockClear();
  mockMarkConverted.mockResolvedValue(true);
  mockStampFunnel.mockClear();
  mockTriggerNotification.mockClear();
  mockNotifyAdmin.mockClear();
  mockSendCustomerMessage.mockClear();
  mockSendSMS.mockClear();
  mockSendEmail.mockClear();
  mockDb.mockClear();
  delete process.env.GATE_BOOK_PREFERRED_TIME;
});

describe('gate', () => {
  test('off (default): POST is the generic 404 and touches nothing', async () => {
    const r = await post(baseUrl, { ...validBody(), capture_token: loopbackToken() });
    expect(r.status).toBe(404);
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockTriggerNotification).not.toHaveBeenCalled();
  });

  test('bookPreferredTimeLive is strict opt-in', () => {
    const { bookPreferredTimeLive } = require('../config/feature-gates');
    expect(bookPreferredTimeLive()).toBe(false);
    process.env.GATE_BOOK_PREFERRED_TIME = '1';
    expect(bookPreferredTimeLive()).toBe(false);
    process.env.GATE_BOOK_PREFERRED_TIME = 'true';
    expect(bookPreferredTimeLive()).toBe(true);
  });
});

describe('pre-router guard (mounted above cors, the global limiter and the body parsers)', () => {
  const fs = require('fs');
  const path = require('path');
  const { preferredTimePreParserGuard } = bookingRouter;

  // A tiny app in the SAME order index.js uses: guard first, then a strict JSON
  // parser that would answer malformed bodies 400 on its own.
  async function guarded() {
    const app = express();
    app.use('/api/booking/preferred-time', ...preferredTimePreParserGuard);
    app.use(express.json({ limit: 20 }));
    app.use('/api/booking', bookingRouter);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: 'parser' }));
    const srv = app.listen(0);
    return { srv, url: `http://127.0.0.1:${srv.address().port}/api/booking/preferred-time` };
  }

  test('dark: every method, even a malformed or oversized body, is the generic 404 with the privacy headers', async () => {
    const { srv, url } = await guarded();
    try {
      for (const init of [
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' },
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(500) }) },
        { method: 'OPTIONS' },
        { method: 'GET' },
      ]) {
        const res = await fetch(url, init);
        expect(res.status).toBe(404);
        expect(res.headers.get('cache-control')).toMatch(/no-store/);
        expect(res.headers.get('x-robots-tag')).toMatch(/noindex/);
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      }
    } finally { await new Promise((r) => srv.close(r)); }
  });

  test('live: success, 400 and 429 responses all carry no-store / noindex / no-referrer', async () => {
    process.env.GATE_BOOK_PREFERRED_TIME = 'true';
    const check = (res) => {
      expect(res.headers.get('cache-control')).toMatch(/no-store/);
      expect(res.headers.get('x-robots-tag')).toMatch(/noindex/);
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    };
    const send = (body) => fetch(`${baseUrl}/api/booking/preferred-time`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': currentIp }, body: JSON.stringify(body),
    });
    check(await send({ ...validBody(), capture_token: loopbackToken() }));
    check(await send({ name: '' }));
    let last;
    for (let i = 0; i < 6; i += 1) last = await send({ name: '' });
    expect(last.status).toBe(429);
    check(last);
  });

  test('index.js mounts the guard above the global cors(), the /api/ limiter and the body parsers', () => {
    const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    const guardAt = src.indexOf("app.use('/api/booking/preferred-time', ...require('./routes/booking').preferredTimePreParserGuard)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(src.indexOf('app.use(cors({'));
    expect(guardAt).toBeLessThan(src.indexOf("app.use('/api/', limiter)"));
    expect(guardAt).toBeLessThan(src.indexOf('app.use(express.json'));
  });

  test('limiters key by the /64-collapsed IP: rotating IPv6 addresses inside one /64 shares one bucket', async () => {
    process.env.GATE_BOOK_PREFERRED_TIME = 'true';
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await fetch(`${baseUrl}/api/booking/preferred-time`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `2001:db8:abcd:12::${i + 1}` },
        body: JSON.stringify({ name: '' }),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(statuses[5]).toBe(429);
  });
});

describe('validatePreferredTimeRequest', () => {
  test('accepts a complete request and normalizes it', () => {
    const r = validatePreferredTimeRequest(validBody({ second_date: dayOffset(6), note: '  gate code 1234  ', time_of_day: 'Afternoon' }));
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({
      firstName: 'Pat', lastName: 'Sample', phone: '9415550100',
      preferredDate: dayOffset(5), secondDate: dayOffset(6), timeOfDay: 'afternoon', note: 'gate code 1234',
    });
  });

  test('phone: an 11-digit +1 number is normalized, a short one is refused', () => {
    expect(validatePreferredTimeRequest(validBody({ phone: '+1 941 555 0100' })).value.phone).toBe('9415550100');
    expect(validatePreferredTimeRequest(validBody({ phone: '555-0100' })).ok).toBe(false);
  });

  test('requires a name and a real, upcoming date', () => {
    expect(validatePreferredTimeRequest(validBody({ name: '  ' })).ok).toBe(false);
    expect(validatePreferredTimeRequest(validBody({ preferred_date: '' })).ok).toBe(false);
    expect(validatePreferredTimeRequest(validBody({ preferred_date: '2026-02-30' })).ok).toBe(false);
    expect(validatePreferredTimeRequest(validBody({ preferred_date: dayOffset(-1) })).ok).toBe(false);
    expect(validatePreferredTimeRequest(validBody({ preferred_date: dayOffset(400) })).ok).toBe(false);
  });

  test('second day: optional, must be valid, a repeat of the first is dropped', () => {
    expect(validatePreferredTimeRequest(validBody({ second_date: 'soon' })).ok).toBe(false);
    expect(validatePreferredTimeRequest(validBody({ second_date: dayOffset(5) })).value.secondDate).toBeNull();
  });

  test('time of day is an allowlist; blank means any time', () => {
    expect(validatePreferredTimeRequest(validBody({ time_of_day: 'midnight' })).ok).toBe(false);
    expect(validatePreferredTimeRequest(validBody({ time_of_day: '' })).value.timeOfDay).toBe('any');
  });

  test('honeypot is flagged, not stored', () => {
    expect(validatePreferredTimeRequest(validBody({ website: 'http://spam' }))).toMatchObject({ ok: false, honeypot: true });
  });
});

describe('POST /api/booking/preferred-time (gate on)', () => {
  beforeEach(() => { process.env.GATE_BOOK_PREFERRED_TIME = 'true'; });

  test('missing/invalid token is refused and stores nothing', async () => {
    const r = await post(baseUrl, validBody());
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('session_expired');
    expect(mockOps.filter((o) => o.table === 'leads')).toHaveLength(0);
  });

  test('bad body is a 400 with a plain message', async () => {
    const r = await post(baseUrl, { ...validBody({ phone: '12' }), capture_token: loopbackToken() });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/phone/i);
  });

  test('honeypot answers ok and stores nothing', async () => {
    const r = await post(baseUrl, { ...validBody({ website: 'x' }), capture_token: loopbackToken() });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(mockOps).toHaveLength(0);
  });

  test('valid request: one internal lead, one admin bell, intents retired, NOTHING sent to the customer', async () => {
    const r = await post(baseUrl, {
      ...validBody({
        second_date: dayOffset(7), note: 'Cortez, near the bridge',
        address_line1: '1 Example Way', city: 'Cortez', zip: '34215',
        service_id: 'pest_control', session_id: 'sess-1', email: 'pat@example.com',
        attribution: {
          gclid: 'g-123', fbc: 'fb.1.x', utm: { source: 'google', campaign: 'venice' },
          referrer: 'https://www.google.com/', landing_url: 'https://portal.test/book?gclid=g-123',
        },
      }),
      capture_token: loopbackToken(),
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });

    const inserts = mockOps.filter((o) => o.table === 'leads' && o.op === 'insert');
    expect(inserts).toHaveLength(1);
    const lead = inserts[0].arg;
    expect(lead).toMatchObject({
      first_name: 'Pat', last_name: 'Sample', phone: '+19415550100', email: 'pat@example.com',
      address: '1 Example Way', city: 'Cortez', zip: '34215',
      lead_type: 'book_preferred_time', first_contact_channel: 'booking',
      service_interest: 'Pest Control', status: 'new',
    });
    // First-touch attribution rides onto the lead like every other funnel's.
    expect(lead).toMatchObject({ lead_source_id: 'src-main', gclid: 'g-123', fbc: 'fb.1.x' });
    expect(JSON.parse(lead.extracted_data)).toMatchObject({
      utm: { source: 'google', campaign: 'venice' }, referrer: 'https://www.google.com/',
    });
    // Lookup + write ran under a per-phone advisory lock.
    expect(mockLocks).toHaveLength(1);
    expect(mockLocks[0].sql).toMatch(/pg_advisory_xact_lock/);
    expect(mockLocks[0].bindings[0]).toBe('book_preferred_time:9415550100');
    expect(lead.transcript_summary).toMatch(/Could not find an online time on \/book for Pest Control/);
    expect(lead.transcript_summary).toMatch(/morning/);
    expect(lead.transcript_summary).toMatch(/Second choice/);
    expect(lead.transcript_summary).toMatch(/Cortez, near the bridge/);
    expect(lead.transcript_summary).toMatch(/No automatic message was sent/);
    expect(JSON.parse(lead.extracted_data)).toMatchObject({
      source: 'book_preferred_time', preferred_date: dayOffset(5), second_date: dayOffset(7),
      time_of_day: 'morning', note: 'Cortez, near the bridge', customer_messaged: false,
    });

    // Recovery worker cannot text them: their open intents are suppressed.
    const retire = mockOps.filter((o) => o.table === 'booking_intents' && o.op === 'update');
    expect(retire).toHaveLength(1);
    expect(retire[0].arg).toMatchObject({ suppressed: true });

    // One internal bell (staff), zero customer messages of any kind.
    expect(mockTriggerNotification).toHaveBeenCalledTimes(1);
    expect(mockTriggerNotification.mock.calls[0][0]).toBe('new_lead');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockSendSMS).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockOps.some((o) => ['sms_log', 'emails', 'messaging_audit_log'].includes(o.table))).toBe(false);
  });

  test('a second submit from the same phone within a day refreshes the one lead: no new row, no second bell', async () => {
    mockExistingLead = { id: 'lead-existing' };
    const r = await post(baseUrl, { ...validBody(), capture_token: loopbackToken() });
    expect(r.status).toBe(200);
    expect(mockOps.filter((o) => o.table === 'leads' && o.op === 'insert')).toHaveLength(0);
    expect(mockOps.filter((o) => o.table === 'leads' && o.op === 'update')).toHaveLength(1);
    expect(mockTriggerNotification).not.toHaveBeenCalled();
  });

  test('refresh is conditional on the lead STILL being open: staff closed it since the lookup -> a NEW lead + bell, no write onto the closed one', async () => {
    mockExistingLead = { id: 'lead-existing' };
    mockLeadUpdateRows = 0;
    const r = await post(baseUrl, { ...validBody(), capture_token: loopbackToken() });
    expect(r.status).toBe(200);
    expect(mockOps.filter((o) => o.table === 'leads' && o.op === 'insert')).toHaveLength(1);
    expect(mockTriggerNotification).toHaveBeenCalledTimes(1);
    expect(mockStampFunnel).toHaveBeenCalledTimes(1);
  });

  test('a refresh MERGES only the request-specific fields: first-touch UTM / referrer / landing URL are neither sent nor replaced', async () => {
    mockExistingLead = { id: 'lead-existing' };
    const r = await post(baseUrl, {
      ...validBody({
        note: 'second ask',
        attribution: { utm: { source: 'direct-revisit' }, referrer: 'https://direct.example/', landing_url: 'https://portal.test/book' },
      }),
      capture_token: loopbackToken(),
    });
    expect(r.status).toBe(200);
    const upd = mockOps.find((o) => o.table === 'leads' && o.op === 'update');
    // A jsonb `||` merge onto the stored row, never a wholesale replacement.
    expect(upd.arg.extracted_data.__raw).toMatch(/COALESCE\(extracted_data, '\{\}'::jsonb\) \|\| \?::jsonb/);
    const sent = JSON.parse(upd.arg.extracted_data.bindings[0]);
    expect(sent).toMatchObject({ note: 'second ask', preferred_date: dayOffset(5) });
    for (const k of ['utm', 'referrer', 'landing_url']) expect(sent).not.toHaveProperty(k);
  });

  test('the apartment unit (address_line2) is kept: inline on the lead address and in extracted_data', async () => {
    const r = await post(baseUrl, {
      ...validBody({ address_line1: '1 Example Way', address_line2: 'Apt 4B', city: 'Cortez', zip: '34215' }),
      capture_token: loopbackToken(),
    });
    expect(r.status).toBe(200);
    const lead = mockOps.find((o) => o.table === 'leads' && o.op === 'insert').arg;
    expect(lead.address).toBe('1 Example Way, Apt 4B');
    expect(JSON.parse(lead.extracted_data)).toMatchObject({ address_line1: '1 Example Way', address_line2: 'Apt 4B' });
    // No unit: the address is the street line alone.
    mockOps.length = 0;
    await post(baseUrl, { ...validBody({ address_line1: '1 Example Way' }), capture_token: loopbackToken() });
    expect(mockOps.find((o) => o.table === 'leads' && o.op === 'insert').arg.address).toBe('1 Example Way');
  });

  test('the client sends the unit', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../client/src/components/booking/CantFindTimeBlock.jsx'), 'utf8');
    expect(src).toMatch(/address_line2:\s*address\.line2/);
  });

  const bookingNotes = () => mockOps.filter((o) => o.table === 'lead_activities' && o.op === 'insert');
  const closes = () => mockOps.filter((o) => o.table === 'leads' && o.op === 'update' && o.arg.status === 'handled');
  const leadOrFunnelWrites = () => mockOps.filter((o) => (o.table === 'leads' && o.op === 'update' && !('transcript_summary' in o.arg)) || o.table === 'ad_service_attribution');

  test('a booking that won the race (committed while this submit was in flight): the lead closes as handled with ONE audit row and ONE admin FYI, is NOT converted, and NO new_lead bell rings', async () => {
    mockBookedSince = { id: 'sba-1', customer_id: 'cust-1', created_at: new Date() };
    mockCustomer = { phone: '+19415550100' };
    mockOpenLeads = [{ id: 'lead-1' }];
    const r = await post(baseUrl, { ...validBody(), capture_token: loopbackToken() });
    expect(r.status).toBe(200);
    expect(bookingNotes()).toHaveLength(1);
    expect(bookingNotes()[0].arg).toMatchObject({ lead_id: 'lead-1', activity_type: 'status_change', performed_by: 'system' });
    expect(bookingNotes()[0].arg.description).toBe('Closed automatically \u2014 customer booked Pest Control for Thu, Oct 8 (visit ss-1) on /book');
    expect(JSON.parse(bookingNotes()[0].arg.metadata)).toMatchObject({ reason: 'booking_on_preferred_request', visit_id: 'ss-1', previous_status: 'new', status: 'handled' });
    expect(closes()).toHaveLength(1);
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockMarkConverted).not.toHaveBeenCalled();
    expect(mockTriggerNotification).not.toHaveBeenCalled();
    expect(mockSendSMS).not.toHaveBeenCalled();
  });

  test('a race booking never wins the lead or touches its funnel row (even with several open requests: each closes as handled, none converted)', async () => {
    mockBookedSince = { id: 'sba-1', customer_id: 'cust-1', created_at: new Date() };
    mockCustomer = { phone: '+19415550100' };
    mockOpenLeads = [{ id: 'lead-1' }, { id: 'lead-2' }];
    const r = await post(baseUrl, { ...validBody(), capture_token: loopbackToken() });
    expect(r.status).toBe(200);
    expect(bookingNotes().map((o) => o.arg.lead_id).sort()).toEqual(['lead-1', 'lead-2']);
    expect(mockMarkConverted).not.toHaveBeenCalled();
    expect(mockOps.filter((o) => o.table === 'ad_service_attribution')).toHaveLength(0);
    expect(mockOps.filter((o) => o.table === 'leads' && o.op === 'update' && 'status' in o.arg && o.arg.status !== 'handled')).toHaveLength(0);
    expect(closes()).toHaveLength(2);
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(2);
    expect(mockTriggerNotification).not.toHaveBeenCalled();
  });

  test('a booking whose only visit is cancelled/skipped/rescheduled (codex #5399 r10 P2): no note, and the lead rings', async () => {
    mockBookedSince = { id: 'sba-1', customer_id: 'cust-1', created_at: new Date() };
    mockDeadVisit = true;
    mockCustomer = { phone: '+19415550100' };
    mockOpenLeads = [{ id: 'lead-1' }];
    const r = await post(baseUrl, { ...validBody(), capture_token: loopbackToken() });
    expect(r.status).toBe(200);
    expect(bookingNotes()).toHaveLength(0);
    expect(closes()).toHaveLength(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockTriggerNotification).toHaveBeenCalledTimes(1);
  });

  test('a free callback visit inside the reconcile window is not an acquisition: no note, and the lead rings', async () => {
    mockBookedSince = { id: 'sba-1', customer_id: 'cust-1', created_at: new Date() };
    mockScheduledService = { id: 'ss-1', self_booking_id: 'sba-1', is_callback: true };
    mockCustomer = { phone: '+19415550100' };
    mockOpenLeads = [{ id: 'lead-1' }];
    const r = await post(baseUrl, { ...validBody(), capture_token: loopbackToken() });
    expect(r.status).toBe(200);
    expect(bookingNotes()).toHaveLength(0);
    expect(closes()).toHaveLength(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockMarkConverted).not.toHaveBeenCalled();
    expect(mockTriggerNotification).toHaveBeenCalledTimes(1);
  });

  test('a refresh that changes the service reclassifies the linked funnel row in the same transaction', async () => {
    mockExistingLead = { id: 'lead-existing' };
    const r = await post(baseUrl, { ...validBody(), service_type: 'lawn_care', capture_token: loopbackToken() });
    expect(r.status).toBe(200);
    const lead = mockOps.find((o) => o.table === 'leads' && o.op === 'update');
    const funnel = mockOps.find((o) => o.table === 'ad_service_attribution' && o.op === 'update');
    expect(funnel).toBeDefined();
    expect(mockOrder.indexOf('update:ad_service_attribution')).toBeGreaterThan(mockOrder.indexOf('update:leads'));
    const { inferServiceLine } = require('../utils/service-line-infer');
    expect(funnel.arg.service_line).toBe(inferServiceLine(lead.arg.service_interest));
    expect(funnel.arg.service_line).toBe('lawn');
    expect(Object.keys(funnel.arg).sort()).toEqual(['service_bucket', 'service_line', 'specific_service']);
    expect(mockOps.filter((o) => o.table === 'leads' && o.op === 'insert')).toHaveLength(0);
  });

  test('no booking since the request began: no note, nothing converted, and the bell rings', async () => {
    const r = await post(baseUrl, { ...validBody(), capture_token: loopbackToken() });
    expect(r.status).toBe(200);
    expect(mockMarkConverted).not.toHaveBeenCalled();
    expect(mockTriggerNotification).toHaveBeenCalledTimes(1);
  });

  test('the refresh source: the id-only UPDATE also carries the open-status / unconverted / not-deleted predicates', () => {
    const svc = require('fs').readFileSync(require('path').join(__dirname, '../services/booking-preferred-time.js'), 'utf8');
    const refresh = svc.slice(svc.indexOf("const refreshed = await trx('leads')"), svc.indexOf('if (refreshed)'));
    expect(refresh).toMatch(/whereIn\('status', OPEN_LEAD_STATUSES\)/);
    expect(refresh).toMatch(/whereNull\('converted_at'\)/);
    expect(refresh).toMatch(/whereNull\('deleted_at'\)/);
  });

  test('the funnel row is stamped INSIDE the lead transaction (on the trx handle, before it commits), so no lead is visible without its row', async () => {
    let inTx = false;
    mockStampFunnel.mockImplementationOnce(async (handle, lead, opts) => {
      inTx = handle.isTrx === true && opts && opts.rethrow === true;
      mockOrder.push('stamp');
      return 'funnel-1';
    });
    await recordPreferredTimeRequest(mockDb, validatePreferredTimeRequest(validBody()).value, { notify: false });
    expect(inTx).toBe(true);
    expect(mockOrder.indexOf('insert:leads')).toBeLessThan(mockOrder.indexOf('stamp'));
  });

  test('a stamp failure aborts the request: no lead is committed without its row, no bell', async () => {
    mockStampFunnel.mockRejectedValueOnce(new Error('funnel insert failed'));
    await expect(recordPreferredTimeRequest(mockDb, validatePreferredTimeRequest(validBody()).value)).rejects.toThrow('funnel insert failed');
    expect(mockTriggerNotification).not.toHaveBeenCalled();
  });

  test('recovery intents are suppressed INSIDE the same transaction, before the lead is written; a failure there fails the request (no lead, no bell)', async () => {
    await recordPreferredTimeRequest(mockDb, validatePreferredTimeRequest(validBody({ session_id: 'sess-1' })).value, { notify: false });
    expect(mockOrder.indexOf('update:booking_intents')).toBeGreaterThan(-1);
    expect(mockOrder.indexOf('update:booking_intents')).toBeLessThan(mockOrder.indexOf('insert:leads'));
    mockOrder.length = 0; mockOps.length = 0;
    mockRetireError = new Error('intent update failed');
    await expect(recordPreferredTimeRequest(mockDb, validatePreferredTimeRequest(validBody()).value)).rejects.toThrow('intent update failed');
    expect(mockOps.filter((o) => o.table === 'leads' && o.op === 'insert')).toHaveLength(0);
    expect(mockTriggerNotification).not.toHaveBeenCalled();
  });

  test('a failing admin bell never fails the visitor and still sends nothing to them', async () => {
    mockTriggerNotification.mockRejectedValueOnce(new Error('bell down'));
    const r = await post(baseUrl, { ...validBody(), capture_token: loopbackToken() });
    expect(r.status).toBe(200);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockSendSMS).not.toHaveBeenCalled();
  });

  test('per-IP limiter: the sixth request inside a minute is a 429', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await post(baseUrl, { ...validBody({ phone: `94155501${String(i).padStart(2, '0')}` }), capture_token: loopbackToken() })).status);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  test('an unrecognized service value is never echoed into the lead', async () => {
    await post(baseUrl, { ...validBody({ service_id: '<script>x</script>' }), capture_token: loopbackToken() });
    const lead = mockOps.find((o) => o.table === 'leads' && o.op === 'insert').arg;
    expect(lead.service_interest).toBeNull();
  });
});

describe('GET /api/booking/config', () => {
  test('preferred_time follows the gate', async () => {
    mockDb.mockImplementation((table) => {
      const b = builder(table);
      b.first = () => Promise.resolve({});
      return b;
    });
    const get = async () => (await (await fetch(`${baseUrl}/api/booking/config`)).json());
    expect((await get()).preferred_time).toBe(false);
    process.env.GATE_BOOK_PREFERRED_TIME = 'true';
    expect((await get()).preferred_time).toBe(true);
    mockDb.mockImplementation((table) => builder(table));
  });
});

describe('capture-intent never stages recovery for a phone that asked for a time', () => {
  test('hasRecentPreferredTimeRequest reads recent request leads', async () => {
    mockExistingLead = { id: 'lead-existing' };
    expect(await hasRecentPreferredTimeRequest(mockDb, '9415550100')).toBe(true);
    mockExistingLead = null;
    expect(await hasRecentPreferredTimeRequest(mockDb, '9415550100')).toBe(false);
  });

  test('gate on + recent request: capture-intent answers the constant ok and writes no intent', async () => {
    process.env.GATE_BOOK_PREFERRED_TIME = 'true';
    mockExistingLead = { id: 'lead-existing' };
    const res = await fetch(`${baseUrl}/api/booking/capture-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': currentIp },
      body: JSON.stringify({
        capture_token: loopbackToken(), phone: '9415550100', slot_date: dayOffset(3), slot_start: '09:00',
      }),
    });
    expect(await res.json()).toEqual({ ok: true });
    // Proves the skip ran (not an earlier gate): the leads lookup happened.
    expect(mockDb).toHaveBeenCalledWith('leads');
    expect(mockOps.filter((o) => o.table === 'booking_intents' && o.op === 'insert')).toHaveLength(0);
  });
});

describe('capture-intent looks the funnel session up too', () => {
  test('the skip passes the visitor\'s session id, so a phone retyped after the request is still recognised', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/booking.js'), 'utf8');
    expect(src).toMatch(/hasRecentPreferredTimeRequest\(db, ten, \{ sessionId: captureSession \}\)/);
  });
});

describe('abandoned-booking recovery re-checks at send time', () => {
  const recovery = require('../services/booking-abandon-recovery');
  const intent = { id: 'intent-1', phone: '+19415550100', session_id: 'sess-1', captured_at: new Date(Date.now() - 3600000) };

  test('a preferred-time request filed for the phone blocks the send and suppresses the intent', async () => {
    mockExistingLead = { id: 'lead-existing' };
    expect(await recovery._internals.blockedByPreferredTimeRequest(intent)).toBe(true);
    const upd = mockOps.filter((o) => o.table === 'booking_intents' && o.op === 'update');
    expect(upd).toHaveLength(1);
    expect(upd[0].arg).toMatchObject({ suppressed: true });
  });

  test('no request on file: the send is not blocked', async () => {
    mockExistingLead = null;
    expect(await recovery._internals.blockedByPreferredTimeRequest(intent)).toBe(false);
    expect(mockOps.filter((o) => o.table === 'booking_intents')).toHaveLength(0);
  });

  test('a lookup error fails closed (skip this tick)', async () => {
    mockDb.mockImplementationOnce(() => { throw new Error('db down'); });
    expect(await recovery._internals.blockedByPreferredTimeRequest(intent)).toBe(true);
  });
});

describe('request recency is the customer\'s own latest submit, not lead edits', () => {
  const HOUR = 3600000;
  const ago = (h) => new Date(Date.now() - h * HOUR);
  // In-memory leads table that evaluates only the recency comparison (the part
  // under test): the submit-only extracted_data.last_requested_at expression,
  // or a plain column comparison, so a query on the wrong column reads as
  // "no request".
  function fakeDb(row) {
    const conds = [];
    const chain = {
      where: (a, op, val) => { if (typeof a === 'string' && op === '>') conds.push([a, val]); else if (typeof a === 'function') a(chain); return chain; },
      whereNull: () => chain, whereIn: () => chain, orWhereRaw: () => chain,
      whereRaw: (sql, [val]) => {
        if (/last_requested_at/.test(sql)) {
          conds.push([null, val, () => new Date(row.last_requested_at || row.created_at)]);
        }
        return chain;
      },
      first: async () => (conds.every(([col, val, get]) => (get ? get() : new Date(row[col])).getTime() > new Date(val).getTime()) ? { id: row.id } : undefined),
    };
    return () => chain;
  }

  test('created 25h ago, customer resubmitted 1h ago: still blocks an intent captured 2h ago and capture-intent', async () => {
    const row = { id: 'lead-1', created_at: ago(25), updated_at: ago(1), last_requested_at: ago(1).toISOString() };
    const db = fakeDb(row);
    expect(await hasRecentPreferredTimeRequest(db, '9415550100', { since: ago(2) })).toBe(true);
    expect(await hasRecentPreferredTimeRequest(db, '9415550100')).toBe(true);
  });

  test('an office edit (updated_at bumped) does NOT extend suppression', async () => {
    const row = { id: 'lead-1', created_at: ago(30), updated_at: ago(0.1), last_requested_at: ago(30).toISOString() };
    expect(await hasRecentPreferredTimeRequest(fakeDb(row), '9415550100')).toBe(false);
  });

  test('a resubmit stamps last_requested_at (and only a submit writes it)', async () => {
    mockExistingLead = { id: 'lead-existing' };
    await recordPreferredTimeRequest(mockDb, validatePreferredTimeRequest(validBody()).value, { notify: false });
    const upd = mockOps.find((o) => o.table === 'leads' && o.op === 'update');
    const stamp = JSON.parse(upd.arg.extracted_data.bindings[0]).last_requested_at;
    expect(Math.abs(Date.now() - new Date(stamp).getTime())).toBeLessThan(5000);

    mockOps.length = 0;
    mockExistingLead = null;
    await recordPreferredTimeRequest(mockDb, validatePreferredTimeRequest(validBody()).value, { notify: false });
    const ins = mockOps.find((o) => o.table === 'leads' && o.op === 'insert');
    expect(JSON.parse(ins.arg.extracted_data).last_requested_at).toBeTruthy();
  });

  test('the dedupe lookup and the suppression check both read the submit-only stamp, never updated_at', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/booking-preferred-time.js'), 'utf8');
    expect(src).toContain("extracted_data->>'last_requested_at'");
    expect(src).not.toMatch(/\.where\('updated_at'/);
    expect((src.match(/LAST_REQUESTED_SQL, \[/g) || []).length).toBe(2);
  });
});

describe('a completed booking closes the customer\'s open preferred-time request as handled (owner ruling 2026-10-01: closed, neither won nor lost)', () => {
  const { closeBookedPreferredLeads } = require('../services/booking-preferred-time');
  const bookedAt = new Date('2026-09-29T15:00:00Z');
  const booking = { id: 'sba-1', created_at: bookedAt };
  const activities = () => mockOps.filter((o) => o.table === 'lead_activities' && o.op === 'insert');
  const closeWrites = () => mockOps.filter((o) => o.table === 'leads' && o.op === 'update');
  beforeEach(() => {
    mockCustomer = { phone: '+1 (941) 555-0100' };
    mockOpenLeads = [{ id: 'lead-1' }];
    mockScheduledService = { id: 'visit-7', self_booking_id: 'sba-1', service_type: 'Lawn Care', scheduled_date: '2026-10-08' };
    mockLockedLead = { lead_type: 'book_preferred_time', status: 'new', converted_at: null, deleted_at: null, phone: '+19415550100', customer_id: null, first_name: 'Pat', last_name: 'Sample', requested_in_time: true };
  });

  test.each([
    ['its phone was reassigned to someone else', { phone: '+19415559999' }],
    ['it is now linked to a different customer', { customer_id: 'cust-other' }],
    ['staff closed it (lost)', { status: 'lost' }],
    ['staff already handled it', { status: 'handled' }],
    ['it was converted', { converted_at: new Date() }],
    ['it was deleted', { deleted_at: new Date() }],
    ['it is no longer a preferred-time lead', { lead_type: 'phone_call' }],
    ['the customer refreshed the request after the booking (newer than the booking + 60 s slack)', { requested_in_time: false }],
  ])('revalidated under the row lock (codex #5399 r14): %s -> not closed, no notice', async (_label, change) => {
    mockLockedLead = { ...mockLockedLead, ...change };
    expect(await closeBookedPreferredLeads(mockDb, { customerId: 'cust-1', booking })).toMatchObject({ live: true, closed: 0 });
    expect(activities()).toHaveLength(0);
    expect(closeWrites()).toHaveLength(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('the locked re-read applies the same request-recency cutoff as the candidate query (booking + 60 s slack)', async () => {
    await closeBookedPreferredLeads(mockDb, { customerId: 'cust-1', booking });
    const cutoffs = mockRaws.filter((o) => o.table === 'leads' && /<= \?/.test(o.arg));
    expect(cutoffs).toHaveLength(1); // the candidate query; the locked read selects it as a column
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/booking-preferred-time.js'), 'utf8');
    expect(src).toMatch(/\.forUpdate\(\)\.first\([^)]*trx\.raw\(`\(\$\{LAST_REQUESTED_SQL\.replace\(' > \?', ' <= \?'\)\}\) AS requested_in_time`, \[new Date\(bookedMs \+ BOOKING_SLACK_MS\)\]\)/s);
    expect(src).toMatch(/current\.requested_in_time === true/);
  });

  test('a lead that vanished between the query and the lock is not closed', async () => {
    mockLockedLead = null;
    expect(await closeBookedPreferredLeads(mockDb, { customerId: 'cust-1', booking })).toMatchObject({ live: true, closed: 0 });
    expect(activities()).toHaveLength(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('an unchanged lead, or one already linked to THIS customer, is still closed once', async () => {
    mockLockedLead = { ...mockLockedLead, customer_id: 'cust-1', phone: '(941) 555-0100' };
    expect(await closeBookedPreferredLeads(mockDb, { customerId: 'cust-1', booking })).toMatchObject({ live: true, closed: 1 });
    expect(closeWrites()).toHaveLength(1);
  });

  test('closes with status handled and ONE status_change audit row; no markConverted, no funnel write, nothing sent to the customer', async () => {
    expect(await closeBookedPreferredLeads(mockDb, { customerId: 'cust-1', booking })).toMatchObject({ live: true, closed: 1 });
    expect(closeWrites()).toHaveLength(1);
    expect(closeWrites()[0].arg).toEqual({ status: 'handled', updated_at: 'NOW' });
    expect(activities()).toHaveLength(1);
    expect(activities()[0].arg).toMatchObject({
      lead_id: 'lead-1',
      activity_type: 'status_change',
      performed_by: 'system',
      description: 'Closed automatically — customer booked Lawn Care for Thu, Oct 8 (visit visit-7) on /book',
    });
    expect(JSON.parse(activities()[0].arg.metadata)).toEqual({
      reason: 'booking_on_preferred_request', visit_id: 'visit-7', booking_id: 'sba-1', previous_status: 'new', status: 'handled', auto: true,
    });
    // The status write and its audit row share one transaction, status first.
    expect(mockOrder.indexOf('update:leads')).toBeLessThan(mockOrder.indexOf('insert:lead_activities'));
    expect(mockMarkConverted).not.toHaveBeenCalled();
    // The close itself writes NO funnel row at all (the request's row is only dropped later, by the
    // booking path, once the booking's own row exists: dropSupersededPreferredFunnelRows).
    expect(mockOps.filter((o) => o.table === 'ad_service_attribution')).toHaveLength(0);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockSendSMS).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockTriggerNotification).not.toHaveBeenCalled();
  });

  test('the ONLY notification is one admin FYI (Leads area, 60/110 limits, link to the lead, already_done), deduped per (lead, visit)', async () => {
    await closeBookedPreferredLeads(mockDb, { customerId: 'cust-1', booking });
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('lead');
    expect(headline).toBe('Leads — Request closed, customer booked online');
    expect(headline.length).toBeLessThanOrEqual(60);
    expect(why).toBe('Pat Sample booked Lawn Care for Thu, Oct 8; the time request closed on its own.');
    expect(why.length).toBeLessThanOrEqual(110);
    expect(opts).toMatchObject({
      link: '/admin/leads?lead=lead-1',
      dedupeKey: 'preferred-time-auto-close:lead-1:visit-7',
      bell: true,
      metadata: { area: 'Leads', severity: 'fyi', subject: { type: 'lead', id: 'lead-1' }, doneWhen: 'already_done', who: 'person' },
    });
    expect(opts).not.toHaveProperty('fyiRow');
  });

  test('a service type that looks like a code is read as words (the notice never breaks the notification rule)', async () => {
    mockScheduledService = { ...mockScheduledService, service_type: 'pest_control_quarterly' };
    await closeBookedPreferredLeads(mockDb, { customerId: 'cust-1', booking });
    expect(mockNotifyAdmin.mock.calls[0][2]).toContain('booked pest control quarterly for');
  });

  test('a failed admin notice never undoes the close or reaches the booking', async () => {
    mockNotifyAdmin.mockRejectedValueOnce(new Error('bell down'));
    expect(await closeBookedPreferredLeads(mockDb, { customerId: 'cust-1', booking })).toMatchObject({ live: true, closed: 1 });
    expect(closeWrites()).toHaveLength(1);
  });

  test('closed once per (lead, visit): the dedupe read runs under a per-(lead, visit) advisory lock, and a replay finds the audit row, closes nothing and rings nothing', async () => {
    await closeBookedPreferredLeads(mockDb, { customerId: 'cust-1', booking });
    expect(mockLocks.map((l) => l.bindings[0])).toEqual(['book_preferred_note:lead-1:visit-7']);
    mockOps.length = 0;
    mockNotifyAdmin.mockClear();
    const seenDb = jest.fn((table) => {
      const b = builder(table);
      if (table === 'lead_activities') b.first = () => Promise.resolve({ id: 'act-1' });
      return b;
    });
    seenDb.fn = mockDb.fn;
    seenDb.transaction = async (cb) => { const trx = (t) => seenDb(t); trx.raw = async () => ({ rows: [] }); trx.fn = mockDb.fn; return cb(trx); };
    expect(await closeBookedPreferredLeads(seenDb, { customerId: 'cust-1', booking })).toMatchObject({ live: true, closed: 0 });
    expect(activities()).toHaveLength(0);
    expect(closeWrites()).toHaveLength(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('every open request on the phone is closed (no ambiguity rule: nothing is being won), one FYI each', async () => {
    mockOpenLeads = [{ id: 'lead-1' }, { id: 'lead-2' }];
    expect(await closeBookedPreferredLeads(mockDb, { customerId: 'cust-1', booking })).toMatchObject({ live: true, closed: 2 });
    expect(activities().map((o) => o.arg.lead_id)).toEqual(['lead-1', 'lead-2']);
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(2);
  });

  test('a NEWER request is new work: the lookup is bounded to requests at or before the booking (+60 s slack), so it is not closed', async () => {
    mockOpenLeadsNewerOnly = true;
    expect(await closeBookedPreferredLeads(mockDb, { customerId: 'cust-1', booking })).toMatchObject({ live: true, closed: 0 });
    expect(activities()).toHaveLength(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    const cutoff = mockRaws.find((o) => o.table === 'leads' && /<= \?/.test(o.arg));
    expect(cutoff).toBeTruthy();
    expect(cutoff.arg).toMatch(/last_requested_at/);
    expect(cutoff.vals[0]).toEqual(new Date(bookedAt.getTime() + 60 * 1000));
  });

  test('a free re-service callback visit is not an acquisition: not live, nothing closed', async () => {
    mockScheduledService = { id: 'visit-7', self_booking_id: 'sba-1', is_callback: true };
    expect(await closeBookedPreferredLeads(mockDb, { customerId: 'cust-1', booking })).toEqual({ live: false, closed: 0 });
    expect(activities()).toHaveLength(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('a cancelled / skipped / rescheduled visit (or a booking with no visit) is not live: nothing closed', async () => {
    mockDeadVisit = true;
    expect(await closeBookedPreferredLeads(mockDb, { customerId: 'cust-1', booking })).toEqual({ live: false, closed: 0 });
    mockDeadVisit = false;
    mockScheduledService = null;
    expect(await closeBookedPreferredLeads(mockDb, { customerId: 'cust-1', booking })).toEqual({ live: false, closed: 0 });
    expect(activities()).toHaveLength(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('nothing open on the phone: nothing is closed (a closed / converted / deleted lead is never written to)', async () => {
    mockOpenLeads = [];
    expect(await closeBookedPreferredLeads(mockDb, { customerId: 'cust-1', booking })).toMatchObject({ live: true, closed: 0 });
    expect(activities()).toHaveLength(0);
  });

  test('no customer / no booking / no phone: nothing is touched; a failure never reaches the booking', async () => {
    expect(await closeBookedPreferredLeads(mockDb, {})).toEqual({ live: false, closed: 0 });
    expect(await closeBookedPreferredLeads(mockDb, { customerId: 'cust-1' })).toEqual({ live: false, closed: 0 });
    mockCustomer = { phone: null };
    expect(await closeBookedPreferredLeads(mockDb, { customerId: 'cust-1', booking })).toMatchObject({ live: true, closed: 0 });
    mockDb.mockImplementationOnce(() => { throw new Error('db down'); });
    await expect(closeBookedPreferredLeads(mockDb, { customerId: 'cust-1', booking })).resolves.toEqual({ live: false, closed: 0 });
  });

  test('filing the lead stamps its funnel row (attribution present) in the lead transaction; a refresh never stamps a second', async () => {
    await recordPreferredTimeRequest(mockDb, validatePreferredTimeRequest(validBody({
      attribution: { gclid: 'g-9', referrer: 'https://www.google.com/', landing_url: 'https://portal.test/book' },
    })).value, { notify: false });
    expect(mockStampFunnel).toHaveBeenCalledTimes(1);
    const stamped = mockStampFunnel.mock.calls[0][1];
    expect(stamped).toMatchObject({ id: 'lead-1', lead_type: 'book_preferred_time', gclid: 'g-9', lead_source_id: 'src-main' });
    mockStampFunnel.mockClear();
    mockExistingLead = { id: 'lead-existing' };
    await recordPreferredTimeRequest(mockDb, validatePreferredTimeRequest(validBody()).value, { notify: false });
    expect(mockStampFunnel).not.toHaveBeenCalled();
  });

  test('wiring: the normal commit path AND the txResult.existing replay path both call the close helper (skipped for a callback visit); a booking never converts', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/booking.js'), 'utf8');
    const replayStart = src.indexOf('if (txResult.existing) {');
    const replayEnd = src.indexOf('const { booking, serviceRow } = txResult;');
    expect(replayStart).toBeGreaterThan(-1);
    const replaySrc = src.slice(replayStart, replayEnd);
    expect(replaySrc).toMatch(/if \(!callbackVisit\) \{\s*await closeBookedPreferredLeads\(db, \{ customerId: custId, booking: txResult\.existing \}\);/);
    const normal = src.slice(replayEnd);
    expect(normal).toMatch(/if \(!callbackVisit\) \{\s*await closeBookedPreferredLeads\(db, \{ customerId: custId, booking \}\);/);
    // The request's funnel row is dropped by whichever closer runs SECOND: the normal path after attributeSelfBooking
    // (only when it attributed), the replay path after its close, and the submit's reconcile after its close.
    expect(normal).toMatch(/if \(selfAttribution\?\.attributed\) await dropSupersededPreferredFunnelRows\(db, \{ booking \}\);/);
    expect(normal.indexOf('await attributeSelfBooking(')).toBeLessThan(normal.indexOf('dropSupersededPreferredFunnelRows(db'));
    expect(replaySrc).toMatch(/closeBookedPreferredLeads\(db, \{ customerId: custId, booking: txResult\.existing \}\);\s*[^\n]*\n[^\n]*\n\s*await dropSupersededPreferredFunnelRows\(db, \{ booking: txResult\.existing \}\);/);
    const svc0 = require('fs').readFileSync(require('path').join(__dirname, '../services/booking-preferred-time.js'), 'utf8');
    expect(svc0).toMatch(/closeBookedPreferredLeads\(db, \{ customerId: candidate\.customer_id, booking: candidate \}\);[\s\S]*?await dropSupersededPreferredFunnelRows\(db, \{ booking: candidate \}\);/);
    // attribution runs exactly as on main: only the originating-lead conversion feeds it.
    expect(src).toMatch(/leadConverted: !!leadConversion\?\.converted,/);
    expect(src).not.toContain('convertPreferredTimeLeadsOnBooking');
    expect(src).not.toContain('preferredLeadConverted');
    // No conversion machinery anywhere in the service.
    const svc = require('fs').readFileSync(require('path').join(__dirname, '../services/booking-preferred-time.js'), 'utf8');
    expect(svc).not.toMatch(/status:\s*'won'/);
    expect(svc).not.toMatch(/markConverted|convertLeadFromEvent|convertPreferredTimeLeadsOnBooking/);
  });
});

describe('recordPreferredTimeRequest (service)', () => {
  test('notify:false files the lead without ringing anyone', async () => {
    const v = validatePreferredTimeRequest(validBody()).value;
    const out = await recordPreferredTimeRequest(mockDb, v, { notify: false });
    expect(out).toEqual({ created: true, leadId: 'lead-1' });
    expect(mockTriggerNotification).not.toHaveBeenCalled();
  });
});
