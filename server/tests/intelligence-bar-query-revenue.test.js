/**
 * Intelligence Bar query_revenue — customer scoping contract (07-18 admin
 * audit, finding #5). Two defects pinned:
 *
 *  - The default (ungrouped) branch filtered the invoice LIST by
 *    customer_id but rebuilt the summary totals query without it, so a
 *    customer-specific answer paired one customer's invoices with
 *    COMPANY-WIDE totals in the same response.
 *  - customer_id went straight into a uuid-column comparison; name-like
 *    input from the model threw a Postgres cast error and flagged the tool
 *    DEGRADED in Tool Health. Now a typed { error } comes back before any
 *    query runs.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-email-fanout', () => ({ EMAIL_FANOUT_DISCLOSURE: '' }));

// Chainable knex stand-in: every builder records its where-clauses and
// resolves to canned rows. Builders are collected in creation order so the
// test can tell the list query (first) from the totals query (second).
jest.mock('../models/db', () => {
  const state = { builders: [], listRows: [], totalsRow: {} };
  const dbFn = (table) => {
    const builder = {
      table,
      wheres: [],
      where(...args) { builder.wheres.push(args); return builder; },
      leftJoin() { return builder; },
      modify(cb) { cb(builder); return builder; },
      select() { return builder; },
      orderBy() { return builder; },
      orderByRaw() { return builder; },
      groupBy() { return builder; },
      groupByRaw() { return builder; },
      limit() { return builder; },
      first() { return Promise.resolve({ ...state.totalsRow }); },
      then(resolve, reject) { return Promise.resolve(state.listRows.map((r) => ({ ...r }))).then(resolve, reject); },
    };
    state.builders.push(builder);
    return builder;
  };
  dbFn.raw = (sql) => ({ toString: () => sql });
  dbFn.__state = state;
  return dbFn;
});

const db = require('../models/db');
const { executeTool } = require('../services/intelligence-bar/tools');

const CUSTOMER_UUID = '5a3f2c1d-9b8e-4f6a-a1b2-c3d4e5f60789';

beforeEach(() => {
  db.__state.builders = [];
  db.__state.listRows = [];
  db.__state.totalsRow = { total_revenue: '150', total_invoices: '2', overdue_amount: '0' };
});

describe('query_revenue customer scoping', () => {
  test('name-like customer_id returns a typed error before any query runs', async () => {
    const result = await executeTool('query_revenue', { customer_id: 'Karen White' });
    expect(result.error).toMatch(/must be a customer UUID/i);
    expect(result.error).toMatch(/query_customers/);
    expect(db.__state.builders).toHaveLength(0);
  });

  test('the summary totals query carries the same customer_id filter as the list', async () => {
    const result = await executeTool('query_revenue', { customer_id: CUSTOMER_UUID });
    expect(result.error).toBeUndefined();
    expect(result.summary.total_revenue).toBe(150);

    // Builder 0 = invoice list, builder 1 = totals. BOTH must be pinned to
    // the customer.
    expect(db.__state.builders).toHaveLength(2);
    const [list, totals] = db.__state.builders;
    expect(list.wheres).toContainEqual(['invoices.customer_id', CUSTOMER_UUID]);
    expect(totals.wheres).toContainEqual(['customer_id', CUSTOMER_UUID]);
  });

  test('without customer_id the totals stay company-wide (no customer clause)', async () => {
    await executeTool('query_revenue', {});
    const totals = db.__state.builders[1];
    expect(totals.wheres.some(([col]) => String(col).includes('customer_id'))).toBe(false);
  });
});
