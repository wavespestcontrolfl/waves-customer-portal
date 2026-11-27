'use strict';

// The account holder's list of people a caller named for the visit texts (owner 2026-11-24 PM, 2026-11-27 "yes"):
//   GET  /api/notifications/reminder-contacts/:customerId
//   POST /api/notifications/reminder-contacts/:customerId/:reminderId/stop | restart
// Holder only, one of the account's own profiles only, by = 'customer'. The stop rules themselves (sticky, a mark never
// a delete, every visit row of the number) are proven on real SQL in call-visit-recipient-postgres.test.js.

// The stop / restart write runs in a transaction that locks the profile's customers row (mockProfile answers it).
// Every customers read answers from mockProfiles by id: an entry means "an active profile of the signed-in account"
// (the route's own COALESCE(account_id, id) check is SQL, proven on real PostgreSQL elsewhere; here it is the answer).
const mockProfiles = { current: {} };
jest.mock('../models/db', () => {
  const read = () => {
    let ids = [];
    const q = {};
    q.whereIn = (_col, list) => { ids = list; return q; };
    q.orderBy = () => q;
    q.select = () => q;
    q.forUpdate = () => q;
    q.forShare = () => q;
    q.then = (resolve, reject) => Promise.resolve(ids.map((id) => mockProfiles.current[id]).filter(Boolean)).then(resolve, reject);
    return q;
  };
  const db = jest.fn(read);
  db.raw = jest.fn((sql) => sql);
  db.transaction = jest.fn(async (fn) => fn(Object.assign(jest.fn(read), { isTransaction: true, raw: db.raw })));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/account-properties', () => ({
  ...jest.requireActual('../services/account-properties'),
  accountPropertyIds: jest.fn(async () => [OWN]),
}));
jest.mock('../services/call-visit-recipient', () => ({
  listReminderContacts: jest.fn(async () => [{ id: REMINDER, firstName: 'Bob', stopped: false, hasAppAccess: false }]),
  setReminderContactStopped: jest.fn(async ({ stopped, by }) => ({ id: REMINDER, stopped, stoppedBy: stopped ? by : null })),
}));
const mockSession = { current: null };
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { Object.assign(req, mockSession.current); next(); },
  revokeRemovedContactRefreshSessions: jest.fn(() => Promise.resolve(0)),
}));

const OWN = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const REMINDER = '33333333-3333-4333-8333-333333333333';

const express = require('express');
const VisitRecipient = require('../services/call-visit-recipient');
const router = require('../routes/notifications');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  mockSession.current = { customerId: OWN, customer: { id: OWN } };
  mockProfiles.current = { [OWN]: { id: OWN, active: true, deleted_at: null, owner_account: OWN } };
});

const call = (method, path) => fetch(`${baseUrl}/api/notifications${path}`, { method, headers: { 'content-type': 'application/json' } })
  .then(async (res) => ({ status: res.status, body: await res.json() }));

test('the holder reads the list of one of their own profiles', async () => {
  const res = await call('GET', `/reminder-contacts/${OWN}`);
  expect(res.status).toBe(200);
  expect(res.body.reminderContacts).toEqual([expect.objectContaining({ firstName: 'Bob', hasAppAccess: false })]);
  expect(VisitRecipient.listReminderContacts).toHaveBeenCalledWith(OWN, { conn: expect.any(Function) });
});

test('stop and restart are recorded as the customer\'s own choice', async () => {
  const stop = await call('POST', `/reminder-contacts/${OWN}/${REMINDER}/stop`);
  expect(stop).toMatchObject({ status: 200, body: { reminderContact: { stopped: true, stoppedBy: 'customer' } } });
  expect(VisitRecipient.setReminderContactStopped).toHaveBeenLastCalledWith({ customerId: OWN, id: REMINDER, stopped: true, by: 'customer', conn: expect.any(Function) });
  const restart = await call('POST', `/reminder-contacts/${OWN}/${REMINDER}/restart`);
  expect(restart).toMatchObject({ status: 200, body: { reminderContact: { stopped: false } } });
  expect(VisitRecipient.setReminderContactStopped).toHaveBeenLastCalledWith({ customerId: OWN, id: REMINDER, stopped: false, by: 'customer', conn: expect.any(Function) });
});

test('another account\'s profile is refused and nothing is read or changed', async () => {
  expect((await call('GET', `/reminder-contacts/${OTHER}`)).status).toBe(403);
  expect((await call('POST', `/reminder-contacts/${OTHER}/${REMINDER}/stop`)).status).toBe(403);
  expect(VisitRecipient.listReminderContacts).not.toHaveBeenCalled();
  expect(VisitRecipient.setReminderContactStopped).not.toHaveBeenCalled();
});

test('a contact session is refused (holder only)', async () => {
  mockSession.current = { customerId: OWN, customer: { id: OWN }, contactSession: { phoneKey: '9415550100', slot: 1 } };
  expect((await call('GET', `/reminder-contacts/${OWN}`))).toMatchObject({ status: 403, body: { code: 'ACCOUNT_HOLDER_ONLY' } });
  expect((await call('POST', `/reminder-contacts/${OWN}/${REMINDER}/stop`)).status).toBe(403);
  expect(VisitRecipient.setReminderContactStopped).not.toHaveBeenCalled();
});

test('a bad id is a 400; an id not on this customer\'s list is a 404', async () => {
  expect((await call('POST', `/reminder-contacts/${OWN}/not-a-uuid/stop`)).status).toBe(400);
  VisitRecipient.setReminderContactStopped.mockResolvedValueOnce(null);
  expect((await call('POST', `/reminder-contacts/${OWN}/${REMINDER}/stop`)).status).toBe(404);
});

test('a profile merged away (or no longer on the account) between the check and the locked write changes nothing', async () => {
  // The first (unlocked) check sees the profile; the locked one in the write's transaction does not.
  const db = require('../models/db');
  db.transaction.mockImplementationOnce(async (fn) => {
    mockProfiles.current = {};
    return fn(Object.assign(jest.fn(() => db()), { isTransaction: true, raw: db.raw }));
  });
  expect((await call('POST', `/reminder-contacts/${OWN}/${REMINDER}/restart`)).status).toBe(403);
  expect(VisitRecipient.setReminderContactStopped).not.toHaveBeenCalled();
});

test('a signed-in profile moved to another account after sign-in reaches nothing on its old account', async () => {
  const SIBLING = '44444444-4444-4444-8444-444444444444';
  mockProfiles.current = {
    [OWN]: { id: OWN, active: true, deleted_at: null, owner_account: OTHER },
    [SIBLING]: { id: SIBLING, active: true, deleted_at: null, owner_account: OWN },
  };
  expect((await call('GET', `/reminder-contacts/${SIBLING}`)).status).toBe(403);
  expect((await call('POST', `/reminder-contacts/${SIBLING}/${REMINDER}/restart`)).status).toBe(403);
  expect(VisitRecipient.listReminderContacts).not.toHaveBeenCalled();
  expect(VisitRecipient.setReminderContactStopped).not.toHaveBeenCalled();
});

test('a signed-in profile staff turned off reaches nothing on its account', async () => {
  const SIBLING = '44444444-4444-4444-8444-444444444444';
  mockProfiles.current = {
    [OWN]: { id: OWN, active: false, deleted_at: null, owner_account: OWN },
    [SIBLING]: { id: SIBLING, active: true, deleted_at: null, owner_account: OWN },
  };
  expect((await call('GET', `/reminder-contacts/${SIBLING}`)).status).toBe(403);
  expect((await call('POST', `/reminder-contacts/${SIBLING}/${REMINDER}/stop`)).status).toBe(403);
  expect(VisitRecipient.setReminderContactStopped).not.toHaveBeenCalled();
});

test('a profile id in capital letters is the same profile', async () => {
  const UPPER = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  const lower = UPPER.toLowerCase();
  mockProfiles.current = {
    [OWN]: { id: OWN, active: true, deleted_at: null, owner_account: OWN },
    [lower]: { id: lower, active: true, deleted_at: null, owner_account: OWN },
  };
  expect((await call('GET', `/reminder-contacts/${UPPER}`)).status).toBe(200);
});
