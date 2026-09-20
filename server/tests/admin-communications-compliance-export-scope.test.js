/**
 * Compliance export keeps the recruiting boundary: messaging_audit_log
 * body_preview holds the whole applicant invite (bearer interview link
 * included), so a non-admin export excludes audience 'applicant' rows; an
 * admin export is unfiltered. Both JSON and CSV go through the same query.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('twilio', () => jest.fn(() => ({ calls: { create: jest.fn() } })));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/twilio', () => ({}));
jest.mock('../config', () => ({ twilio: { accountSid: 'AC_test', authToken: 'auth_test' } }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!['admin', 'tech'].includes(token)) return res.status(401).json({ error: 'nope' });
    req.techRole = token === 'admin' ? 'admin' : 'technician';
    req.technicianId = token === 'admin' ? 'admin-1' : 'tech-1';
    req.technician = { id: req.technicianId, role: req.techRole };
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (req, res, next) => (req.techRole !== 'admin' ? res.status(403).json({ error: 'Admin access required' }) : next()),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-media', () => ({
  mediaFromOutboundAttachments: jest.fn(() => []),
  signMediaForClient: jest.fn(async (media) => media),
}));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(() => Promise.resolve()) }));
const mockIsRecruitingPhone = jest.fn(async () => false);
jest.mock('../utils/recruiting-thread-scope', () => {
  const real = jest.requireActual('../utils/recruiting-thread-scope');
  return { ...real, isRecruitingPhone: (...a) => mockIsRecruitingPhone(...a) };
});

const express = require('express');
const db = require('../models/db');
const communicationsRouter = require('../routes/admin-communications');

function query({ result = [] } = {}) {
  const q = {};
  ['where', 'whereNot', 'whereNull', 'orWhere', 'whereRaw', 'whereIn', 'orderBy', 'limit', 'select', 'leftJoin', 'first']
    .forEach((m) => { q[m] = jest.fn(() => q); });
  q.select = jest.fn(async () => result);
  q.first = jest.fn(async () => result[0] || null);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

let server;
let base;
let auditQuery;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/communications', communicationsRouter);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  auditQuery = query({ result: [] });
  db.mockReset();
  db.mockImplementation((table) => (table === 'messaging_audit_log' ? auditQuery : query({ result: [] })));
});

async function exportAs(role, format = 'json') {
  const res = await fetch(`${base}/api/admin/communications/compliance-export?format=${format}`, {
    headers: { Authorization: `Bearer ${role}` },
  });
  return res;
}

test('technician export excludes applicant audit rows (JSON)', async () => {
  const res = await exportAs('tech');
  expect(res.status).toBe(200);
  expect(auditQuery.whereNot).toHaveBeenCalledWith({ audience: 'applicant' });
});

test('technician export excludes applicant audit rows (CSV)', async () => {
  const res = await exportAs('tech', 'csv');
  expect(res.status).toBe(200);
  expect(auditQuery.whereNot).toHaveBeenCalledWith({ audience: 'applicant' });
});

test('admin export is unfiltered', async () => {
  const res = await exportAs('admin');
  expect(res.status).toBe(200);
  expect(auditQuery.whereNot).not.toHaveBeenCalledWith({ audience: 'applicant' });
});

describe('POST /ai-draft recruiting boundary', () => {
  async function draftAs(role) {
    return fetch(`${base}/api/admin/communications/ai-draft`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${role}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerPhone: '+19415550142', lastMessage: 'hi' }),
    });
  }

  test('technician is refused (403) for an applicant phone BEFORE any history is read', async () => {
    mockIsRecruitingPhone.mockResolvedValueOnce(true);
    db.mockClear();
    const res = await draftAs('tech');
    expect(res.status).toBe(403);
    expect(db).not.toHaveBeenCalled();
  });

  test('admin is never refused by the recruiting boundary', async () => {
    mockIsRecruitingPhone.mockResolvedValueOnce(true);
    const res = await draftAs('admin');
    expect(res.status).not.toBe(403);
  });
});

describe('GET /scheduled recruiting boundary', () => {
  test('technician: queued recruiting texts are filtered (message-level predicate); admin: unfiltered', async () => {
    const smsLogQuery = query({ result: [] });
    smsLogQuery.where = jest.fn((arg) => { if (typeof arg === 'function') arg.call(smsLogQuery); return smsLogQuery; });
    smsLogQuery.leftJoin = jest.fn(() => smsLogQuery);
    smsLogQuery.select = jest.fn(() => smsLogQuery);
    smsLogQuery.orderBy = jest.fn(async () => []);
    db.mockImplementation((table) => (table === 'sms_log' ? smsLogQuery : query({ result: [] })));
    let res = await fetch(`${base}/api/admin/communications/scheduled`, { headers: { Authorization: 'Bearer tech' } });
    expect(res.status).toBe(200);
    expect(smsLogQuery.orWhere).toHaveBeenCalledWith('sms_log.message_type', 'not like', 'job_%');
    smsLogQuery.orWhere.mockClear();
    res = await fetch(`${base}/api/admin/communications/scheduled`, { headers: { Authorization: 'Bearer admin' } });
    expect(res.status).toBe(200);
    expect(smsLogQuery.orWhere).not.toHaveBeenCalled();
  });
});
