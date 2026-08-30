/**
 * #3617 follow-up rulings (owner 2026-08-30): callback reports never ask for
 * a Google review, and callback visits are excluded from customer-facing
 * trend charts and "since last visit" baselines while the re-service gate is
 * on. Pest-pressure SCORING (review-window.js) is untouched by design.
 */
const { buildSinceLastVisitContext } = require('../services/service-report/since-last-visit');
const { loadActivityCustomerView } = require('../services/service-report/activity-scores-store');

const ORIGINAL = process.env.GATE_RESERVICE_REPORT_COPY;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.GATE_RESERVICE_REPORT_COPY;
  else process.env.GATE_RESERVICE_REPORT_COPY = ORIGINAL;
});

// Chainable fake knex that RECORDS constraints. Nested where-functions are
// invoked against the same chain so their clauses are captured too.
function fakeKnex({ rows = [], firstRow = null } = {}) {
  const applied = [];
  function chain(table) {
    const q = { table };
    const record = (method) => (...args) => {
      if (typeof args[0] === 'function') { args[0].call(q, q); return q; }
      applied.push({ table, method, args });
      return q;
    };
    for (const m of ['where', 'whereNot', 'whereNull', 'orWhere', 'orWhereNull', 'whereNotIn', 'whereIn', 'orderBy', 'limit', 'select']) q[m] = record(m);
    q.modify = (fn) => { fn(q); return q; };
    q.first = async () => firstRow;
    q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    q.catch = (fn) => Promise.resolve(rows).catch(fn);
    return q;
  }
  return Object.assign((table) => chain(table), { applied });
}

const record = { id: 'rec-now', customer_id: 'cust-1', status: 'completed', service_type: 'Pest Control', service_line: 'pest', service_date: '2026-08-30' };

describe('since-last-visit callback exclusion', () => {
  test('gate on + excludeCallbacks (customer-report path): the prior-visit query excludes callback records', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    const knex = fakeKnex({ firstRow: null });
    await buildSinceLastVisitContext({ record, knex, excludeCallbacks: true });
    expect(knex.applied).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'where', args: ['is_callback', false] }),
      expect.objectContaining({ method: 'orWhereNull', args: ['is_callback'] }),
    ]));
  });

  test('gate dark: no callback constraint (legacy behavior byte-identical)', async () => {
    delete process.env.GATE_RESERVICE_REPORT_COPY;
    const knex = fakeKnex({ firstRow: null });
    await buildSinceLastVisitContext({ record, knex, excludeCallbacks: true });
    expect(knex.applied.find((entry) => JSON.stringify(entry.args).includes('is_callback'))).toBeUndefined();
  });

  test('tech pre-visit brief path (no flag): callbacks stay the true prior visit even with the gate on', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    const knex = fakeKnex({ firstRow: null });
    await buildSinceLastVisitContext({ record, knex, strict: true });
    expect(knex.applied.find((entry) => JSON.stringify(entry.args).includes('is_callback'))).toBeUndefined();
  });
});

describe('activity chart callback exclusion', () => {
  const snapshot = { activity: { score: 3, indicatorKey: 'pest_activity', label: 'Pest activity' } };

  test('gate on: history and baseline queries exclude callback records (current visit exempt in history)', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    const knex = fakeKnex({ rows: [] });
    await loadActivityCustomerView(knex, { snapshot, service: record });
    const notIns = knex.applied.filter((entry) => entry.method === 'whereNotIn' && entry.args[0] === 'service_record_id');
    expect(notIns.length).toBeGreaterThanOrEqual(1);
    // The subquery targets callback records for this customer.
    const sub = knex.applied.filter((entry) => entry.table === 'service_records' && entry.method === 'where');
    expect(JSON.stringify(sub)).toContain('is_callback');
  });

  test('gate dark: no exclusion applied', async () => {
    delete process.env.GATE_RESERVICE_REPORT_COPY;
    const knex = fakeKnex({ rows: [] });
    await loadActivityCustomerView(knex, { snapshot, service: record });
    expect(knex.applied.find((entry) => entry.method === 'whereNotIn' && entry.args[0] === 'service_record_id')).toBeUndefined();
  });
});

describe('trend word recomputed against the filtered history (codex #3623 r1)', () => {
  const snapshot = { activity: { score: 2, indicatorKey: 'pest_activity', label: 'Pest activity', trend: 'down', trendWord: 'improving' } };
  const record2 = { id: 'rec-now', customer_id: 'cust-1', service_date: '2026-08-30' };

  test('gate on: trend derives from the filtered prior point, not the snapshot', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    // History rows: a regular visit scored 1 (the callback scored 5 is
    // excluded by the query in production; the fake returns post-filter rows).
    const knex = fakeKnex({ rows: [
      { service_record_id: 'rec-now', service_date: '2026-08-30', score: 2 },
      { service_record_id: 'rec-old', service_date: '2026-08-01', score: 1 },
    ] });
    const view = await loadActivityCustomerView(knex, { snapshot, service: record2 });
    // 1 → 2 is WORSE, though the callback-inflated snapshot said 'improving'.
    expect(view.trend).not.toBe('down');
    expect(view.trendWord).not.toBe('improving');
  });

  test('gate dark: snapshot trend words pass through untouched', async () => {
    delete process.env.GATE_RESERVICE_REPORT_COPY;
    const knex = fakeKnex({ rows: [] });
    const view = await loadActivityCustomerView(knex, { snapshot, service: record2 });
    expect(view.trend).toBe('down');
    expect(view.trendWord).toBe('improving');
  });
});

describe('reserviceTrendsPdfSignature (codex #3623 r1 P2)', () => {
  const { reserviceTrendsPdfSignature } = require('../services/service-report/reservice-report');
  const svc = { customer_id: 'cust-1' };
  const knexWith = (rows) => () => {
    const chain = {
      where() { return chain; },
      modify(fn) { fn(chain); return chain; },
      orderBy() { return chain; },
      async select() { if (rows === 'throw') throw new Error('down'); return rows; },
    };
    return chain;
  };

  test('gate on: key derives from the SET of callback records — adding or reclassifying one moves it', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    const one = await reserviceTrendsPdfSignature(svc, knexWith([{ id: 'cb-1' }]));
    const two = await reserviceTrendsPdfSignature(svc, knexWith([{ id: 'cb-1' }, { id: 'cb-2' }]));
    const swapped = await reserviceTrendsPdfSignature(svc, knexWith([{ id: 'cb-9' }]));
    expect(one).toMatch(/^-rstr1-[0-9a-f]{8}$/);
    expect(two).toMatch(/^-rstr2-[0-9a-f]{8}$/);
    expect(one).not.toBe(two);
    expect(one).not.toBe(swapped);
    expect(await reserviceTrendsPdfSignature(svc, knexWith([]))).toBe('');
    expect(await reserviceTrendsPdfSignature(svc, knexWith('throw'))).toBe('-rstru');
  });

  test('gate dark: always empty — existing keys untouched', async () => {
    delete process.env.GATE_RESERVICE_REPORT_COPY;
    expect(await reserviceTrendsPdfSignature(svc, knexWith([{ id: 'cb-1' }]))).toBe('');
  });
});

describe('pest-pressure display exclusion is OPT-IN (scoring callers unaffected)', () => {
  const { loadHistoryForCustomer } = require('../services/pest-pressure/store');
  function recordingKnex() {
    const applied = [];
    const chain = {
      leftJoin() { return chain; },
      where(...args) { if (typeof args[0] === 'function') { args[0].call(chain, chain); } else applied.push(args); return chain; },
      orWhere(...args) { applied.push(['orWhere', ...args]); return chain; },
      orWhereNull(...args) { applied.push(['orWhereNull', ...args]); return chain; },
      orderBy() { return chain; }, orderByRaw() { return chain; }, limit() { return chain; },
      async select() { return []; },
    };
    return Object.assign(() => chain, { applied });
  }

  test('the same-day-overflow FALLBACK query applies the exclusion too', async () => {
    // Force the fallback: current record absent from the over-fetched window.
    const applied = [];
    const row = { id: 'pps-cur', service_record_id: 'rec-now', service_date: '2026-08-30' };
    const chain = {
      leftJoin() { return chain; },
      where(...args) { if (typeof args[0] === 'function') { args[0].call(chain, chain); } else applied.push(args); return chain; },
      orWhere(...args) { applied.push(['orWhere', ...args]); return chain; },
      orWhereNull(...args) { applied.push(['orWhereNull', ...args]); return chain; },
      orderBy() { return chain; }, orderByRaw() { return chain; }, limit() { return chain; },
      async first() { return row; },
      select(...args) {
        const p = Promise.resolve([]);
        p.first = async () => row;
        p.catch = (fn) => Promise.resolve([]).catch(fn);
        return p;
      },
    };
    const knex = () => chain;
    await loadHistoryForCustomer(knex, 'cust-1', { serviceLine: 'pest', excludeCallbacks: true, currentServiceRecordId: 'rec-now', limit: 2 });
    // Both the main window and the fallback earlierQuery carry the filter.
    const flat = JSON.stringify(applied);
    expect((flat.match(/is_callback/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  test('excludeCallbacks: true applies the is_callback filter; default does not', async () => {
    const withFlag = recordingKnex();
    await loadHistoryForCustomer(withFlag, 'cust-1', { serviceLine: 'pest', excludeCallbacks: true });
    expect(JSON.stringify(withFlag.applied)).toContain('is_callback');
    const without = recordingKnex();
    await loadHistoryForCustomer(without, 'cust-1', { serviceLine: 'pest' });
    expect(JSON.stringify(without.applied)).not.toContain('is_callback');
  });
});
