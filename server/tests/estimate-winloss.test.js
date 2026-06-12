/**
 * Win/loss slicing by fieldVerifyFlags and price band (estimator backlog).
 *
 * Pins: resolved-only semantics (won = accepted, lost = declined/expired,
 * resolution-date filter mirrors the client's fallback chain), dual
 * estimate_data shapes (engineRequest.profile vs engineInputs), flag
 * bucketing (presence / field / priority), price banding, and the
 * recurring-band × flag cross slice.
 */

let mockDbHandler = () => { throw new Error('db handler not configured'); };
jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { winLossSlices, _private } = require('../services/estimate-winloss');

function estimatesTable(rows) {
  const builder = {
    whereIn: () => builder,
    where: () => builder,
    select: async () => rows,
  };
  return () => builder;
}

const NOW = Date.now();
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

function row(overrides = {}) {
  return {
    id: 'est-1',
    status: 'accepted',
    accepted_at: daysAgo(5),
    declined_at: null,
    expires_at: null,
    archived_at: null,
    created_at: daysAgo(10),
    updated_at: daysAgo(5),
    monthly_total: '79.00',
    onetime_total: null,
    estimate_data: {
      engineRequest: {
        profile: { fieldVerifyFlags: [] },
      },
    },
    ...overrides,
  };
}

const flagged = (fields, priority = 'MEDIUM') => ({
  engineRequest: {
    profile: {
      fieldVerifyFlags: fields.map((field) => ({ field, reason: 'x', priority })),
    },
  },
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('winLossSlices', () => {
  test('clean vs flagged presence with win rates and the band cross', async () => {
    mockDbHandler = estimatesTable([
      row({ id: 'a' }), // clean, won, $79 recurring
      row({ id: 'b', status: 'declined', accepted_at: null, declined_at: daysAgo(3), estimate_data: flagged(['pool']) }),
      row({ id: 'c', status: 'expired', accepted_at: null, expires_at: daysAgo(2), estimate_data: flagged(['pool', 'lotSize'], 'HIGH') }),
      row({ id: 'd', estimate_data: flagged(['lotSize'], 'LOW'), monthly_total: '135.00' }),
    ]);

    const result = await winLossSlices({ days: 90 });

    expect(result.resolved).toBe(4);
    expect(result.won).toBe(2);
    expect(result.lost).toBe(2);
    expect(result.byFlagPresence.clean).toMatchObject({ won: 1, lost: 0, total: 1, winRatePct: 100 });
    expect(result.byFlagPresence.flagged).toMatchObject({ won: 1, lost: 2, total: 3 });
    // Per-field: pool 0/2, lotSize 1/2.
    const pool = result.byFlagField.find((f) => f.field === 'pool');
    const lot = result.byFlagField.find((f) => f.field === 'lotSize');
    expect(pool).toMatchObject({ won: 0, lost: 2, total: 2, winRatePct: 0 });
    expect(lot).toMatchObject({ won: 1, lost: 1, total: 2, winRatePct: 50 });
    // Priority buckets.
    expect(result.byFlagPriority.HIGH.total).toBe(2); // both flags on row c
    expect(result.byFlagPriority.LOW.total).toBe(1);
    // Band cross: $60–89 row a clean-won + row b flagged-lost; $130+ row d flagged-won.
    const band6090 = result.recurringBandsByFlag.find((b) => b.key === '60_90');
    expect(band6090.clean).toMatchObject({ won: 1, total: 1 });
    expect(band6090.flagged).toMatchObject({ lost: 2, total: 2 }); // rows b and c both sit at the default $79
    const band130 = result.recurringBandsByFlag.find((b) => b.key === '130_plus');
    expect(band130.flagged).toMatchObject({ won: 1, total: 1 });
  });

  test('flattened engineInputs shape and missing profile both classify correctly', async () => {
    mockDbHandler = estimatesTable([
      row({ id: 'a', estimate_data: { engineInputs: { fieldVerifyFlags: [{ field: 'stories', priority: 'HIGH', reason: 'x' }] } } }),
      row({ id: 'b', estimate_data: {} }), // no profile at all
      // engineInputs WITHOUT enrichment markers = manual/v1 pricing inputs,
      // no lookup provenance → noProfile, never "clean".
      row({ id: 'c', estimate_data: '{"engineInputs":{"homeSqFt":1800}}' }),
      // engineInputs WITH a surviving enrichment marker counts as a profile.
      row({ id: 'd', estimate_data: { engineInputs: { homeSqFt: 1800, fieldVerifyFlags: [] } } }),
    ]);

    const result = await winLossSlices({ days: 90 });

    expect(result.byFlagPresence.flagged.total).toBe(1);
    expect(result.byFlagPresence.noProfile.total).toBe(2);
    expect(result.byFlagPresence.clean.total).toBe(1);
    expect(result.byFlagField).toEqual([
      expect.objectContaining({ field: 'stories', total: 1 }),
    ]);
  });

  test('quote-wizard shape: estimate_data.enriched profile is recognized (not noProfile)', async () => {
    mockDbHandler = estimatesTable([
      row({
        id: 'qw',
        estimate_data: {
          lead_id: 'lead-1',
          enriched: { fieldVerifyFlags: [{ field: 'lotSize', reason: 'x', priority: 'MEDIUM' }] },
        },
      }),
      row({
        id: 'qw-clean',
        estimate_data: { lead_id: 'lead-2', enriched: { fieldVerifyFlags: [] } },
      }),
    ]);

    const result = await winLossSlices({ days: 90 });

    expect(result.byFlagPresence.noProfile.total).toBe(0);
    expect(result.byFlagPresence.flagged.total).toBe(1);
    expect(result.byFlagPresence.clean.total).toBe(1);
  });

  test('resolution-date window: a re-saved old resolution is excluded', async () => {
    mockDbHandler = estimatesTable([
      // Accepted 200 days ago but updated yesterday (re-save) — outside window.
      row({ id: 'old', accepted_at: daysAgo(200), updated_at: daysAgo(1) }),
      row({ id: 'fresh' }),
    ]);

    const result = await winLossSlices({ days: 90 });

    expect(result.resolved).toBe(1);
  });

  test('one-time estimates band on onetime_total when no recurring total', async () => {
    mockDbHandler = estimatesTable([
      row({ id: 'a', monthly_total: null, onetime_total: '249.00' }),
      row({ id: 'b', monthly_total: '0', onetime_total: '750.00', status: 'declined', accepted_at: null, declined_at: daysAgo(1) }),
    ]);

    const result = await winLossSlices({ days: 90 });

    const mid = result.byPriceBand.oneTime.find((b) => b.key === '150_300');
    const high = result.byPriceBand.oneTime.find((b) => b.key === '600_plus');
    expect(mid).toMatchObject({ won: 1, total: 1 });
    expect(high).toMatchObject({ lost: 1, total: 1 });
    // Recurring bands untouched.
    expect(result.byPriceBand.recurring.every((b) => b.total === 0)).toBe(true);
  });

  test('archived rows drop symmetrically — rates come from active rows only', async () => {
    // PipelineAnalytics computes close-rate from non-archived rows because
    // archived losses are never fetched; counting archived wins here would
    // inflate every win-rate slice.
    mockDbHandler = estimatesTable([
      row({ id: 'win-archived', archived_at: daysAgo(1) }), // excluded from rates
      row({ id: 'loss-archived', status: 'declined', accepted_at: null, declined_at: daysAgo(2), archived_at: daysAgo(1) }), // excluded
      row({ id: 'loss-live', status: 'declined', accepted_at: null, declined_at: daysAgo(2) }),
      row({ id: 'win-live' }),
    ]);

    const result = await winLossSlices({ days: 90 });

    expect(result.resolved).toBe(2);
    expect(result.won).toBe(1);
    expect(result.lost).toBe(1);
    expect(result.winRatePct).toBe(50);
  });

  test('zero resolved rows returns null win rates, not divide-by-zero', async () => {
    mockDbHandler = estimatesTable([]);
    const result = await winLossSlices({ days: 30 });
    expect(result.resolved).toBe(0);
    expect(result.winRatePct).toBeNull();
    expect(result.byFlagPresence.clean.winRatePct).toBeNull();
  });

  test('malformed flag entries are ignored, not crashed on', async () => {
    mockDbHandler = estimatesTable([
      row({
        estimate_data: {
          engineRequest: {
            profile: { fieldVerifyFlags: [null, 'junk', { reason: 'no field' }, { field: 'pool', priority: 'HIGH' }] },
          },
        },
      }),
    ]);
    const result = await winLossSlices({ days: 90 });
    expect(result.byFlagField).toHaveLength(1);
    expect(result.byFlagField[0].field).toBe('pool');
  });
});

describe('resolutionDateMs fallback chain (mirrors client resolutionDate)', () => {
  const { resolutionDateMs } = _private;
  test('accepted prefers accepted_at, falls back to created_at', () => {
    expect(resolutionDateMs({ status: 'accepted', accepted_at: '2026-06-01T00:00:00Z' }))
      .toBe(new Date('2026-06-01T00:00:00Z').getTime());
    expect(resolutionDateMs({ status: 'accepted', created_at: '2026-05-01T00:00:00Z' }))
      .toBe(new Date('2026-05-01T00:00:00Z').getTime());
  });
  test('expired uses expires_at then updated_at then created_at', () => {
    expect(resolutionDateMs({ status: 'expired', expires_at: '2026-06-02T00:00:00Z', updated_at: '2026-06-09T00:00:00Z' }))
      .toBe(new Date('2026-06-02T00:00:00Z').getTime());
  });
  test('open statuses resolve to null', () => {
    expect(resolutionDateMs({ status: 'sent', created_at: '2026-06-01T00:00:00Z' })).toBeNull();
  });
});
