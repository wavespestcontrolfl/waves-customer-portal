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
jest.mock('../config/feature-gates', () => ({ techVisitTextsLive: (...a) => mockLive(...a), visitAccessCardsLive: () => false }));
jest.mock('../services/sms-media', () => ({
  signMediaForClient: async (media) => media.map((m) => ({ ...m, url: `https://signed.example/${m.key}` })),
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

const SVC_ROW = { id: 'svc-1', customer_id: 'cust-1', scheduled_date: '2026-11-26' };
const row = (id, at, over = {}) => ({ id, customer_id: 'cust-1', direction: 'inbound', message_type: 'inbound', status: 'received', message_body: `text ${id}`, metadata: null, created_at: new Date(at), ...over });

let smsRows;
let smsWhere;
function stubDb({ ownsVisit = true, recheckOwns = null } = {}) {
  db.mockImplementation((table) => {
    const q = {};
    let list = smsRows.slice();
    q.where = jest.fn((a, op, val) => {
      if (table === 'sms_log') {
        smsWhere.push([a, op, val]);
        if (typeof a === 'object') list = list.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        else if (op === '>=') list = list.filter((r) => r[a] >= val);
        else if (op === '<=') list = list.filter((r) => r[a] <= val);
      }
      return q;
    });
    q.whereNotIn = jest.fn(() => q);
    q.modify = jest.fn((cb) => { cb(q); return q; });
    q.orderBy = jest.fn((col, dir) => { list.sort((x, y) => (dir === 'desc' ? -1 : 1) * (x[col] < y[col] ? -1 : x[col] > y[col] ? 1 : 0)); return q; });
    q.limit = jest.fn((n) => { list = list.slice(0, n); return q; });
    q.select = jest.fn(async () => list);
    q.first = jest.fn(async (...cols) => {
      if (table !== 'scheduled_services') return undefined;
      if (cols[0] === 'scheduled_services.id') return (recheckOwns ?? ownsVisit) ? { id: 'svc-1' } : undefined;
      return ownsVisit ? SVC_ROW : undefined;
    });
    return q;
  });
}

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
  mockLive.mockReturnValue(true);
  smsWhere = [];
  smsRows = [
    row('a', '2026-11-20T15:00:00Z', { message_body: 'please skip the back yard' }),
    row('b', '2026-11-20T16:00:00Z', { direction: 'outbound', message_type: 'manual', status: 'sent', message_body: 'Got it, thanks' }),
    row('c', '2026-11-20T17:00:00Z', { message_body: 'can you send me the bill again' }),
    row('d', '2026-11-20T18:00:00Z', { direction: 'outbound', message_type: 'receipt', status: 'sent', message_body: 'Thanks for your visit' }),
    row('e', '2026-11-20T19:00:00Z', { direction: 'outbound', message_type: 'brand_new_type_2027', status: 'sent', message_body: 'hello there' }),
    row('f', '2026-11-20T20:00:00Z', { message_body: '', metadata: { media: [{ key: 'sms-media/inbound/k1', providerUrl: 'https://api.twilio.com/m/1', contentType: 'image/jpeg' }] } }),
    row('g', '2026-11-20T21:00:00Z', { customer_id: 'cust-2', message_body: 'another customer' }),
  ];
});

describe('GET /:id/visit-texts', () => {
  test('gate off: 404 {enabled:false}, nothing read', async () => {
    mockLive.mockReturnValue(false);
    stubDb();
    const res = await get('technician');
    expect(res).toEqual({ status: 404, body: { enabled: false } });
    expect(db).not.toHaveBeenCalled();
  });

  test('the assigned technician gets the texts, photos as signed links, money held back and counted', async () => {
    stubDb();
    const { status, body } = await get('technician');
    expect(status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.texts.map((t) => t.id)).toEqual(['a', 'b', 'f']);
    expect(body.texts[2].photos).toEqual([{ url: 'https://signed.example/sms-media/inbound/k1', contentType: 'image/jpeg' }]);
    expect(body.hidden).toBe(3); // c (bill word), d (receipt type), e (unknown type)
    const text = JSON.stringify(body);
    for (const leaked of ['bill again', 'Thanks for your visit', 'hello there', 'another customer', 'twilio']) expect(text).not.toContain(leaked);
    expect(smsWhere[0][0]).toEqual({ customer_id: 'cust-1' });
  });

  test('a technician not assigned the visit gets the same 404 as an unknown visit, and sms_log is never read', async () => {
    stubDb({ ownsVisit: false });
    const res = await get('technician');
    expect(res.status).toBe(404);
    expect(db.mock.calls.map((c) => c[0])).not.toContain('sms_log');
  });

  test('reassigned away while the texts were read: 404, nothing returned', async () => {
    stubDb({ ownsVisit: true, recheckOwns: false });
    const res = await get('technician');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('back yard');
  });

  test('an admin reaches any visit', async () => {
    stubDb();
    const res = await get('admin');
    expect(res.status).toBe(200);
    expect(res.body.texts).toHaveLength(3);
  });
});

describe('GET /:id/visit-brief carries the flag the Visit Brief reads', () => {
  test('visitTexts: true only while the gate is on, and no texts are read', async () => {
    stubDb();
    const on = await get('technician', 'visit-brief');
    expect(on.status).toBe(200);
    expect(on.body.visitTexts).toBe(true);
    expect(db.mock.calls.map((c) => c[0])).not.toContain('sms_log');
    mockLive.mockReturnValue(false);
    const off = await get('technician', 'visit-brief');
    expect(off.body).not.toHaveProperty('visitTexts');
  });
});
