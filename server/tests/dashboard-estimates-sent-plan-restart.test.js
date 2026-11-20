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
let chainSeq = 0;
function makeChain(table) {
  const chain = {
    table,
    id: ++chainSeq,
    log(method, args) { recorded.push({ table: this.table, chain: this.id, method, args }); return this; },
  };
  const methods = ['leftJoin', 'where', 'andWhere', 'orWhere', 'whereNot', 'orWhereNot', 'whereRaw', 'orWhereRaw',
    'whereIn', 'orWhereIn', 'whereNotIn', 'orWhereNotIn', 'whereNull', 'orWhereNull', 'whereNotNull', 'orWhereNotNull',
    'whereBetween', 'select', 'groupBy', 'orderBy', 'orderByRaw', 'limit', 'sum', 'count', 'modify'];
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

test('estimates_sent keeps source-NULL rows and DELIVERED self-serve quotes; drops only undelivered plan_restart and plan_start mints', async () => {
  recorded.length = 0;
  await executeDashboardTool('compare_periods', { period_a: 'this_month', period_b: 'last_month', metrics: ['estimates_sent'] });
  const estimateCalls = recorded.filter((r) => String(r.table).includes('estimates'));
  expect(estimateCalls.length).toBeGreaterThan(0);
  const nullArms = estimateCalls.filter((r) => r.method === 'whereNull' && r.args[0] === 'e.source');
  const notRestartArms = estimateCalls.filter((r) => r.method === 'orWhereNotIn' && r.args[0] === 'e.source'
    && JSON.stringify(r.args[1]) === JSON.stringify(['plan_restart', 'plan_start']));
  const deliveredArms = estimateCalls.filter((r) => r.method === 'orWhereRaw'
    && String(r.args[0]).includes("e.estimate_data #>> '{deliveryState,firstDeliveredAt}'") && String(r.args[0]).includes('IS NOT NULL'));
  // One grouped predicate per period, all three arms OR'd together.
  expect(nullArms.length).toBe(2);
  expect(notRestartArms.length).toBe(2);
  expect(deliveredArms.length).toBe(2);
});

test('every get_estimate_funnel query leaves out undelivered self-serve quotes, so the rates share one cohort (codex pre-push P1)', async () => {
  recorded.length = 0;
  const out = await executeDashboardTool('get_estimate_funnel', { date_from: '2026-11-01', date_to: '2026-11-19' });
  expect(out.error).toBeUndefined();
  const chains = new Map();
  for (const r of recorded) {
    if (!String(r.table).includes('estimates')) continue;
    if (!chains.has(r.chain)) chains.set(r.chain, []);
    chains.get(r.chain).push(r);
  }
  // Four stages, response time, accepted value, the sent cohort by service, open follow-ups.
  expect(chains.size).toBe(8);
  for (const calls of chains.values()) {
    expect(calls.some((c) => c.method === 'whereNull' && c.args[0] === 'e.source')).toBe(true);
    expect(calls.some((c) => c.method === 'orWhereNotIn' && c.args[0] === 'e.source'
      && JSON.stringify(c.args[1]) === JSON.stringify(['plan_restart', 'plan_start']))).toBe(true);
    expect(calls.some((c) => c.method === 'orWhereRaw'
      && String(c.args[0]).includes("e.estimate_data #>> '{deliveryState,firstDeliveredAt}'") && String(c.args[0]).includes('IS NOT NULL'))).toBe(true);
  }
});

test('the funnel\'s viewed stage counts a self-serve quote\'s view only from staff delivery on (codex pre-push r15 P1)', async () => {
  recorded.length = 0;
  await executeDashboardTool('get_estimate_funnel', { date_from: '2026-11-01', date_to: '2026-11-19' });
  const { countableViewAtSql } = require('../services/self-serve-estimates');
  const stages = recorded.filter((r) => r.method === 'whereRaw' && String(r.args[0]).endsWith(' BETWEEN ? AND ?'));
  expect(stages.map((r) => r.args[0])).toEqual([
    'e.sent_at BETWEEN ? AND ?',
    `${countableViewAtSql('e')} BETWEEN ? AND ?`,
    'e.accepted_at BETWEEN ? AND ?',
    'e.declined_at BETWEEN ? AND ?',
  ]);
  for (const r of stages) expect(r.args[1]).toEqual(['2026-11-01T00:00:00', '2026-11-19T23:59:59']);
  // The raw first-view stamp filters nothing on its own.
  expect(recorded.some((r) => r.method === 'whereBetween' && r.args[0] === 'e.viewed_at')).toBe(false);
});
