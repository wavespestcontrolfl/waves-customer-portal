// Customer activity timeline, no database: merge order and pagination, the
// engagement rule (an email open is never engagement), the row-to-event
// mappers, absent-relation guards and per-source failure isolation. The SQL
// itself is proven on a real Postgres in customer-activity-timeline-postgres.test.js.
jest.mock('../models/db', () => ({}));
const mockWarn = jest.fn();
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: (...a) => mockWarn(...a), error: jest.fn(), debug: jest.fn() }));

const timeline = require('../services/customer-activity-timeline');
const { mergeEvents, isEngagedKind, SOURCES, getCustomerActivity, needsPresent, hasRelation, hasColumn } = timeline;

const ev = (id, at, extra = {}) => ({ id, at: new Date(at).toISOString(), channel: 'sms', kind: 'sent', title: id, detail: null, engaged: false, source: 's', ref: null, ...extra });
const source = (name) => SOURCES.find((s) => s.name === name);

// A permissive stand-in for a knex builder: every chain call returns itself,
// awaiting it yields the table's rows, and .first() yields the customer / a null MAX.
function fakeDb({ customer = { id: 'c1', email: 'A@Example.test' }, rows = {}, present = true, failTable = null, failMax = [], maxes = {} } = {}) {
  const calls = { limit: [], raw: [], chain: [] };
  const dbh = (name) => {
    const b = new Proxy(function builder() {}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve, reject) => (failTable === name ? reject(new Error('boom')) : resolve(rows[name] || []));
        }
        if (prop === 'first') {
          return async () => {
            if (name === 'customers') return customer;
            if (failMax === 'all' || failMax.includes(name)) throw new Error('max boom');
            return { m: maxes[name] || null };
          };
        }
        if (prop === 'limit') return (n) => { calls.limit.push(n); return b; };
        return (...args) => { calls.chain.push([name, String(prop), args]); return b; };
      },
    });
    return b;
  };
  dbh.raw = async (sql, bindings) => {
    calls.raw.push([sql, bindings]);
    if (/to_regclass\(\?\) IS NOT NULL/.test(sql)) return { rows: [{ ok: typeof present === 'function' ? present(bindings[0]) : present }] };
    if (/pg_attribute/.test(sql)) return { rows: (typeof present === 'function' ? present(bindings[0], bindings[1]) : present) ? [{ ok: 1 }] : [] };
    return { rows: [] };
  };
  dbh.calls = calls;
  return dbh;
}

beforeEach(() => { timeline.resetGuardCacheForTests(); mockWarn.mockReset(); });

describe('engagement rule', () => {
  test('only clicks, views and replies are engagement; opens, sends and calls are not', () => {
    for (const kind of ['clicked', 'viewed', 'replied']) expect(isEngagedKind(kind)).toBe(true);
    for (const kind of ['opened', 'sent', 'delivered', 'failed', 'bounced', 'complained', 'called', 'placed']) expect(isEngagedKind(kind)).toBe(false);
  });

  test('an email row explodes into events where the open is not engaged and the click is', () => {
    const at = (m) => new Date(Date.UTC(2026, 8, 1, 12, m));
    const events = source('emails').toEvents({
      id: 'e1', status: 'clicked', subject_snapshot: 'Your estimate', sent_at: at(0), delivered_at: at(1), opened_at: at(2), clicked_at: at(3),
    });
    const by = Object.fromEntries(events.map((e) => [e.kind, e]));
    expect(Object.keys(by).sort()).toEqual(['clicked', 'delivered', 'opened', 'sent']);
    expect(by.opened.engaged).toBe(false);
    expect(by.opened.title).toMatch(/not reliable/i);
    expect(by.clicked.engaged).toBe(true);
    expect(by.sent.engaged).toBe(false);
    expect(events.every((e) => e.channel === 'email' && e.detail === 'Your estimate')).toBe(true);
  });

  test('automation emails: bounced and complained statuses each produce their event, dated updated_at', () => {
    const at = (m) => new Date(Date.UTC(2026, 8, 1, 12, m));
    const map = (status) => source('automation emails').toEvents({
      id: 'a1', status, step_order: 0, template_key: 'k', sent_at: at(0), updated_at: at(7),
    });
    const bounced = map('bounced');
    expect(bounced.map((e) => e.kind).sort()).toEqual(['bounced', 'sent']);
    expect(bounced.find((e) => e.kind === 'bounced').at).toBe(at(7).toISOString());
    expect(map('complained').map((e) => e.kind).sort()).toEqual(['complained', 'sent']);
    expect(map('failed').map((e) => e.kind).sort()).toEqual(['failed', 'sent']);
    expect(map('delivered').map((e) => e.kind)).toEqual(['sent']);
    expect(source('automation emails').ts.join(' ')).toMatch(/'bounced'/);
    expect(source('automation emails').ts.join(' ')).toMatch(/'complained'/);
  });

  test('a failed email is dated at the failure transition (updated_at), after its queue time', () => {
    const at = (m) => new Date(Date.UTC(2026, 8, 1, 12, m));
    const [failed] = source('emails').toEvents({ id: 'e2', status: 'failed', subject_snapshot: 'x', queued_at: at(0), updated_at: at(9) });
    expect(failed).toMatchObject({ kind: 'failed', at: at(9).toISOString() });
    expect(source('emails').ts.join(' ')).toMatch(/COALESCE\(em\.updated_at, em\.queued_at\)/);
    // Legacy row with no updated_at falls back to the queue time.
    expect(source('emails').toEvents({ id: 'e3', status: 'failed', queued_at: at(0) })[0].at).toBe(at(0).toISOString());
  });

  test('summary sources: opens feed lastEmailOpenAt only, never the engaged list', () => {
    for (const name of ['emails', 'automation emails', 'newsletters']) {
      const src = source(name);
      expect(src.open).toBeTruthy();
      expect(src.engaged.expr).toMatch(/clicked_at$/);
      expect(src.engaged.expr).not.toMatch(/opened_at/);
    }
    for (const src of SOURCES) expect(src.engaged?.expr || '').not.toMatch(/opened_at/);
    expect(source('calls').engaged).toBeUndefined();
  });

  test('texts: only the inbound reply is engagement and outbound status maps to sent / delivered / failed', () => {
    const t = new Date('2026-09-01T12:00:00Z');
    const map = (row) => source('texts').toEvents({ id: 'x', message_type: 'reminder', message_body: 'hi', created_at: t, ...row })[0];
    expect(map({ direction: 'inbound', status: 'received' })).toMatchObject({ kind: 'replied', engaged: true, title: 'Replied by text' });
    expect(map({ direction: 'outbound', status: 'delivered' })).toMatchObject({ kind: 'delivered', engaged: false });
    expect(map({ direction: 'outbound', status: 'undelivered' })).toMatchObject({ kind: 'failed', engaged: false });
    expect(map({ direction: 'outbound', status: 'queued' })).toMatchObject({ kind: 'sent', engaged: false });
    expect(map({ direction: 'outbound', status: null })).toMatchObject({ kind: 'sent' });
  });

  test('texts: scheduled, sending and cancelled rows never left, so they produce no "sent" event', () => {
    const t = new Date('2026-09-01T12:00:00Z');
    for (const status of ['scheduled', 'sending', 'canceled', 'cancelled', 'draft', 'held', 'pending', 'skipped', 'blocked', 'suppressed']) {
      expect(source('texts').toEvents({ id: 'x', direction: 'outbound', status, message_body: 'hi', created_at: t })).toEqual([]);
    }
  });

  test('portal page views ride the portal channel; token pages ride the page channel', () => {
    const t = new Date('2026-09-01T12:00:00Z');
    const map = (page) => source('page views').toEvents({ id: 'p', page, viewed_at: t })[0];
    expect(map('portal:billing')).toMatchObject({ channel: 'portal', kind: 'viewed', engaged: true, detail: 'billing' });
    expect(map('appointment')).toMatchObject({ channel: 'page', kind: 'viewed', engaged: true, title: 'Opened the appointment page' });
  });
});

describe('mergeEvents', () => {
  const lists = [
    [ev('a', '2026-09-05T10:00:00Z'), ev('b', '2026-09-03T10:00:00Z')],
    [ev('c', '2026-09-04T10:00:00Z'), ev('d', '2026-09-01T10:00:00Z')],
    [ev('e', '2026-09-02T10:00:00Z')],
  ];

  test('merges newest first and cuts at limit with a cursor at the last shown event', () => {
    const r = mergeEvents(lists, { limit: 3 });
    expect(r.events.map((e) => e.id)).toEqual(['a', 'c', 'b']);
    expect(r.hasMore).toBe(true);
    expect(r.nextCursor).toBe('2026-09-03T10:00:00.000Z');
  });

  test('the cursor page continues exactly where the last one stopped', () => {
    const first = mergeEvents(lists, { limit: 3 });
    const second = mergeEvents(lists, { limit: 3, before: first.nextCursor });
    expect(second.events.map((e) => e.id)).toEqual(['e', 'd']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  test('a saturated source keeps hasMore true even when the merged page fits', () => {
    const r = mergeEvents([[ev('a', '2026-09-05T10:00:00Z')]], { limit: 5, saturated: true });
    expect(r.hasMore).toBe(true);
  });

  test('events at or after the cursor are dropped', () => {
    const r = mergeEvents(lists, { limit: 10, before: '2026-09-03T10:00:00Z' });
    expect(r.events.map((e) => e.id)).toEqual(['e', 'd']);
  });
});

describe('getCustomerActivity guards', () => {
  test('unknown customer is null; a bad cursor is a 400 before any source runs', async () => {
    expect(await getCustomerActivity('nope', {}, fakeDb({ customer: null }))).toBeNull();
    await expect(getCustomerActivity('c1', { before: 'garbage' }, fakeDb())).rejects.toMatchObject({ status: 400 });
  });

  test('absent relations skip their sources and are reported; the always-present ones still run', async () => {
    const t = new Date('2026-09-10T12:00:00Z');
    const dbh = fakeDb({
      present: false,
      rows: { 'sms_log as sl': [{ id: 's1', direction: 'inbound', status: 'received', message_body: 'hello', created_at: t }] },
    });
    const r = await getCustomerActivity('c1', {}, dbh);
    expect(r.absentSources).toEqual(expect.arrayContaining(['outside link clicks', 'portal visits', 'automation emails', 'newsletters', 'page views', 'calls']));
    expect(r.absentSources).not.toContain('texts');
    expect(r.absentSources).not.toContain('emails');
    expect(r.events.map((e) => e.title)).toEqual(['Replied by text']);
    expect(r.unavailableSources).toEqual([]);
  });

  test('the sibling-PR sources light up when their relations exist', async () => {
    const present = (table, column) => !['outbound_link_clicks', 'outbound_links'].includes(table) && !(table === 'customers' && column === 'last_seen_at');
    const before = await getCustomerActivity('c1', {}, fakeDb({ present }));
    expect(before.absentSources).toEqual(expect.arrayContaining(['outside link clicks', 'portal visits']));
    timeline.resetGuardCacheForTests();
    const after = await getCustomerActivity('c1', {}, fakeDb({ present: true }));
    expect(after.absentSources).not.toContain('outside link clicks');
    expect(after.absentSources).not.toContain('portal visits');
  });

  test('one failing source is reported and the others still return', async () => {
    const t = new Date('2026-09-10T12:00:00Z');
    const dbh = fakeDb({
      failTable: 'email_messages as em',
      rows: { 'sms_log as sl': [{ id: 's1', direction: 'outbound', status: 'sent', message_body: 'hi', created_at: t }] },
    });
    const r = await getCustomerActivity('c1', {}, dbh);
    expect(r.unavailableSources).toContain('emails');
    expect(r.events).toHaveLength(1);
    expect(mockWarn).toHaveBeenCalled();
  });

  test('a failed query is logged without the error message (it carries the customer email in its bindings)', async () => {
    const dbh = fakeDb({ failTable: 'email_messages as em', customer: { id: 'c1', email: 'private.person@example.test' } });
    await getCustomerActivity('c1', {}, dbh);
    const logged = mockWarn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/emails failed for customer c1/);
    expect(logged).not.toMatch(/private\.person|boom/);
  });

  test('limit is clamped to 1..200 and defaults to 100', async () => {
    const run = async (limit) => { const d = fakeDb(); await getCustomerActivity('c1', { limit }, d); return new Set(d.calls.limit); };
    // Each source fetches limit + 1 (the extra row says "more exists").
    expect([...(await run(9999))]).toEqual([201]);
    expect([...(await run(undefined))]).toEqual([101]);
    expect([...(await run(-3))]).toEqual([101]);
    expect([...(await run('7'))]).toEqual([8]);
  });

  test('an archived customer is not found (deleted_at IS NULL is part of the lookup)', async () => {
    const dbh = fakeDb();
    await getCustomerActivity('c1', {}, dbh);
    expect(dbh.calls.chain).toContainEqual(['customers', 'whereNull', ['deleted_at']]);
  });

  test('a source with exactly `limit` rows does not advertise more; one extra row does', async () => {
    const row = (i) => ({ id: `s${i}`, direction: 'outbound', status: 'sent', message_body: 'hi', created_at: new Date(Date.UTC(2026, 8, 10, 12, i)) });
    const exact = await getCustomerActivity('c1', { limit: 2 }, fakeDb({ rows: { 'sms_log as sl': [row(2), row(1)] } }));
    expect(exact.events).toHaveLength(2);
    expect(exact.hasMore).toBe(false);
    expect(exact.nextCursor).toBeNull();
    timeline.resetGuardCacheForTests();
    const more = await getCustomerActivity('c1', { limit: 2 }, fakeDb({ rows: { 'sms_log as sl': [row(3), row(2), row(1)] } }));
    expect(more.events).toHaveLength(2);
    expect(more.hasMore).toBe(true);
    expect(more.nextCursor).toBe(more.events[1].at);
  });

  test('summary is computed on the first page only', async () => {
    expect((await getCustomerActivity('c1', {}, fakeDb())).summary).not.toBeNull();
    expect((await getCustomerActivity('c1', { before: '2026-09-01T00:00:00Z' }, fakeDb())).summary).toBeNull();
  });

  test('summary settles per source: one failing MAX drops that source, the rest still summarise', async () => {
    const dbh = fakeDb({
      failMax: ['newsletter_send_deliveries as d'],
      maxes: { 'sms_log as sl': new Date('2026-09-09T10:00:00Z'), 'email_messages as em': new Date('2026-09-08T10:00:00Z') },
    });
    const r = await getCustomerActivity('c1', {}, dbh);
    expect(r.summary).toMatchObject({ lastEngagedAt: '2026-09-09T10:00:00.000Z', lastEngagedFrom: 'texts' });
    expect(r.unavailableSources).toEqual(['newsletters']);
    const logged = mockWarn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/summary \(newsletters\) failed for customer c1/);
    expect(logged).not.toMatch(/max boom|example\.test/);
  });

  test('summary is null only when every MAX query failed', async () => {
    const r = await getCustomerActivity('c1', {}, fakeDb({ failMax: 'all' }));
    expect(r.summary).toBeNull();
    expect(r.unavailableSources).toEqual(expect.arrayContaining(['texts', 'emails', 'newsletters']));
  });

  test('relation guards are cached and use to_regclass / pg_attribute', async () => {
    const dbh = fakeDb({ present: true });
    expect(await hasRelation(dbh, 'call_log')).toBe(true);
    expect(await hasRelation(dbh, 'call_log')).toBe(true);
    expect(await hasColumn(dbh, 'customers', 'last_seen_at')).toBe(true);
    expect(dbh.calls.raw).toHaveLength(2);
    expect(await needsPresent(dbh, ['call_log', ['customers', 'last_seen_at']])).toBe(true);
    expect(await needsPresent(fakeDb({ present: false }), ['never_cached_table'])).toBe(false);
  });
});

test('every source is read-only: nothing but select/max builders are used', () => {
  const src = require('fs').readFileSync(require.resolve('../services/customer-activity-timeline'), 'utf8');
  expect(src).not.toMatch(/\.(insert|update|del|delete|truncate)\(|INSERT INTO|UPDATE |DELETE FROM/);
});
