jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/internal-test-customers', () => ({ isInternalTestCustomerId: () => false }));
jest.mock('../services/push-notifications', () => ({}));
jest.mock('../services/dashboard-alerts', () => ({}));
jest.mock('../services/dashboard-alerts-cron', () => ({ COUNT_ESCALATION_COOLDOWN_MS: {} }));
jest.mock('../services/notification-bell-policy', () => ({ isBellPolicyEnabled: () => false }));
jest.mock('../services/admin-unread', () => ({
  liveAlertNotifications: jest.fn(async () => ({ live: [], liveKeys: new Set() })),
  isLiveDuplicate: jest.requireActual('../services/admin-unread').isLiveDuplicate,
}));
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: jest.fn(), requireAdmin: jest.fn() }));

let mockRows = [];
jest.mock('../models/db', () => () => {
  let rows = [...mockRows];
  const sorts = [];
  let limit = Infinity;
  let offset = 0;
  const q = {
    where(filters) { rows = rows.filter(r => Object.entries(filters).every(([k, v]) => r[k] === v)); return q; },
    // The bell list leaves done rows out (done_at).
    whereNull(key) { rows = rows.filter(r => r[key] == null); return q; },
    // The one raw predicate the bell list adds: Activity-only rows
    // (metadata.feed = 'activity') never reach the bell.
    whereRaw(sql) {
      if (!/metadata->>'feed'/.test(sql)) throw new Error(`unexpected whereRaw: ${sql}`);
      rows = rows.filter(r => r.metadata?.feed !== 'activity');
      return q;
    },
    orderBy(key, direction) { sorts.push([key, direction]); return q; },
    limit(n) { limit = n; return q; },
    offset(n) { offset = n; return q; },
    then(resolve, reject) {
      rows.sort((a, b) => {
        for (const [key, direction] of sorts) {
          const comparison = String(a[key]).localeCompare(String(b[key]));
          if (comparison) return direction === 'desc' ? -comparison : comparison;
        }
        return 0;
      });
      return Promise.resolve(rows.slice(offset, offset + limit)).then(resolve, reject);
    },
  };
  return q;
});

const router = require('../routes/admin-notifications');
const { liveAlertNotifications } = require('../services/admin-unread');
const handler = router.stack.find(layer => layer.route?.path === '/' && layer.route.methods.get).route.stack[0].handle;

async function list(query = {}) {
  const res = { json: jest.fn() };
  await handler({ query, techRole: 'admin', technicianId: 'audit-admin' }, res, err => { throw err; });
  return res.json.mock.calls[0][0];
}

beforeEach(() => {
  liveAlertNotifications.mockResolvedValue({ live: [], liveKeys: new Set() });
  mockRows = Array.from({ length: 30 }, (_, i) => ({
    id: `recent-${String(i).padStart(2, '0')}`, recipient_type: 'admin',
    created_at: '2026-09-12T12:00:00Z', read_at: '2026-09-12T13:00:00Z',
  }));
  mockRows.push({ id: 'older-refreshed', recipient_type: 'admin', title: 'Updated restock alert', created_at: '2026-09-01T12:00:00Z', read_at: null });
});

test('an older refreshed unread alert is reachable after the 30 newest read rows', async () => {
  const first = await list({ limit: '30' });
  expect(first.notifications).toHaveLength(30);
  expect(first.hasMore).toBe(true);
  expect(first.notifications.map(n => n.id)).not.toContain('older-refreshed');
  const second = await list({ limit: '30', page: '2' });
  expect(second).toMatchObject({ page: 2, limit: 30, hasMore: false, notifications: [{ id: 'older-refreshed', read_at: null }] });
  expect(second.notifications).toHaveLength(1);
});

test('overlay deduplication does not hide the next persisted page', async () => {
  mockRows.slice(0, 30).forEach(n => { n.metadata = { triggerKey: 'dashboard_alert', payload: { alertId: n.id, alertCount: 1 } }; });
  liveAlertNotifications.mockResolvedValue({ live: [], liveKeys: new Set(mockRows.slice(0, 30).map(n => `${n.id}:1`)) });
  const first = await list({ limit: '30' });
  expect(first.notifications).toEqual([]);
  expect(first.hasMore).toBe(true);
  expect((await list({ limit: '30', page: '2' })).notifications[0].id).toBe('older-refreshed');
});

test('later pages suppress live duplicates but preserve escalation history without repeating the overlay', async () => {
  const metadata = { triggerKey: 'dashboard_alert', payload: { alertId: 'audit-alert', alertCount: 2 } };
  mockRows.push({ id: 'persisted-current', recipient_type: 'admin', created_at: '2026-09-02T12:00:00Z', metadata });
  mockRows.push({ id: 'persisted-history', recipient_type: 'admin', created_at: '2026-09-02T11:00:00Z', metadata: { ...metadata, payload: { ...metadata.payload, alertCount: 1 } } });
  liveAlertNotifications.mockResolvedValue({ live: [{ id: 'live:audit-alert' }], liveKeys: new Set(['audit-alert:2']) });
  expect((await list({ limit: '30' })).notifications[0].id).toBe('live:audit-alert');
  expect((await list({ limit: '30', page: '2' })).notifications.map(n => n.id)).toEqual(['persisted-history', 'older-refreshed']);
});

test('pagination clamps negative inputs before querying', async () => {
  const result = await list({ limit: '-1', page: '-5' });
  expect(result).toMatchObject({ page: 1, limit: 1, hasMore: true });
  expect(result.notifications).toHaveLength(1);
});

test('an Activity-only row never reaches the bell list', async () => {
  mockRows.push({ id: 'activity-only', recipient_type: 'admin', created_at: '2026-09-13T12:00:00Z', read_at: null, metadata: { feed: 'activity', kind: 'FIX' } });
  mockRows.push({ id: 'owner-row', recipient_type: 'admin', created_at: '2026-09-13T11:00:00Z', read_at: null, metadata: { feed: null, kind: 'ACT' } });
  const ids = (await list({ limit: '100' })).notifications.map(n => n.id);
  expect(ids).not.toContain('activity-only');
  expect(ids).toContain('owner-row');
});

test('a done row leaves the list: read is not done', async () => {
  mockRows.push({ id: 'done-row', recipient_type: 'admin', created_at: '2026-09-20T12:00:00Z', read_at: null, done_at: '2026-09-21T12:00:00Z' });
  const ids = [];
  for (const page of ['1', '2']) ids.push(...(await list({ limit: '30', page })).notifications.map(n => n.id));
  expect(ids).not.toContain('done-row');
  expect(ids).toContain('older-refreshed');
});

describe('PUT /:id/done and /:id/reopen', () => {
  const NotificationService = require('../services/notification-service');
  const routeHandler = (path, method) => router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.slice(-1)[0].handle;
  const call = async (handler, req) => {
    const res = { json: jest.fn(), status: jest.fn(() => res) };
    await handler({ body: {}, ...req }, res, err => { throw err; });
    return res;
  };

  afterEach(() => jest.restoreAllMocks());

  test('done: marks the persisted row by the caller, under their role, with an optional resolution', async () => {
    const done = jest.spyOn(NotificationService, 'markAdminDone').mockResolvedValue(1);
    const res = await call(routeHandler('/:id/done', 'put'), { params: { id: 'n1' }, body: { resolution: 'Called back' }, techRole: 'technician', technicianId: 42 });
    expect(done).toHaveBeenCalledWith(['n1'], { by: '42', resolution: 'Called back', role: 'technician' });
    expect(res.json).toHaveBeenCalledWith({ success: true, updated: true });
  });

  test('done: a live overlay row has no persisted id and is refused', async () => {
    const done = jest.spyOn(NotificationService, 'markAdminDone').mockResolvedValue(1);
    const res = await call(routeHandler('/:id/done', 'put'), { params: { id: 'live:overdue_invoices' }, techRole: 'admin', technicianId: 1 });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(done).not.toHaveBeenCalled();
  });

  test('reopen: clears the done fields of one admin row, and is behind requireAdmin', async () => {
    const reopen = jest.spyOn(NotificationService, 'reopenAdminDone').mockResolvedValue(true);
    const layer = router.stack.find(l => l.route?.path === '/:id/reopen' && l.route.methods.put);
    expect(layer.route.stack).toHaveLength(2); // requireAdmin, then the handler
    const res = await call(routeHandler('/:id/reopen', 'put'), { params: { id: 'n1' }, techRole: 'admin', technicianId: 1 });
    expect(reopen).toHaveBeenCalledWith('n1');
    expect(res.json).toHaveBeenCalledWith({ success: true, updated: true });
  });
});
