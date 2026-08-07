/**
 * stripe-webhook-health — ledger query shape.
 *
 * Pins the in-flight-claim exclusion at the SQL level (codex on #3268): a
 * processed=false / error=null row younger than the webhook route's
 * STALE_CLAIM_WINDOW_MS is a live worker mid-handler (the route uses
 * received_at as the claim lease), NOT a failure — the digest must only
 * report abandoned claims. The db mock is a connection-less knex instance so
 * the exact compiled SQL + bindings are asserted without faking the builder.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({})),
}));
// Query-building only — never awaited, so no connection is ever acquired.
jest.mock('../models/db', () => require('knex')({ client: 'pg' }));

const {
  _private: { failedEventsQuery, ledgerCutoffs, LOOKBACK_HOURS },
} = require('../services/stripe-webhook-health');
const { STALE_CLAIM_WINDOW_MS } = require('../routes/stripe-webhook-helpers');

describe('failedEventsQuery', () => {
  const cutoff = new Date('2026-08-05T07:04:00Z');
  const staleCutoff = new Date('2026-08-07T06:59:00Z');

  test('error-free unprocessed rows are only selected when the claim is PAST the stale window', () => {
    const { sql, bindings } = failedEventsQuery(cutoff, staleCutoff).toSQL().toNative();
    // Branch 1: any row with a recorded handler error.
    expect(sql).toContain('"error" is not null');
    // Branch 2: unprocessed AND error-free AND received before the stale
    // cutoff — an in-flight claim (received_at >= staleCutoff) matches
    // neither branch and is excluded.
    expect(sql).toMatch(/"processed" = \$\d+ and "error" is null and "received_at" < \$\d+/);
    expect(bindings).toContain(cutoff);
    expect(bindings).toContain(staleCutoff);
    expect(bindings).toContain(false);
  });

  test('window filter still bounds the scan to the lookback', () => {
    const { sql } = failedEventsQuery(cutoff, staleCutoff).toSQL().toNative();
    expect(sql).toContain('"received_at" > $');
  });
});

describe('ledgerCutoffs', () => {
  test('stale cutoff reuses the webhook route\'s STALE_CLAIM_WINDOW_MS (no duplicated constant)', () => {
    const now = Date.parse('2026-08-07T07:04:00Z');
    const { cutoff, staleCutoff } = ledgerCutoffs(now);
    expect(staleCutoff.getTime()).toBe(now - STALE_CLAIM_WINDOW_MS);
    expect(cutoff.getTime()).toBe(now - LOOKBACK_HOURS * 60 * 60 * 1000);
    // The claim window is minutes; the lookback is hours — the exclusion can
    // never swallow the whole window.
    expect(STALE_CLAIM_WINDOW_MS).toBeLessThan(LOOKBACK_HOURS * 60 * 60 * 1000);
  });
});
