// Audit repro r1-authz-6: technician-role staff token can flip the global
// system_config.ai_sms_auto_reply switch via POST /api/admin/communications/ai-auto-reply
// (router.use mounts adminAuthenticate + requireTechOrAdmin; the route has no requireAdmin).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn(async (cb) => cb(fn));
  return fn;
});
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    // Only the token→row lookup is faked; requireAdmin/requireTechOrAdmin are real.
    adminAuthenticate: (req, res, next) => {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (token !== 'tech' && token !== 'admin') return res.status(401).json({ error: 'Admin authentication required' });
      req.technician = { id: `${token}-1`, role: token === 'tech' ? 'technician' : 'admin' };
      req.technicianId = req.technician.id;
      req.techRole = req.technician.role;
      return next();
    },
  };
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => (function Anthropic() { return { messages: { create: jest.fn() } }; }));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-communications');

function chain({ first } = {}) {
  const q = {};
  ['where', 'orderBy', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.update = jest.fn(async () => 1);
  q.insert = jest.fn(async () => [1]);
  q.first = jest.fn(async () => first);
  q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  return q;
}

async function call(method, path, token, body) {
  const a = express();
  a.use(express.json());
  a.use('/api/admin/communications', router);
  const server = a.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe('r1-authz-6: technician token vs POST /api/admin/communications/ai-auto-reply', () => {
  beforeEach(() => db.mockReset());

  test('technician POST {enabled:true} with no existing row inserts ai_sms_auto_reply=true (expected 403)', async () => {
    const q = chain({ first: undefined });
    db.mockImplementation(() => q);
    const res = await call('POST', '/api/admin/communications/ai-auto-reply', 'tech', { enabled: true });
     
    console.log('tech POST status', res.status, JSON.stringify(res.body), 'insert calls', JSON.stringify(q.insert.mock.calls), 'update calls', q.update.mock.calls.length);
    expect(res.status).toBe(403);
    expect(q.insert).not.toHaveBeenCalled();
    expect(q.update).not.toHaveBeenCalled();
  });

  test('technician POST {enabled:false} with existing row flips the switch off (expected 403)', async () => {
    const q = chain({ first: { key: 'ai_sms_auto_reply', value: 'true' } });
    db.mockImplementation(() => q);
    const res = await call('POST', '/api/admin/communications/ai-auto-reply', 'tech', { enabled: false });
     
    console.log('tech POST(off) status', res.status, JSON.stringify(res.body), 'update calls', JSON.stringify(q.update.mock.calls));
    expect(res.status).toBe(403);
    expect(q.update).not.toHaveBeenCalled();
  });

  test('control: admin POST {enabled:true} is allowed (200, upsert called)', async () => {
    const q = chain({ first: undefined });
    db.mockImplementation(() => q);
    const res = await call('POST', '/api/admin/communications/ai-auto-reply', 'admin', { enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
    expect(q.insert).toHaveBeenCalledWith({ key: 'ai_sms_auto_reply', value: 'true' });
  });
});
