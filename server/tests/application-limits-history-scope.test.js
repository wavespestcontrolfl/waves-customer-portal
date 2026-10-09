// checkLimits reads a product's own history (annual_max_apps, min_interval_days, the
// per-product annual rate) with the same scope as the shared active-ingredient cap:
// opts.propertyId limits it to the treated property, opts.excludeScheduledServiceId leaves
// the planned visit's own ledger rows out . A caller that passes
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
    'andWhere', 'orWhere', 'select', 'orderBy', 'limit', 'leftJoin', 'join', 'from', 'count', 'whereNotExists']) {
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
    // Two reads share the scope: this year's history, and (the year being empty and a minimum interval set) the look-back to the latest earlier application.
    expect(scope).toHaveLength(2);
    expect(history.calls).toContainEqual(['whereRaw', 'sr_scope.id = ??.service_record_id', ['property_application_history']]);
    expect(history.calls).toContainEqual(['whereNotNull', 'ss_scope.property_id']);
    expect(history.calls).toContainEqual(['whereNot', 'ss_scope.property_id', 'prop-A']);
    // The treated property frozen on the ledger row decides first: a row placed here or unplaced passes the
    // predicate; the visit join only judges legacy rows that carry no frozen property.
    expect(history.calls).toContainEqual(['whereNull', 'property_application_history.property_id']);
    expect(history.calls).toContainEqual(['orWhere', 'property_application_history.property_id', 'prop-A']);
    expect(history.calls).toContainEqual(['whereRaw', '??.property_id is null', ['property_application_history']]);
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

// A visit that recorded the same product twice (a Tree & Shrub host row and an area add-on row of that product) made two
// applications of it (Codex round 9 on #6135): the yearly count judges the visit's first against the others, and each
// further row of the visit adds to what is used.
describe('auditAnnualCount counts a visit\'s second row of the product as another application', () => {
  const others = (n) => () => chain({ rows: Array.from({ length: n }, (_, i) => ({ id: i })) });
  const product = { name: 'Arena 50 WDG' };

  test('one row on the visit: unchanged (others at the cap block, below it do not)', async () => {
    expect(await applicationLimits.auditAnnualCount(others(1), product, '2026-10-09', 2, 0)).toBeNull();
    expect(await applicationLimits.auditAnnualCount(others(2), product, '2026-10-09', 2, 0)).toMatchObject({ type: 'annual_max_apps', current: 2, max: 2 });
  });

  test('two rows on the visit with one other application: used 2 of 2, reached', async () => {
    expect(await applicationLimits.auditAnnualCount(others(1), product, '2026-10-09', 2, 1)).toMatchObject({ type: 'annual_max_apps', current: 2, max: 2, message: expect.stringContaining('2/2') });
    expect(await applicationLimits.auditAnnualCount(others(0), product, '2026-10-09', 2, 1)).toBeNull();
  });

  // Codex round 11 P1 on #6135: a visit booked while the gate was on is completed after it is turned off; the audit returned 0
  // with the gate off, so the host application plus the attached add-on of the same product counted once and the hard limit
  // finding and the office alert were missed. The audit reads the data, never the sale gate.
  test('the visit\'s extra rows are counted from its own ledger rows, minus the first, with the sale gate on OR off; no visit named, nothing extra', async () => {
    const saved = process.env.GATE_AREA_ADDONS;
    try {
      for (const gate of ['true', undefined, 'false']) {
        if (gate === undefined) delete process.env.GATE_AREA_ADDONS; else process.env.GATE_AREA_ADDONS = gate;
        const database = jest.fn(() => chain({ first: { n: '2' } }));
        expect(await applicationLimits.ownApplicationsBeyondFirst(database, 'c', 'p', { excludeScheduledServiceId: 'v' })).toBe(1);
        expect(await applicationLimits.ownApplicationsBeyondFirst(database, 'c', 'p', {})).toBe(0);
        expect(database).toHaveBeenCalledTimes(2);
      }
    } finally {
      if (saved === undefined) delete process.env.GATE_AREA_ADDONS; else process.env.GATE_AREA_ADDONS = saved;
    }
    const one = jest.fn(() => chain({ first: { n: '1' } }));
    expect(await applicationLimits.ownApplicationsBeyondFirst(one, 'c', 'p', { excludeScheduledServiceId: 'v' })).toBe(0);
    const none = jest.fn(() => chain({ first: undefined }));
    expect(await applicationLimits.ownApplicationsBeyondFirst(none, 'c', 'p', { excludeScheduledServiceId: 'v' })).toBe(0);
  });

  test('a caller that knows the visit has no add-on row reads nothing extra (the ordinary lawn closeout, gate off, keeps its single audit)', async () => {
    delete process.env.GATE_AREA_ADDONS;
    const database = jest.fn(() => chain({ first: { n: '3' } }));
    expect(await applicationLimits.ownApplicationsBeyondFirst(database, 'c', 'p', { excludeScheduledServiceId: 'v', addOnRows: false })).toBe(0);
    expect(database).not.toHaveBeenCalled();
    expect(await applicationLimits.ownApplicationsBeyondFirst(database, 'c', 'p', { excludeScheduledServiceId: 'v', addOnRows: true })).toBe(2);
  });

  test('the module no longer reads the sale gate, and the completion passes whether the closeout has an add-on row', () => {
    const fs = require('fs');
    const path = require('path');
    expect(fs.readFileSync(path.join(__dirname, '..', 'services', 'application-limits.js'), 'utf8')).not.toContain('GATE_AREA_ADDONS');
    const completion = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');
    expect(completion).toContain('addOnRows: addOnTags.size > 0');
    expect(completion).toContain('excludeScheduledServiceId: svc.id, addOnRows,');
  });
});
