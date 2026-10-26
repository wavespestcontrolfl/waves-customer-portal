/**
 * GATE_TECH_LOGIN_PRIVACY (owner 2026-10-25, second technician): a technician
 * login sees only its own customers' alerts and promises. This file holds the
 * parts that run without Postgres: who a customer alert is pushed to (M4),
 * the promise routes answering 404 for another technician's customer (M5),
 * and the account-deleted push reaching admin devices only (A10). The bell
 * feed and the promise feeds against real rows are in
 * tech-login-privacy-db.test.js.
 */
// Read when the gate map loads, so it is set before any require.
process.env.GATE_CALL_COMMITMENTS = 'true';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'notif-1' })),
}));
jest.mock('../services/push-notifications', () => ({
  sendToAdminUsers: jest.fn(async () => ({ subscriptions: 0, sent: 0, expired: 0, failed: 0, skipped: 0, results: [] })),
}));
jest.mock('../services/admin-unread', () => ({
  getUnreadCountForAdmin: jest.fn(async () => ({ count: 0, at: Date.now() })),
}));
jest.mock('../services/technician-visit-scope', () => ({
  ...jest.requireActual('../services/technician-visit-scope'),
  technicianServicesCustomer: jest.fn(),
  technicianCustomerIdsSubquery: jest.fn(() => 'own-customers-subquery'),
}));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const PushService = require('../services/push-notifications');
const NotificationService = require('../services/notification-service');
const scope = require('../services/technician-visit-scope');
const { triggerNotification } = require('../services/notification-triggers');

function tableMock(rows) {
  const chain = {
    where: jest.fn(() => chain),
    select: jest.fn(() => Promise.resolve(rows)),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

const STAFF = [
  { id: 'admin-1', role: 'admin' },
  { id: 'tech-own', role: 'technician' },
  { id: 'tech-other', role: 'technician' },
];

// Technician "tech-own" has a current visit at customer-own only.
function ownRoute() {
  scope.technicianServicesCustomer.mockImplementation(async (req, customerId) => (
    req.technicianId === 'tech-own' && customerId === 'customer-own'
  ));
}

const pushedIds = () => PushService.sendToAdminUsers.mock.calls.map((call) => call[0]);

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_TECH_LOGIN_PRIVACY;
  db.mockImplementation((table) => tableMock(table === 'technicians' ? STAFF : []));
  ownRoute();
});
afterAll(() => { delete process.env.GATE_TECH_LOGIN_PRIVACY; delete process.env.GATE_CALL_COMMITMENTS; });

describe('M4: a customer-text alert reaches a technician only for that technician\'s own customer', () => {
  const ownText = { threadId: 'customer-own', twilioSid: 'SM-own', message: 'Gate is open', fromName: 'Dana Example' };

  test('gate on: the technician with the visit and the admin are pushed; the other technician is not', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    await triggerNotification('sms_reply', ownText);
    expect(pushedIds()).toEqual([['admin-1', 'tech-own']]);
  });

  test('gate on: another technician\'s customer reaches the admin only', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    await triggerNotification('sms_reply', { ...ownText, threadId: 'customer-elsewhere' });
    expect(pushedIds()).toEqual([['admin-1']]);
  });

  test('gate on: the scope uses customerId, not only the SMS thread id', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    await triggerNotification('appointment_reschedule_intent', { customerId: 'customer-elsewhere', name: 'Dana Example', message: 'Away that week' });
    expect(pushedIds()).toEqual([['admin-1']]);
  });

  test('gate on: the service report alerts carry scopeCustomerId and follow the same rule', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    await triggerNotification('service_report_delivery_failed', { scopeCustomerId: 'customer-own', customerName: 'Dana Example' });
    expect(pushedIds()).toEqual([['admin-1', 'tech-own']]);
    PushService.sendToAdminUsers.mockClear();
    await triggerNotification('service_report_pdf_failed', { scopeCustomerId: 'customer-elsewhere', customerName: 'Dana Example' });
    expect(pushedIds()).toEqual([['admin-1']]);
  });

  test('gate on: an alert with no customer keeps today\'s routing', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    await triggerNotification('sandy_transfer_no_context', { from: '+19415550100' });
    await triggerNotification('sms_reply', { twilioSid: 'SM-unknown', message: 'Who is this', fromPhone: '+19415550101' });
    expect(pushedIds()).toEqual([['admin-1', 'tech-own', 'tech-other'], ['admin-1', 'tech-own', 'tech-other']]);
    expect(scope.technicianServicesCustomer).not.toHaveBeenCalled();
  });

  test('gate on: an admin-only trigger is untouched (admins only, no customer lookup)', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    db.mockImplementation((table) => tableMock(table === 'technicians' ? [STAFF[0]] : []));
    await triggerNotification('payment_failed', { customerId: 'customer-elsewhere', customerName: 'Dana Example', amount: 10 });
    expect(pushedIds()).toEqual([['admin-1']]);
    expect(scope.technicianServicesCustomer).not.toHaveBeenCalled();
  });

  test('gate on: a failed scope lookup drops the technician (fail closed) and still reaches the admin', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    scope.technicianServicesCustomer.mockRejectedValue(new Error('Synthetic lookup outage'));
    await triggerNotification('sms_reply', ownText);
    expect(pushedIds()).toEqual([['admin-1']]);
  });

  test('gate off: every staff member is pushed, as before, with no scope lookup', async () => {
    await triggerNotification('sms_reply', { ...ownText, threadId: 'customer-elsewhere' });
    expect(pushedIds()).toEqual([['admin-1', 'tech-own', 'tech-other']]);
    expect(scope.technicianServicesCustomer).not.toHaveBeenCalled();
  });

  test('the bell row is still written once for the admins', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    const result = await triggerNotification('sms_reply', { ...ownText, threadId: 'customer-elsewhere' });
    expect(result.bellWritten).toBe(true);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });
});

describe('M5: the promise routes answer 404 for a customer outside the technician\'s route', () => {
  jest.mock('../config', () => ({ jwt: { secret: 'test-jwt-secret' }, twilio: { accountSid: 'AC_test', authToken: 'auth_test' } }));
  jest.mock('../services/call-recording-processor', () => ({}));
  jest.mock('../middleware/admin-auth', () => {
    const actual = jest.requireActual('../middleware/admin-auth');
    return {
      ...actual,
      adminAuthenticate: (req, _res, next) => {
        req.technicianId = 'tech-own';
        req.techRole = global.__privacyRole || 'technician';
        next();
      },
    };
  });
  jest.mock('../services/call-commitments', () => ({
    ...jest.requireActual('../services/call-commitments'),
    listOpenCommitments: jest.fn(async () => []),
    listAutoClosedCommitments: jest.fn(async () => ({ commitments: [], next: null })),
    applyHumanUpdate: jest.fn(async () => ({ id: 'ok' })),
    addHumanCommitment: jest.fn(async () => ({ id: 'new' })),
  }));
  jest.mock('../services/call-reschedule-proposals', () => ({
    enabled: () => true,
    listProposals: jest.fn(async () => []),
    dismissProposal: jest.fn(async () => ({ ok: true })),
    previewProposal: jest.fn(),
    applyProposal: jest.fn(),
  }));

  const express = require('express');
  const router = require('../routes/admin-call-recordings');
  const commitments = require('../services/call-commitments');
  const proposals = require('../services/call-reschedule-proposals');

  const COMMITMENT_ID = '11111111-2222-4333-8444-000000000001';
  const CALL_ID = '11111111-2222-4333-8444-000000000002';
  const PROPOSAL_ID = '11111111-2222-4333-8444-000000000003';
  const OWN_CUSTOMER_ID = '11111111-2222-4333-8444-0000000000a1';
  const OTHER_CUSTOMER_ID = '11111111-2222-4333-8444-0000000000b2';

  function withServer(fn) {
    const app = express();
    app.use(express.json());
    app.use('/calls', router);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    return fn(base).finally(() => new Promise((r) => server.close(r)));
  }
  const send = (base, method, route, body) => fetch(`${base}/calls${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });

  // call_log.customer_id of a call is the promise's customer; triage_items points at a call.
  function tables({ callCustomer }) {
    db.mockImplementation((table) => {
      const row = {
        call_commitments: { call_log_id: CALL_ID, sms_log_id: null, email_id: null, kind: 'estimate', party: 'waves' },
        call_log: { id: CALL_ID, customer_id: callCustomer },
        triage_items: { call_log_id: CALL_ID },
      }[table];
      const chain = { where: jest.fn(() => chain), first: jest.fn(async () => row) };
      return chain;
    });
  }

  beforeEach(() => {
    global.__privacyRole = 'technician';
    scope.technicianServicesCustomer.mockImplementation(async (_req, customerId) => customerId === OWN_CUSTOMER_ID);
  });
  afterEach(() => { delete global.__privacyRole; });

  test('gate on: PATCH on a promise from another technician\'s customer is 404 and writes nothing', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    tables({ callCustomer: OTHER_CUSTOMER_ID });
    await withServer(async (base) => {
      const res = await send(base, 'PATCH', `/commitments/${COMMITMENT_ID}`, { action: 'dismiss' });
      expect(res.status).toBe(404);
    });
    expect(commitments.applyHumanUpdate).not.toHaveBeenCalled();
  });

  test('gate on: PATCH on a promise whose call has no customer is 404 for a technician', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    tables({ callCustomer: null });
    await withServer(async (base) => {
      expect((await send(base, 'PATCH', `/commitments/${COMMITMENT_ID}`, { action: 'dismiss' })).status).toBe(404);
    });
    expect(commitments.applyHumanUpdate).not.toHaveBeenCalled();
  });

  test('gate on: PATCH on an own-customer promise goes through', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    tables({ callCustomer: OWN_CUSTOMER_ID });
    await withServer(async (base) => {
      expect((await send(base, 'PATCH', `/commitments/${COMMITMENT_ID}`, { action: 'dismiss' })).status).toBe(200);
    });
    expect(commitments.applyHumanUpdate).toHaveBeenCalledTimes(1);
  });

  test('gate on: an admin changes any promise', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    global.__privacyRole = 'admin';
    tables({ callCustomer: OTHER_CUSTOMER_ID });
    await withServer(async (base) => {
      expect((await send(base, 'PATCH', `/commitments/${COMMITMENT_ID}`, { action: 'dismiss' })).status).toBe(200);
    });
    expect(scope.technicianServicesCustomer).not.toHaveBeenCalled();
  });

  test('gate off: a technician changes any promise, as before', async () => {
    tables({ callCustomer: OTHER_CUSTOMER_ID });
    await withServer(async (base) => {
      expect((await send(base, 'PATCH', `/commitments/${COMMITMENT_ID}`, { action: 'dismiss' })).status).toBe(200);
    });
    expect(scope.technicianServicesCustomer).not.toHaveBeenCalled();
  });

  test('gate on: recording a promise on another customer\'s call, and acting on their proposal, are 404', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    tables({ callCustomer: OTHER_CUSTOMER_ID });
    await withServer(async (base) => {
      expect((await send(base, 'POST', `/calls/${CALL_ID}/commitments`, { party: 'waves', kind: 'estimate', description: 'Send the estimate' })).status).toBe(404);
      expect((await send(base, 'POST', `/proposals/${PROPOSAL_ID}/dismiss`, {})).status).toBe(404);
      expect((await send(base, 'POST', `/proposals/${PROPOSAL_ID}/preview`, {})).status).toBe(404);
      expect((await send(base, 'POST', `/proposals/${PROPOSAL_ID}/apply`, {
        visit_id: CALL_ID, preview_hash: 'a'.repeat(64),
      })).status).toBe(404);
    });
    expect(commitments.addHumanCommitment).not.toHaveBeenCalled();
    expect(proposals.dismissProposal).not.toHaveBeenCalled();
    expect(proposals.applyProposal).not.toHaveBeenCalled();
  });

  test('the feeds hand the technician\'s own-customer subquery to the readers; an admin and gate off pass none', async () => {
    await withServer(async (base) => {
      process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
      for (const feed of ['/commitments/open', '/commitments/auto-closed', '/proposals']) {
        expect((await send(base, 'GET', feed)).status).toBe(200);
      }
      expect(commitments.listOpenCommitments.mock.calls[0][1].customerScope).toBe('own-customers-subquery');
      expect(commitments.listAutoClosedCommitments.mock.calls[0][1].customerScope).toBe('own-customers-subquery');
      expect(proposals.listProposals.mock.calls[0][1].customerScope).toBe('own-customers-subquery');

      jest.clearAllMocks();
      global.__privacyRole = 'admin';
      for (const feed of ['/commitments/open', '/commitments/auto-closed', '/proposals']) await send(base, 'GET', feed);
      global.__privacyRole = 'technician';
      delete process.env.GATE_TECH_LOGIN_PRIVACY;
      for (const feed of ['/commitments/open', '/commitments/auto-closed', '/proposals']) await send(base, 'GET', feed);
      expect(commitments.listOpenCommitments.mock.calls.map((c) => c[1].customerScope)).toEqual([null, null]);
      expect(commitments.listAutoClosedCommitments.mock.calls.map((c) => c[1].customerScope)).toEqual([null, null]);
      expect(proposals.listProposals.mock.calls.map((c) => c[1].customerScope)).toEqual([null, null]);
    });
  });
});

describe('A10: the customer-deleted-account push goes to admin devices only', () => {
  test('sendToAdmins with adminOnly reads the admin role alone; without it, both staff roles as before', async () => {
    jest.resetModules();
    const mockQuery = {};
    for (const method of ['join', 'where', 'whereIn', 'whereRaw']) mockQuery[method] = jest.fn(() => mockQuery);
    mockQuery.select = jest.fn(async () => []);
    jest.doMock('../models/db', () => jest.fn(() => mockQuery));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/apns', () => ({ send: jest.fn(), status: () => ({ configured: false }) }));
    jest.doMock('../services/fcm', () => ({ send: jest.fn(), status: () => ({ configured: false }) }));
    jest.doMock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));
    jest.unmock('../services/push-notifications');
    const realPush = jest.requireActual('../services/push-notifications');

    await realPush.sendToAdmins({ title: 'Customer deleted their account' }, { adminOnly: true });
    expect(mockQuery.whereIn).toHaveBeenCalledWith('t.role', ['admin']);
    mockQuery.whereIn.mockClear();
    await realPush.sendToAdmins({ title: 'Update' });
    expect(mockQuery.whereIn).toHaveBeenCalledWith('t.role', ['admin', 'technician']);
  });

  test('the account deletion route asks for admin devices only when the gate is on, and passes no option when off', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf8');
    const start = src.indexOf("title: 'Customer deleted their account'");
    const call = src.slice(start, src.indexOf('} catch (notifyErr)', start));
    expect(call).toContain("techLoginPrivacyLive?.() ? [{ adminOnly: true }] : []");
  });
});
