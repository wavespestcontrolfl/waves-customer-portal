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
  test('gate on: the prior-visit query excludes callback records', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    const knex = fakeKnex({ firstRow: null });
    await buildSinceLastVisitContext({ record, knex });
    expect(knex.applied).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'where', args: ['is_callback', false] }),
      expect.objectContaining({ method: 'orWhereNull', args: ['is_callback'] }),
    ]));
  });

  test('gate dark: no callback constraint (legacy behavior byte-identical)', async () => {
    delete process.env.GATE_RESERVICE_REPORT_COPY;
    const knex = fakeKnex({ firstRow: null });
    await buildSinceLastVisitContext({ record, knex });
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
