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
