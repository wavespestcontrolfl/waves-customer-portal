/**
 * GATE_ALERT_BELL_ORDER (owner 2026-11-05, admin-bell plan D1): the route's cursor shapes, the `order` field, the
 * `areaChip` field and what it passes the service, gate on and off. The SQL order itself is proved against Postgres in
 * admin-notifications-bell-order-postgres.test.js.
 */
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/push-notifications', () => ({}));
jest.mock('../services/dashboard-alerts', () => ({}));
jest.mock('../services/dashboard-alerts-cron', () => ({ COUNT_ESCALATION_COOLDOWN_MS: {} }));
jest.mock('../services/notification-bell-policy', () => ({ isBellPolicyEnabled: () => true }));
jest.mock('../services/admin-unread', () => ({
  liveAlertNotifications: jest.fn(async () => ({ live: [], liveKeys: new Set() })),
  isLiveDuplicate: () => false,
}));
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: jest.fn(), requireAdmin: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-service', () => ({ getAdminNotifications: jest.fn() }));

const NotificationService = require('../services/notification-service');
const router = require('../routes/admin-notifications');

const { parseCursor, formatCursor, formatRankedCursor } = router._cursor;
const handler = router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.get).route.stack[0].handle;

const ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-11-05 14:00:00.123456+00';

async function list(query = {}, role = 'admin') {
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  await handler({ query, techRole: role, technicianId: 'tech-1' }, res, (err) => { throw err; });
  return res.status.mock.calls.length ? { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] } : res.json.mock.calls[0][0];
}

const GATE_BEFORE = process.env.GATE_ALERT_BELL_ORDER;
afterAll(() => {
  if (GATE_BEFORE === undefined) delete process.env.GATE_ALERT_BELL_ORDER; else process.env.GATE_ALERT_BELL_ORDER = GATE_BEFORE;
});
beforeEach(() => {
  delete process.env.GATE_ALERT_BELL_ORDER;
  NotificationService.getAdminNotifications.mockReset();
});

describe('cursor shapes', () => {
  test('a two-part cursor parses as before, with no rank', () => {
    expect(parseCursor(`${AT}~${ID}`)).toEqual({ at: AT, id: ID });
  });

  test('a three-part cursor carries its rank', () => {
    expect(parseCursor(`0~${AT}~${ID}`)).toEqual({ at: AT, id: ID, rank: 0 });
    expect(parseCursor(`2~${AT}~${ID}`)).toEqual({ at: AT, id: ID, rank: 2 });
  });

  test('a bad rank, a missing part or an extra part is not a cursor', () => {
    expect(parseCursor(`3~${AT}~${ID}`)).toBeNull();
    expect(parseCursor(`x~${AT}~${ID}`)).toBeNull();
    expect(parseCursor(`-1~${AT}~${ID}`)).toBeNull();
    expect(parseCursor(`0~${AT}`)).toBeNull();
    expect(parseCursor(`0~${AT}~${ID}~1`)).toBeNull();
    expect(parseCursor(AT)).toBeNull();
    expect(parseCursor('')).toBeNull();
    expect(parseCursor(undefined)).toBeNull();
    expect(parseCursor(`1~not-a-time~${ID}`)).toBeNull();
    expect(parseCursor(`1~${AT}~not-a-uuid`)).toBeNull();
  });

  test('formatRankedCursor puts the rank in front of the plain cursor, full precision kept', () => {
    const row = { id: ID, created_at: '2026-11-05T14:00:00.123Z', created_at_cursor: AT };
    expect(formatCursor(row)).toBe(`${AT}~${ID}`);
    expect(formatRankedCursor({ ...row, bell_rank: 0 })).toBe(`0~${AT}~${ID}`);
    expect(formatRankedCursor({ ...row, bell_rank: 1 })).toBe(`1~${AT}~${ID}`);
    expect(formatRankedCursor({ ...row, bell_rank: 2 })).toBe(`2~${AT}~${ID}`);
    expect(parseCursor(formatRankedCursor({ ...row, bell_rank: 2 }))).toEqual({ at: AT, id: ID, rank: 2 });
  });

  test('a row with no usable rank gets rank 0, so a cursor never skips a row', () => {
    const row = { id: ID, created_at: '2026-11-05T14:00:00.123Z', created_at_cursor: AT };
    expect(formatRankedCursor(row)).toBe(`0~${AT}~${ID}`);
    expect(formatRankedCursor({ ...row, bell_rank: 'x' })).toBe(`0~${AT}~${ID}`);
  });
});

function rows(n, over = () => ({})) {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, recipient_type: 'admin', title: `Alert ${i}`,
    created_at: '2026-11-05T14:00:00.000Z', created_at_cursor: `2026-11-05 14:00:00.00${i % 10}000+00`,
    bell_rank: 0, metadata: {}, ...over(i),
  }));
}

describe('gate off', () => {
  test('the service gets the old options, rows have no areaChip, there is no order field and the cursor is two-part', async () => {
    NotificationService.getAdminNotifications.mockResolvedValue(rows(3, () => ({ bell_rank: undefined, metadata: { area: 'Billing' } })));
    const body = await list({ limit: '2' });
    expect(NotificationService.getAdminNotifications).toHaveBeenCalledWith(3, 0, { role: 'admin', technicianId: 'tech-1', before: null, fullAccess: expect.any(Boolean) });
    expect(body).not.toHaveProperty('order');
    expect(body.notifications.every((n) => !('areaChip' in n))).toBe(true);
    expect(body.next).toMatch(/^2026-11-05 14:00:00\.001000\+00~/);
    expect(body.next.split('~')).toHaveLength(2);
  });

  test('a three-part (ranked) cursor belongs to the other order: page 1 of the chronological list, restart: true, no cursor passed on', async () => {
    NotificationService.getAdminNotifications.mockResolvedValue(rows(3, () => ({ bell_rank: undefined })));
    const body = await list({ before: `2~${AT}~${ID}`, page: '4', limit: '2' });
    const [limit, offset, options] = NotificationService.getAdminNotifications.mock.calls[0];
    expect([limit, offset]).toEqual([3, 0]);
    expect(options.before).toBeNull();
    expect(options).not.toHaveProperty('ranked');
    expect(body.restart).toBe(true);
    expect(body.page).toBe(1);
    expect(body).not.toHaveProperty('order');
    expect(body.next.split('~')).toHaveLength(2);
  });

  test('a two-part cursor with the gate off continues as before, with no restart', async () => {
    NotificationService.getAdminNotifications.mockResolvedValue([]);
    const body = await list({ before: `${AT}~${ID}` });
    expect(NotificationService.getAdminNotifications.mock.calls[0][2].before).toEqual({ at: AT, id: ID });
    expect(body).not.toHaveProperty('restart');
  });

  test('anything but exactly "true" reads as off', async () => {
    NotificationService.getAdminNotifications.mockResolvedValue([]);
    for (const value of ['TRUE', '1', 'yes', ' true', 'false']) {
      process.env.GATE_ALERT_BELL_ORDER = value;
      const body = await list({});
      expect(body).not.toHaveProperty('order');
    }
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_ALERT_BELL_ORDER = 'true'; });

  test('asks the service for the ranked order, says so, and serves a three-part next cursor', async () => {
    NotificationService.getAdminNotifications.mockResolvedValue(rows(3, (i) => ({ bell_rank: i === 1 ? 1 : 0 })));
    const body = await list({ limit: '2' });
    expect(NotificationService.getAdminNotifications).toHaveBeenCalledWith(3, 0, expect.objectContaining({ ranked: true, before: null }));
    expect(body.order).toBe('needs-you-first');
    expect(body.hasMore).toBe(true);
    // the next cursor names the LAST row served (index 1, rank 1)
    expect(body.next).toBe(`1~2026-11-05 14:00:00.001000+00~00000000-0000-4000-8000-000000000001`);
    expect(body.notifications).toHaveLength(2);
    expect(body.notifications.every((n) => !('bell_rank' in n) && !('created_at_cursor' in n))).toBe(true);
  });

  test('keeps the service order exactly as served', async () => {
    const served = rows(4, (i) => ({ bell_rank: [0, 0, 1, 2][i], created_at: `2026-11-0${4 - (i % 2)}T10:00:00.000Z` }));
    NotificationService.getAdminNotifications.mockResolvedValue(served);
    const body = await list({ limit: '10' });
    expect(body.notifications.map((n) => n.id)).toEqual(served.map((n) => n.id));
  });

  test('areaChip is the row\'s metadata.area when it is one of the nine Areas, object or JSON text, else absent', async () => {
    NotificationService.getAdminNotifications.mockResolvedValue([
      ...rows(1, () => ({ metadata: { area: 'Comms', severity: 'needs-you' } })),
      ...rows(2, () => ({ id: '00000000-0000-4000-8000-0000000000a1', metadata: JSON.stringify({ area: 'System' }) })).slice(0, 1),
      { ...rows(1)[0], id: '00000000-0000-4000-8000-0000000000a2', metadata: { area: 'Elsewhere' } },
      { ...rows(1)[0], id: '00000000-0000-4000-8000-0000000000a3', metadata: { area: 'comms' } },
      { ...rows(1)[0], id: '00000000-0000-4000-8000-0000000000a4', metadata: {} },
      { ...rows(1)[0], id: '00000000-0000-4000-8000-0000000000a5', metadata: null },
      { ...rows(1)[0], id: '00000000-0000-4000-8000-0000000000a6', metadata: 'not json' },
    ]);
    const body = await list({ limit: '10' });
    expect(body.notifications.map((n) => n.areaChip)).toEqual(['Comms', 'System', undefined, undefined, undefined, undefined, undefined]);
    expect(body.notifications.slice(2).every((n) => !('areaChip' in n))).toBe(true);
  });

  test('each of the nine Areas is served', async () => {
    const { AREAS } = require('../services/admin-alert-compose');
    expect(AREAS).toHaveLength(9);
    NotificationService.getAdminNotifications.mockResolvedValue(rows(9, (i) => ({ metadata: { area: AREAS[i] } })));
    const body = await list({ limit: '10' });
    expect(body.notifications.map((n) => n.areaChip)).toEqual(AREAS);
  });

  test('a three-part cursor reaches the service with its rank and no restart', async () => {
    NotificationService.getAdminNotifications.mockResolvedValue([]);
    const body = await list({ before: `1~${AT}~${ID}` });
    expect(NotificationService.getAdminNotifications.mock.calls[0][2].before).toEqual({ at: AT, id: ID, rank: 1 });
    expect(NotificationService.getAdminNotifications.mock.calls[0][1]).toBe(0);
    expect(body).not.toHaveProperty('restart');
  });

  test('a two-part (chronological) cursor belongs to the other order: page 1 of the ranked list, restart: true, no cursor passed on', async () => {
    NotificationService.getAdminNotifications.mockResolvedValue(rows(3, (i) => ({ bell_rank: i === 2 ? 1 : 0 })));
    const body = await list({ before: `${AT}~${ID}`, page: '3', limit: '2' });
    const [limit, offset, options] = NotificationService.getAdminNotifications.mock.calls[0];
    expect([limit, offset]).toEqual([3, 0]);
    expect(options.before).toBeNull();
    expect(options.ranked).toBe(true);
    expect(body.restart).toBe(true);
    expect(body.order).toBe('needs-you-first');
    expect(body.page).toBe(1);
    expect(body.next.split('~')).toHaveLength(3);
  });

  test('offset paging without a cursor keeps the offset and the ranked option', async () => {
    NotificationService.getAdminNotifications.mockResolvedValue([]);
    await list({ page: '3', limit: '10' });
    expect(NotificationService.getAdminNotifications).toHaveBeenCalledWith(11, 20, expect.objectContaining({ ranked: true, before: null }));
  });

  test('an invalid cursor is still a 400', async () => {
    const out = await list({ before: `9~${AT}~${ID}` });
    expect(out.status).toBe(400);
    expect(NotificationService.getAdminNotifications).not.toHaveBeenCalled();
  });

  test('a technician list is ordered the same way and carries the same fields', async () => {
    NotificationService.getAdminNotifications.mockResolvedValue(rows(2, () => ({ metadata: { area: 'Schedule' } })));
    const body = await list({}, 'technician');
    expect(NotificationService.getAdminNotifications.mock.calls[0][2]).toMatchObject({ role: 'technician', ranked: true });
    expect(body.order).toBe('needs-you-first');
  });

  test('the last page has no cursor but still says the list is ranked', async () => {
    NotificationService.getAdminNotifications.mockResolvedValue(rows(2));
    const body = await list({ limit: '5' });
    expect(body.next).toBeNull();
    expect(body.hasMore).toBe(false);
    expect(body.order).toBe('needs-you-first');
  });
});

describe('a feature-gates mock without the reader', () => {
  test('reads the gate as off', async () => {
    jest.resetModules();
    jest.doMock('../config/feature-gates', () => ({ gates: {} }));
    process.env.GATE_ALERT_BELL_ORDER = 'true';
    const mockedRouter = require('../routes/admin-notifications');
    const NS = require('../services/notification-service');
    NS.getAdminNotifications.mockResolvedValue([]);
    const h = mockedRouter.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.get).route.stack[0].handle;
    const res = { json: jest.fn() };
    await h({ query: {}, techRole: 'admin', technicianId: 't' }, res, (err) => { throw err; });
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('order');
    jest.dontMock('../config/feature-gates');
  });
});
