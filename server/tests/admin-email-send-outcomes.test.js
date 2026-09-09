// Actual native send route with a controlled provider; no network or DB calls.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    req.techRole = req.headers.authorization;
    return req.techRole ? next() : res.status(401).json({ error: 'Authentication required' });
  },
  requireAdmin: (req, res, next) => req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin required' }),
}));
jest.mock('../services/email/gmail-client', () => ({ sendMessage: jest.fn() }));
jest.mock('../services/email/email-sync', () => ({ syncEmails: jest.fn() }));
jest.mock('../services/email/email-classifier', () => ({ classifyEmail: jest.fn() }));
jest.mock('../services/email/email-actions', () => ({ executeAutoAction: jest.fn() }));
jest.mock('../services/email/spam-blocker', () => ({ unblockSender: jest.fn(), manualBlockSender: jest.fn() }));
jest.mock('../services/staff-oauth-state', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), error: jest.fn() }));
const express = require('express');
const gmail = require('../services/email/gmail-client');
const app = express();
app.use(express.json());
app.use('/api/admin/email', require('../routes/admin-email'));
const payload = { to: 'fixture@example.invalid', subject: 'Fixture', body: 'Test only', threadId: 'fixture-thread' };
let server;
beforeAll(done => { server = app.listen(0, '127.0.0.1', done); });
afterAll(done => { server.close(done); });
const send = async (role = 'admin', body = payload) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/email/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(role ? { Authorization: role } : {}) }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
beforeEach(() => jest.clearAllMocks());

test('reports the exact accepted message id', async () => {
  gmail.sendMessage.mockResolvedValue({ id: 'fixture-message' });
  const res = await send();
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, status: 'provider_accepted', messageId: 'fixture-message' });
  expect(gmail.sendMessage).toHaveBeenCalledWith(payload.to, payload.subject, payload.body, payload.threadId, undefined);
});

test.each(['timeout', 'missing-id'])('%s stays unknown and never invites an unverified retry', async mode => {
  if (mode === 'timeout') gmail.sendMessage.mockRejectedValue(Object.assign(new Error('fixture@example.invalid private provider error'), { providerOutcome: { outcomeUnknown: true } }));
  else gmail.sendMessage.mockResolvedValue({});
  const res = await send();
  expect(res.status).toBe(202);
  expect(res.body).toMatchObject({ status: 'outcome_unknown' });
  expect(res.body.success).toBeUndefined();
  expect(JSON.stringify(res.body)).not.toContain(payload.to);
  expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
});

test('preserves a definite failed result separately', async () => {
  gmail.sendMessage.mockRejectedValue(new Error('Pre-send failure'));
  const res = await send();
  expect(res.status).toBe(502);
  expect(res.body.status).toBe('failed');
});

test.each([[null, 401], ['technician', 403]])('role %s cannot submit a message', async (role, status) => {
  expect((await send(role)).status).toBe(status);
  expect(gmail.sendMessage).not.toHaveBeenCalled();
});

test('invalid input is definitely not submitted', async () => {
  const res = await send('admin', { to: payload.to });
  expect(res.status).toBe(400);
  expect(res.body.status).toBe('failed');
  expect(gmail.sendMessage).not.toHaveBeenCalled();
});
