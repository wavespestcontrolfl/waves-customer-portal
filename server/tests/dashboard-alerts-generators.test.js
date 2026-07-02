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
jest.mock('../services/mrr-breakdown', () => ({ computeMrrBreakdown: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { computeMrrBreakdown } = require('../services/mrr-breakdown');
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
  'orWhereRaw', 'orWhereNull', 'leftJoin', 'join', 'select', 'count',
  'countDistinct', 'orderBy', 'modify',
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
        if (typeof args[0] === 'function') args[0].call(b);
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

// Distinguish the two db('leads') generators by their unique chain calls.
const leadsResult = ({ waiting, unattributed }) => (calls) => {
  if (calls.some((c) => c.method === 'whereNotIn')) return unattributed;
  return waiting;
};

const NO_MRR = { total: 0, committed: 0, atRisk: 0, totalCount: 0, atRiskCount: 0 };

beforeEach(() => {
  jest.clearAllMocks();
  db.raw.mockImplementation((sql) => ({ sql, rows: [] }));
  db.schema.hasTable.mockResolvedValue(false);
  computeMrrBreakdown.mockResolvedValue(NO_MRR);
  primeDb({});
});

describe('Action Inbox generators', () => {
  test('leads_awaiting_contact: critical action, floored at the fresh-start baseline', async () => {
    const capture = primeDb({
      leads: leadsResult({ waiting: { count: '3' }, unattributed: { count: 0 } }),
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

    // The Speed-to-Lead fresh-start floor must be applied (env unset →
    // default 2026-07-01 baseline), so the pre-reset backlog can't nag.
    const floor = capture.find(
      (c) => c.table === 'leads' && c.method === 'where'
        && c.args[0] === 'first_contact_at' && c.args[1] === '>=',
    );
    expect(floor).toBeDefined();
    expect(floor.args[2]).toBeInstanceOf(Date);
  });

  test('estimates_expiring: warn action carrying the annualized at-stake amount, internal-test rows excluded', async () => {
    const { INTERNAL_TEST_CUSTOMERS } = require('../services/internal-test-customers');
    const capture = primeDb({
      'estimates as e': { count: '2', amount: '3120.50' },
    });
    const { alerts } = await computeDashboardAlertsUncached();

    expect(alerts.find((a) => a.id === 'estimates_expiring')).toMatchObject({
      kind: 'action',
      severity: 'warn',
      count: 2,
      amount: 3120.5,
      href: '/admin/estimates',
    });

    // Same population as /sales-capture: both the estimate-name and the
    // joined-customer-name internal-test exclusions applied.
    const exclusions = capture.filter(
      (c) => c.table === 'estimates as e' && c.method === 'whereNotIn'
        && c.args[1] === INTERNAL_TEST_CUSTOMERS,
    );
    expect(exclusions).toHaveLength(2);
  });

  test('at_risk_mrr: reuses the shared MRR breakdown; absent when nothing is at risk', async () => {
    computeMrrBreakdown.mockResolvedValue({ ...NO_MRR, atRisk: 512.5, atRiskCount: 7 });
    let { alerts } = await computeDashboardAlertsUncached();
    expect(alerts.find((a) => a.id === 'at_risk_mrr')).toMatchObject({
      kind: 'action',
      severity: 'warn',
      count: 7,
      amount: 512.5,
      href: '/admin/billing-recovery',
    });

    computeMrrBreakdown.mockResolvedValue(NO_MRR);
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

  test('autopay_coverage_low: silent at/above target and on an empty base', async () => {
    primeDb({ customers: { c: '100' }, 'customers as c': { c: '60' } });
    let { alerts } = await computeDashboardAlertsUncached();
    expect(alerts.find((a) => a.id === 'autopay_coverage_low')).toBeUndefined();

    primeDb({ customers: { c: '0' }, 'customers as c': { c: '0' } });
    ({ alerts } = await computeDashboardAlertsUncached());
    expect(alerts.find((a) => a.id === 'autopay_coverage_low')).toBeUndefined();
  });

  test('leads_unattributed_7d: counts this week\'s sourceless leads, non-engaged statuses excluded', async () => {
    const { NON_ENGAGED_LEAD_STATUSES } = require('../services/lead-statuses');
    const capture = primeDb({
      leads: leadsResult({ waiting: { count: 0 }, unattributed: { count: '4' } }),
    });
    const { alerts } = await computeDashboardAlertsUncached();

    expect(alerts.find((a) => a.id === 'leads_unattributed_7d')).toMatchObject({
      kind: 'action',
      severity: 'warn',
      count: 4,
      href: '/admin/leads',
    });
    const excluded = capture.find(
      (c) => c.table === 'leads' && c.method === 'whereNotIn' && c.args[0] === 'status',
    );
    expect(excluded.args[1]).toBe(NON_ENGAGED_LEAD_STATUSES);
  });

  test('legacy watch-state generators are back-tagged kind:"alert"', async () => {
    primeDb({
      invoices: { count: '2', amount: '500' },
      leads: leadsResult({ waiting: { count: '1' }, unattributed: { count: 0 } }),
    });
    const { alerts } = await computeDashboardAlertsUncached();
    expect(alerts.find((a) => a.id === 'ar_overdue_60').kind).toBe('alert');
    expect(alerts.find((a) => a.id === 'leads_awaiting_contact').kind).toBe('action');
  });

  test('fail-soft: one broken generator logs and cannot blank the rest', async () => {
    computeMrrBreakdown.mockResolvedValue({ ...NO_MRR, atRisk: 100, atRiskCount: 1 });
    primeDb({
      leads: () => { throw new Error('boom'); },
      'estimates as e': { count: '1', amount: '99' },
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

      computeMrrBreakdown.mockResolvedValue({ ...NO_MRR, atRisk: 100, atRiskCount: 1 });
      const first = await computeDashboardAlerts();
      expect(computeMrrBreakdown).toHaveBeenCalledTimes(1);
      expect(first.alerts.find((a) => a.id === 'at_risk_mrr').amount).toBe(100);

      // Underlying state changes, but a second read within the TTL is served
      // from the memo — no recompute, same result object.
      computeMrrBreakdown.mockResolvedValue({ ...NO_MRR, atRisk: 999, atRiskCount: 9 });
      now += 10_000;
      const cached = await computeDashboardAlerts();
      expect(computeMrrBreakdown).toHaveBeenCalledTimes(1);
      expect(cached.alerts.find((a) => a.id === 'at_risk_mrr').amount).toBe(100);

      // Write paths (dismissals, cron) must see current state.
      const forced = await computeDashboardAlerts({ fresh: true });
      expect(computeMrrBreakdown).toHaveBeenCalledTimes(2);
      expect(forced.alerts.find((a) => a.id === 'at_risk_mrr').amount).toBe(999);

      // TTL expiry recomputes on the read path too.
      now += 31_000;
      await computeDashboardAlerts();
      expect(computeMrrBreakdown).toHaveBeenCalledTimes(3);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
