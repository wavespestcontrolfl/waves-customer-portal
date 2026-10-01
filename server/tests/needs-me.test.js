// The needs-me reader (server/services/needs-me.js) and its route: legacy rows map to
// the eight parts with honest defaults, composed rows pass through, `who` filters the
// way docs/admin-notifications.md section 5 reads, and one failing source never loses
// the other.
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: jest.fn(), requireTechOrAdmin: jest.fn() }));
jest.mock('../services/dashboard-alerts', () => ({ computeDashboardAlerts: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  scopeAdminFeedToRole: jest.fn((q) => q),
  // agent-activity (whose legacy title reader needs-me reuses) reads this at load.
  _private: { NOTIFICATION_VERSION_SQL: jest.requireActual('../services/notification-service')._private.NOTIFICATION_VERSION_SQL },
}));

let mockRows;
let mockQueryError;
let mockPages = null;
const mockCalls = [];
jest.mock('../models/db', () => Object.assign(() => {
  const q = new Proxy({}, {
    get(_, name) {
      if (name === 'then') {
        // mockPages (when set) serves one page per query, for the keyset walk.
        const result = mockPages ? (mockPages.shift() || []) : mockRows;
        return (resolve, reject) => (mockQueryError ? Promise.reject(mockQueryError) : Promise.resolve(result)).then(resolve, reject);
      }
      return (...args) => { mockCalls.push([name, ...args]); return q; };
    },
  });
  return q;
}, { raw: (sql) => ({ raw: sql }) }));

const NotificationService = require('../services/notification-service');
const { computeDashboardAlerts } = require('../services/dashboard-alerts');
const { listNeedsMe, mapAlertRow, decodeCursor } = require('../services/needs-me');
const router = require('../routes/admin-needs-me');

const UUID = '0b1f6c1e-3c64-4f8e-9d7a-5a2f3e9b1c10';
const row = (over = {}) => ({
  id: 'n1', category: 'system', title: 'Something', body: 'Why it matters.', link: '/admin/agents',
  metadata: {}, created_at: '2026-09-30T12:00:00Z', read_at: null, ...over,
});

beforeEach(() => {
  mockRows = [];
  mockQueryError = null;
  mockPages = null;
  mockCalls.length = 0;
  computeDashboardAlerts.mockReset().mockResolvedValue({ alerts: [] });
  NotificationService.scopeAdminFeedToRole.mockClear();
});

test('a composed row keeps the parts its emitter stamped and is not derived', () => {
  const item = mapAlertRow(row({
    category: 'billing', title: 'Billing — send the invoice', link: `/admin/invoices?invoice=${UUID}`,
    metadata: { area: 'Billing', severity: 'needs-you', subject: { type: 'invoice', id: UUID }, doneWhen: 'invoice_sent', who: 'either', dedupeKey: 'k1' },
  }));
  expect(item).toMatchObject({
    kind: 'alert', area: 'Billing', severity: 'needs-you', who: 'either', doneWhen: 'invoice_sent', derived: false,
    subject: { type: 'invoice', id: UUID }, headline: 'Billing — send the invoice', why: 'Why it matters.',
    metadata: { dedupeKey: 'k1', triggerKey: null },
  });
});

test.each([
  ['inbound_sms', 'Comms'], ['voicemail_callback', 'Comms'], ['new_lead', 'Leads'], ['estimate_followup', 'Estimates'],
  ['payment', 'Billing'], ['dispute', 'Billing'], ['appointment', 'Schedule'], ['service', 'Schedule'],
  ['customer_retention', 'Customers'], ['visit_prep_photos', 'Customers'], ['inventory', 'Inventory'],
  ['newsletter', 'Content'], ['review', 'Content'], ['token_alert', 'System'], ['alert', 'System'], ['job_application', 'System'],
])('a raw legacy %s row is filed under %s, for a person, unsorted (no guessed severity)', (category, area) => {
  expect(mapAlertRow(row({ category }))).toMatchObject({ area, who: 'person', severity: null, unsorted: true, doneWhen: null, derived: true });
  // The same row from the trigger registry is known work.
  expect(mapAlertRow(row({ category, metadata: { triggerKey: 'sms_reply' } }))).toMatchObject({ area, severity: 'needs-you', unsorted: false });
});

test('a legacy row takes its subject from the ids its emitter wrote, the record first', () => {
  const lead = mapAlertRow(row({ category: 'new_lead', metadata: { triggerKey: 'new_lead', payload: { leadId: UUID, customerId: 'c-1' } } }));
  expect(lead.subject).toEqual({ type: 'lead', id: UUID });
  expect(lead.metadata.triggerKey).toBe('new_lead');
  expect(mapAlertRow(row({ metadata: { payload: { callLogId: 12 } } })).subject).toEqual({ type: 'call', id: '12' });
  expect(mapAlertRow(row({ metadata: { customer_id: 'c-9' } })).subject).toEqual({ type: 'customer', id: 'c-9' });
  expect(mapAlertRow(row({ metadata: {} })).subject).toBeNull();
});

test('a FIX digest is broken, and an engineering ops_digest row is Claude\'s to fix', () => {
  expect(mapAlertRow(row({ category: 'ops_digest', metadata: { kind: 'FIX', audience: 'engineering' } })))
    .toMatchObject({ severity: 'broken', who: 'claude', area: 'System', derived: true });
  expect(mapAlertRow(row({ category: 'ops_digest', metadata: { kind: 'ACT', audience: 'owner' } })))
    .toMatchObject({ severity: 'needs-you', who: 'person' });
});

test('an engineering digest that is Activity-only appears under who=claude, flagged, sorted with the broken rows', async () => {
  mockRows = [
    row({ id: 'person-new', created_at: '2026-09-30T20:00:00Z' }),
    row({ id: 'eng', category: 'ops_digest', created_at: '2026-08-01T00:00:00Z', metadata: { kind: 'FIX', audience: 'engineering', feed: 'activity', quiet: true } }),
  ];
  const claude = await listNeedsMe({ who: 'claude' });
  expect(claude.items).toHaveLength(1);
  expect(claude.items[0]).toMatchObject({ id: 'eng', severity: 'broken', who: 'claude', activityOnly: true });
  const all = await listNeedsMe();
  expect(all.items.map((i) => [i.id, i.activityOnly])).toEqual([['eng', true], ['person-new', false]]);
});

test('an fyi digest is severity fyi and absent under every who', async () => {
  mockRows = [row({ id: 'fyi-digest', category: 'ops_digest', metadata: { kind: 'FYI', audience: 'fyi', feed: 'activity' } }), row({ id: 'real', metadata: { triggerKey: 'sms_reply' } })];
  expect(mapAlertRow(mockRows[0]).severity).toBe('fyi');
  for (const who of [undefined, 'claude', 'person', 'either']) {
    expect((await listNeedsMe({ who })).items.map((i) => i.id)).not.toContain('fyi-digest');
  }
  const all = await listNeedsMe();
  expect(all.items.map((i) => i.id)).toEqual(['real']);
  expect(all.counts.bySeverity).toEqual({ 'needs-you': 1 });
});

test('a legacy ops_digest row without a stamped kind is classified by its title prefix, like the Activity feed', async () => {
  const legacy = (id, title) => row({ id, category: 'ops_digest', title, metadata: {} });
  expect(mapAlertRow(legacy('l-fix', 'FIX: sync is failing'))).toMatchObject({ severity: 'broken', who: 'person', derived: true });
  expect(mapAlertRow(legacy('l-act', 'ACT: approve the draft')).severity).toBe('needs-you');
  expect(mapAlertRow(legacy('l-review', '[Review] price match')).severity).toBe('needs-you');
  expect(mapAlertRow(legacy('l-fyi', 'FYI: weekly numbers')).severity).toBe('fyi');
  expect(mapAlertRow(legacy('l-ok', 'OK: all clear')).severity).toBe('fyi');
  mockRows = [legacy('l-fix', 'FIX: sync is failing'), legacy('l-fyi', 'FYI: weekly numbers'), legacy('l-ok', 'OK: all clear')];
  const out = await listNeedsMe();
  expect(out.items.map((i) => i.id)).toEqual(['l-fix']);
});

test('an ops_digest row with no body carries the bounded diagnosis in detail and a first-sentence why', () => {
  const diagnosis = `The nightly sync stalled on a bad token. Details follow.\n${'x'.repeat(3000)}`;
  const item = mapAlertRow(row({ id: 'd1', category: 'ops_digest', body: null, detail: diagnosis, link: null, metadata: { kind: 'FIX', audience: 'engineering', feed: 'activity' } }));
  expect(item.why).toBe('The nightly sync stalled on a bad token.');
  expect(item.detail.length).toBe(2000);
  expect(item.detail.endsWith('\u2026')).toBe(true);
  expect(item.link).toBe('/admin/agents?tab=activity&focus=d1');
  expect(mapAlertRow(row({ category: 'ops_digest', body: 'Own body.', detail: 'Long report.', metadata: {} }))).toMatchObject({ why: 'Own body.', detail: 'Long report.' });
  expect(mapAlertRow(row({ body: null, detail: null })).detail).toBeNull();
  expect(mapAlertRow(row({ id: 'd2', category: 'ops_digest', link: '/admin/communications', metadata: {} })))
    .toMatchObject({ link: '/admin/communications', reportLink: '/admin/agents?tab=activity&focus=d2' });
  expect(mapAlertRow(row({ id: 'd3', category: 'ops_digest', link: '/admin/agents?tab=activity', metadata: {} })).link).toBe('/admin/agents?tab=activity&focus=d3');
  // A non-digest row's link is untouched.
  expect(mapAlertRow(row({ id: 'p1', link: null })).link).toBeNull();
});

test('a failed dashboard generator is named in warnings while the rest still answers', async () => {
  computeDashboardAlerts.mockResolvedValue({
    alerts: [{ id: 'ar_overdue_60', severity: 'critical', count: 2, label: '2 invoices over 60 days', href: '/admin/invoices' }],
    failures: [{ id: 'payments_failed_today' }, { id: 'estimates_expiring' }],
  });
  const out = await listNeedsMe();
  expect(out.warnings).toEqual([
    { source: 'dashboard_alerts', generator: 'payments_failed_today', error: 'unavailable' },
    { source: 'dashboard_alerts', generator: 'estimates_expiring', error: 'unavailable' },
  ]);
  expect(out.items.map((i) => i.id)).toEqual(['live:ar_overdue_60']);
});

test('a standing condition is a needs-you count that clears at zero, filed by the page it opens', async () => {
  computeDashboardAlerts.mockResolvedValue({ alerts: [
    { id: 'ar_overdue_60', severity: 'critical', count: 4, label: '4 invoices over 60 days', href: '/admin/invoices?tab=overdue' },
    { id: 'x_unknown', severity: 'warn', count: 1, label: 'Something else', href: '/admin/pricing-logic', members: ['a'] },
  ] });
  const { items } = await listNeedsMe();
  expect(items.find((i) => i.id === 'live:ar_overdue_60')).toMatchObject({
    kind: 'standing', area: 'Billing', headline: '4 invoices over 60 days', why: null, severity: 'needs-you',
    count: 4, link: '/admin/invoices?tab=overdue', who: 'person', doneWhen: 'count_zero', derived: false,
  });
  expect(items.find((i) => i.id === 'live:x_unknown')).toMatchObject({ area: 'System', members: ['a'] });
});

test('a row whose invalid subject raiseAdminAlert dropped keeps its other fields but stays derived', () => {
  const item = mapAlertRow(row({ metadata: { area: 'Billing', severity: 'needs-you', who: 'either', doneWhen: 'invoice_sent' } }));
  expect(item.derived).toBe(true);
  // Each valid part stands on its own: only the subject was inferred.
  expect(item).toMatchObject({ area: 'Billing', severity: 'needs-you', who: 'either', doneWhen: 'invoice_sent' });
  const claudeOnly = mapAlertRow(row({ metadata: { who: 'claude' } }));
  expect(claudeOnly).toMatchObject({ who: 'claude', derived: true });
  const badType = mapAlertRow(row({ metadata: { area: 'Billing', severity: 'needs-you', who: 'either', doneWhen: 'invoice_sent', subject: { type: 'planet', id: 'x' } } }));
  expect(badType.derived).toBe(true);
});

test('who is exact: claude excludes either, either returns it; broken sorts first, then newest', async () => {
  mockRows = [
    row({ id: 'old-person', created_at: '2026-09-01T00:00:00Z', metadata: { triggerKey: 'sms_reply' } }),
    row({ id: 'new-person', created_at: '2026-09-29T00:00:00Z', metadata: { triggerKey: 'sms_reply' } }),
    row({ id: 'either', metadata: { area: 'Billing', severity: 'needs-you', who: 'either', doneWhen: 'invoice_sent', subject: { type: 'invoice', id: UUID } } }),
    row({ id: 'fix', category: 'ops_digest', created_at: '2026-08-01T00:00:00Z', metadata: { kind: 'FIX', audience: 'engineering' } }),
  ];
  expect((await listNeedsMe({ who: 'claude' })).items.map((i) => i.id)).toEqual(['fix']);
  expect((await listNeedsMe({ who: 'either' })).items.map((i) => i.id)).toEqual(['either']);
  expect((await listNeedsMe({ who: 'person' })).items.map((i) => i.id)).toEqual(['new-person', 'old-person']);
  const all = await listNeedsMe();
  expect(all.items.map((i) => i.id)).toEqual(['fix', 'either', 'new-person', 'old-person']);
  expect(all.counts).toEqual({
    byArea: { System: 3, Billing: 1 }, byWho: { claude: 1, either: 1, person: 2 }, bySeverity: { broken: 1, 'needs-you': 3 },
  });
  expect((await listNeedsMe({ area: 'Billing' })).items.map((i) => i.id)).toEqual(['either']);
  const capped = await listNeedsMe({ limit: 2 });
  expect(capped).toMatchObject({ total: 4 });
  expect(capped.items).toHaveLength(2);
});

test('the open-rows query excludes done rows and the cron\'s dashboard_alert echoes, never filters Activity-only rows, and is scoped to the role', async () => {
  await listNeedsMe({ role: 'technician' });
  expect(mockCalls).toEqual(expect.arrayContaining([['whereNull', 'done_at']]));
  expect(mockCalls.find(([name, sql]) => name === 'whereRaw' && /triggerKey.*dashboard_alert/.test(sql))).toBeTruthy();
  expect(mockCalls.some(([name, sql]) => name === 'whereRaw' && /feed/.test(sql))).toBe(false);
  expect(NotificationService.scopeAdminFeedToRole.mock.calls.map((c) => c[1])).toEqual(['technician']);
  // Standing conditions carry owner-only finance totals: not for a technician.
  expect(computeDashboardAlerts).not.toHaveBeenCalled();
});

test('a failing source is reported and the other source still answers', async () => {
  mockQueryError = new Error('relation does not exist');
  computeDashboardAlerts.mockResolvedValue({ alerts: [{ id: 'a', severity: 'warn', count: 2, label: 'Two things', href: '/admin/leads' }] });
  const down = await listNeedsMe();
  expect(down.warnings).toEqual([{ source: 'notifications', error: 'unavailable' }]);
  expect(down.items.map((i) => i.id)).toEqual(['live:a']);

  mockQueryError = null;
  mockRows = [row()];
  computeDashboardAlerts.mockRejectedValue(new Error('boom'));
  const partial = await listNeedsMe();
  expect(partial.warnings).toEqual([{ source: 'dashboard_alerts', error: 'unavailable' }]);
  expect(partial.items.map((i) => i.id)).toEqual(['n1']);
});

test('an older open FIX behind more than a page of newer rows is still listed and counted', async () => {
  const filler = (from) => Array.from({ length: 500 }, (_, i) => row({ id: `p${String(from + i).padStart(5, '0')}`, created_at: '2026-09-30T12:00:00Z', created_at_cursor: `2026-09-30 12:00:00.${String(999999 - from - i).padStart(6, '0')}+00` }));
  const oldFix = row({ id: 'q-old-fix', category: 'ops_digest', created_at: '2026-08-01T12:00:00Z', metadata: { kind: 'FIX', audience: 'engineering' } });
  mockPages = [filler(0), filler(500), [oldFix]];
  const out = await listNeedsMe({ who: 'claude' });
  expect(out.items.map((i) => i.id)).toEqual(['q-old-fix']);
  expect(out.total).toBe(1);
  expect(out.warnings).toEqual([]);
  // Newest first on the indexed (created_at, id) keyset; each page continues
  // strictly before the last row read, at its exact (microsecond) created_at.
  expect(mockCalls).toEqual(expect.arrayContaining([['orderByRaw', 'created_at DESC, id DESC']]));
  expect(mockCalls.filter((c) => c[0] === 'whereRaw' && /^\(created_at, id\) </.test(c[1])).map((c) => c[2]))
    .toEqual([['2026-09-30 12:00:00.999500+00', 'p00499'], ['2026-09-30 12:00:00.999000+00', 'p00999']]);
});

test('a scan that reaches the cap says so, and its cursor continues the scan past the cap', async () => {
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const at = (n) => `2026-09-30 12:00:00.${String(999999 - n).padStart(6, '0')}+00`;
  const work = (n) => row({ id: uuid(n), created_at: '2026-09-30T12:00:00Z', created_at_cursor: at(n), metadata: { triggerKey: 'sms_reply' } });
  const windowPages = () => { let n = 0; return Array.from({ length: 41 }, () => Array.from({ length: 500 }, () => work(n++))); };
  computeDashboardAlerts.mockResolvedValue({ alerts: [{ id: 'q', severity: 'warn', count: 1, label: 'Queue', href: '/admin/leads' }] });

  mockPages = windowPages();
  const first = await listNeedsMe({ limit: 5 });
  expect(first.warnings).toEqual([{ source: 'notifications', error: 'truncated' }]);
  expect(first.items[0].id).toBe('live:q');
  expect(decodeCursor(first.next)).toMatchObject({ s: null });

  // The window's last item (same time, lowest id) leaves nothing in the window:
  // next now starts a new window where the scan stopped (row 19999).
  mockPages = windowPages();
  const lastKey = [1, new Date('2026-09-30T12:00:00Z').getTime(), uuid(0)];
  const end = await listNeedsMe({ limit: 5, after: { k: lastKey, s: null } });
  expect(end.items).toEqual([]);
  const resume = decodeCursor(end.next);
  expect(resume).toEqual({ k: null, s: { at: at(19999), id: uuid(19999) } });

  // The continued window scans from there, holds the rows past the cap, and no standing item repeats.
  mockPages = [[work(20000), work(20001)]];
  mockCalls.length = 0;
  const past = await listNeedsMe({ limit: 5, after: resume });
  expect(mockCalls.find(([name, sql]) => name === 'whereRaw' && /^\(created_at, id\) </.test(sql))[2]).toEqual([at(19999), uuid(19999)]);
  expect(past.items.map((i) => i.id)).toEqual([uuid(20001), uuid(20000)]);
  expect(past.warnings).toEqual([]);
  expect(past.next).toBeNull();
});

test('a cursor that is not one we issued is refused', () => {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  expect(decodeCursor(enc([1, 2, 'x']))).toBeNull();
  expect(decodeCursor(enc({ k: null, s: null }))).toBeNull();
  expect(decodeCursor(enc({ k: null, s: { at: 'nope', id: 'x' } }))).toBeNull();
  expect(decodeCursor(enc({ k: [1, 2, 'x'], s: null }))).toEqual({ k: [1, 2, 'x'], s: null });
});

test('the router guards by role as well as authentication', () => {
  const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
  const handles = router.stack.filter((layer) => !layer.route).map((layer) => layer.handle);
  expect(handles).toEqual(expect.arrayContaining([adminAuthenticate, requireTechOrAdmin]));
});

test('an ops digest with no stamped area takes its work page\'s area from its link; an unknown link stays System', () => {
  const digest = (link) => mapAlertRow(row({ category: 'ops_digest', link, metadata: { kind: 'ACT', audience: 'owner' } }));
  expect(digest('/admin/estimates?tab=promised').area).toBe('Estimates');
  expect(digest('/admin/communications').area).toBe('Comms');
  expect(digest('/admin/agents?tab=activity').area).toBe('System');
  // The live promised-estimate watcher links the pipeline page; its tab tells Leads from Estimates.
  expect(digest('/admin/pipeline').area).toBe('Estimates');
  expect(digest('/admin/pipeline?tab=estimates').area).toBe('Estimates');
  expect(digest('/admin/pipeline?tab=leads').area).toBe('Leads');
  expect(digest('/admin/pipeline?foo=1&tab=leads').area).toBe('Leads');
  expect(digest('/admin/pipelines').area).toBe('System');
});

test('a cursor pages past the response cap: every open item exactly once, in one stable order', async () => {
  mockRows = Array.from({ length: 23 }, (_, i) => row({ id: `n${String(i).padStart(2, '0')}`, created_at: `2026-09-${String(10 + (i % 5)).padStart(2, '0')}T00:00:00Z`, metadata: i % 4 === 0 ? {} : { triggerKey: 'sms_reply' } }));
  const seen = [];
  let after = null;
  for (let pages = 0; pages < 10; pages += 1) {
    const out = await listNeedsMe({ limit: 5, after });
    // Every fourth row is raw (unsorted): paged too, after the work, counted apart.
    expect(out.total + out.unsortedTotal).toBe(23);
    seen.push(...out.items.map((i) => i.id));
    if (!out.next) break;
    after = decodeCursor(out.next);
    expect(after).not.toBeNull();
  }
  expect(seen).toHaveLength(23);
  expect(new Set(seen).size).toBe(23);
  const firstUnsorted = seen.findIndex((id) => Number(id.slice(1)) % 4 === 0);
  expect(seen.slice(firstUnsorted).every((id) => Number(id.slice(1)) % 4 === 0)).toBe(true);
  expect(decodeCursor('not-a-cursor')).toBeNull();
});

describe('GET /api/admin/needs-me', () => {
  const handler = router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.get).route.stack[0].handle;
  const call = async (query, techRole = 'admin') => {
    const res = { set: jest.fn(), status: jest.fn(() => res), json: jest.fn() };
    await handler({ query, techRole }, res, (err) => { throw err; });
    return res;
  };

  test('returns the reader\'s object, filtered by the query and scoped to the caller\'s role', async () => {
    mockRows = [row({ id: 'fix', category: 'ops_digest', metadata: { kind: 'FIX', audience: 'engineering' } }), row()];
    const res = await call({ who: 'claude', area: 'System', limit: '5' }, 'technician');
    const body = res.json.mock.calls[0][0];
    expect(body.items.map((i) => i.id)).toEqual(['fix']);
    expect(body).toEqual(expect.objectContaining({ generatedAt: expect.any(String), total: 1, warnings: [] }));
    expect(NotificationService.scopeAdminFeedToRole.mock.calls.map((c) => c[1])).toEqual(['technician']);
  });

  test('a malformed after cursor is a 400', async () => {
    expect((await call({ after: 'garbage' })).status).toHaveBeenCalledWith(400);
  });

  test('refuses a who or area it does not know', async () => {
    expect((await call({ who: 'robot' })).status).toHaveBeenCalledWith(400);
    expect((await call({ area: 'Weather' })).status).toHaveBeenCalledWith(400);
  });
});

test('the bar tool trims item text and drops internals (members, dedupe keys, read state)', async () => {
  const { executeNeedsMeTool } = require('../services/intelligence-bar/needs-me-tools');
  mockRows = [row({ title: 'x'.repeat(200), body: 'y'.repeat(300), metadata: { dedupeKey: 'k', triggerKey: 'sms_reply' } })];
  computeDashboardAlerts.mockResolvedValue({ alerts: [{ id: 'a', severity: 'warn', count: 3, label: 'Three things', href: '/admin/leads', members: ['m1'] }] });
  const out = await executeNeedsMeTool('needs_me', { limit: 5 });
  expect(out).toMatchObject({ total_open: 2, returned: 2, warnings: [] });
  const alert = out.items.find((i) => i.kind === 'alert');
  expect(alert.headline.length).toBeLessThanOrEqual(80);
  expect(alert.why.length).toBeLessThanOrEqual(140);
  const standing = out.items.find((i) => i.kind === 'standing');
  expect(standing).toMatchObject({ count: 3, done_when: 'count_zero' });
  for (const item of out.items) expect(Object.keys(item)).not.toEqual(expect.arrayContaining(['members', 'metadata', 'readAt']));
});

test('the bar tool carries a digest\'s bounded detail and report link', async () => {
  const { executeNeedsMeTool } = require('../services/intelligence-bar/needs-me-tools');
  mockRows = [row({ id: 'd9', category: 'ops_digest', body: null, detail: `Diagnosis here. ${'Zed '.repeat(2000)}`, link: '/admin/communications', metadata: { kind: 'FIX', audience: 'engineering', feed: 'activity' } })];
  const out = await executeNeedsMeTool('needs_me', { who: 'claude' });
  expect(out.items[0]).toMatchObject({ why: 'Diagnosis here.', report_link: '/admin/agents?tab=activity&focus=d9' });
  expect(out.items[0].detail.length).toBeLessThanOrEqual(600);
  expect((await executeNeedsMeTool('needs_me', { who: 'either' })).items).toHaveLength(0);
});

test('a registry event the registry marks informational is fyi and left out; an actionable one stays', async () => {
  expect(mapAlertRow(row({ category: 'payment', metadata: { triggerKey: 'payment_succeeded' } })).severity).toBe('fyi');
  expect(mapAlertRow(row({ category: 'payment', metadata: { triggerKey: 'one_tap_purchase_completed' } })).severity).toBe('fyi');
  expect(mapAlertRow(row({ category: 'payment', metadata: { triggerKey: 'payment_failed' } })).severity).toBe('needs-you');
  // A composed row's own severity wins over the registry.
  expect(mapAlertRow(row({ metadata: { triggerKey: 'payment_succeeded', severity: 'needs-you' } })).severity).toBe('needs-you');
  mockRows = [row({ id: 'p1', metadata: { triggerKey: 'payment_succeeded' } }), row({ id: 'p2', metadata: { triggerKey: 'payment_failed' } })];
  const result = await listNeedsMe({});
  expect(result.items.map((i) => i.id)).toEqual(['p2']);
});

test('content work pages are Content', () => {
  const digest = (link) => mapAlertRow(row({ category: 'ops_digest', link, metadata: { kind: 'ACT', audience: 'owner' } }));
  for (const link of ['/admin/reviews', '/admin/blog?tab=parked', '/admin/seo', '/admin/knowledge', '/admin/social-media']) {
    expect(digest(link).area).toBe('Content');
  }
  expect(digest('/admin/blogger').area).toBe('System');
});

test('a pre-brevity digest whose report lives in body keeps it as detail; why is its first sentence', () => {
  const report = `Twelve estimates are past their promised time. ${'Line of the report. '.repeat(30)}`;
  const item = mapAlertRow(row({ category: 'ops_digest', body: report, detail: null, metadata: { kind: 'ACT', audience: 'owner' } }));
  expect(item.detail).toBe(report.trim());
  expect(item.why).toBe('Twelve estimates are past their promised time.');
  // A current digest keeps body as why and detail as detail.
  const current = mapAlertRow(row({ category: 'ops_digest', body: 'Short why.', detail: 'Full finding.', metadata: { kind: 'ACT' } }));
  expect(current).toMatchObject({ why: 'Short why.', detail: 'Full finding.' });
});

test('a standing condition carries its dollar exposure', async () => {
  computeDashboardAlerts.mockResolvedValue({ alerts: [
    { id: 'overdue_60', severity: 'critical', count: 3, label: '3 invoices 60+ days overdue', href: '/admin/invoices', amount: 1250.5 },
    { id: 'unassigned', severity: 'warn', count: 2, label: '2 visits unassigned', href: '/admin/schedule' },
  ] });
  const { items } = await listNeedsMe({});
  expect(items.find((i) => i.id === 'live:overdue_60').amount).toBe(1250.5);
  expect(items.find((i) => i.id === 'live:unassigned').amount).toBeNull();
});

test('an unstamped registry alert takes its area from its work link; category is the fallback', () => {
  expect(mapAlertRow(row({ category: 'system', link: '/admin/estimates?estimateId=e1', metadata: { triggerKey: 'estimate_deposit_reconcile_needed' } })).area).toBe('Estimates');
  expect(mapAlertRow(row({ category: 'system', link: '/admin/dispatch?visit=v1', metadata: { triggerKey: 'service_report_delivery_failed' } })).area).toBe('Schedule');
  expect(mapAlertRow(row({ category: 'payment', link: '/admin/unknown', metadata: {} })).area).toBe('Billing');
  // A skipped newsletter run asks for approvals: work, not a fact.
  expect(mapAlertRow(row({ category: 'newsletter', metadata: { triggerKey: 'newsletter_autopilot_skipped' } })).severity).toBe('needs-you');
});

test('a standing condition names its dashboard check as its subject', async () => {
  computeDashboardAlerts.mockResolvedValue({ alerts: [{ id: 'overdue_60', severity: 'critical', count: 1, label: '1 invoice 60+ days overdue', href: '/admin/invoices' }] });
  const { items } = await listNeedsMe({});
  expect(items[0].subject).toEqual({ type: 'check', id: 'overdue_60' });
});

test('the bar tool refuses an unknown who or area instead of answering "nothing open"', async () => {
  const { executeNeedsMeTool } = require('../services/intelligence-bar/needs-me-tools');
  expect((await executeNeedsMeTool('needs_me', { who: 'Claude' })).error).toMatch(/who must be one of/);
  expect((await executeNeedsMeTool('needs_me', { area: 'billing' })).error).toMatch(/area must be one of/);
  expect((await executeNeedsMeTool('needs_me', { area: 'Billing' })).error).toBeUndefined();
});

test('a raw alert with no label is unsorted: listed after the work, no guessed severity, out of the totals', async () => {
  // inspection-credit's "no action needed unless it repeats" note: raw notifyAdmin, metadata.reason only.
  const raw = row({ id: 'raw1', category: 'system', title: 'Inspection credit recovery queued', metadata: { reason: 'stripe_timeout' }, created_at: '2026-09-30T13:00:00Z' });
  const work = row({ id: 'w1', category: 'payment', metadata: { triggerKey: 'payment_failed' }, created_at: '2026-09-29T12:00:00Z' });
  const composed = row({ id: 'c1', metadata: { area: 'Billing', severity: 'needs-you', who: 'person', doneWhen: 'x', subject: { type: 'invoice', id: 'i1' } }, created_at: '2026-09-28T12:00:00Z' });
  expect(mapAlertRow(raw)).toMatchObject({ unsorted: true, severity: null });
  expect(mapAlertRow(work).unsorted).toBe(false);
  expect(mapAlertRow(composed).unsorted).toBe(false);
  mockRows = [raw, work, composed];
  const out = await listNeedsMe({});
  expect(out.items.map((i) => i.id)).toEqual(['w1', 'c1', 'raw1']);
  expect(out.total).toBe(2);
  expect(out.unsortedTotal).toBe(1);
  expect(out.counts.bySeverity).toEqual({ 'needs-you': 2 });
  // A composed row that only lacks a part is still sorted work.
  expect(mapAlertRow(row({ metadata: { severity: 'broken' } })).unsorted).toBe(false);

  const { executeNeedsMeTool } = require('../services/intelligence-bar/needs-me-tools');
  const bar = await executeNeedsMeTool('needs_me', {});
  expect(bar.items.map((i) => i.id)).toEqual(['w1', 'c1']);
  expect(bar.unsorted.map((i) => i.id)).toEqual(['raw1']);
  expect(bar).toMatchObject({ total_open: 2, unsorted_total: 1 });
});
