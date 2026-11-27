/**
 * GET /admin/schedule/:id/visit-texts (GATE_TECH_VISIT_TEXTS): the gate, the ownership scope and the payload.
 * Same harness as admin-schedule-visit-prep-tech-brief.test.js (real router, real technician-visit-scope, stubbed auth).
 * Synthetic data only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'tech-1';
    req.techRole = req.headers['x-test-role'] || 'admin';
    return next();
  },
  requireAdmin: (req, res, next) => (req.headers['x-test-role'] === 'technician' ? res.status(403).json({ error: 'Admin access required' }) : next()),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/appointment-tagger', () => ({
  classifyAppointmentType: () => ({ tag: 'pest_general', label: 'Pest Control' }),
  onServiceScheduled: jest.fn(),
}));
const mockLive = jest.fn(() => true);
const mockPhotos = jest.fn(() => true);
jest.mock('../config/feature-gates', () => ({
  techVisitTextsLive: (...a) => mockLive(...a),
  techVisitTextPhotosLive: (...a) => mockPhotos(...a),
  visitAccessCardsLive: () => false,
}));
jest.mock('../services/sms-media', () => ({
  signMediaForClient: async (media) => media.map((m) => ({ ...m, url: m.url || m.providerUrl || `https://signed.example/${m.key}` })),
}));
jest.mock('../services/previsit-brief', () => ({
  briefGateEnabled: () => false,
  visitFactsGateEnabled: () => false,
  deterministicVisitFacts: jest.fn(),
  briefStaleReason: () => null,
  VISIT_BRIEF_TYPE: 'visit_brief_v1',
}));
jest.mock('../models/db', () => jest.fn());

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-schedule');

const row = (id, at, over = {}) => ({ id, customer_id: 'cust-1', direction: 'inbound', message_type: 'inbound', status: 'received', message_body: `text ${id}`, metadata: null, created_at: new Date(at), ...over });

let smsRows;
let visits;
let onSmsRead;
const colOf = (name) => String(name).replace(/^(scheduled_services|sl|twin)\./, '');

// scheduled_services evaluates the predicates the route and technician-visit-scope actually build (technician, status, date window,
// customer), so removing a guard from the route makes a test fail. sms_log applies customer, bounds, order, limit and offset.
function scheduledServices() {
  const preds = [];
  const q = {
    where: (a, op, val) => {
      if (typeof a === 'object') Object.entries(a).forEach(([k, v]) => preds.push((r) => r[colOf(k)] === v));
      else if (op === '>=') preds.push((r) => String(r[colOf(a)]) >= val);
      else preds.push((r) => r[colOf(a)] === op);
      return q;
    },
    whereNotIn: (c, vals) => { preds.push((r) => !vals.includes(r[colOf(c)])); return q; },
    modify: (cb) => { cb(q); return q; },
    first: async (...cols) => {
      const hit = visits.find((r) => preds.every((p) => p(r)));
      if (!hit) return undefined;
      return cols[0] === 'scheduled_services.id' ? { id: hit.id } : { ...hit };
    },
  };
  return q;
}

function smsLog() {
  let list = smsRows.slice();
  let skip = 0;
  let max = Infinity;
  const sub = () => { const b = {}; for (const m of ['select', 'from', 'where', 'whereRaw', 'whereNull', 'orWhere', 'modify']) b[m] = (...args) => { if (typeof args[0] === 'function') args[0].call(b, b); return b; }; return b; };
  const q = {
    where: (a, op, val) => {
      if (typeof a === 'function') { a.call(sub(), sub()); return q; }
      if (op === '>=') list = list.filter((r) => r[colOf(a)] >= val);
      else if (op === '<=') list = list.filter((r) => r[colOf(a)] <= val);
      else list = list.filter((r) => r[colOf(a)] === op);
      return q;
    },
    whereNotExists: (cb) => { cb.call(sub(), sub()); return q; },
    whereRaw: () => q,
    orderBy: (c, dir) => { const k = colOf(c); list.sort((x, y) => (dir === 'desc' ? -1 : 1) * (x[k] < y[k] ? -1 : x[k] > y[k] ? 1 : 0)); return q; },
    limit: (n) => { max = n; return q; },
    offset: (n) => { skip = n; return q; },
    select: async () => { if (onSmsRead) onSmsRead(); return list.slice(skip, skip + max); },
  };
  return q;
}

db.mockImplementation((table) => (String(table).startsWith('sms_log') ? smsLog() : scheduledServices()));

async function get(role, path = 'visit-texts') {
  const app = express();
  app.use('/admin/schedule', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/schedule/svc-1/${path}`, { headers: role ? { 'x-test-role': role } : {} });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation((table) => (String(table).startsWith('sms_log') ? smsLog() : scheduledServices()));
  // Only Date is frozen: the technician access window and the 7-day window are computed from "now".
  jest.useFakeTimers({
    now: new Date('2026-11-27T15:00:00Z'),
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'],
  });
  mockLive.mockReturnValue(true);
  mockPhotos.mockReturnValue(true);
  onSmsRead = null;
  visits = [{ id: 'svc-1', customer_id: 'cust-1', technician_id: 'tech-1', status: 'confirmed', scheduled_date: '2026-11-26' }];
  smsRows = [
    row('a', '2026-11-20T15:00:00Z', { message_body: 'please skip the back yard' }),
    row('b', '2026-11-20T16:00:00Z', { direction: 'outbound', message_type: 'manual', admin_user_id: 'staff-1', metadata: { human_authored: true }, status: 'sent', message_body: 'Got it, thanks' }),
    row('c', '2026-11-20T17:00:00Z', { message_body: 'can you send me the bill again' }),
    row('d', '2026-11-20T18:00:00Z', { direction: 'outbound', message_type: 'receipt', status: 'sent', message_body: 'Thanks for your visit' }),
    row('e', '2026-11-20T19:00:00Z', { direction: 'outbound', message_type: 'brand_new_type_2027', status: 'sent', message_body: 'hello there' }),
    row('f', '2026-11-20T20:00:00Z', { message_body: 'Brown patch by the gate', metadata: { media: [{ key: 'sms-media/inbound/k1', providerUrl: 'https://api.twilio.com/m/1', contentType: 'image/jpeg' }] } }),
    row('h', '2026-11-20T20:30:00Z', { message_body: '', metadata: { media: [{ key: 'sms-media/inbound/k2', contentType: 'image/png' }] } }),
    row('g', '2026-11-20T21:00:00Z', { customer_id: 'cust-2', message_body: 'another customer' }),
  ];
});

afterEach(() => { jest.useRealTimers(); });

describe('GET /:id/visit-texts', () => {
  test('gate off: 404 {enabled:false}, nothing read', async () => {
    mockLive.mockReturnValue(false);
    const res = await get('technician');
    expect(res).toEqual({ status: 404, body: { enabled: false } });
    expect(db).not.toHaveBeenCalled();
  });

  test('the assigned technician gets the texts, photos as signed links, money held back and counted', async () => {
    const { status, body } = await get('technician');
    expect(status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.texts.map((t) => t.id)).toEqual(['a', 'b', 'f', 'h']);
    expect(body.texts[3].photos).toEqual([{ url: 'https://signed.example/sms-media/inbound/k2', contentType: 'image/png' }]);
    expect(body.texts[2].photos).toEqual([{ url: 'https://signed.example/sms-media/inbound/k1', contentType: 'image/jpeg' }]);
    expect(body.hidden).toBe(3); // c (bill word), d (receipt type), e (unknown type)
    const text = JSON.stringify(body);
    for (const leaked of ['bill again', 'Thanks for your visit', 'hello there', 'another customer', 'twilio']) expect(text).not.toContain(leaked);
  });

  test('photo gate off: the words show, no photo link is signed, the count says what was held back', async () => {
    mockPhotos.mockReturnValue(false);
    const { body } = await get('technician');
    expect(body.texts[2]).toMatchObject({ id: 'f', photos: [], photoCount: 1 });
    expect(body.texts.map((t) => t.id)).toEqual(['a', 'b', 'f']); // a photo with no words waits for the photo switch
    expect(JSON.stringify(body)).not.toContain('signed.example');
  });

  test('a technician not assigned the visit gets the same 404 as an unknown visit, and sms_log is never read', async () => {
    visits[0].technician_id = 'tech-2';
    const res = await get('technician');
    expect(res.status).toBe(404);
    expect(db.mock.calls.map((c) => c[0])).not.toContain('sms_log as sl');
  });

  test('a visit outside the technician access window or cancelled reads nothing', async () => {
    visits[0].status = 'cancelled';
    expect((await get('technician')).status).toBe(404);
    visits[0].status = 'confirmed';
    visits[0].scheduled_date = '2026-11-10';
    expect((await get('technician')).status).toBe(404);
  });

  test('reassigned away while the texts were read: 404, nothing returned', async () => {
    onSmsRead = () => { visits[0].technician_id = 'tech-2'; };
    const res = await get('technician');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/back yard|signed\.example/);
  });

  test('a customer merge or undo during the read withholds the whole answer: 404, no texts, no signed links', async () => {
    onSmsRead = () => { visits[0].customer_id = 'cust-2'; };
    const { status, body } = await get('technician');
    expect(status).toBe(404);
    expect(JSON.stringify(body)).not.toMatch(/back yard|signed\.example/);
  });

  test('a reschedule during the read (the visit date changed) withholds the whole answer', async () => {
    onSmsRead = () => { visits[0].scheduled_date = '2026-11-27'; };
    const { status, body } = await get('technician');
    expect(status).toBe(404);
    expect(JSON.stringify(body)).not.toMatch(/back yard|signed\.example/);
  });

  test('an admin reaches any visit, whoever it is assigned to', async () => {
    visits[0].technician_id = 'tech-2';
    const res = await get('admin');
    expect(res.status).toBe(200);
    expect(res.body.texts).toHaveLength(4);
  });
});

describe('GET /:id/visit-brief carries the flag the Visit Brief reads', () => {
  test('visitTexts: true only while the gate is on, and no texts are read', async () => {
    const on = await get('technician', 'visit-brief');
    expect(on.status).toBe(200);
    expect(on.body.visitTexts).toBe(true);
    expect(db.mock.calls.map((c) => c[0])).not.toContain('sms_log as sl');
    mockLive.mockReturnValue(false);
    const off = await get('technician', 'visit-brief');
    expect(off.body).not.toHaveProperty('visitTexts');
  });
});
