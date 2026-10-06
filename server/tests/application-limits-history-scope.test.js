// checkLimits reads a product's own history (annual_max_apps, min_interval_days, the
// per-product annual rate) with the same scope as the shared active-ingredient cap:
// opts.propertyId limits it to the treated property, opts.excludeScheduledServiceId leaves
// the planned visit's own ledger rows out (Codex round 1 on #6084). A caller that passes
// neither reads the customer's whole year, exactly as before.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const applicationLimits = require('../services/application-limits');

// A chainable query that records every call and runs the callback arguments of where()
// against a recording sub-query, so the scope's shape can be asserted.
function chain({ rows = [], first: firstVal } = {}) {
  const calls = [];
  const q = { calls };
  for (const m of ['where', 'whereIn', 'whereRaw', 'whereNull', 'whereNotNull', 'whereNot', 'orWhereNull', 'orWhereNotIn',
    'andWhere', 'select', 'orderBy', 'limit', 'leftJoin', 'join', 'from', 'count', 'whereNotExists']) {
    q[m] = jest.fn((...args) => {
      calls.push([m, ...args]);
      if (typeof args[0] === 'function') args[0].call(q);
      return q;
    });
  }
  q.first = jest.fn(async () => firstVal);
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}

const PRODUCT = { id: 'prod-1', name: 'Dimension fixture', moa_group: null, category: 'herbicide', active_ingredient: 'Dithiopyr' };
const INTERVAL_LIMIT = { id: 'lim-1', product_id: 'prod-1', match_type: 'product', limit_type: 'min_interval_days', limit_value: '60', limit_unit: 'days', severity: 'hard_block' };

// The tables checkLimits reads, answered by name (the scope also opens a service_records sub-query).
function mockDb(historyRows) {
  const history = chain({ rows: historyRows });
  db.mockImplementation((table) => {
    if (table === 'products_catalog') return chain({ first: PRODUCT });
    if (table === 'customers') return chain({ first: { id: 'cust-1', city: 'Sarasota' } });
    if (table === 'property_application_history') return history;
    if (table === 'product_limits') return chain({ rows: [INTERVAL_LIMIT] });
    if (table === 'service_records') return chain({ rows: [] });
    throw new Error(`unexpected table ${table}`);
  });
  return history;
}

describe('checkLimits: the product history honors the treated property and the planned visit', () => {
  beforeEach(() => { db.mockReset(); db.raw = jest.fn((sql) => ({ sql })); });

  test('no options: the history query has no property or visit scope (legacy callers read the whole year)', async () => {
    const history = mockDb([]);
    await applicationLimits.checkLimits('cust-1', 'prod-1', new Date('2026-10-12T16:00:00Z'));
    const methods = history.calls.map((call) => call[0]);
    expect(methods).not.toContain('whereNotExists');
    expect(methods).not.toContain('orWhereNotIn');
    expect(methods).not.toContain('orWhereNull');
  });

  test('propertyId: rows ledgered at another of the customer\'s properties are excluded; the history table is named in the scope', async () => {
    const history = mockDb([]);
    await applicationLimits.checkLimits('cust-1', 'prod-1', new Date('2026-10-12T16:00:00Z'), db, { propertyId: 'prop-A' });
    const scope = history.calls.filter((call) => call[0] === 'whereNotExists');
    expect(scope).toHaveLength(1);
    expect(history.calls).toContainEqual(['whereRaw', 'sr_scope.id = ??.service_record_id', ['property_application_history']]);
    expect(history.calls).toContainEqual(['whereNotNull', 'ss_scope.property_id']);
    expect(history.calls).toContainEqual(['whereNot', 'ss_scope.property_id', 'prop-A']);
  });

  test('excludeScheduledServiceId: the visit\'s own ledger rows are left out (a row with no service record still counts)', async () => {
    const history = mockDb([]);
    await applicationLimits.checkLimits('cust-1', 'prod-1', new Date('2026-10-12T16:00:00Z'), db, { excludeScheduledServiceId: 'visit-9' });
    const methods = history.calls.map((call) => call[0]);
    expect(methods).toContain('whereNull');
    expect(history.calls).toContainEqual(['whereNull', 'property_application_history.service_record_id']);
    expect(methods).toContain('orWhereNotIn');
    expect(history.calls.find((call) => call[0] === 'orWhereNotIn')[1]).toBe('property_application_history.service_record_id');
    expect(methods).not.toContain('whereNotExists');
  });

  test('the history stops at the proposed day: a later application is not read, the day itself is', async () => {
    const history = mockDb([]);
    await applicationLimits.checkLimits('cust-1', 'prod-1', new Date('2026-10-12T16:00:00Z'));
    expect(history.calls).toContainEqual(['where', 'application_date', '<=', '2026-10-12']);
    // A pg DATE proposed day keeps its own calendar day.
    const second = mockDb([]);
    await applicationLimits.checkLimits('cust-1', 'prod-1', new Date(2026, 0, 12));
    expect(second.calls).toContainEqual(['where', 'application_date', '<=', '2026-01-12']);
  });

  test('both options together apply both scopes; the retraction and year filters stay', async () => {
    const history = mockDb([]);
    await applicationLimits.checkLimits('cust-1', 'prod-1', new Date('2026-10-12T16:00:00Z'), db, { propertyId: 'prop-A', excludeScheduledServiceId: 'visit-9' });
    const methods = history.calls.map((call) => call[0]);
    expect(methods).toEqual(expect.arrayContaining(['whereNotExists', 'orWhereNotIn']));
    expect(history.calls).toContainEqual(['whereNull', 'retracted_at']);
    expect(history.calls.some((call) => call[0] === 'where' && call[1] === 'application_date' && call[2] === '>=')).toBe(true);
    expect(history.calls.find((call) => call[0] === 'orderBy')).toEqual(['orderBy', 'application_date', 'desc']);
  });

  test('the rows the scoped query returns decide the limit: a recent row inside the interval blocks, none passes', async () => {
    const recent = { id: 'h1', application_date: '2026-09-20', application_rate: 4, rate_unit: 'lb' };
    mockDb([recent]);
    const blocked = await applicationLimits.checkLimits('cust-1', 'prod-1', new Date('2026-10-12T16:00:00Z'), db, { propertyId: 'prop-A' });
    expect(blocked.allowed).toBe(false);
    expect(blocked.blocks[0]).toMatchObject({ type: 'min_interval_days' });
    mockDb([]);
    const clear = await applicationLimits.checkLimits('cust-1', 'prod-1', new Date('2026-10-12T16:00:00Z'), db, { propertyId: 'prop-A', excludeScheduledServiceId: 'visit-9' });
    expect(clear.allowed).toBe(true);
  });
});
