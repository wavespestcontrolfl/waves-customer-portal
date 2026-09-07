jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((sql) => ({ sql, rows: [] }));
  mockDb.schema = { hasTable: jest.fn().mockResolvedValue(false) };
  return mockDb;
});
jest.mock('../services/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));
jest.mock('../services/mrr-breakdown', () => ({ listAtRiskMrrAccounts: jest.fn() }));
jest.mock('../services/closeout-alerts', () => {
  const actual = jest.requireActual('../services/closeout-alerts');
  return { ...actual, loadCloseoutStatuses: jest.fn(async () => new Map()) };
});
jest.mock('../services/annual-prepay-renewals', () => ({
  getCardExpiryExemptions: jest.fn(async () => ({ customerIds: new Set(), chargeMethodIdsByCustomer: new Map() })),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { listAtRiskMrrAccounts } = require('../services/mrr-breakdown');
const { getCardExpiryExemptions } = require('../services/annual-prepay-renewals');
const exemptions = (customerIds = [], charged = []) => ({ customerIds: new Set(customerIds), chargeMethodIdsByCustomer: new Map(charged) });
const {
  computeDashboardAlerts,
  computeDashboardAlertsUncached,
} = require('../services/dashboard-alerts');

// Fake Knex: db(table) returns a fresh chainable builder that resolves to the
// primed result for that table. Every chain method records into `capture`
// (as {table, method, args}) so tests can assert query shape. Grouped
// where(function(){...}) callbacks run against the same builder. A result may
// be a function of the builder's own recorded calls — that's how the two
// different db('leads') generators (waiting vs unattributed) get distinct rows.
const CHAIN_METHODS = [
  'where', 'whereNull', 'whereNotNull', 'whereRaw', 'whereIn', 'whereNotIn',
  'orWhereRaw', 'orWhereNull', 'orWhere', 'orWhereNot', 'orWhereIn', 'leftJoin', 'join', 'select', 'count',
  'countDistinct', 'orderBy', 'modify', 'limit',
];

function primeDb(results) {
  const capture = [];
  db.mockImplementation((table) => {
    const t = String(table);
    const calls = [];
    const b = {};
    for (const m of CHAIN_METHODS) {
      b[m] = function chainMethod(...args) {
        calls.push({ table: t, method: m, args });
        capture.push({ table: t, method: m, args });
        // knex hands the builder to grouped where() and modify() callbacks
        // as both `this` and the first argument.
        if (typeof args[0] === 'function') args[0].call(b, b);
        return b;
      };
    }
    const resolve = async () => {
      const r = results[t];
      return typeof r === 'function' ? r(calls) : r;
    };
    b.first = (...args) => {
      calls.push({ table: t, method: 'first', args });
      return resolve();
    };
    b.then = (res, rej) => resolve().then(res, rej);
    return b;
  });
  return capture;
}

// Distinguish the db('leads') generators by their unique chain calls.
// (All apply the internal-lead whereNotIn, so key on each generator's own
// signature: unattributed filters whereNull('lead_source_id'), the builder
// warranty queue filters whereNotNull('builder_warranty_expires_on').)
const leadsResult = ({ waiting, unattributed, builderWarranty }) => (calls) => {
  if (calls.some((c) => c.method === 'whereNull' && c.args[0] === 'lead_source_id')) return unattributed;
  if (calls.some((c) => c.method === 'whereNotNull' && c.args[0] === 'leads.builder_warranty_expires_on')) {
    return builderWarranty;
  }
  return waiting;
};

// listAtRiskMrrAccounts-shaped account rows for the at_risk_mrr generator.
const atRiskAccount = (id, monthlyRate, causes = ['overdue']) => ({
  id, firstName: 'A', lastName: String(id), monthlyRate, causes,
});

beforeEach(() => {
  jest.clearAllMocks();
  db.raw.mockImplementation((sql) => ({ sql, rows: [] }));
  db.schema.hasTable.mockResolvedValue(false);
  listAtRiskMrrAccounts.mockResolvedValue([]);
  getCardExpiryExemptions.mockResolvedValue(exemptions());
  primeDb({});
});

describe('Action Inbox generators', () => {
  test('leads_awaiting_contact: critical action, floored at the fresh-start baseline', async () => {
    const capture = primeDb({
      leads: leadsResult({
        waiting: [{ id: 'lead-a' }, { id: 'lead-b' }, { id: 'lead-c' }],
        unattributed: { count: 0 },
      }),
    });
    const { alerts } = await computeDashboardAlertsUncached();

    const item = alerts.find((a) => a.id === 'leads_awaiting_contact');
    expect(item).toMatchObject({
      kind: 'action',
      severity: 'critical',
      count: 3,
      href: '/admin/leads',
    });
    expect(item.label).toContain('waiting over 30m');
    expect(item.members).toEqual(['lead-a', 'lead-b', 'lead-c']); // membership rides along

    // The Speed-to-Lead fresh-start floor must be applied (env unset →
    // default 2026-07-01 baseline), so the pre-reset backlog can't nag.
    const floor = capture.find(
      (c) => c.table === 'leads' && c.method === 'where'
        && c.args[0] === 'first_contact_at' && c.args[1] === '>=',
    );
    expect(floor).toBeDefined();
    expect(floor.args[2]).toBeInstanceOf(Date);

    // Internal/test leads must not page an operator as critical — the waiting
    // query applies the same name exclusion as the dashboard lead panels.
    const { INTERNAL_TEST_CUSTOMERS } = require('../services/internal-test-customers');
    const excluded = capture.find(
      (c) => c.table === 'leads' && c.method === 'whereNotIn'
        && c.args[1] === INTERNAL_TEST_CUSTOMERS,
    );
    expect(excluded).toBeDefined();

    // Soft-deleted leads are invisible on every Leads surface — an item the
    // operator can't find must not page as critical.
    const notDeleted = capture.find(
      (c) => c.table === 'leads' && c.method === 'whereNull' && c.args[0] === 'deleted_at',
    );
    expect(notDeleted).toBeDefined();
  });

  test('leads_awaiting_contact: members are sorted (order-independent) so dismissal subset checks are stable', async () => {
    const alertFor = async (waiting) => {
      primeDb({ leads: leadsResult({ waiting, unattributed: { count: 0 } }) });
      const { alerts } = await computeDashboardAlertsUncached();
      return alerts.find((a) => a.id === 'leads_awaiting_contact');
    };

    const ab = await alertFor([{ id: 'lead-a' }, { id: 'lead-b' }]);
    const ba = await alertFor([{ id: 'lead-b' }, { id: 'lead-a' }]);
    const ac = await alertFor([{ id: 'lead-a' }, { id: 'lead-c' }]);

    // Same membership, any query order → identical members list.
    expect(ba.members).toEqual(ab.members);
    // Same COUNT but a different lead in the queue → different membership, so
    // a dismissal recorded against {a,b} re-surfaces when the queue is {a,c}.
    expect(ac.count).toBe(ab.count);
    expect(ac.members).toEqual(['lead-a', 'lead-c']);
    expect(ac.members).not.toEqual(ab.members);
  });

  test('estimates_expiring: warn action carrying the annualized at-stake amount, internal-test rows excluded', async () => {
    const { INTERNAL_TEST_CUSTOMERS } = require('../services/internal-test-customers');
    const capture = primeDb({
      'estimates as e': [
        { id: 'est-2', at_stake: '2000.50' },
        { id: 'est-1', at_stake: '1120.00' },
      ],
    });
    const { alerts } = await computeDashboardAlertsUncached();

    expect(alerts.find((a) => a.id === 'estimates_expiring')).toMatchObject({
      kind: 'action',
      severity: 'warn',
      count: 2,
      amount: 3120.5,
      members: ['est-1', 'est-2'], // sorted membership for dismissal checks
      href: '/admin/estimates',
    });

    // Same population as /sales-capture: both the estimate-name and the
    // joined-customer-name internal-test exclusions applied.
    const exclusions = capture.filter(
      (c) => c.table === 'estimates as e' && c.method === 'whereNotIn'
        && c.args[1] === INTERNAL_TEST_CUSTOMERS,
    );
    expect(exclusions).toHaveLength(2);

    // Undelivered plan_restart quotes never become a "call before it
    // expires" prompt (C4 zero-follow-up contract, codex #3671 r28 P1):
    // source-NULL legacy rows and operator-delivered restart quotes stay.
    const est = capture.filter((c) => c.table === 'estimates as e');
    expect(est.some((c) => c.method === 'whereNull' && c.args[0] === 'e.source')).toBe(true);
    expect(est.some((c) => c.method === 'orWhereNot' && c.args[0] === 'e.source' && c.args[1] === 'plan_restart')).toBe(true);
    expect(est.some((c) => c.method === 'orWhereRaw'
      && String(c.args[0]).includes("e.estimate_data #>> '{deliveryState,firstDeliveredAt}'") && String(c.args[0]).includes('IS NOT NULL'))).toBe(true);
  });

  test('builder_warranty_expiring: warn action on open leads inside the ET window; absent when empty', async () => {
    const { INTERNAL_TEST_CUSTOMERS } = require('../services/internal-test-customers');
    const capture = primeDb({
      leads: leadsResult({
        waiting: [],
        unattributed: { count: 0 },
        builderWarranty: [{ id: 'lead-bw-2' }, { id: 'lead-bw-1' }],
      }),
    });
    const { alerts } = await computeDashboardAlertsUncached();

    const item = alerts.find((a) => a.id === 'builder_warranty_expiring');
    expect(item).toMatchObject({
      kind: 'action',
      severity: 'warn',
      count: 2,
      members: ['lead-bw-1', 'lead-bw-2'], // sorted membership for dismissal checks
      href: '/admin/leads?builder_warranty=expiring',
    });
    expect(item.label).toContain('builder termite warranty');

    // Window bounds must be ET date STRINGS compared against the DATE column —
    // a Date object (or UTC ISO slice) here would shift the boundary day for
    // 4-5 hours around midnight ET.
    const bounds = capture.filter(
      (c) => c.table === 'leads' && c.method === 'where'
        && c.args[0] === 'leads.builder_warranty_expires_on',
    );
    expect(bounds).toHaveLength(2);
    for (const bound of bounds) expect(bound.args[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // POSITIVE open-status membership (codex P2): a whereNotIn built from a
    // closed-status list silently re-includes any status it forgot
    // (unresponsive/disqualified were nagging as action items).
    const { OPEN_LEAD_STATUSES } = require('../services/lead-statuses');
    const statusMembership = capture.find(
      (c) => c.table === 'leads' && c.method === 'whereIn' && c.args[0] === 'leads.status',
    );
    expect(statusMembership).toBeDefined();
    expect(statusMembership.args[1]).toEqual(OPEN_LEAD_STATUSES);

    // Internal-test and soft-deleted leads never page the operator.
    expect(capture.find(
      (c) => c.table === 'leads' && c.method === 'whereNotIn'
        && c.args[1] === INTERNAL_TEST_CUSTOMERS,
    )).toBeDefined();
    expect(capture.find(
      (c) => c.table === 'leads' && c.method === 'whereNull' && c.args[0] === 'leads.deleted_at',
    )).toBeDefined();

    // Empty window → no alert at all (not a zero-count row).
    primeDb({
      leads: leadsResult({ waiting: [], unattributed: { count: 0 }, builderWarranty: [] }),
    });
    const { alerts: quiet } = await computeDashboardAlertsUncached();
    expect(quiet.find((a) => a.id === 'builder_warranty_expiring')).toBeUndefined();
  });

  test('at_risk_mrr: reuses the shared at-risk account list; absent when nothing is at risk', async () => {
    listAtRiskMrrAccounts.mockResolvedValue([
      atRiskAccount('cust-b', 400),
      atRiskAccount('cust-a', 112.5, ['autopay_paused']),
    ]);
    let { alerts } = await computeDashboardAlertsUncached();
    expect(alerts.find((a) => a.id === 'at_risk_mrr')).toMatchObject({
      kind: 'action',
      severity: 'warn',
      count: 2,
      amount: 512.5,
      members: ['cust-a', 'cust-b'],
      href: '/admin/billing-recovery',
    });

    listAtRiskMrrAccounts.mockResolvedValue([]);
    ({ alerts } = await computeDashboardAlertsUncached());
    expect(alerts.find((a) => a.id === 'at_risk_mrr')).toBeUndefined();
  });

  test('autopay_coverage_low: fires below the 50% target with the manual-pay count', async () => {
    primeDb({
      customers: { c: '100' },
      'customers as c': { c: '23' },
    });
    const { alerts } = await computeDashboardAlertsUncached();
    const item = alerts.find((a) => a.id === 'autopay_coverage_low');
    expect(item).toMatchObject({ kind: 'action', severity: 'warn', count: 77 });
    expect(item.label).toContain('Autopay covers 23%');
  });

  test('autopay_coverage_low: thresholds on the raw ratio — 49.9% must fire, not round up to 50 and skip', async () => {
    primeDb({
      customers: { c: '1000' },
      'customers as c': { c: '499' },
    });
    const { alerts } = await computeDashboardAlertsUncached();
    const item = alerts.find((a) => a.id === 'autopay_coverage_low');
    expect(item).toMatchObject({ kind: 'action', count: 501 });
    // Label shows the tile's one-decimal form, never a rounded-up 50.
    expect(item.label).toContain('Autopay covers 49.9%');
  });

  test('autopay_coverage_low: silent at/above target and on an empty base', async () => {
    primeDb({ customers: { c: '100' }, 'customers as c': { c: '60' } });
    let { alerts } = await computeDashboardAlertsUncached();
    expect(alerts.find((a) => a.id === 'autopay_coverage_low')).toBeUndefined();

    primeDb({ customers: { c: '0' }, 'customers as c': { c: '0' } });
    ({ alerts } = await computeDashboardAlertsUncached());
    expect(alerts.find((a) => a.id === 'autopay_coverage_low')).toBeUndefined();
  });

  test('closeout_gaps_today: warn action over today\'s completed visits with open closeout issues; unknown/not_required never count', async () => {
    const { loadCloseoutStatuses } = require('../services/closeout-alerts');
    const fact = (state, reason, extra = {}) => ({ state, reason, ...extra });
    const done = (o = {}) => ({
      found: true,
      facts: {
        completion: fact('done', 'record_exists'), application: fact('done', 'x'), photos: fact('not_required', 'x'),
        report: fact('done', 'x'), reportDelivery: fact('done', 'x'), invoice: fact('done', 'x'), invoiceDelivery: fact('done', 'x'),
        comms: fact('done', 'x'), followUp: fact('not_required', 'x'), license: fact('not_required', 'x'), ...o,
      },
    });
    primeDb({ scheduled_services: [{ id: 'svc-a' }, { id: 'svc-b' }, { id: 'svc-c' }, { id: 'svc-d' }] });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([
      ['svc-a', done()],                                                                 // closed out
      ['svc-b', done({ report: fact('pending', 'no_report_artifact'), photos: fact('pending', 'photo_count_short', { required: 2, actual: 0 }) })], // 2 issues
      ['svc-c', done({ report: fact('unknown', 'requirements_unavailable') })],          // outage → not a gap
      ['svc-d', null],                                                                   // load failed → not a gap
    ]));
    const { alerts } = await computeDashboardAlertsUncached();
    const item = alerts.find((a) => a.id === 'closeout_gaps_today');
    // Members are visit:issue identities so a new issue on a listed visit re-surfaces a dismissal (GH r2).
    expect(item).toMatchObject({ kind: 'action', severity: 'warn', count: 1, href: expect.stringMatching(/^\/admin\/dispatch\?tab=schedule&date=\d{4}-\d{2}-\d{2}$/), members: ['svc-b:missing_required_photos', 'svc-b:missing_required_service_report'] });
    expect(item.label).toBe('1 completed visit today not closed out (2 open items)');
    expect(loadCloseoutStatuses).toHaveBeenCalledWith(['svc-a', 'svc-b', 'svc-c', 'svc-d'], { fresh: false });
  });

  test('closeout_gaps_today: money + comms facts count as members only behind GATE_CLOSEOUT_MONEY_COMMS_ALERTS', async () => {
    const { loadCloseoutStatuses } = require('../services/closeout-alerts');
    const { __private } = require('../services/dashboard-alerts');
    const fact = (state, reason, extra = {}) => ({ state, reason, ...extra });
    const done = (o = {}) => ({
      found: true,
      facts: {
        completion: fact('done', 'record_exists'), application: fact('done', 'x'), photos: fact('not_required', 'x'),
        report: fact('done', 'x'), reportDelivery: fact('done', 'x'), invoice: fact('done', 'x'), invoiceDelivery: fact('done', 'x'),
        comms: fact('done', 'x'), followUp: fact('not_required', 'x'), license: fact('not_required', 'x'), ...o,
      },
    });
    const statuses = () => new Map([
      ['svc-a', done({ comms: fact('failed', 'completion_sms_failed'), invoice: fact('pending', 'expected_invoice_not_minted'), invoiceDelivery: fact('pending', 'no_invoice_yet') })],
      ['svc-b', done({ invoiceDelivery: fact('pending', 'receipt_queued'), comms: fact('pending', 'deferred_send_window') })], // transient → silent either way
    ]);
    try {
      __private.resetCloseoutCarry();
      delete process.env.GATE_CLOSEOUT_MONEY_COMMS_ALERTS;
      primeDb({ scheduled_services: [{ id: 'svc-a' }, { id: 'svc-b' }] });
      loadCloseoutStatuses.mockResolvedValueOnce(statuses());
      expect((await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today')).toBeUndefined();
      process.env.GATE_CLOSEOUT_MONEY_COMMS_ALERTS = 'true';
      __private.resetCloseoutCarry();
      primeDb({ scheduled_services: [{ id: 'svc-a' }, { id: 'svc-b' }] });
      loadCloseoutStatuses.mockResolvedValueOnce(statuses());
      const item = (await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today');
      expect(item).toMatchObject({ count: 1, members: ['svc-a:completion_notice_failed', 'svc-a:invoice_not_minted:expected_invoice_not_minted'] });
      expect(item.label).toBe('1 completed visit today not closed out (2 open items)');
      // A comms outage is now an incomplete read: the gap holds (no members) rather than clearing.
      __private.resetCloseoutCarry();
      primeDb({ scheduled_services: [{ id: 'svc-a' }], dashboard_alert_state: { alert_id: 'closeout_gaps_today', current_count: 1, last_label: 'x', last_seen_at: new Date().toISOString() } });
      loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-a', done({ comms: fact('unknown', 'no_comms_marker_on_record') })]]));
      const held = (await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today');
      expect(held).toMatchObject({ count: 1, heldThroughOutage: true });
      expect(held.members).toBeUndefined();
    } finally {
      delete process.env.GATE_CLOSEOUT_MONEY_COMMS_ALERTS;
    }
  });

  test('closeout_gaps_today: a lookup outage holds the last-known gap (no clear/re-fire); a complete clean read clears it (codex r5)', async () => {
    const { loadCloseoutStatuses } = require('../services/closeout-alerts');
    const { __private } = require('../services/dashboard-alerts');
    __private.resetCloseoutCarry();
    const gap = { found: true, facts: { completion: { state: 'done', reason: 'record_exists' }, report: { state: 'pending', reason: 'no_report_artifact' } } };
    const clean = { found: true, facts: { completion: { state: 'done', reason: 'record_exists' }, report: { state: 'done', reason: 'report_published' } } };
    // A failed probe that feeds a mapped fact surfaces there as 'unknown'.
    const partialNoIssue = { ...clean, facts: { ...clean.facts, reportDelivery: { state: 'unknown', reason: 'delivery_lookup_failed' } }, unavailable: [{ lookup: 'service_report_deliveries', error: 'timeout' }] };
    primeDb({ scheduled_services: [{ id: 'svc-a' }] });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-a', gap]]));
    expect((await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today')).toMatchObject({ count: 1 });
    // Load failed → still present.
    primeDb({ scheduled_services: [{ id: 'svc-a' }] });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-a', null]]));
    expect((await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today')).toMatchObject({ count: 1, members: ['svc-a:missing_required_service_report'] });
    // Partial read with no readable issue → still present.
    primeDb({ scheduled_services: [{ id: 'svc-a' }] });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-a', partialNoIssue]]));
    expect((await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today')).toMatchObject({ count: 1 });
    // Complete clean read → cleared, and a later outage does not resurrect it.
    primeDb({ scheduled_services: [{ id: 'svc-a' }] });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-a', clean]]));
    expect((await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today')).toBeUndefined();
    primeDb({ scheduled_services: [{ id: 'svc-a' }] });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-a', null]]));
    expect((await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today')).toBeUndefined();
  });

  test('closeout_gaps_today: after a restart (empty carry) an active DB state row holds the alert through an outage (codex r6)', async () => {
    const { loadCloseoutStatuses } = require('../services/closeout-alerts');
    const { __private } = require('../services/dashboard-alerts');
    __private.resetCloseoutCarry();
    primeDb({
      scheduled_services: [{ id: 'svc-a' }],
      dashboard_alert_state: { alert_id: 'closeout_gaps_today', current_count: 2, last_label: '2 completed visits today not closed out (3 open items)', last_seen_at: new Date().toISOString() },
    });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-a', null]]));
    const item = (await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today');
    expect(item).toMatchObject({ count: 2, heldThroughOutage: true, label: expect.stringContaining('3 open items') });
    expect(item.members).toBeUndefined(); // an outage snapshot never seeds membership-aware dismissal (codex r7)
    // Yesterday's state row never becomes today's gap (codex r7).
    __private.resetCloseoutCarry();
    primeDb({
      scheduled_services: [{ id: 'svc-a' }],
      dashboard_alert_state: { alert_id: 'closeout_gaps_today', current_count: 2, last_label: 'old', last_seen_at: new Date(Date.now() - 2 * 86400000).toISOString() },
    });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-a', null]]));
    expect((await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today')).toBeUndefined();
    // No active state row (alert genuinely resolved earlier) → an outage does not invent one.
    __private.resetCloseoutCarry();
    primeDb({ scheduled_services: [{ id: 'svc-a' }], dashboard_alert_state: undefined });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-a', null]]));
    expect((await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today')).toBeUndefined();
  });

  test('closeout_gaps_today: partial outage with one readable gap holds count = max(readable, persisted), no members (codex r8)', async () => {
    const { loadCloseoutStatuses } = require('../services/closeout-alerts');
    const { __private } = require('../services/dashboard-alerts');
    __private.resetCloseoutCarry();
    const gap = { found: true, facts: { completion: { state: 'done', reason: 'record_exists' }, report: { state: 'pending', reason: 'no_report_artifact' } } };
    primeDb({
      scheduled_services: [{ id: 'svc-a' }, { id: 'svc-b' }],
      dashboard_alert_state: { alert_id: 'closeout_gaps_today', current_count: 2, last_label: 'x', last_seen_at: new Date().toISOString() },
    });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-a', gap], ['svc-b', null]]));
    const item = (await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today');
    expect(item).toMatchObject({ count: 2, heldThroughOutage: true });
    expect(item.members).toBeUndefined();
    expect(item.label).toMatch(/partially unavailable/);
  });

  test('closeout_gaps_today: a partial read that still shows an issue is held (no members) and its carry merges, never shrinks (codex r12)', async () => {
    const { loadCloseoutStatuses } = require('../services/closeout-alerts');
    const { __private } = require('../services/dashboard-alerts');
    __private.resetCloseoutCarry();
    const two = { found: true, facts: { completion: { state: 'done', reason: 'record_exists' }, report: { state: 'pending', reason: 'no_report_artifact' }, photos: { state: 'pending', reason: 'photo_count_short', required: 2, actual: 0 } } };
    const partialOne = { found: true, unavailable: [{ lookup: 'service_photos', error: 'timeout' }], facts: { completion: { state: 'done', reason: 'record_exists' }, report: { state: 'pending', reason: 'no_report_artifact' }, photos: { state: 'unknown', reason: 'service_photos_lookup_failed' } } };
    primeDb({ scheduled_services: [{ id: 'svc-a' }] });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-a', two]]));
    expect((await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today').members).toHaveLength(2);
    // Partial read: photos unreadable but report still open → held snapshot, no members, count not shrunk.
    primeDb({ scheduled_services: [{ id: 'svc-a' }], dashboard_alert_state: { alert_id: 'closeout_gaps_today', current_count: 1, last_label: 'x', last_seen_at: new Date().toISOString() } });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-a', partialOne]]));
    const held = (await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today');
    expect(held).toMatchObject({ count: 1, heldThroughOutage: true });
    expect(held.members).toBeUndefined();
    // Complete read afterwards shows both issues again → exact members restored.
    primeDb({ scheduled_services: [{ id: 'svc-a' }] });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-a', two]]));
    expect((await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today').members).toHaveLength(2);
  });

  test('closeout_gaps_today: an unreadable alert-state row with something known open holds a snapshot, not absence (codex r13)', async () => {
    const { loadCloseoutStatuses } = require('../services/closeout-alerts');
    const { __private } = require('../services/dashboard-alerts');
    __private.resetCloseoutCarry();
    const gap = { found: true, facts: { completion: { state: 'done', reason: 'record_exists' }, report: { state: 'pending', reason: 'no_report_artifact' } } };
    primeDb({ scheduled_services: [{ id: 'svc-a' }, { id: 'svc-b' }], dashboard_alert_state: () => { throw new Error('state table unavailable'); } });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-a', gap], ['svc-b', null]]));
    const item = (await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today');
    expect(item).toMatchObject({ count: 1, heldThroughOutage: true });
    expect(item.members).toBeUndefined();
    // Nothing known open + unreadable state row → still nothing invented.
    __private.resetCloseoutCarry();
    primeDb({ scheduled_services: [{ id: 'svc-b' }], dashboard_alert_state: () => { throw new Error('state table unavailable'); } });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-b', null]]));
    expect((await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today')).toBeUndefined();
  });

  test('closeout_gaps_today: a visit that leaves the completed set is pruned from the carry, so a later failure cannot resurrect it (GH r3)', async () => {
    const { loadCloseoutStatuses } = require('../services/closeout-alerts');
    const { __private } = require('../services/dashboard-alerts');
    __private.resetCloseoutCarry();
    const gap = { found: true, facts: { completion: { state: 'done', reason: 'record_exists' }, report: { state: 'pending', reason: 'no_report_artifact' } } };
    primeDb({ scheduled_services: [{ id: 'svc-a' }] });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-a', gap]]));
    expect((await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today')).toBeDefined();
    // svc-a leaves today's completed set (un-completed / moved) → carry pruned.
    primeDb({ scheduled_services: [] });
    expect((await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today')).toBeUndefined();
    // Generator failure afterwards (no state row) must not resurrect it.
    primeDb({ scheduled_services: [{ id: 'svc-z' }], dashboard_alert_state: undefined });
    loadCloseoutStatuses.mockRejectedValueOnce(new Error('boom'));
    expect((await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today')).toBeUndefined();
  });

  test('closeout_gaps_today: a gapped visit pushed past the sweep cap stays counted — a truncated clean window cannot clear it (pre-push r15)', async () => {
    const { loadCloseoutStatuses } = require('../services/closeout-alerts');
    const { __private } = require('../services/dashboard-alerts');
    __private.resetCloseoutCarry();
    const gap = { found: true, facts: { completion: { state: 'done', reason: 'record_exists' }, report: { state: 'pending', reason: 'no_report_artifact' } } };
    const clean = { found: true, facts: { completion: { state: 'done', reason: 'record_exists' }, report: { state: 'done', reason: 'report_published' } } };
    primeDb({ scheduled_services: [{ id: 'svc-gap' }] });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-gap', gap]]));
    expect((await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today')).toMatchObject({ count: 1 });
    // Backfilled earlier visits push svc-gap past the cap; the checked 50 are all clean.
    const rows = Array.from({ length: 51 }, (_, i) => ({ id: `svc-${i}` }));
    primeDb({ scheduled_services: (calls) => (calls.some((c) => c.method === 'count') ? { n: 51 } : rows) });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map(rows.slice(0, 50).map((r) => [r.id, clean])));
    const item = (await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today');
    expect(item).toMatchObject({ count: 1, members: ['svc-gap:missing_required_service_report'] });
  });

  test('closeout_gaps_today: every truncated sweep reconciles the persisted floor — one in-window gap after a restart cannot shrink a larger over-cap count (pre-push r16)', async () => {
    const { loadCloseoutStatuses } = require('../services/closeout-alerts');
    const { __private } = require('../services/dashboard-alerts');
    __private.resetCloseoutCarry(); // restart: in-process carry is empty
    const gap = { found: true, facts: { completion: { state: 'done', reason: 'record_exists' }, report: { state: 'pending', reason: 'no_report_artifact' } } };
    const clean = { found: true, facts: { completion: { state: 'done', reason: 'record_exists' }, report: { state: 'done', reason: 'report_published' } } };
    const rows = Array.from({ length: 51 }, (_, i) => ({ id: `svc-${i}` }));
    primeDb({
      scheduled_services: (calls) => (calls.some((c) => c.method === 'count') ? { n: 51 } : rows),
      dashboard_alert_state: { alert_id: 'closeout_gaps_today', current_count: 3, last_label: 'x', last_seen_at: new Date().toISOString() },
    });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map(rows.slice(0, 50).map((r, i) => [r.id, i === 0 ? gap : clean])));
    const item = (await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today');
    expect(item).toMatchObject({ count: 3, heldThroughOutage: true });
    expect(item.members).toBeUndefined();
  });

  test('closeout_sweep_incomplete: a day over the cap surfaces the unchecked count instead of a silent false-clean (codex r7)', async () => {
    const { loadCloseoutStatuses } = require('../services/closeout-alerts');
    const { __private } = require('../services/dashboard-alerts');
    __private.resetCloseoutCarry();
    const rows53 = Array.from({ length: 53 }, (_, i) => ({ id: `svc-${i}` }));
    primeDb({ scheduled_services: (calls) => (calls.some((c) => c.method === 'count') ? { n: 53 } : rows53.slice(0, 51)) });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map());
    const { alerts } = await computeDashboardAlertsUncached();
    // The list query is capped at cap+1; the exact overflow comes from the COUNT query (codex r10).
    expect(alerts.find((a) => a.id === 'closeout_sweep_incomplete')).toMatchObject({ severity: 'warn', kind: 'alert', href: expect.stringMatching(/^\/admin\/dispatch\?tab=schedule&date=\d{4}-\d{2}-\d{2}$/), count: 3 });
    expect(loadCloseoutStatuses.mock.calls[0][0]).toHaveLength(50);
  });

  test('closeout_gaps_today: a generator failure re-emits the held alert instead of clearing it (codex r10)', async () => {
    const { loadCloseoutStatuses } = require('../services/closeout-alerts');
    const { __private } = require('../services/dashboard-alerts');
    __private.resetCloseoutCarry();
    primeDb({
      scheduled_services: [{ id: 'svc-a' }],
      dashboard_alert_state: { alert_id: 'closeout_gaps_today', current_count: 2, last_label: 'held label', last_seen_at: new Date().toISOString() },
    });
    loadCloseoutStatuses.mockRejectedValueOnce(new Error('loader exploded'));
    const item = (await computeDashboardAlertsUncached()).alerts.find((a) => a.id === 'closeout_gaps_today');
    expect(item).toMatchObject({ count: 2, heldThroughOutage: true, label: 'held label' });
    expect(item.members).toBeUndefined();
  });

  test('closeout_gaps_today: absent when every completed visit is closed out or there are none', async () => {
    const { loadCloseoutStatuses } = require('../services/closeout-alerts');
    primeDb({ scheduled_services: [] });
    let res = await computeDashboardAlertsUncached();
    expect(res.alerts.find((a) => a.id === 'closeout_gaps_today')).toBeUndefined();
    expect(loadCloseoutStatuses).not.toHaveBeenCalled();
    primeDb({ scheduled_services: [{ id: 'svc-a' }] });
    loadCloseoutStatuses.mockResolvedValueOnce(new Map([['svc-a', { found: true, facts: { completion: { state: 'done', reason: 'record_exists' } } }]]));
    res = await computeDashboardAlertsUncached();
    expect(res.alerts.find((a) => a.id === 'closeout_gaps_today')).toBeUndefined();
  });

  test('stale_draft_invoices: warns on billable drafts unsent 3+ days, deep-links the oldest, names the rows', async () => {
    const capture = primeDb({
      'invoices as i': [
        { id: 'inv-old', invoice_number: 'WPC-2026-0100' },
        { id: 'inv-new', invoice_number: 'WPC-2026-0200' },
      ],
    });
    const { alerts } = await computeDashboardAlertsUncached();
    const item = alerts.find((a) => a.id === 'stale_draft_invoices');
    expect(item).toMatchObject({ severity: 'warn', count: 2, href: '/admin/invoices?invoice=inv-old' });
    expect(item.label).toContain('unsent 3+ days');
    // The operator must be able to FIND the rows (Codex PR r4 P2).
    expect(item.label).toContain('WPC-2026-0100');
    // Statement-accrued NET-terms drafts stay unsent BY DESIGN — the
    // predicate must exclude them.
    expect(capture.some((c) => c.table === 'invoices as i' && c.method === 'whereNull' && c.args[0] === 'i.payer_statement_id')).toBe(true);
    // Members ride along so dismissals re-surface on queue change (r5 P2).
    const item2 = alerts.find((a) => a.id === 'stale_draft_invoices');
    expect(item2.members).toEqual(['inv-new', 'inv-old']);
    // Card-lane anchors (drafts on not-yet-completed visits) are excluded.
    expect(capture.some((c) => c.table === 'invoices as i' && c.method === 'leftJoin' && c.args[0] === 'scheduled_services as ss')).toBe(true);
  });

  test('stale_draft_invoices: absent when no stale drafts exist', async () => {
    primeDb({ 'invoices as i': [] });
    const { alerts } = await computeDashboardAlertsUncached();
    expect(alerts.find((a) => a.id === 'stale_draft_invoices')).toBeUndefined();
  });

  test('leads_unattributed_7d: counts this week\'s sourceless leads, non-engaged statuses excluded', async () => {
    const { NON_ENGAGED_LEAD_STATUSES } = require('../services/lead-statuses');
    const capture = primeDb({
      leads: leadsResult({ waiting: [], unattributed: { count: '4' } }),
    });
    const { alerts } = await computeDashboardAlertsUncached();

    expect(alerts.find((a) => a.id === 'leads_unattributed_7d')).toMatchObject({
      kind: 'action',
      severity: 'warn',
      count: 4,
      href: '/admin/leads',
    });
    const excluded = capture.find(
      (c) => c.table === 'leads' && c.method === 'whereNotIn' && c.args[0] === 'leads.status',
    );
    expect(excluded.args[1]).toBe(NON_ENGAGED_LEAD_STATUSES);

    // Mirror /leads-by-source: null-source email/referral leads map to their
    // own direct buckets there, so they are NOT a data-quality gap here.
    const directBuckets = capture.find(
      (c) => c.table === 'leads' && c.method === 'whereRaw'
        && String(c.args[0]).includes("NOT IN ('email', 'referral')"),
    );
    expect(directBuckets).toBeDefined();

    // Internal/test leads with a null source must not nag either.
    const { INTERNAL_TEST_CUSTOMERS } = require('../services/internal-test-customers');
    const internal = capture.find(
      (c) => c.table === 'leads' && c.method === 'whereNotIn'
        && c.args[1] === INTERNAL_TEST_CUSTOMERS,
    );
    expect(internal).toBeDefined();

    // Soft-deleted leads are out of every Leads surface — no nagging on them.
    const notDeleted = capture.find(
      (c) => c.table === 'leads' && c.method === 'whereNull' && c.args[0] === 'deleted_at',
    );
    expect(notDeleted).toBeDefined();

    // Windowed on first_contact_at — the same basis /leads-by-source uses —
    // not created_at, which can differ for imported/backfilled leads.
    const window = capture.find(
      (c) => c.table === 'leads' && c.method === 'whereRaw'
        && String(c.args[0]).includes("first_contact_at AT TIME ZONE 'America/New_York'"),
    );
    expect(window).toBeDefined();
  });

  test('legacy watch-state generators are back-tagged kind:"alert"', async () => {
    primeDb({
      invoices: { count: '2', amount: '500' },
      leads: leadsResult({ waiting: [{ id: 'lead-a' }], unattributed: { count: 0 } }),
    });
    const { alerts } = await computeDashboardAlertsUncached();
    expect(alerts.find((a) => a.id === 'ar_overdue_60').kind).toBe('alert');
    expect(alerts.find((a) => a.id === 'leads_awaiting_contact').kind).toBe('action');
  });

  test('fail-soft: one broken generator logs and cannot blank the rest', async () => {
    listAtRiskMrrAccounts.mockResolvedValue([atRiskAccount('cust-1', 100)]);
    primeDb({
      leads: () => { throw new Error('boom'); },
      'estimates as e': [{ id: 'est-1', at_stake: '99' }],
    });
    const { alerts } = await computeDashboardAlertsUncached();

    expect(alerts.find((a) => a.id === 'leads_awaiting_contact')).toBeUndefined();
    expect(alerts.find((a) => a.id === 'leads_unattributed_7d')).toBeUndefined();
    expect(alerts.find((a) => a.id === 'estimates_expiring')).toBeDefined();
    expect(alerts.find((a) => a.id === 'at_risk_mrr')).toBeDefined();
    const logged = logger.error.mock.calls.map((c) => String(c[0]));
    expect(logged.some((m) => m.includes('leads_awaiting_contact'))).toBe(true);
    expect(logged.some((m) => m.includes('leads_unattributed_7d'))).toBe(true);
  });
});

describe('computeDashboardAlerts memo', () => {
  test('shares one computation within the TTL; fresh:true and TTL expiry recompute', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    try {
      let now = 1_750_000_000_000;
      nowSpy.mockImplementation(() => now);

      listAtRiskMrrAccounts.mockResolvedValue([atRiskAccount('cust-1', 100)]);
      const first = await computeDashboardAlerts();
      expect(listAtRiskMrrAccounts).toHaveBeenCalledTimes(1);
      expect(first.alerts.find((a) => a.id === 'at_risk_mrr').amount).toBe(100);

      // Underlying state changes, but a second read within the TTL is served
      // from the memo — no recompute, same result object.
      listAtRiskMrrAccounts.mockResolvedValue([atRiskAccount('cust-9', 999)]);
      now += 10_000;
      const cached = await computeDashboardAlerts();
      expect(listAtRiskMrrAccounts).toHaveBeenCalledTimes(1);
      expect(cached.alerts.find((a) => a.id === 'at_risk_mrr').amount).toBe(100);

      // Write paths (dismissals, cron) must see current state.
      const forced = await computeDashboardAlerts({ fresh: true });
      expect(listAtRiskMrrAccounts).toHaveBeenCalledTimes(2);
      expect(forced.alerts.find((a) => a.id === 'at_risk_mrr').amount).toBe(999);

      // TTL expiry recomputes on the read path too.
      now += 31_000;
      await computeDashboardAlerts();
      expect(listAtRiskMrrAccounts).toHaveBeenCalledTimes(3);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('cards_expiring_7d — prepay-covered customers are not "autopay breaks this week"', () => {
  const cardsCalls = (capture) => capture.filter((c) => c.table === 'payment_methods');

  test('asks coverage at the 7-day horizon and excludes covered customers from the count', async () => {
    getCardExpiryExemptions.mockResolvedValue(exemptions(['cust-prepaid']));
    const capture = primeDb({ payment_methods: { count: 1 }, leads: { count: 0 } });
    const { alerts } = await computeDashboardAlertsUncached();

    const [asOf] = getCardExpiryExemptions.mock.calls[0];
    expect(asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const excl = cardsCalls(capture).find((c) => c.method === 'whereNotIn');
    expect(excl.args).toEqual(['customers.id', ['cust-prepaid']]);
    // Still-present alert reflects the DB count with the exclusion applied.
    expect(alerts.find((a) => a.id === 'cards_expiring_7d')).toMatchObject({ count: 1 });
  });

  // PER METHOD (#3533 follow-up): a covered customer with a charge coming
  // counts only the card(s) that charge will use; an unresolved charge
  // method (null) counts every card — no clause at all for that customer.
  test('partially covered customers count only their charge methods; unresolved ones count every card', async () => {
    getCardExpiryExemptions.mockResolvedValue(exemptions(['cust-prepaid'], [
      ['cust-hold', new Set(['pm-hold'])],
      ['cust-unknown', null],
    ]));
    const capture = primeDb({ payment_methods: { count: 1 }, leads: { count: 0 } });
    await computeDashboardAlertsUncached();
    const calls = cardsCalls(capture);
    expect(calls.find((c) => c.method === 'whereNotIn' && c.args[0] === 'customers.id' && c.args[1].includes('cust-prepaid')).args)
      .toEqual(['customers.id', ['cust-prepaid']]);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'whereNotIn', args: ['customers.id', ['cust-hold']] }),
      expect.objectContaining({ method: 'orWhereIn', args: ['payment_methods.id', ['pm-hold']] }),
    ]));
    expect(calls.some((c) => JSON.stringify(c.args).includes('cust-unknown'))).toBe(false);
  });

  test('no covered customers → no exclusion clause (query unchanged)', async () => {
    const capture = primeDb({ payment_methods: { count: 2 }, leads: { count: 0 } });
    const { alerts } = await computeDashboardAlertsUncached();
    expect(cardsCalls(capture).some((c) => c.method === 'whereNotIn')).toBe(false);
    expect(alerts.find((a) => a.id === 'cards_expiring_7d')).toMatchObject({ count: 2 });
  });

  test('coverage lookup failure fails toward the warning (no exclusion, alert still computed)', async () => {
    getCardExpiryExemptions.mockRejectedValue(new Error('boom'));
    const capture = primeDb({ payment_methods: { count: 1 }, leads: { count: 0 } });
    const { alerts } = await computeDashboardAlertsUncached();
    expect(cardsCalls(capture).some((c) => c.method === 'whereNotIn')).toBe(false);
    expect(alerts.find((a) => a.id === 'cards_expiring_7d')).toMatchObject({ count: 1 });
  });
});
