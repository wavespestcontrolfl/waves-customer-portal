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
jest.mock('../models/db', () => {
// Microsecond-resolution instant of an ISO or Postgres timestamptz text
// ("2026-09-30 12:00:00.123456+00"), as a BigInt: a plain Date would round to
// the millisecond and hide exactly the skip the full-precision cursor prevents.
const micros = (text) => {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(String(text));
  if (!m) return BigInt(Date.parse(text)) * 1000n;
  const zone = m[4] === 'Z' ? 'Z' : m[4].length === 3 ? `${m[4]}:00` : m[4].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = BigInt(Date.parse(`${m[1]}T${m[2]}${zone}`));
  return ms * 1000n + BigInt((m[3] || '').padEnd(6, '0'));
};
// A row's full-precision value for a column: the *_cursor / *_token text the
// real query selects (a fixture may set it), else the column itself.
const fullAt = (r, col) => micros(r[col === 'done_at' ? 'done_at_token' : 'created_at_cursor'] ?? r[col]);
const PERSON = /^([0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|claude)$/i;
const makeQuery = () => {
  let rows = [...mockRows];
  const sorts = [];
  let limit = Infinity;
  let offset = 0;
  let selectsVersion = false;
  const rawSelected = [];
  const q = {
    where(filters) { rows = rows.filter(r => Object.entries(filters).every(([k, v]) => r[k] === v)); return q; },
    // The bell list leaves done rows out (done_at).
    whereNull(key) { rows = rows.filter(r => r[key] == null); return q; },
    whereNotNull(key) { rows = rows.filter(r => r[key] != null); return q; },
    select(...cols) {
      for (const c of cols) if (c && c.__raw) { selectsVersion = true; rawSelected.push(c.sql); }
      return q;
    },
    first(...cols) { return Promise.resolve(rows[0] ? { done_at: rows[0].done_at ?? null, version: rows[0].version ?? null } : undefined); },
    // The one raw predicate the bell list adds: Activity-only rows
    // (metadata.feed = 'activity') never reach the bell.
    whereRaw(sql, bindings) {
      // The keyset cursor: (created_at, id) strictly after it, at full precision.
      const cursor = /^\((created_at|done_at), id\) < \(\?::timestamptz, \?::uuid\)$/.exec(sql);
      if (cursor) {
        const col = cursor[1];
        const [at, id] = bindings;
        const atUs = micros(at);
        rows = rows.filter(r => fullAt(r, col) < atUs || (fullAt(r, col) === atUs && r.id < id));
        return q;
      }
      // The Recently done window: done_at within the last N days.
      if (/done_at >= now\(\)/.test(sql)) {
        const cutoff = Date.now() - bindings[0] * 86400000;
        rows = rows.filter(r => Date.parse(r.done_at) >= cutoff);
        return q;
      }
      if (!/metadata->>'feed'/.test(sql)) throw new Error(`unexpected whereRaw: ${sql}`);
      rows = rows.filter(r => r.metadata?.feed !== 'activity');
      return q;
    },
    orderBy(key, direction) {
      if (Array.isArray(key)) key.forEach(({ column, order }) => sorts.push([column, order]));
      else sorts.push([key, direction]);
      return q;
    },
    // The feed order: plain created_at (or done_at) DESC, id DESC: no
    // date_trunc, so an index on the column can serve it.
    orderByRaw(sql) {
      const m = /^(created_at|done_at) DESC, id DESC$/.exec(sql);
      if (!m) throw new Error(`unexpected orderByRaw: ${sql}`);
      sorts.push([m[1], 'desc', true], ['id', 'desc']);
      return q;
    },
    limit(n) { limit = n; return q; },
    offset(n) { offset = n; return q; },
    then(resolve, reject) {
      rows.sort((a, b) => {
        for (const [key, direction, full] of sorts) {
          let comparison;
          if (full) { const x = fullAt(a, key); const y = fullAt(b, key); comparison = x < y ? -1 : x > y ? 1 : 0; }
          else comparison = String(a[key]).localeCompare(String(b[key]));
          if (comparison) return direction === 'desc' ? -comparison : comparison;
        }
        return 0;
      });
      const out = rows.slice(offset, offset + limit);
      // What the real select adds: version, the full-precision cursor text, the reopen flag.
      const shaped = (r) => ({
        ...r,
        ...(selectsVersion ? { version: `v-${r.id}` } : {}),
        ...(rawSelected.some((x) => /created_at::text AS created_at_cursor/.test(x)) ? { created_at_cursor: r.created_at_cursor ?? r.created_at } : {}),
        ...(rawSelected.some((x) => /done_at::text AS done_at_token/.test(x)) ? { done_at_token: r.done_at_token ?? r.done_at } : {}),
        ...(rawSelected.some((x) => /AS reopenable/.test(x)) ? { reopenable: PERSON.test(r.done_by ?? '') } : {}),
      });
      return Promise.resolve(out.map(shaped)).then(resolve, reject);
    },
  };
  return q;
};
makeQuery.raw = (sql) => ({ __raw: true, sql });
return makeQuery;
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

describe('keyset cursor', () => {
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  beforeEach(() => {
    // 35 open rows, newest first by created_at; uuid ids so a cursor parses.
    mockRows = Array.from({ length: 35 }, (_, i) => ({
      id: uuid(i), recipient_type: 'admin', read_at: null,
      created_at: new Date(Date.UTC(2026, 8, 30, 12, 0, 0) - i * 60000).toISOString(),
    }));
  });

  test('rows closed elsewhere between pages (an auto-close, another admin) never make Load more skip an open row', async () => {
    const first = await list({ limit: '30' });
    expect(first.notifications).toHaveLength(30);
    expect(first.next).toBe(`${mockRows[29].created_at}~${uuid(29)}`);
    // Five first-page rows go done before the next request.
    for (const i of [0, 3, 7, 11, 20]) mockRows[i].done_at = '2026-09-30T13:00:00Z';
    const offsetPage = (await list({ limit: '30', page: '2' })).notifications.map(n => n.id);
    expect(offsetPage).not.toContain(uuid(30)); // why offsets are not enough
    const second = await list({ limit: '30', page: '2', before: first.next });
    expect(second.notifications.map(n => n.id)).toEqual([30, 31, 32, 33, 34].map(uuid));
    expect(second).toMatchObject({ hasMore: false, next: null });
  });

  test('a cursor page never repeats the live overlay', async () => {
    liveAlertNotifications.mockResolvedValue({ live: [{ id: 'live:audit-alert' }], liveKeys: new Set() });
    const first = await list({ limit: '30' });
    const second = await list({ limit: '30', page: '2', before: first.next });
    expect(second.notifications.map(n => n.id)).not.toContain('live:audit-alert');
  });

  test('rows in the same millisecond page by id, none skipped', async () => {
    for (const r of mockRows) r.created_at = '2026-09-30T12:00:00.123Z';
    const first = await list({ limit: '30' });
    const second = await list({ limit: '30', page: '2', before: first.next });
    const all = [...first.notifications, ...second.notifications].map(n => n.id);
    expect(new Set(all).size).toBe(35);
  });

  test('rows in the same millisecond but different microseconds page by their microseconds, none skipped or repeated', async () => {
    // Every row serializes to one millisecond; only created_at_cursor (what the real query selects as created_at::text) tells them apart.
    mockRows.forEach((r, i) => {
      r.created_at = '2026-09-30T12:00:00.123Z';
      r.created_at_cursor = `2026-09-30 12:00:00.123${String(900 - i * 10).padStart(3, '0')}+00`;
    });
    const first = await list({ limit: '10' });
    expect(first.notifications.map(n => n.id)).toEqual(Array.from({ length: 10 }, (_, i) => uuid(i)));
    // The cursor carries the microseconds (and the offset), not the rounded millisecond.
    expect(first.next).toBe(`${mockRows[9].created_at_cursor}~${uuid(9)}`);
    const seen = first.notifications.map(n => n.id);
    let next = first.next;
    while (next) {
      const page = await list({ limit: '10', before: next });
      seen.push(...page.notifications.map(n => n.id));
      next = page.next;
    }
    expect(seen).toEqual(Array.from({ length: 35 }, (_, i) => uuid(i)));
    // The bell payload does not leak the cursor helper column.
    expect(first.notifications.every(n => !('created_at_cursor' in n))).toBe(true);
  });

  test('a cursor needs a zone and a real timestamp: a naive time or garbage is a 400', async () => {
    for (const bad of [`2026-09-30 12:00:00~${uuid(1)}`, `junk~${uuid(1)}`, `2026-09-30T12:00:00.123456789Z~${uuid(1)}`, `2026-09-30T12:00:00Z~not-a-uuid`]) {
      const res = { json: jest.fn(), status: jest.fn(() => res) };
      await handler({ query: { limit: '30', before: bad }, techRole: 'admin' }, res, (err) => { throw err; });
      expect(res.status).toHaveBeenCalledWith(400);
    }
    // A Postgres-text cursor is accepted.
    const ok = await list({ limit: '30', before: `2026-09-30 12:00:00.123456+00~${uuid(1)}` });
    expect(Array.isArray(ok.notifications)).toBe(true);
  });

  test('a malformed cursor is a 400, not a silent first page', async () => {
    const res = { json: jest.fn(), status: jest.fn(() => res) };
    await handler({ query: { limit: '30', before: 'not-a-cursor' }, techRole: 'admin' }, res, (err) => { throw err; });
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('PUT /:id/done and /:id/reopen', () => {
  const NotificationService = require('../services/notification-service');
  const routeHandler = (path, method) => router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.slice(-1)[0].handle;
  const call = async (handler, req) => {
    const res = { json: jest.fn(), status: jest.fn(() => res) };
    await handler({ body: {}, ...req }, res, err => { throw err; });
    return res;
  };

  const VERSION = 'a'.repeat(32);
  afterEach(() => jest.restoreAllMocks());

  test('done: marks the persisted row by the caller, under their role, with an optional resolution', async () => {
    const done = jest.spyOn(NotificationService, 'markAdminDone').mockResolvedValue(1);
    const res = await call(routeHandler('/:id/done', 'put'), { params: { id: 'n1' }, body: { resolution: 'Called back', version: VERSION }, techRole: 'technician', technicianId: 42 });
    expect(done).toHaveBeenCalledWith(['n1'], { by: '42', resolution: 'Called back', role: 'technician', expectedVersion: VERSION });
    expect(res.json).toHaveBeenCalledWith({ success: true, updated: true });
  });

  test('done: a missing or malformed version is refused before any write', async () => {
    const done = jest.spyOn(NotificationService, 'markAdminDone').mockResolvedValue(1);
    for (const body of [{}, { version: 'not-a-hash' }, { version: 123 }]) {
      const res = await call(routeHandler('/:id/done', 'put'), { params: { id: 'n1' }, body, techRole: 'admin', technicianId: 1 });
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(done).not.toHaveBeenCalled();
  });

  test('done: nothing marked and the row changed since the bell served it answers 409 changed', async () => {
    jest.spyOn(NotificationService, 'markAdminDone').mockResolvedValue(0);
    const state = jest.spyOn(NotificationService, 'getAdminNotificationState').mockResolvedValue({ done: false, version: 'f'.repeat(32) });
    const res = await call(routeHandler('/:id/done', 'put'), { params: { id: 'n1' }, body: { version: VERSION }, techRole: 'admin', technicianId: 1 });
    expect(state).toHaveBeenCalledWith('n1', { role: 'admin' });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'changed' });
  });

  test('done: nothing marked on an already-done or missing row keeps the plain updated:false answer', async () => {
    jest.spyOn(NotificationService, 'markAdminDone').mockResolvedValue(0);
    const state = jest.spyOn(NotificationService, 'getAdminNotificationState');
    for (const row of [{ done: true, version: 'f'.repeat(32) }, null, { done: false, version: VERSION }]) {
      state.mockResolvedValueOnce(row);
      const res = await call(routeHandler('/:id/done', 'put'), { params: { id: 'n1' }, body: { version: VERSION }, techRole: 'admin', technicianId: 1 });
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ success: true, updated: false });
    }
  });

  test('done: a live overlay row has no persisted id and is refused', async () => {
    const done = jest.spyOn(NotificationService, 'markAdminDone').mockResolvedValue(1);
    const res = await call(routeHandler('/:id/done', 'put'), { params: { id: 'live:overdue_invoices' }, body: { version: VERSION }, techRole: 'admin', technicianId: 1 });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(done).not.toHaveBeenCalled();
  });

  describe('reopen', () => {
    const TOKEN = '2026-09-30 12:00:00.123456+00';
    const reopenCall = (body) => call(routeHandler('/:id/reopen', 'put'), { params: { id: 'n1' }, body, techRole: 'admin', technicianId: 1 });

    test('clears the done fields of one admin row under the served done_at token, and is behind requireAdmin', async () => {
      const reopen = jest.spyOn(NotificationService, 'reopenAdminDone').mockResolvedValue('reopened');
      const layer = router.stack.find(l => l.route?.path === '/:id/reopen' && l.route.methods.put);
      expect(layer.route.stack).toHaveLength(2); // requireAdmin, then the handler
      const res = await reopenCall({ doneAt: TOKEN });
      expect(reopen).toHaveBeenCalledWith('n1', { expectedDoneAt: TOKEN });
      expect(res.json).toHaveBeenCalledWith({ success: true, updated: true });
    });

    test('a missing or unparseable doneAt is refused before any write', async () => {
      const reopen = jest.spyOn(NotificationService, 'reopenAdminDone').mockResolvedValue('reopened');
      for (const body of [{}, { doneAt: '' }, { doneAt: 'nope' }, { doneAt: 123 }, { doneAt: '2026-09-30 12:00:00' }, { doneAt: null }]) {
        const res = await reopenCall(body);
        expect(res.status).toHaveBeenCalledWith(400);
      }
      const noBody = await call(routeHandler('/:id/reopen', 'put'), { params: { id: 'n1' }, body: undefined, techRole: 'admin', technicianId: 1 });
      expect(noBody.status).toHaveBeenCalledWith(400);
      expect(reopen).not.toHaveBeenCalled();
    });

    test('a row done again since the list was served answers 409 changed (a stale list cannot clear a newer completion)', async () => {
      jest.spyOn(NotificationService, 'reopenAdminDone').mockResolvedValue('changed');
      const res = await reopenCall({ doneAt: TOKEN });
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({ error: 'changed' });
    });

    test('a system-closed row answers 409 not_reopenable', async () => {
      jest.spyOn(NotificationService, 'reopenAdminDone').mockResolvedValue('not_reopenable');
      const res = await reopenCall({ doneAt: TOKEN });
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({ error: 'not_reopenable' });
    });

    test('a row that is gone or no longer done keeps the plain updated:false answer', async () => {
      jest.spyOn(NotificationService, 'reopenAdminDone').mockResolvedValue('not_found');
      const res = await reopenCall({ doneAt: TOKEN });
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ success: true, updated: false });
    });
  });
});

describe('GET /done (Recently done list)', () => {
  const NotificationService = require('../services/notification-service');
  const day = 86400000;
  const iso = (ago) => new Date(Date.now() - ago).toISOString();
  const layer = router.stack.find(l => l.route?.path === '/done' && l.route.methods.get);
  const call = async (req) => {
    const res = { json: jest.fn(), status: jest.fn(() => res) };
    await layer.route.stack.slice(-1)[0].handle({ query: {}, ...req }, res, err => { throw err; });
    return res;
  };

  beforeEach(() => {
    mockRows = [
      { id: 'open', recipient_type: 'admin', title: 'Open', done_at: null, created_at: iso(day) },
      { id: 'old', recipient_type: 'admin', title: 'Done long ago', done_at: iso(9 * day), created_at: iso(10 * day) },
      { id: 'b', recipient_type: 'admin', title: 'Done earlier', done_at: iso(2 * day), created_at: iso(3 * day) },
      { id: 'c', recipient_type: 'admin', title: 'Done latest', done_at: iso(60000), created_at: iso(day) },
      { id: 'cust', recipient_type: 'customer', title: 'Customer', done_at: iso(60000), created_at: iso(day) },
      { id: 'act', recipient_type: 'admin', title: 'Activity only', done_at: iso(1000), created_at: iso(day), metadata: { feed: 'activity' } },
    ];
  });

  test('returns only recent done admin rows, newest done first, Activity-only rows included (their one reopen path)', async () => {
    const res = await call({ techRole: 'admin' });
    expect(res.json.mock.calls[0][0].notifications.map(n => n.id)).toEqual(['act', 'c', 'b']);
  });

  test('honors the limit', async () => {
    const rows = await NotificationService.getAdminDoneNotifications({ role: 'admin', limit: 1 });
    expect(rows.map(n => n.id)).toEqual(['act']); // the newest done row
  });

  test('pages by cursor: every row in the window stays reachable, even with more closed after it', async () => {
    const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    mockRows = Array.from({ length: 25 }, (_, i) => ({ id: uuid(i), recipient_type: 'admin', title: `Done ${i}`, done_at: iso((i + 1) * 3600000), created_at: iso(3 * day) }));
    const first = (await call({ techRole: 'admin' })).json.mock.calls[0][0];
    expect(first.notifications).toHaveLength(20);
    expect(first).toMatchObject({ hasMore: true, next: `${mockRows[19].done_at}~${uuid(19)}` });
    // Three more rows close before Load more: nothing older is pushed out.
    mockRows.push(...[90, 91, 92].map(n => ({ id: uuid(n), recipient_type: 'admin', title: 'New', done_at: iso(1000), created_at: iso(day) })));
    const second = (await call({ techRole: 'admin', query: { before: first.next } })).json.mock.calls[0][0];
    expect(second.notifications.map(n => n.id)).toEqual([20, 21, 22, 23, 24].map(uuid));
    expect(second).toMatchObject({ hasMore: false, next: null });
  });

  test('rows done in the same millisecond but different microseconds page by the full-precision done_at token, none skipped', async () => {
    const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const base = Date.now() - 3600000;
    const ms = new Date(base - (base % 1000) + 123).toISOString(); // one serialized millisecond
    const stamp = ms.replace('T', ' ').replace('Z', '');
    mockRows = Array.from({ length: 25 }, (_, i) => ({
      id: uuid(i), recipient_type: 'admin', title: `Done ${i}`, done_by: '7', created_at: iso(day),
      done_at: ms, done_at_token: `${stamp}${String(900 - i * 10).padStart(3, '0')}+00`,
    }));
    const first = (await call({ techRole: 'admin' })).json.mock.calls[0][0];
    expect(first.notifications.map(n => n.id)).toEqual(Array.from({ length: 20 }, (_, i) => uuid(i)));
    expect(first.next).toBe(`${mockRows[19].done_at_token}~${uuid(19)}`);
    const second = (await call({ techRole: 'admin', query: { before: first.next } })).json.mock.calls[0][0];
    expect(second.notifications.map(n => n.id)).toEqual([20, 21, 22, 23, 24].map(uuid));
  });

  test('every row carries the reopen fence (done_at_token) and reopenable: only a person-closed row can be put back', async () => {
    const closed = (id, by) => ({ id, recipient_type: 'admin', title: id, done_at: iso(1000), done_by: by, created_at: iso(day) });
    mockRows = [
      closed('by-uuid', '6f1c2d9e-4b7a-4c1e-9a3b-0d5e7f8a9b10'), closed('by-digits', '7'), closed('by-claude', 'claude'),
      closed('by-episodes', 'episodes'), closed('by-ops', 'ops-crons'), closed('by-backfill', 'backfill'), closed('by-nobody', null),
    ];
    const rows = (await call({ techRole: 'admin' })).json.mock.calls[0][0].notifications;
    const flags = Object.fromEntries(rows.map(n => [n.id, n.reopenable]));
    expect(flags).toEqual({ 'by-uuid': true, 'by-digits': true, 'by-claude': true, 'by-episodes': false, 'by-ops': false, 'by-backfill': false, 'by-nobody': false });
    expect(rows.every(n => typeof n.done_at_token === 'string')).toBe(true);
  });

  test('a malformed cursor is a 400', async () => {
    const res = await call({ techRole: 'admin', query: { before: 'nope' } });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('is behind requireAdmin', () => {
    expect(layer.route.stack).toHaveLength(2); // requireAdmin, then the handler
  });

  test('is declared before any /:id route so it is not shadowed', () => {
    const paths = router.stack.filter(l => l.route).map(l => l.route.path);
    expect(paths.indexOf('/done')).toBeLessThan(paths.findIndex(p => p.startsWith('/:id')));
  });
});
