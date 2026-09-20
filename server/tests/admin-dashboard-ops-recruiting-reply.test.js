/**
 * Dashboard inbox reply to an applicant message rides the recruiting rail
 * (owner-only, job_owner_reply, evidence on the application) — never a
 * 'manual' customer text (Codex r7 P0 on #4623).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!['admin', 'tech'].includes(token)) return res.status(401).json({ error: 'nope' });
    req.techRole = token === 'admin' ? 'admin' : 'technician';
    req.technicianId = token === 'admin' ? 'admin-1' : 'tech-1';
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (req, res, next) => (req.techRole !== 'admin' ? res.status(403).json({ error: 'Admin access required' }) : next()),
}));
const mockSendCustomerMessage = jest.fn(async () => ({ sent: true, providerMessageId: 'SM1' }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSendCustomerMessage(...a) }));
jest.mock('../services/inbound-sms-read', () => ({ markInboundSmsRead: jest.fn(async () => ({})) }));
const mockSendOwnerReply = jest.fn(async () => ({ outcome: 'sent', applicationId: 'app-1' }));
jest.mock('../services/recruiting-comms', () => ({ sendOwnerReply: (...a) => mockSendOwnerReply(...a), errorSummary: (e) => (e && e.name) || 'Error' }));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-dashboard-ops');

function original(messageType) {
  const q = {};
  ['leftJoin', 'where', 'whereNull', 'orWhere', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => ({ id: 'm-1', conversation_id: 'c-1', message_type: messageType, metadata: { job_application_id: 'app-1' }, customer_id: 'cust-1', our_endpoint_id: '+19415550199', contact_phone: '+19415550142' }));
  return q;
}

let server; let base;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/admin/dashboard', router);
  await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => { mockSendOwnerReply.mockClear(); mockSendCustomerMessage.mockClear(); });

async function reply(role, messageType) {
  db.mockImplementation((table) => (table === 'messages' ? original(messageType) : original(messageType)));
  return fetch(`${base}/api/admin/dashboard/inbox/m-1/reply`, { method: 'POST', headers: { Authorization: `Bearer ${role}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Thanks, see you then' }) });
}

test('admin reply to an applicant message goes through sendOwnerReply from the inbound line, not sendCustomerMessage', async () => {
  const res = await reply('admin', 'job_applicant_reply');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ success: true, recruiting: true });
  expect(mockSendOwnerReply).toHaveBeenCalledWith({ applicationId: 'app-1', body: 'Thanks, see you then', by: 'admin-1', fromNumber: '+19415550199' });
  expect(mockSendCustomerMessage).not.toHaveBeenCalled();
});

test('technician reply to an applicant message is refused (403)', async () => {
  // the reader filter hides the row from a technician in production; a hit that slips through is still refused
  const res = await reply('tech', 'job_applicant_reply');
  expect(res.status).toBe(403);
  expect(mockSendOwnerReply).not.toHaveBeenCalled();
});

test('an ordinary customer message still replies through sendCustomerMessage', async () => {
  const res = await reply('admin', 'inbound');
  expect(res.status).toBe(200);
  expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
  expect(mockSendOwnerReply).not.toHaveBeenCalled();
});
