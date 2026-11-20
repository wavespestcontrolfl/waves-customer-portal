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
  const { sentAtSql, countableViewAtSql } = require('../services/self-serve-estimates');
  const inWindow = (sql) => `${sql} >= ? AND ${sql} < ?`;
  const windows = recorded.filter((r) => r.method === 'whereRaw' && String(r.args[0]).endsWith(' < ?'));
  expect(windows.map((r) => r.args[0])).toEqual([
    inWindow(sentAtSql('e')),
    inWindow(countableViewAtSql('e')),
    inWindow('e.accepted_at'),
    inWindow('e.declined_at'),
    // The response time and the accepted value, by acceptance.
    inWindow('e.accepted_at'),
    inWindow('e.accepted_at'),
    // The sent cohort by service, then open follow-ups: both dated by the send.
    inWindow(sentAtSql('e')),
    inWindow(sentAtSql('e')),
  ]);
  // Eastern calendar days, half-open (codex pre-push P1): Nov 1 opens at EDT
  // midnight (DST ends that night) and the window closes at EST midnight Nov 20.
  for (const r of windows) {
    expect(r.args[1].map((d) => d.toISOString())).toEqual(['2026-11-01T04:00:00.000Z', '2026-11-20T05:00:00.000Z']);
  }
  // The raw first-view stamp filters nothing on its own.
  expect(recorded.some((r) => r.method === 'whereBetween' && r.args[0] === 'e.viewed_at')).toBe(false);
});

test('every estimates query dated by the send reads sentAtSql, never the sent_at a suppressed resend rewrites (codex pre-push r16 P1)', async () => {
  const { sentAtSql } = require('../services/self-serve-estimates');
  const sendDated = `${sentAtSql('e')} >= ? AND ${sentAtSql('e')} < ?`;
  const rawSentAt = () => recorded.filter((r) => String(r.table).includes('estimates')
    && ['whereNotNull', 'whereBetween'].includes(r.method) && r.args[0] === 'e.sent_at');

  recorded.length = 0;
  await executeDashboardTool('get_estimate_funnel', { date_from: '2026-11-01', date_to: '2026-11-19' });
  expect(rawSentAt()).toEqual([]);
  // The response time runs from the first delivery for a self-serve quote.
  const average = recorded.find((r) => r.method === 'select' && JSON.stringify(r.args).includes('avg_hrs'));
  expect(average.args[0].__raw[0]).toBe(`AVG(EXTRACT(EPOCH FROM (e.accepted_at - ${sentAtSql('e')})) / 3600) as avg_hrs`);
  expect(recorded.some((r) => r.method === 'whereRaw' && r.args[0] === `${sentAtSql('e')} IS NOT NULL`)).toBe(true);

  recorded.length = 0;
  await executeDashboardTool('compare_periods', { period_a: 'this_month', period_b: 'last_month', metrics: ['estimates_sent'] });
  expect(rawSentAt()).toEqual([]);
  expect(recorded.filter((r) => r.method === 'whereRaw' && r.args[0] === sendDated).length).toBe(2);
});

test('compare_periods dates estimate events by Eastern calendar day and churn by its DATE; a day that does not exist is an error, not a query (codex pre-push P1)', async () => {
  const { sentAtSql } = require('../services/self-serve-estimates');
  recorded.length = 0;
  const out = await executeDashboardTool('compare_periods', {
    period_a: '2026-11', period_b: '2026-10', metrics: ['estimates_sent', 'estimates_accepted', 'churn'],
  });
  expect(out.error).toBeUndefined();
  const windows = (sql) => recorded.filter((r) => r.method === 'whereRaw' && r.args[0] === `${sql} >= ? AND ${sql} < ?`)
    .map((r) => r.args[1].map((d) => d.toISOString())).sort();
  const OCT = ['2026-10-01T04:00:00.000Z', '2026-11-01T04:00:00.000Z'];
  const NOV = ['2026-11-01T04:00:00.000Z', '2026-12-01T05:00:00.000Z'];
  expect(windows(sentAtSql('e'))).toEqual([OCT, NOV]);
  expect(windows('e.accepted_at')).toEqual([OCT, NOV]);
  // churned_at is a DATE: its bounds stay the calendar strings.
  const churn = recorded.filter((r) => r.method === 'whereRaw' && String(r.args[0]).startsWith('COALESCE(c.churned_at'))
    .map((r) => r.args[1]).sort();
  expect(churn).toEqual([['2026-10-01T00:00:00', '2026-10-31T23:59:59'], ['2026-11-01T00:00:00', '2026-11-30T23:59:59']]);

  recorded.length = 0;
  expect(await executeDashboardTool('compare_periods', { period_a: 'last_year', period_b: 'this_month' }))
    .toEqual({ error: expect.stringContaining('Unknown period "last_year"') });
  expect(await executeDashboardTool('get_estimate_funnel', { date_from: '2026-02-30', date_to: '2026-03-01' }))
    .toEqual({ error: 'date_from and date_to must be real YYYY-MM-DD dates' });
  expect(await executeDashboardTool('get_estimate_funnel', { date_from: '2026-03-02', date_to: '2026-03-01' }))
    .toEqual({ error: 'date_from must be on or before date_to' });
  expect(recorded).toEqual([]);
});
