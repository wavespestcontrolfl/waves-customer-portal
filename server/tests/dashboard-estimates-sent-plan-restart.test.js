'use strict';
/**
 * compare_periods.estimates_sent must exclude ONLY undelivered plan_restart
 * mints (codex #3671 r19 P1 + r26 P2): a restart tap publishes with a
 * synthetic sent_at and nothing delivered, but an operator can later really
 * send the quote through the admin send path, which stamps
 * deliveryState.firstDeliveredAt — the same real-delivery witness
 * estimate-source-performance counts for this source. Legacy source-NULL
 * rows stay counted (r20 P2).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const recorded = [];
function makeChain(table) {
  const chain = {
    table,
    log(method, args) { recorded.push({ table: this.table, method, args }); return this; },
  };
  const methods = ['leftJoin', 'where', 'andWhere', 'orWhere', 'whereNot', 'orWhereNot', 'whereRaw', 'orWhereRaw',
    'whereIn', 'orWhereIn', 'whereNotIn', 'whereNull', 'orWhereNull', 'whereNotNull', 'orWhereNotNull',
    'whereBetween', 'select', 'groupBy', 'orderBy', 'limit', 'sum', 'count', 'modify'];
  for (const m of methods) {
    chain[m] = (...args) => {
      chain.log(m, args);
      if (m === 'where' && typeof args[0] === 'function') args[0].call(chain);
      if (m === 'modify' && typeof args[0] === 'function') args[0](chain);
      return chain;
    };
  }
  chain.first = (...args) => { chain.log('first', args); return Promise.resolve({ count: 0 }); };
  chain.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  return chain;
}
const mockDb = (table) => makeChain(typeof table === 'object' ? JSON.stringify(table) : table);
mockDb.raw = (...args) => ({ __raw: args });
jest.mock('../models/db', () => mockDb);

const { executeDashboardTool } = require('../services/intelligence-bar/dashboard-tools');

test('estimates_sent keeps source-NULL rows and DELIVERED plan_restart quotes; drops only undelivered restart mints', async () => {
  recorded.length = 0;
  await executeDashboardTool('compare_periods', { period_a: 'this_month', period_b: 'last_month', metrics: ['estimates_sent'] });
  const estimateCalls = recorded.filter((r) => String(r.table).includes('estimates'));
  expect(estimateCalls.length).toBeGreaterThan(0);
  const nullArms = estimateCalls.filter((r) => r.method === 'whereNull' && r.args[0] === 'e.source');
  const notRestartArms = estimateCalls.filter((r) => r.method === 'orWhereNot' && r.args[0] === 'e.source' && r.args[1] === 'plan_restart');
  const deliveredArms = estimateCalls.filter((r) => r.method === 'orWhereRaw'
    && String(r.args[0]).includes("e.estimate_data #>> '{deliveryState,firstDeliveredAt}'") && String(r.args[0]).includes('IS NOT NULL'));
  // One grouped predicate per period, all three arms OR'd together.
  expect(nullArms.length).toBe(2);
  expect(notRestartArms.length).toBe(2);
  expect(deliveredArms.length).toBe(2);
});
