// Admin-alerts-brevity scope (owner ruling 2026-09-28):
//   1. NotificationService.create's admin brevity guard — for category
//      ops_digest ONLY, a body over 110 chars is cut at a word boundary;
//      the full original (+ any caller-supplied detail) lands in `detail`.
//      Every OTHER admin category's body is stored UNCHANGED, whatever its
//      length — only the Activity feed ever reads `detail`, and it only
//      reads ops_digest rows, so cutting another category's body would
//      make the rest of it unreachable. A title is only LOGGED when it
//      runs long, never cut, for ANY category (several senders
//      dedupe/refresh by an exact title lookup, so cutting it here would
//      break that probe).
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
  fn.transaction = async (cb) => { const trx = jest.fn((table) => builder(table)); trx.raw = jest.fn(async () => {}); return cb(trx); };
  return fn;
});

const NotificationService = require('../services/notification-service');
const { truncateAtWord, applyAdminBrevityGuard, MAX_ADMIN_BODY_CHARS, MAX_ADMIN_TITLE_CHARS, DIGEST_CATEGORY } = NotificationService._private;

beforeEach(() => {
  mockRows = { notifications: [] };
});

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

  // Restriction: only the Activity feed ever reads `detail`, and it only
  // reads ops_digest — every OTHER category's body is stored unchanged,
  // whatever its length, and just logged (never cut, never moved).
  test('a non-ops_digest over-length body is left completely unchanged; detail stays whatever the caller passed', () => {
    const body = 'word '.repeat(40).trim();
    const out = applyAdminBrevityGuard({ category: 'alert', title: 't', body, detail: null });
    expect(out.body).toBe(body);
    expect(out.detail).toBeNull();
  });

  test('a non-ops_digest over-length body never absorbs a caller-supplied detail either', () => {
    const body = 'word '.repeat(40).trim();
    const out = applyAdminBrevityGuard({ category: 'review', title: 't', body, detail: 'caller extra context' });
    expect(out.body).toBe(body);
    expect(out.detail).toBe('caller extra context');
  });

  test('a title is never cut, only logged when it runs long — several senders dedupe on it exactly', () => {
    const longTitle = 'x'.repeat(MAX_ADMIN_TITLE_CHARS + 40);
    const out = applyAdminBrevityGuard({ category: DIGEST_CATEGORY, title: longTitle, body: 'short body', detail: null });
    expect(out.title).toBe(longTitle);
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

  test('a long body on any OTHER admin category is stored unchanged, with a null detail', async () => {
    const body = 'sentence '.repeat(30).trim();
    const notif = await NotificationService.create({ recipientType: 'admin', category: 'alert', title: 'Short title', body });
    expect(notif.body).toBe(body);
    expect(notif).not.toHaveProperty('detail'); // column not written without a detail
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
