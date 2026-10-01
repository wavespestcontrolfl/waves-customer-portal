/**
 * server/scripts/dunning-spacing-replay.js — the read-only replay's own
 * `collections_contact_ledger` query.
 *
 * Pin (codex r2 P2 "Bound replay rows at the captured end time"): the query
 * must close the historical interval at the `now` it captured and labeled
 * the report with, not at whenever the query itself executes — otherwise a
 * reminder committed after `now` but before the DB snapshot slips into a
 * report claiming to end at `now`. Verified by mocking the db module and
 * asserting the exact `where('occurred_at', '<=', now)` predicate, since the
 * script has no DATABASE_URL to run against here (it fails closed without
 * one — see the other test below).
 */

const NOW = new Date('2026-09-28T12:00:00.000Z');

function fixedDateClass(now) {
  const RealDate = Date;
  return class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) return new RealDate(now);
      return new RealDate(...args);
    }

    static now() { return now.getTime(); }
  };
}

async function flush() {
  // Let the script's async IIFE (mocked, no real I/O latency) settle its
  // microtask chain before assertions run.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('dunning-spacing-replay script — replay window end bound', () => {
  const RealDate = global.Date;
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    jest.resetModules();
    global.Date = fixedDateClass(NOW);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DATABASE_URL = 'postgres://fake-host/fake-db';
    delete process.env.DATABASE_PUBLIC_URL;
  });

  afterEach(() => {
    global.Date = RealDate;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_PUBLIC_URL;
    jest.resetModules();
  });

  test('the ledger query bounds occurred_at with a "<=" predicate at the captured now', async () => {
    const query = {};
    ['whereIn', 'orderBy'].forEach((m) => { query[m] = jest.fn(() => query); });
    const whereCalls = [];
    query.where = jest.fn((...args) => { whereCalls.push(args); return query; });
    query.select = jest.fn(async () => []);
    const dbFn = jest.fn(() => query);
    dbFn.destroy = jest.fn(async () => {});

    jest.doMock('../models/db', () => dbFn);
    jest.doMock('../services/collections/dunning-spacing', () => ({
      OVERDUE_SOURCES: new Set(['invoice_followups']),
      OVERDUE_PURPOSES: new Set(['invoice_followup']),
      summarizeDunningSpacingReplay: jest.fn(() => ({
        spacingHits: [], candidatesInWindow: 0, spacedWithin7d: 0, customersAffected: 0,
      })),
    }));

    jest.isolateModules(() => {
      require('../scripts/dunning-spacing-replay');
    });
    await flush();

    expect(dbFn).toHaveBeenCalledWith('collections_contact_ledger');
    // The lower bound (lookback) and the new upper bound (now) are both
    // present as distinct `where('occurred_at', …)` calls, in that order.
    const occurredAtCalls = whereCalls.filter(([col]) => col === 'occurred_at');
    expect(occurredAtCalls).toHaveLength(2);
    expect(occurredAtCalls[0][1]).toBe('>');
    expect(occurredAtCalls[1]).toEqual(['occurred_at', '<=', NOW]);
    expect(dbFn.destroy).toHaveBeenCalled();
  });
});
