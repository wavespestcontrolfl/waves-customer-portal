// Schedule send routes (GATE_EMAIL_SEND_LATER): the gate, admin-only access,
// and the send-time checks. No network or DB. The reads find no row; the only
// write a refusal may make is the void row that settles its client key.
const mockInsert = jest.fn((row) => {
  if (row.status !== 'cancelled' || row.restored_at === undefined) throw new Error('only the void row may be written');
  return { onConflict: () => ({ ignore: () => ({ returning: async () => [{ id: 'void-fixture' }] }) }) };
});
jest.mock('../models/db', () => Object.assign(jest.fn(() => ({ where: () => ({ first: async () => undefined }), insert: mockInsert })), { fn: { now: () => 'now()' } }));
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
const db = require('../models/db');
const app = express();
app.use(express.json());
app.use('/api/admin/email', require('../routes/admin-email'));
let server;
beforeAll(done => { server = app.listen(0, '127.0.0.1', done); });
afterAll(done => { server.close(done); });
afterEach(() => { delete process.env.GATE_EMAIL_SEND_LATER; jest.clearAllMocks(); });

const etIn = (minutes) => new Date(Date.now() + minutes * 60000)
  .toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 16).replace(' ', 'T');
const valid = () => ({ to: 'fixture@example.invalid', subject: 'Fixture', body: 'Hi<br>there', draftText: 'Hi\nthere', sendAt: etIn(60), clientKey: 'fixture-key-0001' });
const call = async (method, path, { role = 'admin', body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/email${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(role ? { Authorization: role } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
};

test('with the gate off nothing is queued, listed or cancelled', async () => {
  expect(await call('POST', '/schedule', { body: valid() })).toEqual({ status: 404, body: { enabled: false, error: 'Schedule send is off.' } });
  expect(await call('GET', '/scheduled')).toEqual({ status: 200, body: { enabled: false, emails: [] } });
  expect((await call('POST', '/scheduled/fixture/cancel')).status).toBe(404);
  expect(db).not.toHaveBeenCalled();
});

test.each([
  ['a time in the past', { sendAt: etIn(-5) }, 'Pick a time at least a minute from now.'],
  ['a time more than a year out', { sendAt: etIn(400 * 24 * 60) }, 'Pick a time within a year.'],
  ['a zoned instant instead of Eastern wall clock', { sendAt: new Date(Date.now() + 3600000).toISOString() }, 'sendAt must be YYYY-MM-DDTHH:MM (Eastern)'],
  ['no draft text to restore', { draftText: '' }, 'to, body and draftText required'],
  ['a date that does not exist', { sendAt: '2027-02-31T09:00' }, 'That time does not exist once in Eastern time. Pick another.'],
  ['the spring-forward gap', { sendAt: '2027-03-14T02:30' }, 'That time does not exist once in Eastern time. Pick another.'],
  ['the repeated fall-back hour', { sendAt: '2026-11-01T01:30' }, 'That time does not exist once in Eastern time. Pick another.'],
  ['no client key', { clientKey: undefined }, 'clientKey required'],
])('refuses %s, queuing nothing', async (_label, change, error) => {
  process.env.GATE_EMAIL_SEND_LATER = 'true';
  const res = await call('POST', '/schedule', { body: { ...valid(), ...change } });
  // Only a refusal made after the clientKey lookup lets the browser drop it.
  const afterLookup = !/required$/.test(error);
  expect(res).toEqual({ status: 400, body: { error, ...(afterLookup ? { keyChecked: true } : {}) } });
  // A refusal after the lookup voids the key (one void row); none queues.
  expect(mockInsert).toHaveBeenCalledTimes(afterLookup ? 1 : 0);
  if (afterLookup) expect(mockInsert.mock.calls[0][0]).toMatchObject({ status: 'cancelled', client_key: 'fixture-key-0001' });
});

test.each([[null, 401], ['technician', 403]])('role %s cannot schedule', async (role, status) => {
  process.env.GATE_EMAIL_SEND_LATER = 'true';
  expect((await call('POST', '/schedule', { role, body: valid() })).status).toBe(status);
  expect(db).not.toHaveBeenCalled();
});
