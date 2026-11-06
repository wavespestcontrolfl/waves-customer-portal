/**
 * GATE_ALERT_BELL_ORDER (owner 2026-11-05, admin-bell plan D1) against live Postgres, through the real service query and
 * the real GET /api/admin/notifications handler. Proves the SQL side: needs-you rows first, then rows with no severity
 * label, then the rest, newest first inside a rank; paging by the three-part cursor never skips or repeats a row (rows
 * that share a millisecond, and rows that share a timestamp exactly, included); offset paging gives the same order; a
 * cursor of the other order (the gate flipped under an open panel, either way) restarts at page 1 with restart: true and the
 * panel's walk then covers every open row once; the gate off keeps the old order and the old cursor; a technician list is ordered the
 * same way. It reads the whole open admin feed, so it asserts on its own rows only (each carries metadata.beoRun).
 * It refuses any database but a private QA one or CI's.
 */
// Read once, when feature-gates loads (the bell policy keeps the live dashboard overlay out of the list).
const ENV_BEFORE = { GATE_ADMIN_BELL_POLICY: process.env.GATE_ADMIN_BELL_POLICY, GATE_ALERT_BELL_ORDER: process.env.GATE_ALERT_BELL_ORDER };
process.env.GATE_ADMIN_BELL_POLICY = 'true';
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => {
  for (const [key, value] of Object.entries(ENV_BEFORE)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (!SKIP) await require('../models/db').destroy();
});

maybeDescribe('admin bell order (live Postgres)', () => {
  let db;
  let NotificationService;
  let router;
  const RUN = randomUUID();
  const ids = [];
  // Rank of a stored row, the way the feature defines it.
  const rankOf = (severity) => (severity === 'needs-you' ? 0 : severity == null || severity === '' ? 1 : 2);

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    NotificationService = require('../services/notification-service');
    router = require('../routes/admin-notifications');
  });

  afterAll(async () => {
    if (db) await db('notifications').whereRaw("metadata->>'beoRun' = ?", [RUN]).del();
  });

  // created_at is written as text so a row can sit a few microseconds from its neighbour.
  async function put({ at, severity, area, key, doneAt = null, feed, trigger, id = randomUUID() }) {
    const metadata = { beoRun: RUN, ...(severity !== undefined ? { severity } : {}), ...(area ? { area } : {}), ...(feed ? { feed } : {}), ...(trigger ? { triggerKey: trigger } : {}) };
    await db.raw(
      `INSERT INTO notifications (id, recipient_type, category, title, metadata, created_at, done_at) VALUES (?, 'admin', 'system', ?, ?::jsonb, ?::timestamptz, ?)`,
      [id, `bell order ${key}`, JSON.stringify(metadata), at, doneAt],
    );
    ids.push(id);
    return { id, at, severity, key };
  }

  // 2031 keeps every fixture row away from any other suite's rows; the run marker keeps them apart anyway.
  const T = (s, micros = 0) => `2031-01-01 12:00:${String(s).padStart(2, '0')}.${String(micros).padStart(6, '0')}+00`;
  const microsOf = (text) => {
    const m = /(\d{2}):(\d{2}):(\d{2})\.(\d{6})/.exec(text);
    return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1e6 + Number(m[4]);
  };
  const expectedOrder = (rows) => [...rows].sort((a, b) => (rankOf(a.severity) - rankOf(b.severity))
    || (microsOf(b.at) - microsOf(a.at)) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).map((r) => r.id);
  const timeOrder = (rows) => [...rows].sort((a, b) => (microsOf(b.at) - microsOf(a.at)) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).map((r) => r.id);

  const own = (list) => list.filter((n) => n.metadata && n.metadata.beoRun === RUN);
  const handler = () => router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.get).route.stack[0].handle;
  async function list(query = {}, role = 'admin') {
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await handler()({ query, techRole: role, technicianId: null }, res, (err) => { throw err; });
    return res.json.mock.calls[0][0];
  }
  // Page through the whole feed with the cursor the server hands back; returns own rows in served order.
  async function pageAll(limit, role = 'admin') {
    const seen = [];
    let before;
    let first = null;
    for (let i = 0; i < 500; i += 1) {
      const body = await list({ limit: String(limit), ...(before ? { before } : {}) }, role);
      first = first || body;
      seen.push(...own(body.notifications));
      if (!body.next) return { seen, first };
      before = body.next;
    }
    throw new Error('paging did not end');
  }

  let rows;
  beforeAll(async () => {
    // Mixed ranks and times, including a stored empty severity, a null severity, 'broken' and 'fyi'.
    rows = [];
    rows.push(await put({ key: 'n-old', at: T(1), severity: 'needs-you', area: 'Billing' }));
    rows.push(await put({ key: 'n-new', at: T(50), severity: 'needs-you', area: 'Comms' }));
    rows.push(await put({ key: 'u-mid', at: T(20) }));
    rows.push(await put({ key: 'u-empty', at: T(21), severity: '' }));
    rows.push(await put({ key: 'u-null', at: T(22), severity: null }));
    rows.push(await put({ key: 'f-new', at: T(55), severity: 'fyi', area: 'System' }));
    rows.push(await put({ key: 'b-new', at: T(56), severity: 'broken', area: 'Nowhere' }));
    rows.push(await put({ key: 'f-old', at: T(2), severity: 'fyi' }));
    // Three needs-you rows inside one millisecond (microseconds apart), and two rows with the SAME timestamp exactly.
    rows.push(await put({ key: 'ms-a', at: T(30, 100), severity: 'needs-you' }));
    rows.push(await put({ key: 'ms-b', at: T(30, 400), severity: 'needs-you' }));
    rows.push(await put({ key: 'ms-c', at: T(30, 900), severity: 'needs-you' }));
    rows.push(await put({ key: 'tie-1', at: T(31, 500), severity: 'fyi' }));
    rows.push(await put({ key: 'tie-2', at: T(31, 500), severity: 'fyi' }));
    rows.push(await put({ key: 'tie-3', at: T(31, 500), severity: 'needs-you' }));
    rows.push(await put({ key: 'tie-4', at: T(31, 500), severity: 'needs-you' }));
    // A millisecond shared by rows of different ranks.
    rows.push(await put({ key: 'x-u', at: T(40, 200) }));
    rows.push(await put({ key: 'x-f', at: T(40, 700), severity: 'fyi' }));
    // Not in the bell: done, and Activity-only.
    await put({ key: 'done', at: T(57), severity: 'needs-you', doneAt: T(58) });
    await put({ key: 'activity', at: T(59), severity: 'needs-you', feed: 'activity' });
  });

  describe('service order', () => {
    test('gate on: needs-you first, unlabeled next, the rest last, newest first inside a rank', async () => {
      const got = own(await NotificationService.getAdminNotifications(500, 0, { role: 'admin', ranked: true, fullAccess: true })).map((n) => n.id);
      expect(got).toEqual(expectedOrder(rows));
      // unlabeled sit above fyi and broken, below every needs-you
      const keyAt = (id) => rows.find((r) => r.id === id).key;
      const keys = got.map(keyAt);
      expect(keys.indexOf('u-mid')).toBeGreaterThan(keys.indexOf('n-old'));
      expect(keys.indexOf('u-null')).toBeLessThan(keys.indexOf('f-new'));
      expect(keys.indexOf('u-empty')).toBeLessThan(keys.indexOf('b-new'));
      expect(keys.indexOf('x-u')).toBeLessThan(keys.indexOf('x-f'));
    });

    test('gate on: every row carries its rank', async () => {
      const all = await NotificationService.getAdminNotifications(500, 0, { role: 'admin', ranked: true, fullAccess: true });
      for (const n of own(all)) {
        const stored = rows.find((r) => r.id === n.id);
        expect(Number(n.bell_rank)).toBe(rankOf(stored.severity));
      }
    });

    test('gate off: plain newest first, no rank column', async () => {
      const all = await NotificationService.getAdminNotifications(500, 0, { role: 'admin', fullAccess: true });
      expect(own(all).map((n) => n.id)).toEqual(timeOrder(rows));
      expect(own(all).every((n) => !('bell_rank' in n))).toBe(true);
    });

    test('done rows and Activity-only rows stay out', async () => {
      const all = own(await NotificationService.getAdminNotifications(500, 0, { role: 'admin', ranked: true, fullAccess: true }));
      expect(all).toHaveLength(rows.length);
      expect(all.map((n) => n.title)).not.toContain('bell order done');
      expect(all.map((n) => n.title)).not.toContain('bell order activity');
    });
  });

  describe('paging by cursor, gate on', () => {
    beforeEach(() => { process.env.GATE_ALERT_BELL_ORDER = 'true'; });
    afterEach(() => { delete process.env.GATE_ALERT_BELL_ORDER; });

    test.each([1, 2, 3, 5, 7, 100])('limit %i: every row once, in the ranked order', async (limit) => {
      const { seen, first } = await pageAll(limit);
      expect(seen.map((n) => n.id)).toEqual(expectedOrder(rows));
      expect(new Set(seen.map((n) => n.id)).size).toBe(seen.length);
      expect(first.order).toBe('needs-you-first');
    });

    test('the cursor carries the rank of the last row served', async () => {
      const body = await list({ limit: '1' });
      expect(body.next).toMatch(/^[012]~\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:?\d{2})?~[0-9a-f-]{36}$/);
      expect(Number(body.next.split('~')[0])).toBe(0);
    });

    test('offset paging (no cursor) walks the same order', async () => {
      const seen = [];
      for (let page = 1; page < 80; page += 1) {
        const body = await list({ limit: '4', page: String(page) });
        seen.push(...own(body.notifications));
        if (!body.hasMore) break;
      }
      expect(seen.map((n) => n.id)).toEqual(expectedOrder(rows));
    });

    test('a row marked Done between two pages shifts nothing and repeats nothing', async () => {
      const order = expectedOrder(rows);
      const firstPage = await list({ limit: '3' });
      const servedOwn = own(firstPage.notifications).map((n) => n.id);
      // mark the first served own row done, then continue with the cursor
      await db('notifications').where({ id: servedOwn[0] }).update({ done_at: db.fn.now() });
      try {
        const rest = [];
        let before = firstPage.next;
        while (before) {
          const body = await list({ limit: '3', before });
          rest.push(...own(body.notifications).map((n) => n.id));
          before = body.next;
        }
        expect([...servedOwn, ...rest]).toEqual(order);
      } finally {
        await db('notifications').where({ id: servedOwn[0] }).update({ done_at: null });
      }
    });

    test('areaChip: the stored Area when it is one of the nine, none otherwise', async () => {
      const body = await list({ limit: '100' });
      const byKey = Object.fromEntries(own(body.notifications).map((n) => [n.title.replace('bell order ', ''), n]));
      expect(byKey['n-old'].areaChip).toBe('Billing');
      expect(byKey['n-new'].areaChip).toBe('Comms');
      expect(byKey['f-new'].areaChip).toBe('System');
      expect(byKey['b-new']).not.toHaveProperty('areaChip');
      expect(byKey['u-mid']).not.toHaveProperty('areaChip');
      for (const n of body.notifications) {
        expect(n).not.toHaveProperty('bell_rank');
        expect(n).not.toHaveProperty('created_at_cursor');
      }
    });

    test('a technician list is ordered the same way', async () => {
      const tech = [];
      const trigger = 'appointment_reschedule_intent';
      const techRows = [];
      techRows.push(await put({ key: 't-fyi', at: T(10), severity: 'fyi', trigger }));
      techRows.push(await put({ key: 't-needs', at: T(5), severity: 'needs-you', trigger }));
      techRows.push(await put({ key: 't-plain', at: T(12), trigger }));
      const body = await list({ limit: '100' }, 'technician');
      tech.push(...own(body.notifications).map((n) => n.id));
      expect(tech).toEqual(expectedOrder(techRows));
      expect(body.order).toBe('needs-you-first');
    });
  });

  describe('gate off', () => {
    beforeEach(() => { delete process.env.GATE_ALERT_BELL_ORDER; });

    test('plain newest first, a two-part cursor, no order field, no areaChip', async () => {
      const body = await list({ limit: '100' });
      expect(own(body.notifications).map((n) => n.id).filter((id) => rows.some((r) => r.id === id))).toEqual(timeOrder(rows));
      expect(body).not.toHaveProperty('order');
      expect(body.notifications.every((n) => !('areaChip' in n))).toBe(true);
      const small = await list({ limit: '1' });
      expect(small.next.split('~')).toHaveLength(2);
    });

    test('paging by cursor walks the time order, once each', async () => {
      const seen = [];
      let before;
      for (let i = 0; i < 500; i += 1) {
        const body = await list({ limit: '3', ...(before ? { before } : {}) });
        seen.push(...own(body.notifications).map((n) => n.id));
        if (!body.next) break;
        before = body.next;
      }
      expect(seen.filter((id) => rows.some((r) => r.id === id))).toEqual(timeOrder(rows));
    });

  });

  // The bell as the panel behaves: a load-more answer with restart: true REPLACES the held list, anything else appends.
  async function panelWalk({ startGate, pagesBeforeFlip, limit }) {
    let held = [];
    let next = null;
    let restarts = 0;
    const flip = () => { if (startGate) delete process.env.GATE_ALERT_BELL_ORDER; else process.env.GATE_ALERT_BELL_ORDER = 'true'; };
    if (startGate) process.env.GATE_ALERT_BELL_ORDER = 'true'; else delete process.env.GATE_ALERT_BELL_ORDER;
    let body = await list({ limit: String(limit) });
    held = [...body.notifications];
    next = body.next;
    for (let i = 1; i < pagesBeforeFlip && next; i += 1) {
      body = await list({ limit: String(limit), before: next });
      held.push(...body.notifications);
      next = body.next;
    }
    const heldBeforeFlip = [...held];
    flip();
    const flippedFrom = next;
    for (let i = 0; i < 500 && next; i += 1) {
      body = await list({ limit: String(limit), before: next });
      if (body.restart === true) { held = [...body.notifications]; restarts += 1; } else held.push(...body.notifications);
      next = body.next;
    }
    return { held, heldBeforeFlip, restarts, flippedFrom };
  }
  const coverage = (held) => {
    const fixture = new Set(rows.map((r) => r.id));
    const ids = own(held).map((n) => n.id).filter((id) => fixture.has(id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(rows.map((r) => r.id)));
    return ids;
  };

  describe('the gate flips while a panel is part way through its list', () => {
    afterEach(() => { delete process.env.GATE_ALERT_BELL_ORDER; });

    test.each([[2, 3], [1, 4], [3, 2]])('ranked list, gate unset after %i page(s) of %i rows: the old cursor restarts and every open row is covered, none skipped or repeated', async (pages, limit) => {
      const { held, restarts, heldBeforeFlip } = await panelWalk({ startGate: true, pagesBeforeFlip: pages, limit });
      expect(own(heldBeforeFlip).length).toBeLessThan(rows.length);
      expect(restarts).toBe(1);
      expect(coverage(held)).toEqual(timeOrder(rows));
    });

    test.each([[2, 3], [1, 4], [3, 2]])('chronological list, gate set after %i page(s) of %i rows: the old cursor restarts and every open row is covered, none skipped or repeated', async (pages, limit) => {
      const { held, restarts, heldBeforeFlip } = await panelWalk({ startGate: false, pagesBeforeFlip: pages, limit });
      expect(own(heldBeforeFlip).length).toBeLessThan(rows.length);
      expect(restarts).toBe(1);
      expect(coverage(held)).toEqual(expectedOrder(rows));
    });

    test('the restart answer is page 1 of the current order, flagged, with the order named', async () => {
      process.env.GATE_ALERT_BELL_ORDER = 'true';
      const ranked = await list({ limit: '3' });
      delete process.env.GATE_ALERT_BELL_ORDER;
      const off = await list({ limit: '3', before: ranked.next });
      expect(off.restart).toBe(true);
      expect(off).not.toHaveProperty('order');
      expect(off.page).toBe(1);
      expect(off.notifications.map((n) => n.id)).toEqual((await list({ limit: '3' })).notifications.map((n) => n.id));
      const chronoNext = off.next;
      process.env.GATE_ALERT_BELL_ORDER = 'true';
      const on = await list({ limit: '3', before: chronoNext });
      expect(on.restart).toBe(true);
      expect(on.order).toBe('needs-you-first');
      expect(on.notifications.map((n) => n.id)).toEqual(ranked.notifications.map((n) => n.id));
    });

    test('a cursor of the current order never restarts', async () => {
      process.env.GATE_ALERT_BELL_ORDER = 'true';
      const first = await list({ limit: '3' });
      expect(await list({ limit: '3', before: first.next })).not.toHaveProperty('restart');
      delete process.env.GATE_ALERT_BELL_ORDER;
      const chrono = await list({ limit: '3' });
      expect(await list({ limit: '3', before: chrono.next })).not.toHaveProperty('restart');
    });
  });
});
