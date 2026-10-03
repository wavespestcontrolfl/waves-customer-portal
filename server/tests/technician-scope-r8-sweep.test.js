// Codex #5568 r8 sweep: every technician per-visit authorization in the field
// routers uses the ONE canonical current-assignment predicate
// (technicianVisitRowInScope) instead of a bare technician_id compare. A visit
// that is cancelled / rescheduled / skipped / no_show, or older than the
// 7-day access window, grants a technician nothing; an own current visit
// passes. Admin behavior is unchanged.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const fs = require('fs');
const path = require('path');
const { etDateString, addETDays } = require('../utils/datetime-et');

const TODAY = etDateString(new Date());
const STALE = etDateString(addETDays(new Date(), -30));
const VISIT = '11111111-1111-4111-8111-111111111111';

// One scheduled_services row the mocked db hands to every route.
let mockVisit = null;
let mockRecord = null;

jest.mock('../models/db', () => {
  const fn = jest.fn((table) => {
    const c = {};
    for (const m of ['where', 'whereNull', 'whereIn', 'orderBy', 'forUpdate', 'select', 'leftJoin']) c[m] = jest.fn(() => c);
    c.first = jest.fn(async () => {
      if (table === 'scheduled_services') return mockVisit;
      if (table === 'service_records') return mockRecord;
      if (table === 'customers') return { id: 'c1', first_name: 'Pat', last_name: 'Sample', phone: '(941) 555-0100' };
      return null;
    });
    c.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    c.catch = jest.fn(() => undefined);
    return c;
  });
  fn.raw = jest.fn((sql) => sql);
  fn.transaction = async (cb) => cb(fn);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/service-report/pdf-queue', () => ({ enqueuePdfRenderJob: jest.fn() }));
jest.mock('../services/dispatch-alerts', () => ({ createAlertOnce: jest.fn() }));
jest.mock('../services/rain-out', () => ({
  getOptions: jest.fn(async () => ({ ok: true, options: [] })),
  commit: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/service-report/photo-chain', () => ({ validatePhotoChain: jest.fn(async () => ({ ok: true })) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin' },
      tech: { id: 'tech-1', role: 'technician' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    ['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).json({ error: 'Staff access required' })
  ),
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));
// tech-line collaborators
jest.mock('../services/tech-line', () => ({ techLineContext: jest.fn(async () => ({ line: { number: '+19413529161', formatted: '(941) 352-9161', label: 'Tech line 1' }, cell: '+19415550101', technicianName: 'Jordan' })) }));
jest.mock('../services/call-bridge', () => ({
  placeBridgeCall: jest.fn(async () => ({ callSid: 'CA-1', callLogId: 'log-1' })),
  activeBridgeCall: jest.fn(async () => null),
}));
jest.mock('../services/lead-estimate-link', () => ({ stampFirstResponseByContact: jest.fn(async () => 1) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true, providerMessageId: `SM${'a'.repeat(32)}` })) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), gateEnvTimestamp: jest.fn(() => null) }));
jest.mock('../services/sms-suggest-mode', () => ({
  reserveHumanReply: jest.fn(async () => ({ parkedDecisionIds: [], reservationId: '22222222-2222-4222-8222-222222222222', autoSendInFlight: false })),
  settleHumanReply: jest.fn(async () => undefined),
}));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => undefined) }));

const express = require('express');
const techTrackRouter = require('../routes/tech-track');
const serviceRecordsRouter = require('../routes/service-records');
const techLineRouter = require('../routes/tech-line');
const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

const visit = (over = {}) => ({
  id: VISIT, customer_id: 'c1', technician_id: 'tech-1', status: 'confirmed', scheduled_date: TODAY, ...over,
});
// Refused: another technician's visit is covered by the existing suites; here
// the row IS the caller's, but no longer a current assignment.
const NOT_CURRENT = [
  ['cancelled', { status: 'cancelled' }],
  ['rescheduled', { status: 'rescheduled' }],
  ['skipped', { status: 'skipped' }],
  ['no_show', { status: 'no_show' }],
  ['older than the access window', { scheduled_date: STALE }],
];

async function withServer(mount, fn) {
  const app = express();
  app.use(express.json());
  mount(app);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}
const withTrack = (fn) => withServer((app) => app.use('/api/tech/services', techTrackRouter), fn);
const withRecords = (fn) => withServer((app) => app.use('/api/service/records', serviceRecordsRouter), fn);
const authed = (token = 'tech', init = {}) => ({ method: 'GET', ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });

beforeEach(() => {
  jest.clearAllMocks();
  mockVisit = visit();
  mockRecord = null;
  // The durable text claim answers through db.raw (a row = claim acquired).
  db.raw = jest.fn((sql) => (/INSERT INTO sms_send_claims/.test(String(sql)) ? Promise.resolve({ rows: [{ id: 1 }] }) : sql));
});

describe('tech-track: read (rain-out-options)', () => {
  const url = (b) => `${b}/api/tech/services/${VISIT}/rain-out-options`;

  test('an own current visit passes', async () => {
    await withTrack(async (b) => {
      expect((await fetch(url(b), authed())).status).toBe(200);
    });
  });

  test.each(NOT_CURRENT)('own visit that is %s -> 403', async (_label, over) => {
    mockVisit = visit(over);
    await withTrack(async (b) => {
      const res = await fetch(url(b), authed());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Not assigned to this service' });
    });
  });
});

describe('tech-track: mutation (photos/reconcile)', () => {
  const url = (b) => `${b}/api/tech/services/${VISIT}/photos/reconcile`;
  const post = (token) => authed(token, { method: 'POST' });

  test('an own current visit passes the guard (no completion record -> 409 not_completed)', async () => {
    await withTrack(async (b) => {
      const res = await fetch(url(b), post());
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('not_completed');
    });
  });

  test.each(NOT_CURRENT)('own visit that is %s -> 403 before any work', async (_label, over) => {
    mockVisit = visit(over);
    await withTrack(async (b) => {
      const res = await fetch(url(b), post());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Not assigned to this service' });
    });
  });

  test('admin is unscoped: a cancelled, stale visit of another technician still passes the guard', async () => {
    mockVisit = visit({ technician_id: 'tech-9', status: 'cancelled', scheduled_date: STALE });
    await withTrack(async (b) => {
      expect((await fetch(url(b), post('admin'))).status).toBe(409);
    });
  });
});

describe('tech-track: status-flip legs keep their admin refusal and gain the current-assignment check', () => {
  const enRoute = (b, token) => fetch(`${b}/api/tech/services/${VISIT}/en-route`, authed(token, { method: 'POST' }));

  test.each(NOT_CURRENT)('own visit that is %s -> 403 on en-route', async (_label, over) => {
    mockVisit = visit(over);
    await withTrack(async (b) => {
      expect((await enRoute(b, 'tech')).status).toBe(403);
    });
  });

  test("an admin who is NOT the row's assigned technician is still refused (historic contract)", async () => {
    await withTrack(async (b) => {
      expect((await enRoute(b, 'admin')).status).toBe(403);
    });
  });
});

describe('tech-line: visitCustomer (SMS / call to a visit customer)', () => {
  const callRoute = async (method, p, reqOver = {}) => {
    const layer = techLineRouter.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]);
    const r = { statusCode: 200, body: null };
    r.status = jest.fn((c) => { r.statusCode = c; return r; });
    r.json = jest.fn((b) => { r.body = b; return r; });
    const next = jest.fn();
    await layer.route.stack[0].handle({ technicianId: 'tech-1', techRole: 'technician', body: { scheduledServiceId: VISIT, body: 'hi' }, ...reqOver }, r, next);
    if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
    return r;
  };

  test('an own current visit may be texted', async () => {
    const r = await callRoute('post', '/sms');
    expect(r.statusCode).toBe(200);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test.each(NOT_CURRENT)('own visit that is %s -> 403, nothing sent', async (_label, over) => {
    mockVisit = visit(over);
    const r = await callRoute('post', '/sms');
    expect(r.statusCode).toBe(403);
    expect(r.body).toEqual({ error: 'Not assigned to this visit' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('admin may text any visit, whatever its state', async () => {
    mockVisit = visit({ technician_id: 'tech-9', status: 'cancelled', scheduled_date: STALE });
    expect((await callRoute('post', '/sms', { techRole: 'admin' })).statusCode).toBe(200);
  });
});

describe('service-records: validate-photo-chain', () => {
  const url = (b) => `${b}/api/service/records/rec-1/validate-photo-chain`;

  test('a record linked to an own current visit passes', async () => {
    mockRecord = { id: 'rec-1', technician_id: 'tech-1', scheduled_service_id: VISIT };
    await withRecords(async (b) => {
      expect((await fetch(url(b), authed())).status).toBe(200);
    });
  });

  test.each(NOT_CURRENT)('a record whose linked visit is %s -> 403', async (_label, over) => {
    mockRecord = { id: 'rec-1', technician_id: 'tech-1', scheduled_service_id: VISIT };
    mockVisit = visit(over);
    await withRecords(async (b) => {
      expect((await fetch(url(b), authed())).status).toBe(403);
    });
  });

  test('another technician\'s record is still refused; admin passes', async () => {
    mockRecord = { id: 'rec-1', technician_id: 'tech-9', scheduled_service_id: VISIT };
    await withRecords(async (b) => {
      expect((await fetch(url(b), authed())).status).toBe(403);
      expect((await fetch(url(b), authed('admin'))).status).toBe(200);
    });
  });
});

describe('source pins: no bare technician_id authorization left in the swept routers', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('tech-track / tech-line / admin-consultations / the dispatch recap guards use the canonical predicate', () => {
    for (const rel of ['routes/tech-track.js', 'routes/tech-line.js']) {
      expect(read(rel)).not.toMatch(/\.technician_id\s*!==\s*req\.technicianId/);
    }
    const consult = read('routes/admin-consultations.js');
    expect(consult).toMatch(/technicianVisitRowInScope\(req, visit\)/);
    expect(consult).toMatch(/q\.where\('ss\.technician_id', req\.technicianId\)\s*\.whereNotIn\('ss\.status', TECH_DEAD_ASSIGNMENT_STATUSES\)\s*\.where\('ss\.scheduled_date', '>=', techAccessCutoff\(\)\)/);

    const dispatch = read('routes/admin-dispatch.js');
    const recapOwnership = dispatch.slice(dispatch.indexOf('async function assertRecapOwnership'), dispatch.indexOf('function recapStatusForReason'));
    expect(recapOwnership).toMatch(/technicianVisitRowInScope\(req, svc\)/);
    expect(recapOwnership).not.toMatch(/svc\.technician_id !== req\.technicianId/);
    const ownerOk = dispatch.slice(dispatch.indexOf('async function recapOwnerOk'), dispatch.indexOf('const recapVideoActor'));
    expect(ownerOk).toMatch(/technicianVisitRowInScope\(req, svc\)/);
    expect(ownerOk).not.toMatch(/svc\.technician_id === req\.technicianId/);
  });

  test('every tech-track guard row is loaded with status and scheduled_date', () => {
    const src = read('routes/tech-track.js');
    const guards = [...src.matchAll(/(?:technicianVisitRowInScope|ownsTrackedVisit)\(req, (svc|fresh)\)/g)];
    expect(guards.length).toBeGreaterThanOrEqual(15);
    // No narrow select that names technician_id but omits status.
    for (const m of src.matchAll(/\.first\(([^)]*technician_id[^)]*)\)/g)) {
      expect(m[1]).toMatch(/status/);
    }
  });
});
