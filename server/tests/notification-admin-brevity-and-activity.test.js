// Admin-alerts-brevity scope (owner rulings 2026-09-28 and 2026-09-30):
//   1. NotificationService.create's admin brevity guard — an admin body over
//      110 chars is cut to one sentence and the full original (+ any
//      caller-supplied detail) lands in `detail`, for EVERY admin category
//      (the bell's "Show full text" and the Activity feed read it). With
//      ADMIN_BODY_GUARD_ALL killed, only ops_digest is cut and every other
//      category is stored byte-for-byte. A title is only LOGGED when it runs
//      long, never cut, for ANY category (several senders dedupe/refresh by
//      an exact title lookup, so cutting it here would break that probe).
//   2. notifyAdmin's refresh path compares/stores through the SAME
//      normalization, including `detail`, so a changed detail is stored
//      and an unrelated guard artifact never reads as "content changed".
//   3. Activity-only rows (metadata.feed === 'activity') are excluded from
//      the admin bell's list, unread count, and mark-all-read.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/internal-test-customers', () => ({ isInternalTestCustomerId: () => false }));

let mockRows;
jest.mock('../models/db', () => {
  // A small in-memory `notifications` table supporting the predicate shapes
  // notification-service.js actually issues: where(), whereNull('read_at'),
  // and two whereRaw() shapes — the dedupeKey lookup and the
  // metadata->>'feed' <> 'activity' exclusion (matched by inspecting the
  // raw SQL text, same idiom as notification-admin-dedupe-refresh.test.js).
  const metaOf = (r) => (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata || {});
  const builder = (table) => {
    const conds = [];
    const b = {
      where(c) {
        if (typeof c === 'function') { c(b); return b; }
        Object.entries(c).forEach(([k, v]) => conds.push((r) => r[k] === v));
        return b;
      },
      whereNull(col) { conds.push((r) => r[col] == null); return b; },
      whereRaw(sql, params) {
        if (/dedupeKey/.test(sql)) {
          const key = params[0];
          conds.push((r) => metaOf(r).dedupeKey === key);
        } else if (/feed/.test(sql)) {
          conds.push((r) => metaOf(r).feed !== 'activity');
        } else {
          throw new Error(`unmocked whereRaw: ${sql}`);
        }
        return b;
      },
      orderBy() { return b; },
      select() { return b; },
      orderByRaw() { return b; },
      limit() { return b; },
      offset(n) { return (mockRows[table] || []).filter((r) => conds.every((c) => c(r))).slice(n || 0); },
      first: async () => (mockRows[table] || []).find((r) => conds.every((c) => c(r))) || null,
      count: async () => [{ count: String((mockRows[table] || []).filter((r) => conds.every((c) => c(r))).length) }],
      update: async (patch) => {
        const hit = (mockRows[table] || []).filter((r) => conds.every((c) => c(r)));
        hit.forEach((r) => Object.assign(r, patch));
        return hit.length;
      },
      insert: (row) => ({
        returning: async () => {
          const created = { id: `n-${(mockRows[table] ||= []).length + 1}`, read_at: null, ...row };
          mockRows[table].push(created);
          return [created];
        },
      }),
    };
    // then/catch let `await db(...).where(...)` (no terminal call) resolve
    // to the filtered array — mirrors a plain knex query used as a promise.
    b.then = (resolve) => resolve((mockRows[table] || []).filter((r) => conds.every((c) => c(r))));
    return b;
  };
  const fn = jest.fn((table) => builder(table));
  fn.raw = jest.fn((sql) => sql);
  fn.transaction = async (cb) => { const trx = jest.fn((table) => builder(table)); trx.raw = jest.fn(async () => {}); return cb(trx); };
  return fn;
});

const NotificationService = require('../services/notification-service');
const { truncateAtWord, applyAdminBrevityGuard, MAX_ADMIN_BODY_CHARS, MAX_ADMIN_TITLE_CHARS, DIGEST_CATEGORY } = NotificationService._private;

beforeEach(() => {
  mockRows = { notifications: [] };
  delete process.env.ADMIN_BODY_GUARD_ALL;
});
afterAll(() => { delete process.env.ADMIN_BODY_GUARD_ALL; });

describe('truncateAtWord', () => {
  test('leaves a short string untouched', () => {
    expect(truncateAtWord('short', 20)).toBe('short');
  });
  test('cuts at the last word boundary inside the budget and appends an ellipsis, never exceeding max', () => {
    const cut = truncateAtWord('one two three four five', 12);
    expect(cut.length).toBeLessThanOrEqual(12);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/\s…$/); // no trailing space before the ellipsis
    expect('one two three four five'.startsWith(cut.slice(0, -1))).toBe(true);
  });
  test('a string with no space inside the budget still never exceeds max', () => {
    const cut = truncateAtWord('supercalifragilisticexpialidocious', 10);
    expect(cut.length).toBeLessThanOrEqual(10);
    expect(cut.endsWith('…')).toBe(true);
  });
});

describe('applyAdminBrevityGuard', () => {
  test('a body at or under the cap is untouched and detail is whatever the caller passed (ops_digest)', () => {
    const short = 'a'.repeat(MAX_ADMIN_BODY_CHARS);
    const out = applyAdminBrevityGuard({ category: DIGEST_CATEGORY, title: 't', body: short, detail: null });
    expect(out.body).toBe(short);
    expect(out.detail).toBeNull();
  });

  test('an over-length ops_digest body is cut at a word boundary; the FULL original moves to detail', () => {
    const body = 'word '.repeat(40).trim(); // well over 110 chars
    const out = applyAdminBrevityGuard({ category: DIGEST_CATEGORY, title: 't', body, detail: null });
    expect(out.body.length).toBeLessThanOrEqual(MAX_ADMIN_BODY_CHARS);
    expect(out.body.endsWith('…')).toBe(true);
    expect(body.startsWith(out.body.slice(0, -1))).toBe(true);
    expect(out.detail).toBe(body);
  });

  test('a caller-supplied detail is kept ALONGSIDE the full ops_digest body, full body first', () => {
    const body = 'word '.repeat(40).trim();
    const out = applyAdminBrevityGuard({ category: DIGEST_CATEGORY, title: 't', body, detail: 'caller extra context' });
    expect(out.detail).toBe(`${body}\n\ncaller extra context`);
  });

  test('a caller-supplied detail that already contains the full ops_digest body is not duplicated', () => {
    const body = 'word '.repeat(40).trim();
    const already = `${body}\n\nplus more`;
    const out = applyAdminBrevityGuard({ category: DIGEST_CATEGORY, title: 't', body, detail: already });
    expect(out.detail).toBe(already);
  });

  test('an over-length body on ANY admin category is cut at a word boundary; the full original moves to detail', () => {
    const body = 'word '.repeat(40).trim();
    const out = applyAdminBrevityGuard({ category: 'alert', title: 't', body, detail: null });
    expect(out.body.length).toBeLessThanOrEqual(MAX_ADMIN_BODY_CHARS);
    expect(out.body.endsWith('…')).toBe(true);
    expect(out.detail).toBe(body);
  });

  test('a caller-supplied detail on a non-digest row is kept AFTER the full body', () => {
    const body = 'word '.repeat(40).trim();
    const out = applyAdminBrevityGuard({ category: 'review', title: 't', body, detail: 'caller extra context' });
    expect(out.detail).toBe(`${body}\n\ncaller extra context`);
  });

  test('a multi-line list body cuts at its first line break when that line fits; a long first line word-cuts', () => {
    const list = 'Promises with no follow-up:\n• callback for Test Caller\n• quote for Test Owner\n• text for Test Neighbor\n• estimate for Test Tenant';
    expect(list.length).toBeGreaterThan(MAX_ADMIN_BODY_CHARS);
    const out = applyAdminBrevityGuard({ category: 'alert', title: 't', body: list, detail: null });
    expect(out.body).toBe('Promises with no follow-up…');
    expect(out.detail).toBe(list);
    const longFirst = `${'word '.repeat(30).trim()}\n• item`;
    const cut = applyAdminBrevityGuard({ category: 'alert', title: 't', body: longFirst, detail: null });
    expect(cut.body.length).toBeLessThanOrEqual(MAX_ADMIN_BODY_CHARS);
    expect(cut.body).not.toContain('\n');
    expect(cut.detail).toBe(longFirst);
  });

  test('ADMIN_BODY_GUARD_ALL killed: a non-digest body is stored unchanged and ops_digest is still cut, as before', () => {
    const body = 'word '.repeat(40).trim();
    for (const off of ['off', 'FALSE', '0']) {
      process.env.ADMIN_BODY_GUARD_ALL = off;
      const alert = applyAdminBrevityGuard({ category: 'alert', title: 't', body, detail: null });
      expect(alert).toEqual({ title: 't', body, detail: null });
      const withDetail = applyAdminBrevityGuard({ category: 'review', title: 't', body, detail: 'caller extra context' });
      expect(withDetail.body).toBe(body);
      expect(withDetail.detail).toBe('caller extra context');
      const digest = applyAdminBrevityGuard({ category: DIGEST_CATEGORY, title: 't', body, detail: null });
      expect(digest.body.length).toBeLessThanOrEqual(MAX_ADMIN_BODY_CHARS);
      expect(digest.detail).toBe(body);
    }
  });

  test('a title is never cut, only logged when it runs long — several senders dedupe on it exactly', () => {
    const longTitle = 'x'.repeat(MAX_ADMIN_TITLE_CHARS + 40);
    const out = applyAdminBrevityGuard({ category: DIGEST_CATEGORY, title: longTitle, body: 'short body', detail: null });
    expect(out.title).toBe(longTitle);
    expect(applyAdminBrevityGuard({ category: 'alert', title: longTitle, body: 'word '.repeat(40).trim(), detail: null }).title).toBe(longTitle);
  });
});

describe('NotificationService.create — admin brevity guard end to end', () => {
  test('a long ops_digest body is cut in the stored row; detail carries the whole thing', async () => {
    const body = 'sentence '.repeat(30).trim();
    const notif = await NotificationService.create({ recipientType: 'admin', category: DIGEST_CATEGORY, title: 'Short title', body });
    expect(notif.body.length).toBeLessThanOrEqual(110);
    expect(notif.detail).toBe(body);
  });

  test('detail is emoji-stripped like title/body — the Activity feed renders it (codex r2 P2 on #5236)', async () => {
    const detail = 'Autopay mismatch report\n\u26a0 2 customers texted while autopay is off';
    const notif = await NotificationService.create({ recipientType: 'admin', category: DIGEST_CATEGORY, title: 'Autopay', body: null, detail });
    expect(notif.detail).not.toMatch(/\u26a0/);
    expect(notif.detail).toMatch(/2 customers texted while autopay is off/);
  });

  test('a long body on any other admin category is cut in the stored row; detail carries the whole thing', async () => {
    const body = 'sentence '.repeat(30).trim();
    const notif = await NotificationService.create({ recipientType: 'admin', category: 'alert', title: 'Short title', body });
    expect(notif.body.length).toBeLessThanOrEqual(110);
    expect(notif.detail).toBe(body);
  });

  test('ADMIN_BODY_GUARD_ALL killed: a long non-digest body is stored byte-for-byte, no detail column written', async () => {
    process.env.ADMIN_BODY_GUARD_ALL = 'off';
    const body = 'sentence '.repeat(30).trim();
    const notif = await NotificationService.create({ recipientType: 'admin', category: 'alert', title: 'Short title', body });
    expect(notif.body).toBe(body);
    expect(notif).not.toHaveProperty('detail');
  });

  test('a customer row is never touched by the guard', async () => {
    const body = 'sentence '.repeat(30).trim();
    const notif = await NotificationService.create({ recipientType: 'customer', recipientId: 'c1', category: 'service', title: 'Short title', body });
    expect(notif.body).toBe(body);
    expect(notif).not.toHaveProperty('detail'); // column not written without a detail
  });

  test('a short body is untouched and detail stays null when none was given', async () => {
    const notif = await NotificationService.create({ recipientType: 'admin', category: 'alert', title: 'Short', body: 'short body' });
    expect(notif.body).toBe('short body');
    expect(notif).not.toHaveProperty('detail'); // column not written without a detail
  });
});

describe('notifyAdmin refresh — detail participates in the change comparison and the stored row', () => {
  test('a refresh whose ONLY change is the detail still rewrites the standing row and re-bells it', async () => {
    await NotificationService.notifyAdmin('system', 'Standing check', 'body', {
      dedupeKey: 'k1', refreshOnDedupe: true, detail: 'first detail',
    });
    mockRows.notifications[0].read_at = new Date();
    const again = await NotificationService.notifyAdmin('system', 'Standing check', 'body', {
      dedupeKey: 'k1', refreshOnDedupe: true, detail: 'second detail',
    });
    expect(again.refreshed).toBe(true);
    expect(mockRows.notifications[0].detail).toBe('second detail');
    expect(mockRows.notifications[0].read_at).toBeNull();
  });

  test('a routing-only change (FIX -> ACT, identical text) still refreshes and clears the stale feed (codex r3 P0 on #5236)', async () => {
    const base = { dedupeKey: 'k-route', refreshOnDedupe: true, detail: 'same report' };
    await NotificationService.notifyAdmin(DIGEST_CATEGORY, 'Reviews — sync down', null, {
      ...base, metadata: { kind: 'FIX', audience: 'engineering', feed: 'activity' },
    });
    mockRows.notifications[0].read_at = new Date();
    const again = await NotificationService.notifyAdmin(DIGEST_CATEGORY, 'Reviews — sync down', null, {
      ...base, metadata: { kind: 'ACT', audience: 'owner', feed: null },
    });
    expect(again.refreshed).toBe(true);
    const meta = typeof mockRows.notifications[0].metadata === 'string'
      ? JSON.parse(mockRows.notifications[0].metadata) : mockRows.notifications[0].metadata;
    expect(meta).toMatchObject({ kind: 'ACT', audience: 'owner', feed: null });
    expect(mockRows.notifications[0].read_at).toBeNull();
    // Same routing again → plain dedupe.
    const third = await NotificationService.notifyAdmin(DIGEST_CATEGORY, 'Reviews — sync down', null, {
      ...base, metadata: { kind: 'ACT', audience: 'owner', feed: null },
    });
    expect(third.refreshed).toBeUndefined();
  });

  test('an identical re-emission (same title/body/link/detail) stays a plain dedupe — no rewrite, no re-bell', async () => {
    await NotificationService.notifyAdmin('system', 'Standing check', 'body', {
      dedupeKey: 'k2', refreshOnDedupe: true, detail: 'same detail',
    });
    mockRows.notifications[0].read_at = new Date();
    const again = await NotificationService.notifyAdmin('system', 'Standing check', 'body', {
      dedupeKey: 'k2', refreshOnDedupe: true, detail: 'same detail',
    });
    expect(again.deduped).toBe(true);
    expect(again.refreshed).toBeUndefined();
    expect(mockRows.notifications[0].read_at).not.toBeNull();
  });

  test('the refresh comparison normalizes through the SAME brevity guard, so a guard-only difference never reads as changed', async () => {
    const longBody = 'sentence '.repeat(30).trim();
    await NotificationService.notifyAdmin('system', 'Standing check', longBody, { dedupeKey: 'k3', refreshOnDedupe: true });
    mockRows.notifications[0].read_at = new Date();
    // Re-emitted with the exact same long body: normalized title/body/detail
    // are identical, so this must stay deduped, not "changed".
    const again = await NotificationService.notifyAdmin('system', 'Standing check', longBody, { dedupeKey: 'k3', refreshOnDedupe: true });
    expect(again.refreshed).toBeUndefined();
    expect(mockRows.notifications[0].read_at).not.toBeNull();
  });

  test('an over-length NON-digest body emitted twice dedupes quietly; a changed tail beyond char 110 is a real change', async () => {
    const head = 'sentence '.repeat(14); // 126 chars: the cut lands before the tail
    const opts = { dedupeKey: 'k3b', refreshOnDedupe: true };
    await NotificationService.notifyAdmin('billing', 'Standing check', `${head}tail one`, opts);
    expect(mockRows.notifications[0].body.length).toBeLessThanOrEqual(110); // the cut path ran
    mockRows.notifications[0].read_at = new Date();
    const same = await NotificationService.notifyAdmin('billing', 'Standing check', `${head}tail one`, opts);
    expect(same.refreshed).toBeUndefined();
    expect(mockRows.notifications[0].read_at).not.toBeNull();
    const changed = await NotificationService.notifyAdmin('billing', 'Standing check', `${head}tail two`, opts);
    expect(changed.refreshed).toBe(true);
    expect(mockRows.notifications[0].detail).toBe(`${head}tail two`);
    expect(mockRows.notifications[0].read_at).toBeNull();
  });

  test('the same invariant holds on the ops_digest CUT path — a re-emission with the same long body stays deduped, not changed', async () => {
    const longBody = 'sentence '.repeat(30).trim();
    await NotificationService.notifyAdmin(DIGEST_CATEGORY, 'Standing check', longBody, { dedupeKey: 'k4', refreshOnDedupe: true });
    const cutBody = mockRows.notifications[0].body;
    expect(cutBody.length).toBeLessThanOrEqual(110); // confirms the cut path actually ran
    expect(mockRows.notifications[0].detail).toBe(longBody);
    mockRows.notifications[0].read_at = new Date();
    const again = await NotificationService.notifyAdmin(DIGEST_CATEGORY, 'Standing check', longBody, { dedupeKey: 'k4', refreshOnDedupe: true });
    expect(again.refreshed).toBeUndefined();
    expect(mockRows.notifications[0].read_at).not.toBeNull();
  });
});

describe('activity-only rows never reach the admin bell', () => {
  async function seedRows() {
    await NotificationService.create({ recipientType: 'admin', category: 'ops_digest', title: 'Owner alert', body: 'b', metadata: { feed: null } });
    await NotificationService.create({ recipientType: 'admin', category: 'ops_digest', title: 'Engineering alert', body: 'b', metadata: { feed: 'activity' } });
  }

  test('getAdminNotifications excludes activity-only rows', async () => {
    await seedRows();
    const rows = await NotificationService.getAdminNotifications(50, 0);
    expect(rows.map((r) => r.title)).toEqual(['Owner alert']);
  });

  test('getAdminUnreadCount excludes activity-only rows', async () => {
    await seedRows();
    const count = await NotificationService.getAdminUnreadCount();
    expect(count).toBe(1);
  });

  test('markAllReadAdmin never marks an activity-only row read', async () => {
    await seedRows();
    await NotificationService.markAllReadAdmin();
    const [owner, engineering] = mockRows.notifications;
    expect(owner.read_at).not.toBeNull();
    expect(engineering.read_at).toBeNull();
  });
});

// create() swallows its own errors and returns null, so a gate reader that is
// missing (a test or caller that mocks feature-gates without it) must read as
// live, never throw and drop the alert.
test('a missing ADMIN_BODY_GUARD_ALL reader reads as live: the alert is still written, cut', () => {
  jest.isolateModules(() => {
    jest.doMock('../config/feature-gates', () => ({ isEnabled: () => false, gates: {} }));
    const svc = require('../services/notification-service');
    const long = `${'word '.repeat(40)}end.`;
    const out = svc.normalizeAdminText({ category: 'alert', title: 'T', body: long });
    expect(out.body.length).toBeLessThanOrEqual(110);
    expect(out.detail).toBe(long);
  });
});
