// The needs-me reader (server/services/needs-me.js) and its route: legacy rows map to
// the eight parts with honest defaults, composed rows pass through, `who` filters the
// way docs/admin-notifications.md section 5 reads, and one failing source never loses
// the other.
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: jest.fn(), requireTechOrAdmin: jest.fn() }));
jest.mock('../services/dashboard-alerts', () => ({ computeDashboardAlerts: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  scopeAdminFeedToRole: jest.fn((q) => q),
}));

let mockRows;
let mockQueryError;
let mockPages = null;
const mockCalls = [];
jest.mock('../models/db', () => () => {
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
});

const NotificationService = require('../services/notification-service');
const { computeDashboardAlerts } = require('../services/dashboard-alerts');
const { listNeedsMe, mapAlertRow } = require('../services/needs-me');
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
])('a legacy %s row is filed under %s, for a person, needing you', (category, area) => {
  expect(mapAlertRow(row({ category }))).toMatchObject({ area, who: 'person', severity: 'needs-you', doneWhen: null, derived: true });
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
  mockRows = [row({ id: 'fyi-digest', category: 'ops_digest', metadata: { kind: 'FYI', audience: 'fyi', feed: 'activity' } }), row({ id: 'real' })];
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

test('who is exact: claude excludes either, either returns it; broken sorts first, then newest', async () => {
  mockRows = [
    row({ id: 'old-person', created_at: '2026-09-01T00:00:00Z' }),
    row({ id: 'new-person', created_at: '2026-09-29T00:00:00Z' }),
    row({ id: 'either', metadata: { area: 'Billing', severity: 'needs-you', who: 'either', doneWhen: 'invoice_sent' } }),
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
  const filler = (from) => Array.from({ length: 500 }, (_, i) => row({ id: `p${String(from + i).padStart(5, '0')}`, created_at: '2026-09-30T12:00:00Z' }));
  const oldFix = row({ id: 'q-old-fix', category: 'ops_digest', created_at: '2026-08-01T12:00:00Z', metadata: { kind: 'FIX', audience: 'engineering' } });
  mockPages = [filler(0), filler(500), [oldFix]];
  const out = await listNeedsMe({ who: 'claude' });
  expect(out.items.map((i) => i.id)).toEqual(['q-old-fix']);
  expect(out.total).toBe(1);
  expect(out.warnings).toEqual([]);
  // Pages continue strictly after the last id read.
  expect(mockCalls.filter((c) => c[0] === 'where' && c[1] === 'id').map((c) => c.slice(2))).toEqual([['>', 'p00499'], ['>', 'p00999']]);
});

test('a scan that reaches the runaway cap says so instead of answering short', async () => {
  let n = 0;
  mockPages = Array.from({ length: 41 }, () => Array.from({ length: 500 }, () => row({ id: `r${String(n++).padStart(6, '0')}` })));
  const out = await listNeedsMe({});
  expect(out.warnings).toEqual([{ source: 'notifications', error: 'truncated' }]);
});

test('the router guards by role as well as authentication', () => {
  const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
  const handles = router.stack.filter((layer) => !layer.route).map((layer) => layer.handle);
  expect(handles).toEqual(expect.arrayContaining([adminAuthenticate, requireTechOrAdmin]));
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

  test('refuses a who or area it does not know', async () => {
    expect((await call({ who: 'robot' })).status).toHaveBeenCalledWith(400);
    expect((await call({ area: 'Weather' })).status).toHaveBeenCalledWith(400);
  });
});

test('the bar tool trims item text and drops internals (members, dedupe keys, read state)', async () => {
  const { executeNeedsMeTool } = require('../services/intelligence-bar/needs-me-tools');
  mockRows = [row({ title: 'x'.repeat(200), body: 'y'.repeat(300), metadata: { dedupeKey: 'k' } })];
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
