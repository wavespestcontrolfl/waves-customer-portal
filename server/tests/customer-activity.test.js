/**
 * Customer activity (GATE_PORTAL_ACTIVITY): the throttled last_seen_at stamp
 * from the customer auth middleware, the portal page-view and push-open
 * beacon routes, and the route-name / push-subject sanitisers.
 *
 * The REAL auth middleware and the REAL customer-activity router run against
 * a stubbed db; db.raw records every SQL statement so the tests can pin what
 * was (and was not) written.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'customer-activity-test-secret';

const mockRaw = jest.fn();
let mockCustomer;
function mockChain() {
  const chain = new Proxy(function chainFn() {}, {
    get(_t, prop) {
      if (prop === 'first') return jest.fn(async () => mockCustomer);
      if (prop === 'then') return (resolve) => resolve(mockCustomer ? [mockCustomer] : []);
      return jest.fn(() => chain);
    },
  });
  return chain;
}
const mockDb = jest.fn(() => mockChain());
mockDb.raw = (...a) => mockRaw(...a);
mockDb.fn = { now: jest.fn() };
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const auth = require('../middleware/auth');
const activity = require('../services/customer-activity');

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const NOTIFICATION_ID = '22222222-2222-4222-8222-222222222222';
const HUMAN_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1';

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  const probe = express.Router();
  probe.use(auth.authenticate);
  probe.get('/ping', (req, res) => res.json({ ok: true }));
  app.use('/api/probe', probe);
  app.use('/api/customer/activity', require('../routes/customer-activity'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

const savedGate = process.env.GATE_PORTAL_ACTIVITY;
const savedAdminIps = process.env.WAVES_ADMIN_IPS;
beforeEach(() => {
  mockRaw.mockReset();
  mockRaw.mockResolvedValue({ rowCount: 1 });
  mockCustomer = { id: CUSTOMER_ID, account_id: CUSTOMER_ID, active: true, deleted_at: null };
  process.env.GATE_PORTAL_ACTIVITY = 'true';
  delete process.env.WAVES_ADMIN_IPS;
});
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_PORTAL_ACTIVITY; else process.env.GATE_PORTAL_ACTIVITY = savedGate;
  if (savedAdminIps === undefined) delete process.env.WAVES_ADMIN_IPS; else process.env.WAVES_ADMIN_IPS = savedAdminIps;
});

const bearer = () => ({ Authorization: `Bearer ${auth.generateToken(CUSTOMER_ID, CUSTOMER_ID)}` });
async function call(method, path, { headers = {}, body, auth: withAuth = true } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'user-agent': HUMAN_UA, ...(withAuth ? bearer() : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json || {} };
}
const updates = () => mockRaw.mock.calls.filter(([sql]) => /UPDATE customers/.test(sql));
const inserts = () => mockRaw.mock.calls.filter(([sql]) => /INSERT INTO customer_page_views/.test(sql));
const tick = () => new Promise((r) => setImmediate(r));

describe('last_seen_at stamp (auth middleware)', () => {
  test('an authenticated request stamps last_seen_at with the throttle in the WHERE clause', async () => {
    const res = await call('GET', '/api/probe/ping');
    expect(res.status).toBe(200);
    await tick();
    expect(updates()).toHaveLength(1);
    const [sql, params] = updates()[0];
    expect(sql).toMatch(/last_seen_at IS NULL OR last_seen_at < now\(\)/);
    expect(params).toEqual([CUSTOMER_ID, activity.LAST_SEEN_THROTTLE_MINUTES]);
  });

  test('gate off: no stamp and the request is unchanged', async () => {
    delete process.env.GATE_PORTAL_ACTIVITY;
    const res = await call('GET', '/api/probe/ping');
    expect(res.status).toBe(200);
    await tick();
    expect(updates()).toHaveLength(0);
  });

  test('staff marker cookie (staff browsing as a customer) does not stamp', async () => {
    const marker = jwt.sign({ kind: 'admin_marker', sub: 'staff-1' }, config.jwt.secret);
    const res = await call('GET', '/api/probe/ping', { headers: { cookie: `waves_admin=${encodeURIComponent(marker)}` } });
    expect(res.status).toBe(200);
    await tick();
    expect(updates()).toHaveLength(0);
  });

  test('a staff IP and a bot user agent do not stamp', async () => {
    process.env.WAVES_ADMIN_IPS = '127.0.0.1,::ffff:127.0.0.1,::1';
    await call('GET', '/api/probe/ping');
    await tick();
    expect(updates()).toHaveLength(0);
    delete process.env.WAVES_ADMIN_IPS;
    await call('GET', '/api/probe/ping', { headers: { 'user-agent': 'curl/8.4.0' } });
    await tick();
    expect(updates()).toHaveLength(0);
    await call('GET', '/api/probe/ping');
    await tick();
    expect(updates()).toHaveLength(1);
  });

  test('a failing stamp never fails or delays the request', async () => {
    mockRaw.mockRejectedValue(new Error('db down'));
    const res = await call('GET', '/api/probe/ping');
    expect(res.status).toBe(200);
    mockRaw.mockImplementation(() => { throw new Error('sync boom'); });
    expect((await call('GET', '/api/probe/ping')).status).toBe(200);
  });

  test('an unauthenticated request never reaches the stamp', async () => {
    const res = await call('GET', '/api/probe/ping', { auth: false });
    expect(res.status).toBe(401);
    expect(updates()).toHaveLength(0);
  });
});

describe('POST /api/customer/activity/page-view', () => {
  test('requires customer auth', async () => {
    const res = await call('POST', '/api/customer/activity/page-view', { auth: false, body: { route: 'visits' } });
    expect(res.status).toBe(401);
    expect(inserts()).toHaveLength(0);
  });

  test('records portal:<tab> with the platform hint and no subject id', async () => {
    const res = await call('POST', '/api/customer/activity/page-view', { body: { route: 'visits', platform: 'ios' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, enabled: true });
    await tick();
    expect(inserts()).toHaveLength(1);
    const params = inserts()[0][1];
    expect(params[0]).toBe(CUSTOMER_ID);
    expect(params[1]).toBe('portal:visits');
    expect(params[2]).toBe('ios');
    expect(params[3]).toBeNull();
    expect(params[4]).toMatch(/^[0-9a-f]{64}$/);
  });

  test('an unknown platform hint falls back to web', async () => {
    await call('POST', '/api/customer/activity/page-view', { body: { route: 'billing', platform: 'windows-phone' } });
    await tick();
    expect(inserts()[0][1][2]).toBe('web');
  });

  test('the route is sanitised: ids, tokens and query strings never reach the row', async () => {
    const good = [
      ['visits/123e4567-e89b-42d3-a456-426614174000', 'portal:visits'],
      ['/visits/:id', 'portal:visits'],
      ['billing?token=abc123&x=1', 'portal:billing'],
      ['Documents#frag', 'portal:documents'],
    ];
    for (const [route, page] of good) {
      mockRaw.mockClear();
      const res = await call('POST', '/api/customer/activity/page-view', { body: { route } });
      expect(res.status).toBe(200);
      await tick();
      expect(inserts()[0][1][1]).toBe(page);
    }
    for (const route of ['a'.repeat(31), '4f9c2a7e11b84d3f9a', ':id', 'my_property', '123', '', null, 42, { a: 1 }]) {
      mockRaw.mockClear();
      const res = await call('POST', '/api/customer/activity/page-view', { body: { route } });
      expect(res.status).toBe(400);
      await tick();
      expect(inserts()).toHaveLength(0);
    }
  });

  test('gate off: answers enabled:false and writes nothing', async () => {
    delete process.env.GATE_PORTAL_ACTIVITY;
    const res = await call('POST', '/api/customer/activity/page-view', { body: { route: 'visits' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, enabled: false });
    await tick();
    expect(inserts()).toHaveLength(0);
  });

  test('a staff browser gets the same answer but no row', async () => {
    const marker = jwt.sign({ kind: 'admin_marker', sub: 'staff-1' }, config.jwt.secret);
    const res = await call('POST', '/api/customer/activity/page-view', {
      body: { route: 'visits' }, headers: { cookie: `waves_admin=${encodeURIComponent(marker)}` },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    await tick();
    expect(inserts()).toHaveLength(0);
  });

  test('a cancelled customer is admitted to the beacon (cancelled-read allowlist)', async () => {
    process.env.GATE_CANCEL_FLOW_V2 = 'true';
    mockCustomer = { ...mockCustomer, active: false, pipeline_stage: 'churned' };
    try {
      const res = await call('POST', '/api/customer/activity/page-view', { body: { route: 'billing' } });
      expect(res.status).toBe(200);
    } finally { delete process.env.GATE_CANCEL_FLOW_V2; }
  });
});

describe('POST /api/customer/activity/push-open', () => {
  test('requires customer auth', async () => {
    const res = await call('POST', '/api/customer/activity/push-open', { auth: false, body: {} });
    expect(res.status).toBe(401);
  });

  test('records push:open keyed to the bell notification id when the push carried one', async () => {
    const res = await call('POST', '/api/customer/activity/push-open', {
      body: { platform: 'android', notificationId: NOTIFICATION_ID, tag: `customer-notification:${NOTIFICATION_ID}`, category: 'billing' },
    });
    expect(res.status).toBe(200);
    await tick();
    const params = inserts()[0][1];
    expect(params.slice(0, 4)).toEqual([CUSTOMER_ID, 'push:open', 'android', `notification:${NOTIFICATION_ID}`]);
  });

  test('a routed push (no id at send time) records the message type only', async () => {
    await call('POST', '/api/customer/activity/push-open', {
      body: { platform: 'ios', tag: 'push-routed:appointment_reminder', category: 'appointment' },
    });
    await tick();
    expect(inserts()[0][1].slice(1, 4)).toEqual(['push:open', 'ios', 'type:appointment_reminder']);
  });

  test('a tag that is not a routed tag is never stored; category is the fallback', async () => {
    await call('POST', '/api/customer/activity/push-open', {
      body: { tag: 'quote-decision-9f8e7d6c5b4a', category: 'estimate' },
    });
    await tick();
    expect(inserts()[0][1][3]).toBe('type:estimate');
    mockRaw.mockClear();
    await call('POST', '/api/customer/activity/push-open', { body: { notificationId: 'not-a-uuid', category: 'Bad Value!' } });
    await tick();
    expect(inserts()[0][1][3]).toBeNull();
  });

  test('gate off: nothing written', async () => {
    delete process.env.GATE_PORTAL_ACTIVITY;
    const res = await call('POST', '/api/customer/activity/push-open', { body: { notificationId: NOTIFICATION_ID } });
    expect(res.body).toEqual({ ok: true, enabled: false });
    await tick();
    expect(inserts()).toHaveLength(0);
  });
});

describe('sanitisers', () => {
  test('sanitizeRouteName keeps only a short lowercase first segment', () => {
    expect(activity.sanitizeRouteName('visits')).toBe('visits');
    expect(activity.sanitizeRouteName('/plan/svc-1')).toBe('plan');
    expect(activity.sanitizeRouteName('my-property')).toBe('my-property');
    expect(activity.sanitizeRouteName('visits2')).toBeNull();
    expect(activity.sanitizeRouteName('x'.repeat(200))).toBeNull();
    expect(activity.sanitizeRouteName(undefined)).toBeNull();
  });

  test('pushSubjectId prefers a uuid notification id, then type, else null', () => {
    expect(activity.pushSubjectId({ notificationId: NOTIFICATION_ID.toUpperCase() })).toBe(`notification:${NOTIFICATION_ID}`);
    expect(activity.pushSubjectId({ tag: 'push-routed:receipt' })).toBe('type:receipt');
    expect(activity.pushSubjectId({ category: 'billing' })).toBe('type:billing');
    expect(activity.pushSubjectId({})).toBeNull();
    expect(activity.pushSubjectId()).toBeNull();
  });
});
