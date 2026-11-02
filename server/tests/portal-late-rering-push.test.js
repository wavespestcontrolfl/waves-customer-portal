// GATE_PORTAL_ASK_PUSH on the late re-ring (GATE_PORTAL_LATE_RERING): a row the sweep really re-rang also pages the
// admin phones, once. A row the fenced update did not rewrite (a reply closed it first) pages nobody. The SQL and
// the single-ring fence run against Postgres in portal-item-close-postgres.test.js; here the database is a stub.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockState = { rows: [], updates: {}, customers: {} };
jest.mock('../models/db', () => {
  const handle = (state) => {
    if (state.verb === 'update') return mockState.updates[state.id] ?? 0;
    if (state.verb === 'first') return mockState.customers[state.id] || null;
    return mockState.rows;
  };
  const db = jest.fn((table) => {
    const state = { table, verb: 'select', id: null };
    const chain = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve(handle(state)).then(res, rej);
        return (...args) => {
          if (prop === 'update' || prop === 'first') state.verb = prop;
          if (prop === 'where' && args[0] && typeof args[0] === 'object' && args[0].id) state.id = args[0].id;
          return chain;
        };
      },
    });
    return chain;
  });
  db.raw = jest.fn((sql) => sql);
  db.fn = { now: () => 'now()' };
  return db;
});
jest.mock('../services/notification-service', () => ({
  _private: { excludeActivityOnlyFromBell: (q) => q, DONE_CLEARED: {} },
  normalizeAdminText: ({ title, body, detail }) => ({ title, body, detail }),
  safeErrorSummary: (e) => e.message,
}));
jest.mock('../services/admin-alert-relevance', () => ({
  classify: () => ({ key: 'portal_chat_answered' }),
  bellEventAt: () => new Date('2026-11-02T15:00:00Z'),
  parseMeta: (m) => (typeof m === 'string' ? JSON.parse(m) : m || {}),
  quoteAnswered: jest.fn(async () => false),
}));
jest.mock('../services/admin-alert-contact-witnesses', () => ({
  loadContactBundles: jest.fn(async (items) => new Map(items.map((i) => [String(i.id), { anchor: new Date('2026-11-02T15:00:00Z'), textAt: null, backAt: null, inAt: null, replyAt: null }]))),
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: false, push: { sent: 1 } })) }));

const { triggerNotification } = require('../services/notification-triggers');
const { runPortalLateRering } = require('../services/portal-late-rering');

const NOW = new Date('2026-11-02T20:00:00Z'); // 3 PM ET: an ask at 10 AM ET was due at 11 AM
const row = (id, customerId) => ({
  id, category: 'alert', title: 'Comms — Reply to Pat Sample\'s portal chat', body: 'Pat Sample asked about a complaint', detail: null,
  link: `/admin/customers?customerId=${customerId}`, metadata: { customerId, dedupeKey: `portal-chat-escalation:${id}` },
  created_at: new Date('2026-11-02T15:00:00Z'), created_at_token: '2026-11-02 15:00:00+00',
});
const pushes = () => triggerNotification.mock.calls.filter(([key]) => key === 'portal_ask');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_PORTAL_LATE_RERING = 'true';
  process.env.GATE_PORTAL_ASK_PUSH = 'true';
  mockState.rows = [row('n-1', 'c-1'), row('n-2', 'c-2')];
  mockState.updates = { 'n-1': 1, 'n-2': 1 };
  mockState.customers = { 'c-1': { first_name: 'Pat', last_name: 'Sample' }, 'c-2': { first_name: 'Lee', last_name: 'Other' } };
});
afterEach(() => { delete process.env.GATE_PORTAL_LATE_RERING; delete process.env.GATE_PORTAL_ASK_PUSH; });

describe('the late re-ring pages the phones', () => {
  test('each re-rung row pushes once, pushOnly, with first name and last initial and no contact details', async () => {
    const out = await runPortalLateRering({ now: NOW });
    expect(out).toEqual({ skipped: false, due: 2, rung: 2 });
    expect(pushes()).toHaveLength(2);
    const [key, payload, opts] = pushes()[0];
    expect(key).toBe('portal_ask');
    expect(opts).toEqual({ pushOnly: true });
    expect(payload).toEqual(expect.objectContaining({
      itemKey: 'late:n-1',
      title: 'Still waiting on a reply to a customer',
      body: 'Pat S. has waited over 1 business hour for an answer',
      link: '/admin/customers?customerId=c-1',
      customerId: 'c-1',
    }));
    expect(pushes()[1][1].itemKey).toBe('late:n-2');
    expect(pushes()[1][1].body).toBe('Lee O. has waited over 1 business hour for an answer');
  });

  test('a row the fenced update did not rewrite (closed or changed first) pushes nothing', async () => {
    mockState.updates = { 'n-1': 0, 'n-2': 1 };
    const out = await runPortalLateRering({ now: NOW });
    expect(out.rung).toBe(1);
    expect(pushes().map(([, p]) => p.itemKey)).toEqual(['late:n-2']);
  });

  test('gate off: the row is re-rung and no push is sent', async () => {
    delete process.env.GATE_PORTAL_ASK_PUSH;
    const out = await runPortalLateRering({ now: NOW });
    expect(out.rung).toBe(2);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a push that throws costs the re-ring nothing', async () => {
    triggerNotification.mockRejectedValue(new Error('push down'));
    const out = await runPortalLateRering({ now: NOW });
    expect(out).toEqual({ skipped: false, due: 2, rung: 2 });
  });

  test('a failed name lookup still pages, with a plain name', async () => {
    mockState.customers = {};
    await runPortalLateRering({ now: NOW });
    expect(pushes()[0][1].body).toBe('A customer has waited over 1 business hour for an answer');
  });
});
