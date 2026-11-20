/**
 * Dashboard inbox reply to an applicant message rides the recruiting rail
 * (owner-only, job_owner_reply, evidence on the application) — never a
 * 'manual' customer text (Codex r7 P0 on #4623). A staff reply from a
 * website-only line checks the number it actually goes to.
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
const mockWebsiteLineRefusal = jest.fn(async () => null);
jest.mock('../services/website-line-contact', () => ({ websiteLineRefusal: (...a) => mockWebsiteLineRefusal(...a) }));

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
beforeEach(() => { mockSendOwnerReply.mockClear(); mockSendCustomerMessage.mockClear(); mockWebsiteLineRefusal.mockReset(); mockWebsiteLineRefusal.mockResolvedValue(null); });

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

test('a reply on a CLOSED application is refused (422) and sends nothing', async () => {
  mockSendOwnerReply.mockResolvedValueOnce({ outcome: 'closed', applicationId: 'app-1' });
  const res = await reply('admin', 'job_applicant_reply');
  expect(res.status).toBe(422);
  expect(mockSendCustomerMessage).not.toHaveBeenCalled();
});

describe('a staff reply on a website-only line thread', () => {
  const WEB_LINE = '+19412542617';
  const CURRENT_PHONE = '+19415550177';
  const chain = (row) => {
    const q = {};
    ['leftJoin', 'where', 'whereNull', 'orWhere', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => row);
    return q;
  };
  // A thread with no contact phone: the reply falls back to the customer's current phone.
  const replyOnWebLineThread = () => {
    db.mockImplementation((table) => (table === 'customers'
      ? chain({ id: 'cust-1', phone: CURRENT_PHONE })
      : chain({ id: 'm-1', conversation_id: 'c-1', message_type: 'inbound', metadata: {}, customer_id: 'cust-1', our_endpoint_id: WEB_LINE, contact_phone: null })));
    return fetch(`${base}/api/admin/dashboard/inbox/m-1/reply`, { method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Thanks, see you then' }) });
  };

  test('checks the line against the number the reply goes to, and refuses a number that never contacted it', async () => {
    mockWebsiteLineRefusal.mockResolvedValueOnce('That line is shown only on a Waves website.');
    const res = await replyOnWebLineThread();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'That line is shown only on a Waves website.', code: 'WEBSITE_LINE_FIRST_CONTACT' });
    expect(mockWebsiteLineRefusal).toHaveBeenCalledWith(WEB_LINE, CURRENT_PHONE);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a check that cannot read fails closed: an error answer, and nothing is sent', async () => {
    mockWebsiteLineRefusal.mockRejectedValueOnce(Object.assign(new Error('The website-only line contact check could not read the message and call logs'), { code: 'WEBSITE_LINE_UNVERIFIED' }));
    const res = await replyOnWebLineThread();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('sends from the thread line when that number contacted it', async () => {
    const res = await replyOnWebLineThread();
    expect(res.status).toBe(200);
    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(mockSendCustomerMessage.mock.calls[0][0]).toMatchObject({ to: CURRENT_PHONE, metadata: expect.objectContaining({ fromNumber: WEB_LINE }) });
  });
});
