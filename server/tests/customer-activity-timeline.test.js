// Customer activity timeline, no database: merge order and pagination, the
// engagement rule (only first-party, already-filtered evidence is engaged), the
// row-to-event mappers, masked recipients and per-source failure isolation. The
// SQL itself is proven on a real Postgres in customer-activity-timeline-postgres.test.js.
jest.mock('../models/db', () => ({}));
const mockWarn = jest.fn();
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: (...a) => mockWarn(...a), error: jest.fn(), debug: jest.fn() }));

const timeline = require('../services/customer-activity-timeline');
const { mergeEvents, isEngagedKind, SOURCES, getCustomerActivity } = timeline;

const ev = (id, at, extra = {}) => ({ id, at: new Date(at).toISOString(), channel: 'sms', kind: 'sent', title: id, detail: null, engaged: false, source: 's', ref: null, ...extra });
const source = (name) => SOURCES.find((s) => s.name === name);

// A permissive stand-in for a knex builder: every chain call returns itself,
// awaiting it yields the table's rows, and .first() yields the customer / a null MAX.
function fakeDb({ customer = { id: 'c1', email: 'A@Example.test' }, rows = {}, failTable = null, failMax = [], failMaxExpr = null, maxes = {} } = {}) {
  const calls = { limit: [], raw: [], chain: [] };
  const dbh = (name) => {
    let lastSelect = null;
    const b = new Proxy(function builder() {}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve, reject) => (failTable === name ? reject(new Error('boom')) : resolve(rows[name] || []));
        }
        if (prop === 'first') {
          return async () => {
            if (name === 'customers') return customer;
            if (failMax === 'all' || failMax.includes(name)) throw new Error('max boom');
            if (failMaxExpr && failMaxExpr.test(name, lastSelect?.sql || '')) throw new Error('max boom');
            const expr = lastSelect?.sql?.match(/MAX\(([^)]*)\)/)?.[1];
            const m = maxes[name];
            return { m: (m instanceof Date ? m : m && m[expr]) || null };
          };
        }
        if (prop === 'select') return (...args) => { lastSelect = args.find((a) => a && a.sql) || lastSelect; calls.chain.push([name, 'select', args]); return b; };
        if (prop === 'limit') return (n) => { calls.limit.push(n); return b; };
        return (...args) => { calls.chain.push([name, String(prop), args]); return b; };
      },
    });
    return b;
  };
  // MAX(...) raws are select-list fragments: keep the SQL readable on the
  // returned object so first() can tell which of a source's queries it is.
  dbh.raw = (sql, bindings) => {
    calls.raw.push([sql, bindings]);
    return { sql };
  };
  dbh.calls = calls;
  return dbh;
}

beforeEach(() => { mockWarn.mockReset(); });

const at = (m, s = 0) => new Date(Date.UTC(2026, 8, 1, 12, m, s));

describe('engagement rule: only first-party, already-filtered evidence is engaged', () => {
  test('the engaged kinds are clicked, viewed and replied; nothing provider-reported or unfiltered is', () => {
    for (const kind of ['clicked', 'viewed', 'replied']) expect(isEngagedKind(kind)).toBe(true);
    for (const kind of ['provider_clicked', 'viewed_unfiltered', 'opened', 'sent', 'delivered', 'failed', 'bounced', 'complained', 'called', 'placed']) {
      expect(isEngagedKind(kind)).toBe(false);
    }
  });

  test('the summary has exactly three engaged sources: inbound texts, short-link clicks, recorded page views', () => {
    expect(SOURCES.filter((s) => s.engaged).map((s) => s.name)).toEqual(['texts', 'link clicks', 'page views']);
    expect(source('texts').engaged.where).toBeTruthy(); // inbound only
    // every other source may only feed the informational open / provider-click fields
    for (const src of SOURCES.filter((s) => !s.engaged)) expect(Object.keys(src)).not.toContain('engaged');
    for (const name of ['emails', 'automation emails', 'newsletters']) {
      expect(source(name).open.expr).toMatch(/opened_at$/);
      expect(source(name).providerClick.expr).toMatch(/clicked_at$/);
    }
  });

  test('link clicks: a payer click is not engaged, and only a recorded sms/email channel names one', () => {
    const t = new Date('2026-09-01T12:00:00Z');
    const links = source('link clicks');
    expect(links.toEvents({ id: 'l', clicked_at: t, kind: 'invoice', channel: 'email', by_payer: true })[0])
      .toMatchObject({ kind: 'payer_clicked', engaged: false, title: 'Link clicked by invoice recipient', channel: 'email' });
    expect(isEngagedKind('payer_clicked')).toBe(false);
    expect(links.engaged.where).toBeTruthy(); // the summary MAX excludes payer clicks
    expect(links.toEvents({ id: 'l', clicked_at: t, kind: 'invoice', channel: null })[0]).toMatchObject({ channel: 'link', engaged: true });
    expect(links.toEvents({ id: 'l', clicked_at: t, kind: 'invoice', channel: 'push' })[0].channel).toBe('link');
    expect(links.toEvents({ id: 'l', clicked_at: t, kind: 'invoice', channel: 'sms' })[0].channel).toBe('sms');
  });

  test('texts: an outcome event uses the status time (event_at) and falls back to created_at', () => {
    const sent = new Date('2026-09-01T12:00:00Z');
    const landed = new Date('2026-09-01T12:05:00Z');
    const texts = source('texts');
    expect(texts.toEvents({ id: 'x', direction: 'outbound', status: 'delivered', created_at: sent, event_at: landed })[0])
      .toMatchObject({ kind: 'delivered', at: landed.toISOString() });
    expect(texts.toEvents({ id: 'x', direction: 'outbound', status: 'failed', created_at: sent, event_at: landed })[0])
      .toMatchObject({ kind: 'failed', at: landed.toISOString() });
    expect(texts.toEvents({ id: 'x', direction: 'outbound', status: 'sent', created_at: sent, event_at: sent })[0])
      .toMatchObject({ kind: 'sent', at: sent.toISOString() });
    expect(texts.toEvents({ id: 'x', direction: 'outbound', status: 'delivered', created_at: sent })[0].at).toBe(sent.toISOString());
  });

  test('each engaged source produces engaged events', () => {
    const t = new Date('2026-09-01T12:00:00Z');
    expect(source('texts').toEvents({ id: 'x', direction: 'inbound', status: 'received', message_body: 'hi', created_at: t })[0])
      .toMatchObject({ kind: 'replied', engaged: true, title: 'Replied by text' });
    expect(source('link clicks').toEvents({ id: 'l', clicked_at: t, kind: 'invoice', channel: 'sms' })[0])
      .toMatchObject({ kind: 'clicked', engaged: true, title: 'Clicked the invoice link' });
    expect(source('page views').toEvents({ id: 'p', page: 'portal:billing', viewed_at: t })[0])
      .toMatchObject({ channel: 'portal', kind: 'viewed', engaged: true, detail: 'billing' });
    expect(source('page views').toEvents({ id: 'p', page: 'appointment', viewed_at: t })[0])
      .toMatchObject({ channel: 'page', kind: 'viewed', engaged: true, title: 'Opened the appointment page' });
    // a push:open row is a verified first-party open: engaged, with the notification id in ref
    const nid = '0b6f3c1e-1f6a-4a52-9a7e-2f0f4f0f9a11';
    expect(source('page views').toEvents({ id: 'q', page: 'push:open', subject_type: 'ios', subject_id: `notification:${nid}`, viewed_at: t })[0])
      .toMatchObject({
        channel: 'push', kind: 'opened', engaged: true, title: 'Opened app from a notification', detail: 'ios',
        ref: { type: 'notification', id: nid },
      });
    // ...while an EMAIL open (same kind) is still never engaged
    expect(isEngagedKind('opened')).toBe(false);
  });

  test('a push:open row without a parseable notification subject falls back to the view row ref', () => {
    const ev = source('page views').toEvents({ id: 'q', page: 'push:open', subject_type: 'weird', subject_id: null, viewed_at: new Date('2026-09-01T12:00:00Z') })[0];
    expect(ev).toMatchObject({ title: 'Opened app from a notification', detail: null, engaged: true, ref: { type: 'customer_page_view', id: 'q' } });
    expect(ev.title).not.toMatch(/push:open/);
  });

  test('every non-engaged source still shows its events, and none of them is engaged', () => {
    const t = new Date('2026-09-01T12:00:00Z');
    const stamps = { sent_at: at(0), delivered_at: at(1), opened_at: at(2), clicked_at: at(3), bounced_at: at(4), complained_at: at(5), updated_at: at(6) };
    const cases = {
      emails: { id: 'e', status: 'failed', subject_snapshot: 'S', recipient_email_snapshot: 'a@example.test', queued_at: at(0), ...stamps },
      'automation emails': { id: 'a', status: 'bounced', step_order: 0, template_key: 'k', email: 'a@example.test', ...stamps },
      newsletters: { id: 'n', subject: 'S', email: 'a@example.test', ...stamps },
      'estimate views': { id: 'v', viewed_at: t, address: '1 Way' },
      'prep guide views': { id: 'v', viewed_at: t, scheduled_service_id: 'ss' },
      'service report views': { id: 'v', report_viewed_at: t },
      'inspection report views': { id: 'v', report_viewed_at: t },
      'contract views': { id: 'v', viewed_at: t },
      'price-change notice views': { id: 'v', first_viewed_at: t, view_count: 2 },
      calls: { id: 'c', created_at: t, direction: 'inbound' },
    };
    for (const [name, row] of Object.entries(cases)) {
      const events = source(name).toEvents(row);
      expect([name, events.length > 0]).toEqual([name, true]);
      expect([name, events.every((e) => e.engaged === false)]).toEqual([name, true]);
    }
    // outbound texts are never engaged either
    for (const status of ['sent', 'delivered', 'read', 'failed']) {
      expect(source('texts').toEvents({ id: 'x', direction: 'outbound', status, message_body: 'hi', created_at: t })[0].engaged).toBe(false);
    }
  });

  test('email rows: the open and the provider click are labelled and never engaged', () => {
    const events = source('emails').toEvents({
      id: 'e1', status: 'clicked', subject_snapshot: 'Your estimate', sent_at: at(0), delivered_at: at(1), opened_at: at(2), clicked_at: at(3),
    });
    const by = Object.fromEntries(events.map((e) => [e.kind, e]));
    expect(Object.keys(by).sort()).toEqual(['delivered', 'opened', 'provider_clicked', 'sent']);
    expect(by.opened.title).toMatch(/not reliable/i);
    expect(by.provider_clicked.title).toBe('Link clicked (reported by email provider — may be a scanner)');
    expect(events.every((e) => e.engaged === false && e.channel === 'email')).toBe(true);
  });

  test('raw token-page stamps are labelled "(unfiltered)"', () => {
    const t = new Date('2026-09-01T12:00:00Z');
    const titles = [
      source('estimate views').toEvents({ id: 'v', viewed_at: t })[0],
      source('prep guide views').toEvents({ id: 'v', viewed_at: t, scheduled_service_id: 's' })[0],
      source('service report views').toEvents({ id: 'v', report_viewed_at: t })[0],
      source('inspection report views').toEvents({ id: 'v', report_viewed_at: t })[0],
      source('contract views').toEvents({ id: 'v', viewed_at: t })[0],
      source('price-change notice views').toEvents({ id: 'v', first_viewed_at: t, view_count: 1 })[0],
    ];
    expect(titles.every((e) => e.kind === 'viewed_unfiltered' && /^Viewed .+ \(unfiltered\)$/.test(e.title))).toBe(true);
  });

  test('a provider click that a human short-link click already covers is not listed twice', () => {
    for (const [name, row] of [
      ['emails', { id: 'e', subject_snapshot: 's', sent_at: at(0), clicked_at: at(3) }],
      ['automation emails', { id: 'a', step_order: 0, template_key: 'k', sent_at: at(0), clicked_at: at(3) }],
      ['newsletters', { id: 'n', subject: 's', sent_at: at(0), clicked_at: at(3) }],
    ]) {
      const kinds = (r) => source(name).toEvents(r).map((e) => e.kind);
      expect([name, kinds(row)]).toEqual([name, ['sent', 'provider_clicked']]);
      expect([name, kinds({ ...row, clicked_collapsed: true })]).toEqual([name, ['sent']]);
      // the ranking time for that stamp is SQL that carries the same rule, so a collapsed click cannot rank the row
      const fn = source(name).ts.find((x) => typeof x === 'function');
      const { sql, bindings } = fn({ customerId: 'c1' });
      expect(sql).toMatch(/NOT EXISTS/);
      expect(sql).toMatch(/INTERVAL '2 minutes'/);
      expect(sql).toMatch(/scx\.is_bot = false/);
      expect(bindings).toEqual(['c1', 'c1']);
    }
  });

  test('every email event names the recipient the send row recorded, masked', () => {
    const own = { sent_at: at(0), opened_at: at(2) };
    const detail = (name, row) => source(name).toEvents({ ...own, ...row }).map((e) => e.detail);
    expect(detail('emails', { id: 'e', subject_snapshot: 'Your estimate', recipient_email_snapshot: 'Billing.Contact@Example.test' }))
      .toEqual(['Your estimate · to b***@example.test', 'Your estimate · to b***@example.test']);
    expect(detail('automation emails', { id: 'a', step_order: 1, template_name: 'Payment failed', email: '  AP.Desk@example.test ' })[0])
      .toBe('Payment failed (step 2) · to a***@example.test');
    expect(detail('newsletters', { id: 'n', subject: 'September', email: 'subscriber@example.test' })[0])
      .toBe('Newsletter: September · to s***@example.test');
    // no recorded address: no recipient text, never a guess
    expect(detail('emails', { id: 'e', subject_snapshot: 'Your estimate', recipient_email_snapshot: null })[0]).toBe('Your estimate');
    expect(detail('emails', { id: 'e', subject_snapshot: 'x', recipient_email_snapshot: 'not-an-address' })[0]).toBe('x');
    // the full address never appears
    const all = JSON.stringify(source('emails').toEvents({ ...own, id: 'e', recipient_email_snapshot: 'Billing.Contact@Example.test' }));
    expect(all).not.toMatch(/Billing\.Contact/i);
  });

  test('automation emails: bounced and complained statuses each produce their event, dated updated_at', () => {
    const map = (status) => source('automation emails').toEvents({
      id: 'a1', status, step_order: 0, template_key: 'k', email: 'a@example.test', sent_at: at(0), updated_at: at(7),
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
    const [failed] = source('emails').toEvents({ id: 'e2', status: 'failed', subject_snapshot: 'x', queued_at: at(0), updated_at: at(9) });
    expect(failed).toMatchObject({ kind: 'failed', at: at(9).toISOString() });
    expect(source('emails').ts.join(' ')).toMatch(/COALESCE\(em\.updated_at, em\.queued_at\)/);
    // Legacy row with no updated_at falls back to the queue time.
    expect(source('emails').toEvents({ id: 'e3', status: 'failed', queued_at: at(0) })[0].at).toBe(at(0).toISOString());
  });

  test('texts: outbound status maps to sent / delivered / read receipt / failed', () => {
    const t = new Date('2026-09-01T12:00:00Z');
    const map = (row) => source('texts').toEvents({ id: 'x', message_type: 'reminder', message_body: 'hi', created_at: t, ...row })[0];
    expect(map({ direction: 'outbound', status: 'delivered' })).toMatchObject({ kind: 'delivered', title: 'Text delivered (reminder)' });
    expect(map({ direction: 'outbound', status: 'read' })).toMatchObject({ kind: 'delivered', title: 'Text delivered (read receipt) (reminder)' });
    expect(map({ direction: 'outbound', status: 'READ', message_type: null })).toMatchObject({ kind: 'delivered', title: 'Text delivered (read receipt)' });
    expect(map({ direction: 'outbound', status: 'undelivered' })).toMatchObject({ kind: 'failed' });
    expect(map({ direction: 'outbound', status: 'queued' })).toMatchObject({ kind: 'sent' });
    expect(map({ direction: 'outbound', status: null })).toMatchObject({ kind: 'sent' });
  });

  test('texts: scheduled, sending and cancelled rows never left, so they produce no "sent" event', () => {
    const t = new Date('2026-09-01T12:00:00Z');
    for (const status of ['scheduled', 'sending', 'canceled', 'cancelled', 'draft', 'held', 'pending', 'skipped', 'blocked', 'suppressed']) {
      expect(source('texts').toEvents({ id: 'x', direction: 'outbound', status, message_body: 'hi', created_at: t })).toEqual([]);
    }
  });

  test('texts: a push-proof row is an app notification, never "Text sent"', () => {
    const t = new Date('2026-09-01T12:00:00Z');
    const map = (row) => source('texts').toEvents({ id: 'p', direction: 'outbound', status: 'sent', message_type: 'appointment_reminder', message_body: 'See you tomorrow', created_at: t, ...row })[0];
    const byPhone = map({ from_phone: 'push', metadata: { channel: 'push' } });
    expect(byPhone).toMatchObject({ channel: 'push', kind: 'delivered', engaged: false, title: 'App notification delivered (appointment reminder)' });
    // metadata alone (jsonb string or object) identifies it too
    expect(map({ from_phone: '+19415550100', metadata: JSON.stringify({ channel: 'push' }) })).toMatchObject({ channel: 'push', kind: 'delivered' });
    expect(map({ from_phone: '+19415550100', metadata: {} })).toMatchObject({ channel: 'sms', kind: 'sent', title: 'Text sent (appointment reminder)' });
    expect(map({ from_phone: '+19415550100', metadata: '{not json' })).toMatchObject({ channel: 'sms', kind: 'sent' });
  });

  test('the speculative sibling-PR sources are not in this PR', () => {
    expect(SOURCES.map((s) => s.name)).not.toContain('outside link clicks');
    expect(SOURCES.map((s) => s.name)).not.toContain('portal visits');
    const src = require('fs').readFileSync(require.resolve('../services/customer-activity-timeline'), 'utf8');
    expect(src).not.toMatch(/outbound_link|last_seen_at|to_regclass|pg_attribute/);
    // and no guessing which sends were the customer's own (round-2 billing-contact rule removed)
    expect(src).not.toMatch(/billing contact|emailNorm|normEmail|BOT_UA/i);
    expect(timeline).not.toHaveProperty('needsPresent');
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
    // the email MAX is newer than nothing engaged: it only feeds the informational fields
    expect(r.summary).toMatchObject({ lastEngagedAt: '2026-09-09T10:00:00.000Z', lastEngagedFrom: 'texts', lastEmailOpenAt: '2026-09-08T10:00:00.000Z', lastProviderClickAt: '2026-09-08T10:00:00.000Z' });
    expect(r.unavailableSources).toEqual(['newsletters']);
    const logged = mockWarn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/summary \(newsletters\) failed for customer c1/);
    expect(logged).not.toMatch(/max boom|example\.test/);
  });

  test('a source whose open MAX fails but whose provider-click MAX succeeds still contributes; it is reported unavailable', async () => {
    const dbh = fakeDb({
      failMaxExpr: { test: (table, sql) => table === 'email_messages as em' && /opened_at/.test(sql) },
      maxes: { 'email_messages as em': { 'em.clicked_at': new Date('2026-09-09T10:00:00Z') } },
    });
    const r = await getCustomerActivity('c1', {}, dbh);
    // a provider click is informational: it never becomes lastEngagedAt
    expect(r.summary).toMatchObject({ lastEngagedAt: null, lastEngagedFrom: null, lastEmailOpenAt: null, lastProviderClickAt: '2026-09-09T10:00:00.000Z' });
    expect(r.summary.lastEmailOpenNote).toMatch(/unreliable/i);
    expect(r.summary.lastProviderClickNote).toMatch(/unfiltered/i);
    expect(r.unavailableSources).toEqual(['emails']);
  });

  test('email opens and provider clicks never reach lastEngagedAt, however new', async () => {
    const newer = new Date('2026-09-20T10:00:00Z');
    const dbh = fakeDb({
      maxes: {
        'sms_log as sl': new Date('2026-09-01T10:00:00Z'),
        'email_messages as em': newer, 'automation_step_sends as s': newer, 'newsletter_send_deliveries as d': newer,
        'estimate_views as ev': newer, 'prep_guide_views as v': newer, 'service_records as sr': newer,
      },
    });
    const r = await getCustomerActivity('c1', {}, dbh);
    expect(r.summary).toMatchObject({ lastEngagedAt: '2026-09-01T10:00:00.000Z', lastEngagedFrom: 'texts', lastEmailOpenAt: newer.toISOString(), lastProviderClickAt: newer.toISOString() });
  });

  test('summary stays non-null while any one of its queries succeeds, null only when all reject', async () => {
    const onlyOne = fakeDb({ failMaxExpr: { test: (table, sql) => !(table === 'sms_log as sl' && /created_at/.test(sql)) } });
    expect((await getCustomerActivity('c1', {}, onlyOne)).summary).not.toBeNull();
  });

  test('summary is null only when every MAX query failed', async () => {
    const r = await getCustomerActivity('c1', {}, fakeDb({ failMax: 'all' }));
    expect(r.summary).toBeNull();
    expect(r.unavailableSources).toEqual(expect.arrayContaining(['texts', 'emails', 'newsletters']));
  });
});

test('every source is read-only: nothing but select/max builders are used', () => {
  const src = require('fs').readFileSync(require.resolve('../services/customer-activity-timeline'), 'utf8');
  expect(src).not.toMatch(/\.(insert|update|del|delete|truncate)\(|INSERT INTO|UPDATE |DELETE FROM/);
});

describe('texts source excludes unresolved send reservations', () => {
  test('the feed and summary MAX queries both carry the shared reservation exclusion on the sl alias', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'customer-activity-timeline.js'), 'utf8');
    expect(src).toMatch(/excludeUnresolvedSendReservations\(excludeRecruitingSmsLog\(dbh\('sms_log as sl'\)/);
    expect(src).toMatch(/'sl'\),\s*select: \['sl\.id'/);
    // a scheduled-send twin that is itself an unresolved placeholder must not hide its parent
    expect(src).toMatch(/excludeUnresolvedSendReservations\(q, 'twin'\)/);
  });
});
